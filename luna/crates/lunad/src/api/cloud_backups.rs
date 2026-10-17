//! Cloud backups: list, start, run, check, delete (plan §5). The copies live in
//! Luna Connect, so anything that talks to the cloud needs Connect set up.
use std::time::Duration;

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::check::{CheckReport, Sample};
use crate::backup::cloud::crypto::Signer;
use crate::backup::cloud::identity;
use crate::backup::cloud::ops::{self, NOT_SET_UP};
use crate::backup::cloud::store::HttpStore;
use crate::backup::drive_backup::{self, Refused};
use crate::db::{self, ProtectionRow};
use crate::net::connect::ConnectService;

/// How long Run and Check wait for the job before answering "not done yet".
const RUN_WAIT: Duration = Duration::from_secs(15);
/// Backups are checked once a day by the scheduler.
const CHECK_EVERY: i64 = 24 * 60 * 60;
/// Packs a manual check downloads: enough to catch most damage, quick to answer.
const MANUAL_CHECK_PACKS: u32 = 16;

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

#[derive(Deserialize)]
struct CreateBody {
    source_drive_id: String,
    source_path: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cloud/backups", get(list).post(create))
        .route("/api/v1/cloud/backups/{id}", delete(remove))
        .route("/api/v1/cloud/backups/{id}/run", post(run))
        .route("/api/v1/cloud/backups/{id}/check", post(check))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let rows = db::list_protections(&conn).map_err(|_| read_failed())?;
    let now = db::now_unix();
    let backups: Vec<Value> = rows
        .iter()
        .filter(|row| row.kind == db::PROTECTION_CLOUD)
        .filter(|row| ops::visible_to(row, &user))
        .map(|row| backup_json(&conn, row, &user, now))
        .collect();
    Ok(Json(Value::Array(backups)))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateBody>,
) -> ApiResult {
    {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let norm = crate::access::normalize_subject_path(&body.source_path);
        // Same order as drive backups: the no-access answer comes first, so
        // someone who cannot see the folder never learns a backup of it exists.
        if norm.is_empty() && user.role != "admin" {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only an Admin can back up a whole drive.",
            ));
        }
        if !crate::auth::has_cap(
            &user,
            &conn,
            &body.source_drive_id,
            &norm,
            crate::access::CAP_VIEW,
        ) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You need Read access to this folder to back it up.",
            ));
        }
    }
    // Connect and the drives are reached with no DB lock held.
    let row = ops::create(&state.db, &state.connect, &user, &body.source_drive_id, &body.source_path)
        .map_err(|Refused(msg)| json_error(refusal_status(&msg), msg))?;
    // An existing backup of this folder comes back as it is, so only people
    // on its access list may see it or start it.
    if !ops::visible_to(&row, &user) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Someone already backs this folder up to the cloud.",
        ));
    }
    // The first copy runs in the background; the row's state tells the rest.
    let connect = state.connect.clone();
    let db = state.db.clone();
    let id = row.id.clone();
    let started_by = user.id.clone();
    drop(tokio::task::spawn_blocking(move || {
        let now = db::now_unix();
        match connect_store(&connect, &db) {
            Some(store) => {
                ops::run(&db, &id, &store, &connect, &started_by, false, now);
            }
            // Without Connect, every active cloud backup says why it cannot run.
            None => {
                ops::run_all(&db, None, &connect, now);
            }
        }
    }));
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    Ok(Json(backup_json(&conn, &row, &user, db::now_unix())))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult {
    let row = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        find_backup(&conn, &id)?
    };
    if !can_delete(&row, &user) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin or the person who made this backup can delete it.",
        ));
    }
    // A copy in progress would write into the backup while it is removed.
    if drive_backup::is_running(&id) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Luna is copying this backup right now. Delete it when the copy finishes.",
        ));
    }
    let connect = state.connect.clone();
    let db = state.db.clone();
    let job = tokio::task::spawn_blocking(move || {
        let store = connect_store(&connect, &db)?;
        Some(ops::delete(&db, &id, &store, db::now_unix()))
    })
    .await;
    match job {
        Ok(Some(Ok(()))) => Ok(Json(json!({ "ok": true }))),
        Ok(Some(Err(err))) => {
            tracing::warn!(error = %err, "could not delete a cloud backup");
            Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't delete this cloud backup. Try again.",
            ))
        }
        // Its copies in the cloud can only be removed through Connect.
        Ok(None) => Err(json_error(
            StatusCode::CONFLICT,
            "Connect this Luna to Luna Connect before deleting a cloud backup. Its copies in the cloud can't be removed until then. Settings → Luna Connect.",
        )),
        Err(_) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't delete this cloud backup. Try again.",
        )),
    }
}

/// Options for running a backup now. `accept_missing` is the person's answer to "the source
/// looks missing": true lets the run go ahead anyway. It may come as a query or in the body.
#[derive(serde::Deserialize, Default)]
struct RunOptions {
    #[serde(default)]
    accept_missing: bool,
}

