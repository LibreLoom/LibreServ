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
use crate::private::{self, OwnerState};

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
        .route("/api/v1/backups/covered", get(covered))
        .route("/api/v1/backups/{id}", delete(remove))
        .route("/api/v1/backups/{id}/run", post(run))
        .route("/api/v1/backups/{id}/resume", post(resume))
}

/// Which backups of a larger folder already hold this one, per kind and place they go to.
/// A drive backup covers it only for the same backup drive; the cloud covers it for the cloud.
async fn covered(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<ListQuery>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let drive = query.drive.unwrap_or_default();
    let path = crate::access::normalize_subject_path(query.path.as_deref().unwrap_or(""));
    if !crate::auth::has_cap(&user, &conn, &drive, &path, crate::access::CAP_VIEW) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find this folder.",
        ));
    }
    let owner = crate::backup::access_list::private_source(&conn, &drive, &path)
        .owner()
        .unwrap_or_default()
        .to_string();
    let rows = db::list_protections(&conn).map_err(|_| read_failed())?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows
        .iter()
        .filter(|r| r.source_drive == drive && r.private_owner == owner)
    {
        if !seen.insert((row.kind.clone(), row.target_drive.clone())) {
            continue;
        }
        let probe = ProtectionRow::probe(&row.kind, &drive, &path, &row.target_drive, &owner);
        if let Some((parent, _)) = drive_backup::covered_by(&conn, &probe) {
            let label = drive_label(&conn, &drive);
            out.push(json!({
                "kind": row.kind,
                "target_drive": row.target_drive,
                "path": parent.source_path,
                "name": parent.source_path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&label),
            }));
        }
    }
    Ok(Json(Value::Array(out)))
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
        .map(|row| backup_json(&state.db, &conn, row, &user, now))
        .collect();
    Ok(Json(Value::Array(backups)))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CreateBody>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let norm = crate::access::normalize_subject_path(&body.source_path);
    // Check the source access first, so someone who cannot see the folder gets
    // the normal no-access answer and never learns a backup of it exists.
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
    // The engine hands back an existing backup of this folder to this drive as
    // it is, so only people on its access list may get its details.
    if let Some(existing) = db::find_protection(
        &conn,
        db::PROTECTION_DRIVE,
        &body.source_drive_id,
        &norm,
        &body.target_drive_id,
    )
    .map_err(|_| read_failed())?
        && !drive_backup::visible_to(&existing, &user)
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Someone already backs this folder up to that drive.",
        ));
    }
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
    let row = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let row = find_backup(&conn, &id)?;
        if !can_delete(&conn, &row, &user) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only an Admin or the person who made this backup can delete it.",
            ));
        }
        row
    };
    // A cloud backup lives in Luna Connect: its records, key copies and packs have to go
    // too, or the person would be told it is deleted while the ciphertext stays behind.
    // The cloud route does that work; this one must not drop the row by itself.
    if row.kind == db::PROTECTION_CLOUD {
        return crate::api::cloud_backups::delete_cloud(&state, &id).await;
    }
    if drive_backup::is_running(&state.db, &id) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "This backup is busy right now. Try again in a minute.",
        ));
    }
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    drive_backup::delete(&state.db, &conn, &row).map_err(|_| {
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
    let allow_mass_delete = wants_mass_delete && {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        can_delete(&conn, &row, &user)
    };

    // A run or a restore already holds the backup. Say so instead of starting
    // another run.
    if drive_backup::is_running(&state.db, &id) {
        return Ok(Json(json!({
            "done": false,
            "problem": "This backup is busy right now. Try again in a minute.",
        })));
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
    // Done only when the copy finished without a problem; a problem is said in words.
    let answer = match tokio::time::timeout(RUN_WAIT, job).await {
        Ok(Ok(Ok(outcome))) => match outcome.problem {
            None => json!({ "done": true }),
            Some(problem) => json!({
                "done": false,
                "source_missing": problem.starts_with("Most of the files in "),
                "problem": problem,
            }),
        },
        Ok(Ok(Err(_))) => {
            json!({ "done": false, "problem": "Luna could not finish this backup. Try again." })
        }
        _ => json!({ "done": false }),
    };
    Ok(Json(answer))
}

/// Lets a backup rebuilt from a drive run again (see `db::PROTECTION_PAUSED`).
/// The drive named who may see it and whose it is; resuming says a person
/// who may manage it here has looked. Same people as delete: for a private
/// item only its owner (or an Admin once the owner's account is gone).
async fn resume(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let row = find_backup(&conn, &id)?;
    if !can_resume(&conn, &row, &user) {
        // Someone who can't see the backup isn't told it exists.
        if !drive_backup::visible_to(&row, &user) {
            return Err(not_found());
        }
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin or the person this backup belongs to can resume it.",
        ));
    }
    // An Admin can't resume a private backup nobody owns: it would stop at once
    // as belonging to someone else. Giving the item away comes first.
    if !row.private_owner.is_empty()
        && private::owner_state(&conn, &row.private_owner) != OwnerState::Active
    {
        return Err(json_error(
            StatusCode::CONFLICT,
            "This private item has no owner here yet. Give it to someone in Settings → Users, then resume its backup.",
        ));
    }
    let row = drive_backup::resume(&conn, &id, &user.id)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't resume this backup. Try again.",
            )
        })?
        .ok_or_else(not_found)?;
    Ok(Json(backup_json(
        &state.db,
        &conn,
        &row,
        &user,
        db::now_unix(),
    )))
}

