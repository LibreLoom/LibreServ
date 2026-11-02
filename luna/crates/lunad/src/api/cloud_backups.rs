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
use crate::api::response::{json_error, json_error_code};
use crate::auth::CurrentUser;
use crate::backup::cloud::check::{CheckReport, Sample};
use crate::backup::cloud::crypto::Signer;
use crate::backup::cloud::identity;
use crate::backup::cloud::ops::{self, NOT_SET_UP};
use crate::backup::cloud::rewrap;
use crate::backup::cloud::run::CloudOutcome;
use crate::backup::cloud::store::HttpStore;
use crate::backup::drive_backup::{self, Refused};
use crate::db::{self, ProtectionRow};
use crate::net::connect::ConnectService;
use crate::private::{self, OwnerState};

/// Machine code for "this person has no recovery phrase, so no cloud backup yet".
const NEEDS_PHRASE_CODE: &str = "needs_phrase";
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

async fn list(State(state): State<AppState>, Extension(user): Extension<CurrentUser>) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let rows = db::list_protections(&conn).map_err(|_| read_failed())?;
    let now = db::now_unix();
    let backups: Vec<Value> = rows
        .iter()
        .filter(|row| row.kind == db::PROTECTION_CLOUD)
        .filter(|row| ops::visible_to(row, &user))
        .map(|row| backup_json(&state.db, &conn, row, &user, now))
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
        // A backup is sealed to the caller's phrase, so no phrase means no backup. This runs
        // before anything is written or queued, so a refused request leaves nothing behind.
        let has_phrase = db::get_user_keys(&conn, &user.id)
            .map_err(|_| read_failed())?
            .is_some();
        if !has_phrase {
            return Err(json_error_code(
                StatusCode::CONFLICT,
                NEEDS_PHRASE_CODE,
                "You need a recovery phrase first. Reload this page to set one up.",
            ));
        }
    }
    // Connect and the drives are reached with no DB lock held.
    let row = ops::create(
        &state.db,
        &state.connect,
        &user,
        &body.source_drive_id,
        &body.source_path,
    )
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
    Ok(Json(backup_json(
        &state.db,
        &conn,
        &row,
        &user,
        db::now_unix(),
    )))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult {
    let allowed = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        can_delete(&conn, &row, &user)
    };
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin or the person who made this backup can delete it.",
        ));
    }
    // A copy in progress would write into the backup while it is removed.
    if drive_backup::is_running(&state.db, &id) {
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
            "Connect this Luna to Luna Connect before deleting a cloud backup. Its copies in the cloud can't be removed until then. Settings → About → Advanced.",
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
    let wants_accept_missing = query.accept_missing || body.is_some_and(|Json(b)| b.accept_missing);
    // Only people who may delete the backup may let a run go ahead on a source that looks gone.
    let accept_missing = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        if !ops::visible_to(&row, &user) {
            return Err(not_found());
        }
        accept_missing_allowed(&conn, &row, &user, wants_accept_missing)
    };
    // A run or a check already holds the backup. Say so instead of starting another.
    if drive_backup::is_running(&state.db, &id) {
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
        Some(ops::run(
            &db,
            &id,
            &store,
            &connect,
            &started_by,
            accept_missing,
            db::now_unix(),
        ))
    });
    // A big first copy can take hours. Answer when it's quick; otherwise say
    // it's not done and let the backup's state tell the rest.
    let answer = match tokio::time::timeout(RUN_WAIT, job).await {
        Ok(Ok(Some(outcome))) => run_answer(&outcome),
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
    if drive_backup::is_running(&state.db, &id) {
        return Ok(Json(json!({
            "done": false,
            "problem": "This backup is busy right now. Try again in a minute.",
        })));
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

/// "Back up anyway" on a source that looks gone is for people who may delete the backup,
/// the same rule as a drive backup's "Run anyway". Anyone else's request is ignored.
fn accept_missing_allowed(
    conn: &Connection,
    row: &ProtectionRow,
    user: &CurrentUser,
    wants: bool,
) -> bool {
    wants && can_delete(conn, row, user)
}

/// Admins may delete any shared backup; anyone else only a backup they made and can see.
/// A private item's backup is the owner's to delete. An Admin may delete it only once
/// its owner's account is gone, and never while the owner is still a person here.
fn can_delete(conn: &Connection, row: &ProtectionRow, user: &CurrentUser) -> bool {
    if !row.private_owner.is_empty() {
        return user.id == row.private_owner
            || (user.role == "admin"
                && private::owner_state(conn, &row.private_owner) != OwnerState::Active);
    }
    user.role == "admin" || (row.created_by == user.id && ops::visible_to(row, user))
}

fn backup_json(
    db: &crate::Db,
    conn: &Connection,
    row: &ProtectionRow,
    user: &CurrentUser,
    now: i64,
) -> Value {
    let source_label = drive_label(conn, &row.source_drive);
    let next_check = if row.last_checked_at == 0 {
        now
    } else {
        row.last_checked_at + CHECK_EVERY
    };
    let covered_by = drive_backup::covered_by(conn, row)
        .map(|(parent, _)| json!({ "path": parent.source_path, "name": folder_name(&parent.source_path, &source_label) }));
    json!({
        "covered_by": covered_by,
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
        "source_missing": ops::last_run_source_missing(conn, &row.id),
        "next_check": next_check,
        "size": ops::size(conn, &row.id),
        "first_done": row.first_done,
        "created_by": row.created_by,
        "can_delete": can_delete(conn, row, user),
        "private": !row.private_owner.is_empty(),
        "old_phrase_copies": old_phrase_copies_json(conn, row, user),
        "running": drive_backup::is_running(db, &row.id),
        "notes": row.notes.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(),
        // `{percent, paused_full}` while older packs move to the newest recovery phrase, else null.
        "moving": rewrap::status_json_for(conn, row, user),
    })
}

/// Copies of a private item made with an old recovery phrase, waiting to be removed.
/// Only the owner sees them; everyone else, Admins included, gets `null`.
fn old_phrase_copies_json(conn: &Connection, row: &ProtectionRow, user: &CurrentUser) -> Value {
    if row.private_owner.is_empty() || user.id != row.private_owner {
        return Value::Null;
    }
    ops::old_phrase_copies(conn, &row.private_owner)
        .map(|(count, removed_at)| json!({ "count": count, "removed_at": removed_at }))
        .unwrap_or(Value::Null)
}

/// What the Run button hears back: done, or the problem and whether the source looks gone.
fn run_answer(outcome: &CloudOutcome) -> Value {
    match &outcome.problem {
        None => json!({ "done": true }),
        Some(problem) => json!({
            "done": false,
            "problem": problem,
            "source_missing": outcome.source_missing,
        }),
    }
}

/// A refusal about who may do something is 403; anything else is 400.
/// "Included in the backup of …" is a 400: it says why nothing is needed, not who may do it.
fn refusal_status(msg: &str) -> StatusCode {
    if msg.starts_with("You need")
        || msg.starts_with("Only an Admin")
        || (msg.starts_with("Only ") && msg.ends_with("can back up this item."))
    {
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
    use super::run_answer;
    use crate::backup::cloud::ops;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::backup::cloud::ops::NOT_SET_UP;
    use crate::backup::cloud::run::CloudOutcome;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
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
            admin_id: admin.id.clone(),
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

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(ids(&body), vec!["c-member".to_string()]);

        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(ids(&body), vec!["c-admin".to_string()]);
    }

    #[tokio::test]
    async fn only_people_who_can_delete_may_accept_a_missing_source() {
        let f = fixture();
        let both = format!(r#"{{"users":["{}"],"admins":true}}"#, f.member_id);
        seed(&f.state, "c-both", &both);
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = db::get_protection(&conn, "c-both").unwrap().unwrap();
        let user_of = |role: &str, id: &str| crate::auth::CurrentUser {
            id: id.to_string(),
            role: role.to_string(),
            username: id.to_string(),
        };
        let member = user_of("user", &f.member_id);
        let admin = user_of("admin", "admin-id");
        assert!(!super::accept_missing_allowed(&conn, &row, &member, true));
        assert!(super::accept_missing_allowed(&conn, &row, &admin, true));
        assert!(!super::accept_missing_allowed(&conn, &row, &admin, false));
    }

    #[test]
    fn run_answer_says_when_the_source_looks_missing() {
        let held = CloudOutcome {
            problem: Some("The source looks missing.".into()),
            source_missing: true,
            ..CloudOutcome::default()
        };
        let body = run_answer(&held);
        assert_eq!(body["done"], false);
        assert_eq!(body["source_missing"], true);
        assert_eq!(run_answer(&CloudOutcome::default())["done"], true);

        let other = CloudOutcome {
            problem: Some(NOT_SET_UP.into()),
            ..CloudOutcome::default()
        };
        assert_eq!(run_answer(&other)["source_missing"], false);
    }

    #[tokio::test]
    async fn list_row_keeps_source_missing_after_a_held_run_until_a_clean_one() {
        let f = fixture();
        seed(&f.state, "c-held", r#"{"users":[],"admins":true}"#);
        let held = CloudOutcome {
            problem: Some("The source looks missing.".into()),
            source_missing: true,
            ..CloudOutcome::default()
        };
        ops::record(&f.state.db, "c-held", 100, &held).unwrap();
        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(body[0]["source_missing"], true);

        ops::record(&f.state.db, "c-held", 200, &CloudOutcome::default()).unwrap();
        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(body[0]["source_missing"], false);
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
    async fn old_phrase_copies_shows_for_the_owner() {
        let f = fixture();
        let owner = f.member_id.clone();
        {
            let mut conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_protection(
                &conn,
                &db::NewProtection {
                    id: "p-private",
                    kind: db::PROTECTION_CLOUD,
                    source_drive: "d1",
                    source_path: "/Docs",
                    target_drive: "",
                    private_owner: &owner,
                    created_by: &owner,
                    created_at: 0,
                },
            )
            .unwrap();
            // Admins are kept out of private rows, but even one who can see it must not see the copies.
            let access = format!(r#"{{"users":["{owner}"],"admins":true}}"#);
            conn.execute(
                "UPDATE protections SET access_json = ?1 WHERE id = ?2",
                rusqlite::params![access, "p-private"],
            )
            .unwrap();
            db::insert_private_scope(
                &conn,
                &db::PrivateScope {
                    scope: "aa".repeat(16),
                    owner: owner.clone(),
                    seal_public: vec![0; 32],
                    scope_public: vec![5; 32],
                    sealed_scope_secret: vec![6; 16],
                    dedup_key: vec![0; 32],
                    state: "old_phrase".to_string(),
                    retire_after: 1_900_000_000,
                    created_at: 0,
                },
            )
            .unwrap();
            db::commit_private_snapshot_tx(
                &mut conn,
                &db::SnapshotInsert {
                    id: "snap-old".to_string(),
                    protection_id: "p-private".to_string(),
                    created_at: 0,
                    key_version: 0,
                    tree_pack_id: "tree-pack".to_string(),
                    record: Vec::new(),
                },
                &[],
                &"aa".repeat(16),
                b"{}",
            )
            .unwrap();
        }

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let row = body
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == "p-private")
            .expect("the owner sees their private backup");
        assert_eq!(row["private"], true);
        assert_eq!(row["old_phrase_copies"]["count"], 1);
        assert_eq!(row["old_phrase_copies"]["removed_at"], 1_900_000_000i64);

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/backups",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let row = body
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == "p-private")
            .expect("the Admin in this test is on the access list");
        assert_eq!(row["private"], true);
        assert!(row["old_phrase_copies"].is_null());
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

    /// Give `user_id` a recovery phrase's public keys, as setting one would.
    fn give_phrase(state: &AppState, user_id: &str) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: user_id.to_string(),
                seal_public: vec![1; 32],
                auth_public: vec![2; 32],
                self_sealed: vec![3; 48],
                phrase_set_at: 1,
                last_checked_at: 0,
                phrase_words: 0,
            },
        )
        .unwrap();
    }

    /// A connected drive "d1" with a folder "Docs", so a backup of it can be created.
    fn seed_drive(f: &Fixture) {
        let root = f._dir.path().join("drive-d1");
        std::fs::create_dir_all(&root).unwrap();
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(
                &root,
                &luna_core::marker::Marker::new("d1".to_string(), "Photos"),
                &prefix,
            )
            .unwrap(),
        );
        std::fs::create_dir_all(root.join("Docs")).unwrap();
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::upsert_drive(
            &conn,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "d1",
            root.to_str().unwrap(),
        )
        .unwrap();
    }

    /// Let the Member read the "Docs" folder, so they may back it up.
    fn grant_member_docs(f: &Fixture) {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "grant-docs".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: "Docs".into(),
                album_id: String::new(),
                user_id: f.member_id.clone(),
                caps: crate::access::CAP_VIEW,
                created_by: f.admin_id.clone(),
            },
        )
        .unwrap();
    }

    /// Rows in the protections table, of any kind.
    fn protection_count(state: &AppState) -> i64 {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("SELECT COUNT(*) FROM protections", [], |r| r.get(0))
            .unwrap()
    }

    fn whole_drive_body() -> Option<&'static str> {
        Some(r#"{"source_drive_id":"d1","source_path":""}"#)
    }

    #[tokio::test]
    async fn admin_without_a_phrase_is_refused_before_anything_is_written() {
        let f = fixture();
        seed_drive(&f);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.admin_token,
            whole_drive_body(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "needs_phrase");
        assert_eq!(
            body["error"],
            "You need a recovery phrase first. Reload this page to set one up."
        );
        assert_eq!(protection_count(&f.state), 0, "no backup row was written");
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            crate::backup::cloud::identity::load(&conn)
                .unwrap()
                .is_none(),
            "no cloud identity was minted"
        );
    }

    #[tokio::test]
    async fn admin_with_a_phrase_creates_the_backup() {
        let f = fixture();
        seed_drive(&f);
        give_phrase(&f.state, &f.admin_id);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.admin_token,
            whole_drive_body(),
        )
        .await;
        assert_eq!(status, 200, "create refused: {body}");
        assert!(body["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(protection_count(&f.state), 1);
    }

    #[tokio::test]
    async fn member_without_a_phrase_is_refused_for_a_shared_folder() {
        let f = fixture();
        seed_drive(&f);
        grant_member_docs(&f);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.member_token,
            Some(r#"{"source_drive_id":"d1","source_path":"Docs"}"#),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "needs_phrase");
        assert_eq!(protection_count(&f.state), 0);
    }

    #[tokio::test]
    async fn a_phrase_belonging_to_someone_else_does_not_count() {
        let f = fixture();
        seed_drive(&f);
        // The Member has a phrase; the Admin asking does not.
        give_phrase(&f.state, &f.member_id);
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.admin_token,
            whole_drive_body(),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(body["code"], "needs_phrase");
        assert_eq!(protection_count(&f.state), 0);
    }

    #[tokio::test]
    async fn no_phrase_and_no_access_still_answers_forbidden_first() {
        let f = fixture();
        seed_drive(&f);
        // The Member has neither a phrase nor access to Docs: the no-access answer comes first,
        // so they never learn a backup of it is possible.
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.member_token,
            Some(r#"{"source_drive_id":"d1","source_path":"Docs"}"#),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "You need Read access to this folder to back it up."
        );
        assert_eq!(protection_count(&f.state), 0);
    }

    #[tokio::test]
    async fn member_with_a_phrase_creates_a_shared_backup_held_while_no_admin_has_one() {
        let f = fixture();
        seed_drive(&f);
        grant_member_docs(&f);
        give_phrase(&f.state, &f.member_id);
        // No Admin has a phrase, so the backup waits with today's hold copy rather than being refused.
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/backups",
            &f.member_token,
            Some(r#"{"source_drive_id":"d1","source_path":"Docs"}"#),
        )
        .await;
        assert_eq!(status, 200, "create refused: {body}");
        assert!(body["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(protection_count(&f.state), 1);
    }
}
