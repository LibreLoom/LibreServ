//! Drive backups: list, start, run, delete (plan §2, §8).

use std::time::Duration;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::drive_backup::{self, Refused};
use crate::db::{self, ProtectionRow};

/// How long Run waits for the copy before answering "not done yet".
const RUN_WAIT: Duration = Duration::from_secs(15);

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

#[derive(Deserialize)]
struct ListQuery {
    drive: Option<String>,
    path: Option<String>,
}

#[derive(Deserialize)]
struct CreateBody {
    source_drive_id: String,
    source_path: String,
    target_drive_id: String,
}

#[derive(Deserialize, Default)]
struct RunBody {
    #[serde(default)]
    allow_mass_delete: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/backups", get(list).post(create))
        .route("/api/v1/backups/{id}", delete(remove))
        .route("/api/v1/backups/{id}/run", post(run))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<ListQuery>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let rows = db::list_protections(&conn).map_err(|_| read_failed())?;
    let want_path = query
        .path
        .as_deref()
        .map(crate::access::normalize_subject_path);
    let now = db::now_unix();
    let backups: Vec<Value> = rows
        .iter()
        .filter(|row| drive_backup::visible_to(row, &user))
        .filter(|row| query.drive.as_deref().is_none_or(|d| row.source_drive == d))
        .filter(|row| {
            want_path
                .as_deref()
                .is_none_or(|p| crate::access::normalize_subject_path(&row.source_path) == p)
        })
        .map(|row| backup_json(&conn, row, &user, now))
        .collect();
    Ok(Json(Value::Array(backups)))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateBody>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let row = drive_backup::create(
        &conn,
        &user,
        &body.source_drive_id,
        &body.source_path,
        &body.target_drive_id,
    )
    .map_err(|Refused(msg)| json_error(refusal_status(&msg), msg))?;
    drop(conn);

    // The first copy runs in the background; the row's state tells the rest.
    let db = state.db.clone();
    let run_id = row.id.clone();
    drop(tokio::task::spawn_blocking(move || {
        let _ = drive_backup::run(&db, &run_id, db::now_unix());
    }));

    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    Ok(Json(backup_json(&conn, &row, &user, db::now_unix())))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let row = find_backup(&conn, &id)?;
    if !can_delete(&row, &user) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin or the person who made this backup can delete it.",
        ));
    }
    drive_backup::delete(&conn, &row).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't delete this backup. Try again.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn run(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
    body: Option<Json<RunBody>>,
) -> ApiResult {
    let wants_mass_delete = body.map(|Json(b)| b.allow_mass_delete).unwrap_or(false);
    let row = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        if !drive_backup::visible_to(&row, &user) {
            return Err(not_found());
        }
        row
    };
    // Only people who may delete the backup may let a run delete a lot.
    let allow_mass_delete = wants_mass_delete && can_delete(&row, &user);

    // A run already in progress records its own result; don't start another.
    if drive_backup::is_running(&id) {
        return Ok(Json(json!({ "done": false })));
    }

    let db = state.db.clone();
    let job = tokio::task::spawn_blocking(move || {
        let now = db::now_unix();
        if allow_mass_delete {
            drive_backup::run_allowing_mass_delete(&db, &id, now)
        } else {
            drive_backup::run(&db, &id, now)
        }
    });
    // A big first copy can take hours. Answer when it's quick; otherwise say
    // it's not done and let the backup's state tell the rest.
    let done = match tokio::time::timeout(RUN_WAIT, job).await {
        Ok(Ok(Ok(_))) => true,
        _ => false,
    };
    Ok(Json(json!({ "done": done })))
}

/// The backup if it exists, else a plain 404.
fn find_backup(conn: &Connection, id: &str) -> Result<ProtectionRow, ApiError> {
    db::get_protection(conn, id)
        .map_err(|_| read_failed())?
        .ok_or_else(not_found)
}

/// Admins may delete any backup; anyone else only a backup they made and can see.
fn can_delete(row: &ProtectionRow, user: &CurrentUser) -> bool {
    user.role == "admin" || (row.created_by == user.id && drive_backup::visible_to(row, user))
}