async fn run(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<RunOptions>,
    body: Option<Json<RunOptions>>,
) -> ApiResult {
    let accept_missing = query.accept_missing || body.is_some_and(|Json(b)| b.accept_missing);
    {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        if !ops::visible_to(&row, &user) {
            return Err(not_found());
        }
    }
    // A run or a check already holds the backup. Say so instead of starting another.
    if drive_backup::is_running(&id) {
        return Ok(Json(json!({
            "done": false,
            "problem": "This backup is busy right now. Try again in a minute.",
        })));
    }
    let connect = state.connect.clone();
    let db = state.db.clone();
    let started_by = user.id.clone();
    let job = tokio::task::spawn_blocking(move || {
        let store = connect_store(&connect, &db)?;
        Some(ops::run(&db, &id, &store, &connect, &started_by, accept_missing, db::now_unix()))
    });
    // A big first copy can take hours. Answer when it's quick; otherwise say
    // it's not done and let the backup's state tell the rest.
    let answer = match tokio::time::timeout(RUN_WAIT, job).await {
        Ok(Ok(Some(outcome))) => match outcome.problem {
            None => json!({ "done": true }),
            Some(problem) => json!({ "done": false, "problem": problem }),
        },
        Ok(Ok(None)) => json!({ "done": false, "problem": NOT_SET_UP }),
        _ => json!({ "done": false }),
    };
    Ok(Json(answer))
}

async fn check(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult {
    {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        if !ops::visible_to(&row, &user) {
            return Err(not_found());
        }
    }
    let connect = state.connect.clone();
    let db = state.db.clone();
    let job = tokio::task::spawn_blocking(move || {
        let store = connect_store(&connect, &db)?;
        Some(ops::check(
            &db,
            &id,
            &store,
            Sample::Random(MANUAL_CHECK_PACKS),
            db::now_unix(),
        ))
    });
    let answer = match tokio::time::timeout(RUN_WAIT, job).await {
        Ok(Ok(Some(Ok(report)))) => check_json(&report),
        Ok(Ok(Some(Err(err)))) => {
            tracing::warn!(error = %err, "could not check a cloud backup");
            json!({
                "done": false,
                "problem": "Luna couldn't check this backup. Try again.",
            })
        }
        Ok(Ok(None)) => json!({ "done": false, "problem": NOT_SET_UP }),
        _ => json!({ "done": false }),
    };
    Ok(Json(answer))
}

/// The Connect store for this Luna, or `None` when Luna Connect is not set up.
/// Blocking: reads the device token and this Luna's identity.
pub fn connect_store(connect: &ConnectService, db: &crate::Db) -> Option<HttpStore> {
    if !connect.is_connect_active() {
        return None;
    }
    let token = connect.token().ok()?;
    let base_url = connect.status().base_url;
    // A fresh Luna mints its identity here, so the first cloud job can run without a setup step.
    let identity = match identity::load_or_create_connected(db, connect, db::now_unix()) {
        Ok(identity) => identity,
        Err(err) => {
            tracing::warn!(error = %err, "could not set up Luna's cloud identity");
            return None;
        }
    };
    // Every request is signed with this Luna's key, so Connect can tell this Luna from any other.
    let signer = Signer::from_seed(identity.signer().seed());
    Some(HttpStore::new(&base_url, &token, identity.luna_id()).signed_by(signer))
}

fn check_json(report: &CheckReport) -> Value {
    json!({
        "done": true,
        "problem": report.problem,
        "snapshots_checked": report.snapshots_checked,
        "packs_checked": report.packs_checked,
        "missing_packs": report.missing_packs,
        "damaged_packs": report.damaged_packs,
        "bad_records": report.bad_records,
    })
}

/// The backup if it exists, else a plain 404.
fn find_backup(conn: &Connection, id: &str) -> Result<ProtectionRow, ApiError> {
    db::get_protection(conn, id)
        .map_err(|_| read_failed())?
        .filter(|row| row.kind == db::PROTECTION_CLOUD)
        .ok_or_else(not_found)
}

/// Admins may delete any backup; anyone else only a backup they made and can see.
fn can_delete(row: &ProtectionRow, user: &CurrentUser) -> bool {
    user.role == "admin" || (row.created_by == user.id && ops::visible_to(row, user))
}

fn backup_json(conn: &Connection, row: &ProtectionRow, user: &CurrentUser, now: i64) -> Value {
    let source_label = drive_label(conn, &row.source_drive);
    let next_check = if row.last_checked_at == 0 {
        now
    } else {
        row.last_checked_at + CHECK_EVERY
    };
    json!({
        "id": row.id,
        "kind": row.kind,
        "source_drive": row.source_drive,
        "source_drive_name": source_label,
        "source_path": row.source_path,
        "source_name": folder_name(&row.source_path, &source_label),
        "state": ops::state(row, now),
        "status": row.state,
        "stop_reason": row.stop_reason,
        "last_ok_at": row.last_ok_at,
        "last_error": row.last_error,
        "last_checked_at": row.last_checked_at,
        "check_problem": ops::last_check_problem(conn, &row.id),
        "next_check": next_check,
        "size": ops::size(conn, &row.id),
        "first_done": row.first_done,
        "created_by": row.created_by,
        "can_delete": can_delete(row, user),
        "running": drive_backup::is_running(&row.id),
        "notes": row.notes.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(),
    })
}

/// A refusal about who may do something is 403; anything else is 400.
fn refusal_status(msg: &str) -> StatusCode {
    if msg.starts_with("You need") || msg.starts_with("Only an Admin") {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    }
}

fn read_failed() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't load the cloud backups. Try again.",
    )
}