/// Who may resume a paused backup: whoever may delete it.
fn can_resume(conn: &Connection, row: &ProtectionRow, user: &CurrentUser) -> bool {
    can_delete(conn, row, user)
}

/// The backup if it exists, else a plain 404.
fn find_backup(conn: &Connection, id: &str) -> Result<ProtectionRow, ApiError> {
    db::get_protection(conn, id)
        .map_err(|_| read_failed())?
        .ok_or_else(not_found)
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
    user.role == "admin" || (row.created_by == user.id && drive_backup::visible_to(row, user))
}

fn backup_json(
    db: &crate::Db,
    conn: &Connection,
    row: &ProtectionRow,
    user: &CurrentUser,
    now: i64,
) -> Value {
    let source_label = drive_label(conn, &row.source_drive);
    let target_label = drive_label(conn, &row.target_drive);
    let covered_by = drive_backup::covered_by(conn, row)
        .map(|(parent, _)| json!({ "path": parent.source_path, "name": folder_name(&parent.source_path, &source_label) }));
    // A backup whose source or backup drive is locked is paused until it is
    // unlocked; the dashboard's "drives are locked, so backups are paused"
    // notice counts these.
    let locked_drives: Vec<_> = [&row.source_drive, &row.target_drive]
        .into_iter()
        .filter(|id| {
            db::get_drive(conn, id)
                .ok()
                .flatten()
                .is_some_and(|d| d.locked)
        })
        .collect();
    // When both are locked, a run encounters the target first.
    let locked_error = locked_drives
        .last()
        .map(|id| drive_backup::waiting_for(conn, id));
    let (waiting_reason, waiting_since) =
        crate::backup::status::waiting(row, locked_error.as_deref());
    json!({
        "paused": if locked_drives.is_empty() { Value::Null } else { json!("locked") },
        "locked_drive_names": locked_drives.iter().map(|id| drive_label(conn, id)).collect::<Vec<_>>(),
        "waiting_reason": waiting_reason,
        "waiting_since": waiting_since,
        "covered_by": covered_by,
        "id": row.id,
        "kind": row.kind,
        "source_drive": row.source_drive,
        "source_drive_name": source_label,
        "source_path": row.source_path,
        "source_name": folder_name(&row.source_path, &source_label),
        "target_drive": row.target_drive,
        "target_drive_name": target_label,
        "state": if waiting_reason.is_some() { json!("waiting") } else { json!(drive_backup::state(row, now)) },
        "status": row.state,
        "stop_reason": row.stop_reason,
        "last_ok_at": row.last_ok_at,
        "last_error": row.last_error,
        "hard": row.hard,
        "source_missing": row.hard && row.last_error.starts_with("Most of the files in "),
        "first_done": row.first_done,
        "created_by": row.created_by,
        "can_delete": can_delete(conn, row, user),
        "can_resume": row.state == db::PROTECTION_PAUSED
            && can_resume(conn, row, user)
            && (row.private_owner.is_empty()
                || private::owner_state(conn, &row.private_owner) == OwnerState::Active),
        "private": !row.private_owner.is_empty(),
        "running": drive_backup::is_running(db, &row.id),
        "notes": row.notes.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(),
    })
}