fn backup_json(conn: &Connection, row: &ProtectionRow, user: &CurrentUser, now: i64) -> Value {
    let source_label = drive_label(conn, &row.source_drive);
    let target_label = drive_label(conn, &row.target_drive);
    json!({
        "id": row.id,
        "kind": row.kind,
        "source_drive": row.source_drive,
        "source_drive_name": source_label,
        "source_path": row.source_path,
        "source_name": folder_name(&row.source_path, &source_label),
        "target_drive": row.target_drive,
        "target_drive_name": target_label,
        "state": drive_backup::state(row, now),
        "status": row.state,
        "stop_reason": row.stop_reason,
        "last_ok_at": row.last_ok_at,
        "last_error": row.last_error,
        "hard": row.hard,
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
        "Luna couldn't load the backups. Try again.",
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

    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
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
            member_token: auth.issue(&member).unwrap(),
            admin_id: admin.id.clone(),
            member_id: member.id.clone(),
            _dir: dir,
            state,
            router,
        }
    }

    /// Insert a backup row straight into the table, with the given access list.
    fn seed(state: &AppState, id: &str, source_path: &str, access_json: &str, created_by: &str) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id,
                kind: db::PROTECTION_DRIVE,
                source_drive: "d1",
                source_path,
                target_drive: "d2",
                private_owner: "",
                created_by,
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
    async fn list_hides_backups_the_user_cannot_see() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        let nobody = r#"{"users":[],"admins":false}"#;
        seed(&f.state, "shown", "photos", &member_only, &f.admin_id);
        seed(&f.state, "hidden", "music", nobody, &f.admin_id);

        let (status, json) = send(&f.router, "GET", "/api/v1/backups", &f.member_token, None).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(ids(&json), vec!["shown"]);
    }

    #[tokio::test]
    async fn list_filters_by_source_drive_and_path() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed(&f.state, "photos", "photos", &member_only, &f.admin_id);
        seed(&f.state, "music", "music", &member_only, &f.admin_id);

        let (_, json) = send(
            &f.router,
            "GET",
            "/api/v1/backups?drive=d1&path=photos",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(ids(&json), vec!["photos"]);

        let (_, json) = send(
            &f.router,
            "GET",
            "/api/v1/backups?drive=other",
            &f.member_token,
            None,
        )
        .await;
        assert!(ids(&json).is_empty());
    }

    #[tokio::test]
    async fn create_is_refused_without_read_on_the_source() {
        let f = fixture();
        let body = r#"{"source_drive_id":"d1","source_path":"photos","target_drive_id":"d2"}"#;
        let (status, json) = send(
            &f.router,
            "POST",
            "/api/v1/backups",
            &f.member_token,
            Some(body),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert!(json["error"].as_str().unwrap().starts_with("You need"));
    }

    #[tokio::test]
    async fn create_refuses_a_whole_drive_for_a_member() {
        let f = fixture();
        let body = r#"{"source_drive_id":"d1","source_path":"","target_drive_id":"d2"}"#;
        let (status, json) = send(
            &f.router,
            "POST",
            "/api/v1/backups",
            &f.member_token,
            Some(body),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "Only an Admin can back up a whole drive.");
    }

    #[tokio::test]
    async fn delete_is_forbidden_for_a_stranger() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed(&f.state, "theirs", "photos", &member_only, &f.admin_id);

        let (status, _) = send(
            &f.router,
            "DELETE",
            "/api/v1/backups/theirs",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(db::get_protection(&conn, "theirs").unwrap().is_some());
        drop(conn);
    }

    #[tokio::test]
    async fn run_answers_done() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        // The source drive is not connected here, so the run records a failure
        // on the row; it still finishes, which is what `done` reports.
        seed(&f.state, "ran", "photos", &member_only, &f.member_id);

        let (status, json) = send(
            &f.router,
            "POST",
            "/api/v1/backups/ran/run",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(json["done"], true);
    }
}