fn not_found() -> ApiError {
    json_error(StatusCode::NOT_FOUND, "This backup doesn't exist anymore.")
}

fn drive_label(conn: &Connection, drive_id: &str) -> String {
    let label = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .map(|d| d.label)
        .unwrap_or_default();
    if label.trim().is_empty() {
        "Unnamed drive".to_string()
    } else {
        label
    }
}

/// The last folder in the path, or the drive's name for a whole drive.
fn folder_name(source_path: &str, drive_label: &str) -> String {
    source_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| drive_label.to_string())
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::backup::cloud::ops::NOT_SET_UP;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_token: String,
        member_id: String,
        member_token: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Fixture {
            admin_token: auth.issue(&admin).unwrap(),
            member_token: auth.issue(&member).unwrap(),
            member_id: member.id.clone(),
            _dir: dir,
            state,
            router,
        }
    }

    /// Insert a cloud backup row straight into the table, with the given access list.
    fn seed(state: &AppState, id: &str, access_json: &str) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id,
                kind: db::PROTECTION_CLOUD,
                source_drive: "d1",
                source_path: id,
                target_drive: "",
                private_owner: "",
                created_by: "someone",
                created_at: 0,
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE protections SET access_json = ?1 WHERE id = ?2",
            rusqlite::params![access_json, id],
        )
        .unwrap();
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<&str>,
    ) -> (axum::http::StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(text) => {
                builder = builder.header("content-type", "application/json");
                Body::from(text.to_string())
            }
            None => Body::empty(),
        };
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn ids(json: &Value) -> Vec<String> {
        json.as_array()
            .unwrap()
            .iter()
            .map(|b| b["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn list_shows_each_backup_only_to_its_access_list() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed(&f.state, "c-member", &member_only);
        seed(&f.state, "c-admin", r#"{"users":[],"admins":true}"#);

        let (status, body) = send(&f.router, "GET", "/api/v1/cloud/backups", &f.member_token, None).await;
        assert_eq!(status, 200);
        assert_eq!(ids(&body), vec!["c-member".to_string()]);

        let (_, body) = send(&f.router, "GET", "/api/v1/cloud/backups", &f.admin_token, None).await;
        assert_eq!(ids(&body), vec!["c-admin".to_string()]);
    }

    #[tokio::test]
    async fn run_says_connect_is_not_set_up() {
        let f = fixture();
        seed(&f.state, "c1", r#"{"users":[],"admins":true}"#);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups/c1/run",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["done"], false);
        assert_eq!(body["problem"], NOT_SET_UP);
    }

    #[tokio::test]
    async fn check_says_connect_is_not_set_up() {
        let f = fixture();
        seed(&f.state, "c1", r#"{"users":[],"admins":true}"#);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups/c1/check",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["done"], false);
        assert_eq!(body["problem"], NOT_SET_UP);
    }

    #[tokio::test]
    async fn delete_is_refused_without_connect() {
        let f = fixture();
        seed(&f.state, "c1", r#"{"users":[],"admins":true}"#);
        let (status, body) = send(
            &f.router,
            "DELETE",
            "/api/v1/cloud/backups/c1",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 409);
        assert!(body["error"].as_str().unwrap().contains("Luna Connect"));
        // The backup is still there.
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(db::get_protection(&conn, "c1").unwrap().is_some());
    }

    #[tokio::test]
    async fn member_cannot_see_or_delete_another_members_backup() {
        let f = fixture();
        seed(&f.state, "c-admin", r#"{"users":[],"admins":true}"#);
        let (status, _) = send(
            &f.router,
            "DELETE",
            "/api/v1/cloud/backups/c-admin",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, 403);
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups/c-admin/run",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn member_cannot_back_up_a_whole_drive() {
        let f = fixture();
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.member_token,
            Some(r#"{"source_drive_id":"d1","source_path":""}"#),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(body["error"], "Only an Admin can back up a whole drive.");
    }
}