/// A refusal about who may do something is 403; anything else is 400.
/// "Included in the backup of …" is not a who-may refusal, so it stays 400.
fn refusal_status(msg: &str) -> StatusCode {
    let who_may = msg.starts_with("You need")
        || msg.starts_with("Only an Admin")
        || (msg.starts_with("Only ") && msg.ends_with("can back up this item."));
    if who_may {
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

    use crate::backup::drive_backup;
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
        admin_token: String,
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

    /// Insert a backup row straight into the table, with the given access list.
    fn seed(state: &AppState, id: &str, source_path: &str, access_json: &str, created_by: &str) {
        seed_owned(state, id, source_path, access_json, created_by, "");
    }

    /// Like `seed`, for a backup of a private item owned by `private_owner`.
    fn seed_owned(
        state: &AppState,
        id: &str,
        source_path: &str,
        access_json: &str,
        created_by: &str,
        private_owner: &str,
    ) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id,
                kind: db::PROTECTION_DRIVE,
                source_drive: "d1",
                source_path,
                target_drive: "d2",
                private_owner,
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

    /// Insert a cloud backup row. Its copies live in Luna Connect, not on a drive.
    fn seed_cloud(state: &AppState, id: &str, access_json: &str, created_by: &str) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id,
                kind: db::PROTECTION_CLOUD,
                source_drive: "",
                source_path: "",
                target_drive: "",
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

    #[tokio::test]
    async fn a_cloud_backup_deleted_through_this_route_is_not_dropped_without_the_cloud() {
        let f = fixture();
        seed_cloud(
            &f.state,
            "cloud-one",
            r#"{"users":[],"admins":true}"#,
            &f.admin_id,
        );

        let (status, json) = send(
            &f.router,
            "DELETE",
            "/api/v1/backups/cloud-one",
            &f.admin_token,
            None,
        )
        .await;

        // Luna Connect is not set up here, so the copies cannot be removed. The person is
        // told so, and the row stays: saying "deleted" while the copies remain is not allowed.
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert!(
            json["error"].as_str().unwrap().contains("Luna Connect"),
            "{json}"
        );
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(db::get_protection(&conn, "cloud-one").unwrap().is_some());
        assert!(
            db::get_meta(&conn, "deleted_backup:cloud-one")
                .unwrap()
                .is_none()
        );
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
    async fn private_row_is_hidden_from_admin_and_marked_private_for_owner() {
        let f = fixture();
        let owner_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed_owned(
            &f.state,
            "mine-private",
            "notes",
            &owner_only,
            &f.member_id,
            &f.member_id,
        );

        let (status, body) = send(&f.router, "GET", "/api/v1/backups", &f.member_token, None).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let member_rows = body.as_array().unwrap();
        let row = member_rows
            .iter()
            .find(|b| b["id"] == "mine-private")
            .expect("the owner sees their private backup");
        assert_eq!(row["private"], true);
        assert_eq!(row["can_delete"], true);

        let (status, body) = send(&f.router, "GET", "/api/v1/backups", &f.admin_token, None).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert!(
            !ids(&body).contains(&"mine-private".to_string()),
            "an Admin who is not on the list must not see a private backup"
        );
    }

    #[tokio::test]
    async fn a_private_folder_is_not_covered_by_the_private_items_backup() {
        let f = fixture();
        let owner_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        // The private item and a folder inside it, both the member's.
        seed_owned(
            &f.state,
            "diary",
            "diary",
            &owner_only,
            &f.member_id,
            &f.member_id,
        );
        seed_owned(
            &f.state,
            "diary-2025",
            "diary/2025",
            &owner_only,
            &f.member_id,
            &f.member_id,
        );
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::record_protection_ok(&conn, "diary", 5, &owner_only).unwrap();
        }

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/backups?drive=d1&path=diary/2025",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let row = body
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == "diary-2025")
            .expect("the owner sees the folder's backup");
        assert_eq!(
            row["covered_by"],
            Value::Null,
            "a private folder is its own backup"
        );
    }

    #[tokio::test]
    async fn a_shared_folder_is_still_covered_by_its_shared_parents_backup() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed(&f.state, "docs", "docs", &member_only, &f.member_id);
        seed(&f.state, "docs-sub", "docs/sub", &member_only, &f.member_id);
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::record_protection_ok(&conn, "docs", 5, &member_only).unwrap();
        }

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/backups?drive=d1&path=docs/sub",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let row = body
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == "docs-sub")
            .expect("the member sees the folder's backup");
        assert_eq!(row["covered_by"]["path"], "docs");
    }

    #[tokio::test]
    async fn admin_can_delete_a_deleted_owners_private_backup_but_not_a_live_owners() {
        let f = fixture();
        let owner_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed_owned(
            &f.state,
            "live-owner",
            "live",
            &owner_only,
            &f.member_id,
            &f.member_id,
        );
        seed_owned(
            &f.state,
            "gone-owner",
            "gone",
            &owner_only,
            "gone-user",
            "gone-user",
        );
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute("INSERT INTO deleted_users (id) VALUES ('gone-user')", [])
                .unwrap();
        }

        let (status, _) = send(
            &f.router,
            "DELETE",
            "/api/v1/backups/live-owner",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

        let (status, _) = send(
            &f.router,
            "DELETE",
            "/api/v1/backups/gone-owner",
            &f.admin_token,
            None,
        )
        .await;
        assert_ne!(status, axum::http::StatusCode::FORBIDDEN);
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(db::get_protection(&conn, "gone-owner").unwrap().is_none());
        assert!(db::get_protection(&conn, "live-owner").unwrap().is_some());
    }

    fn pause(state: &AppState, id: &str) {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::set_protection_state(
            &conn,
            id,
            db::PROTECTION_PAUSED,
            drive_backup::PAUSED_REASON,
        )
        .unwrap();
    }

    fn state_of(state: &AppState, id: &str) -> String {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::get_protection(&conn, id).unwrap().unwrap().state
    }

    #[tokio::test]
    async fn a_member_who_does_not_own_a_paused_backup_cannot_resume_it() {
        let f = fixture();
        // Both can see it; the Admin made it.
        let everyone = format!(r#"{{"users":["{}"],"admins":true}}"#, f.member_id);
        seed(&f.state, "b1", "Docs", &everyone, &f.admin_id);
        pause(&f.state, "b1");

        let (_, list) = send(&f.router, "GET", "/api/v1/backups", &f.member_token, None).await;
        assert_eq!(list[0]["status"], "paused");
        assert_eq!(list[0]["can_resume"], false);
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/backups/b1/resume",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert_eq!(state_of(&f.state, "b1"), db::PROTECTION_PAUSED);

        // A stranger isn't told it exists.
        seed(
            &f.state,
            "b2",
            "Hidden",
            r#"{"users":[],"admins":true}"#,
            &f.admin_id,
        );
        pause(&f.state, "b2");
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/backups/b2/resume",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_admin_can_resume_a_shared_paused_backup() {
        let f = fixture();
        let everyone = format!(r#"{{"users":["{}"],"admins":true}}"#, f.member_id);
        seed(&f.state, "b1", "Docs", &everyone, &f.member_id);
        pause(&f.state, "b1");
        let (_, list) = send(&f.router, "GET", "/api/v1/backups", &f.admin_token, None).await;
        assert_eq!(list[0]["can_resume"], true);
        assert_eq!(list[0]["stop_reason"], drive_backup::PAUSED_REASON);

        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/backups/b1/resume",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["status"], "active");
        assert_eq!(body["can_resume"], false);
        assert_eq!(state_of(&f.state, "b1"), db::PROTECTION_ACTIVE);
    }

    #[tokio::test]
    async fn the_owner_resumes_a_private_paused_backup_and_a_live_owners_admin_cannot() {
        let f = fixture();
        let owner_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed_owned(
            &f.state,
            "mine",
            "vault",
            &owner_only,
            &f.member_id,
            &f.member_id,
        );
        pause(&f.state, "mine");

        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/backups/mine/resume",
            &f.admin_token,
            None,
        )
        .await;
        assert_ne!(status, axum::http::StatusCode::OK);
        assert_eq!(state_of(&f.state, "mine"), db::PROTECTION_PAUSED);

        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/backups/mine/resume",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(state_of(&f.state, "mine"), db::PROTECTION_ACTIVE);
    }

    #[tokio::test]
    async fn a_member_resumes_a_shared_backup_they_made() {
        let f = fixture();
        let both = format!(r#"{{"users":["{}"],"admins":true}}"#, f.member_id);
        seed(&f.state, "b1", "Docs", &both, &f.member_id);
        pause(&f.state, "b1");
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/backups/b1/resume",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(state_of(&f.state, "b1"), db::PROTECTION_ACTIVE);
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
        // The source drive is not connected here, so the run records a problem
        // on the row: it is not done, and the problem is said in words.
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
        assert_eq!(json["done"], false);
        assert!(json["problem"].as_str().is_some_and(|p| !p.is_empty()));
    }

    #[tokio::test]
    async fn run_says_busy_while_a_run_or_restore_holds_the_backup() {
        let f = fixture();
        let member_only = format!(r#"{{"users":["{}"],"admins":false}}"#, f.member_id);
        seed(&f.state, "busy", "photos", &member_only, &f.member_id);

        // A restore holds the same slot as a run.
        let _held = drive_backup::try_hold(&f.state.db, "busy").expect("slot free");
        let (status, json) = send(
            &f.router,
            "POST",
            "/api/v1/backups/busy/run",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(json["done"], false);
        assert_eq!(
            json["problem"],
            "This backup is busy right now. Try again in a minute."
        );
    }

    #[tokio::test]
    async fn create_does_not_reveal_a_backup_the_user_cannot_see() {
        let f = fixture();
        let nobody = r#"{"users":[],"admins":false}"#;
        seed(&f.state, "private", "photos", nobody, &f.admin_id);

        // The member has no Read on "photos", so the no-access answer comes
        // back, not the "already backed up" one.
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

    #[test]
    fn refusal_status_maps_who_may_refusals_to_403() {
        use axum::http::StatusCode;
        assert_eq!(
            super::refusal_status("You need Read access to this folder to back it up."),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            super::refusal_status("Only an Admin can back up a whole drive."),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            super::refusal_status("Only Ann can back up this item."),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn refusal_status_keeps_other_refusals_at_400() {
        use axum::http::StatusCode;
        assert_eq!(
            super::refusal_status("Included in the backup of \"Docs\"."),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            super::refusal_status("Items in the trash can't be backed up."),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            super::refusal_status("Only one copy can run at a time."),
            StatusCode::BAD_REQUEST
        );
    }
}
