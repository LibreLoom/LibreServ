use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::auth::user_json;
use crate::api::response::json_error;
use crate::auth::AuthError;

#[derive(Deserialize)]
struct CreateUser {
    username: String,
    display_name: Option<String>,
    password: String,
    role: Option<String>,
}

#[derive(Deserialize)]
struct UpdateUser {
    display_name: Option<String>,
    /// Renaming the login handle renames the member's home folder on disk —
    /// the directory name IS the username.
    username: Option<String>,
    role: Option<String>,
    /// Admin-set new password. The target's current password is not needed
    /// — the admin's own authority is the check.
    password: Option<String>,
}

#[derive(Deserialize)]
struct MemberHomeBody {
    drive_id: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/users", get(list).post(create))
        .route("/api/v1/users/directory", get(directory))
        .route(
            "/api/v1/users/member-home",
            get(member_home).put(set_member_home),
        )
        .route("/api/v1/users/{id}", delete(remove).patch(update))
}

fn require_admin(user: &crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    Ok(())
}

fn lock_db(
    state: &AppState,
) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, (StatusCode, Json<Value>)> {
    state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })
}

/// Household people picker for Members (album invites, etc.).
/// Returns only non-sensitive identity fields — not an Admin user-management API.
async fn directory(
    State(state): State<AppState>,
    Extension(_user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let users = state.auth.list_users().map_err(map_err)?;
    Ok(Json(
        users
            .iter()
            .map(|u| {
                json!({
                    "id": u.id,
                    "username": u.username,
                    "display_name": u.display_name,
                    // Admins already hold everything — a share row against
                    // them is meaningless, so pickers hide or disable them.
                    "shareable": u.role != "admin",
                })
            })
            .collect(),
    ))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let users = state.auth.list_users().map_err(map_err)?;
    Ok(Json(users.iter().map(user_json).collect()))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let role = body.role.as_deref().unwrap_or("user");
    let user = state
        .auth
        .register(
            &body.username,
            body.display_name.as_deref().unwrap_or(&body.username),
            &body.password,
            role,
        )
        .map_err(map_err)?;
    // Members get a private home folder right away — best-effort: if every
    // drive is unplugged it materializes on their first visit instead.
    if let Ok(conn) = state.db.lock()
        && let Ok(Some(row)) = crate::db::get_user(&conn, &user.id)
    {
        let _ = crate::member_home::ensure(&conn, &row);
    }
    Ok(Json(user_json(&user)))
}

async fn update(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<UpdateUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    let target = crate::db::get_user(&conn, &id)
        .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that person."))?;

    if let Some(raw_username) = body.username.as_deref() {
        let new_username = crate::auth::normalize_username(raw_username).map_err(map_err)?;
        if new_username != target.username {
            if crate::db::get_user_by_username(&conn, &new_username)
                .ok()
                .flatten()
                .is_some()
            {
                return Err(json_error(
                    StatusCode::CONFLICT,
                    "That username is already taken.",
                ));
            }
            // The home dir name is the username — move the folder with the
            // account, then retarget share rows rooted inside it. fs rename
            // first: if it fails the user row stays untouched.
            //
            // An unmounted home drive (rel comes back empty) can't rename
            // the folder now — the rename queues as a pending op that runs
            // inside the mount reconcile, before anything can resolve the
            // old folder, so a future same-name member never inherits it.
            match crate::member_home::resolve(&conn, &target) {
                Ok(Some(home)) if home.rel.is_empty() => {
                    let _ = crate::db::queue_pending_home_op(
                        &conn,
                        "rename",
                        &home.drive_id,
                        &target.username,
                        &new_username,
                        "",
                        &target.id,
                    );
                }
                Err(_) => {
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna couldn't check this person's files. Try again.",
                    ));
                }
                _ => {}
            }
            let mut renamed = false;
            if let Ok(Some(home)) = crate::member_home::resolve(&conn, &target)
                && home.ready
            {
                let drive = crate::db::get_drive(&conn, &home.drive_id)
                    .ok()
                    .flatten()
                    .ok_or_else(|| {
                        json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive.")
                    })?;
                if let Some(new_rel) =
                    crate::member_home::home_rel(&conn, &home.drive_id, &new_username)
                {
                    let root = std::path::Path::new(&drive.mount_point);
                    let from = root.join(&home.rel);
                    let to = root.join(&new_rel);
                    if to.exists() {
                        return Err(json_error(
                            StatusCode::CONFLICT,
                            "A folder already sits where that home would go.",
                        ));
                    }
                    std::fs::rename(&from, &to).map_err(|_| {
                        json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Luna couldn't rename the home folder. Try again.",
                        )
                    })?;
                    if let Err(e) = crate::db::set_user_username(&conn, &id, &new_username) {
                        // Put the folder back so the member's home isn't
                        // orphaned under a name nobody owns.
                        let _ = std::fs::rename(&to, &from);
                        return Err(map_err(AuthError::Db(e)));
                    }
                    let _ =
                        crate::access::repath_subjects(&conn, &home.drive_id, &home.rel, &new_rel);
                    renamed = true;
                }
            }
            if !renamed {
                crate::db::set_user_username(&conn, &id, &new_username)
                    .map_err(|e| map_err(AuthError::Db(e)))?;
            }
        }
    }

    // After the username block: a rename conflict must not leave a
    // display-name-only partial update behind.
    if let Some(name) = body.display_name.as_deref() {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Names are 1-80 characters.",
            ));
        }
        crate::db::set_user_display_name(&conn, &id, name)
            .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?;
    }

    if let Some(role) = body.role.as_deref() {
        let role = role.trim().to_ascii_lowercase();
        if role != "admin" && role != "user" {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Roles are admin or member.",
            ));
        }
        if role != target.role {
            if admin.id == id && role != "admin" {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    "You can't take away your own admin rights.",
                ));
            }
            if target.role == "admin" && role != "admin" {
                let admins = crate::db::list_admins(&conn)
                    .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?;
                if admins.len() <= 1 {
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "Luna needs at least one Admin. Make someone else an Admin first.",
                    ));
                }
            }
            crate::db::set_user_role(&conn, &id, &role)
                .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?;
        }
    }

    if let Some(password) = body.password.as_deref() {
        if let Err(e) = crate::password::validate_password(password) {
            return Err(json_error(StatusCode::BAD_REQUEST, e.message()));
        }
        if let Err(e) = crate::hibp::ensure_password_not_breached(password) {
            return Err(json_error(StatusCode::BAD_REQUEST, e.message()));
        }
        let hash = crate::auth::hash_password(password)
            .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("hash"))))?;
        crate::db::set_user_password_hash(&conn, &id, &hash)
            .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?;
        // A reset password means every stolen session and device token for
        // this person must die — same treatment as a forgotten-password reset.
        let _ = crate::db::bump_user_token_version(&conn, &id);
        let _ = crate::db::revoke_device_tokens_for_user(&conn, &id);
    }

    let updated = crate::db::get_user(&conn, &id)
        .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that person."))?;
    Ok(Json(user_json(&updated)))
}

async fn remove(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    if admin.id == id {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "You can't remove your own account.",
        ));
    }
    // Capture the home location before the user row is gone — a deleted
    // member's home moves to that drive's trash (recoverable, still hidden
    // from admins and every other member).
    let (home_drive, home_rel) = {
        let conn = lock_db(&state)?;
        match crate::db::get_user(&conn, &id).ok().flatten() {
            Some(row) => match crate::member_home::resolve(&conn, &row).ok().flatten() {
                Some(home) => {
                    if home.rel.is_empty() {
                        // The home drive is unplugged: deleting the account
                        // is safe once the folder's trash-out is queued. It
                        // runs inside the mount reconcile — before anything
                        // can resolve the folder — so a future same-name
                        // member can't inherit it. Queued renames/moves for
                        // this home are moot now; the trash supersedes them.
                        let _ = crate::db::cancel_pending_home_ops_for_delete(
                            &conn,
                            &home.drive_id,
                            &row.username,
                            &row.id,
                        );
                        let _ = crate::db::queue_pending_home_op(
                            &conn,
                            "trash",
                            &home.drive_id,
                            &row.username,
                            "",
                            "",
                            &row.id,
                        );
                        (None, None)
                    } else {
                        (Some(home.drive_id), Some(home.rel))
                    }
                }
                None => (None, None),
            },
            None => {
                return Err(json_error(
                    StatusCode::NOT_FOUND,
                    "Luna doesn't know that person.",
                ));
            }
        }
    };
    // Park the home BEFORE the account row goes: trashing first means a
    // failure aborts the delete with the user intact — deleting first and
    // failing to trash would strand the home, where a future member made
    // with the same username would inherit everything in it. The folder
    // stays private in trash either way: its origin is a member-home
    // path only the owner could ever read, and once the account is gone
    // nobody can — nothing to purge, nothing an admin can see.
    if let (Some(drive_id), Some(rel)) = (home_drive, home_rel) {
        let conn = lock_db(&state)?;
        if let Err(e) = crate::files::delete_to_trash(&conn, &drive_id, &rel) {
            // "not found" just means the home never materialized on disk —
            // nothing to park, the delete is safe. Anything else means we
            // couldn't take the files with them; stop before it's too late.
            if !matches!(
                &e,
                crate::files::FilesError::Path(luna_core::path::PathError::NotFound(_))
            ) {
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't move this person's files to the trash. Try again.",
                ));
            }
        }
    }
    state.auth.delete_user(&id).map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

/// Which drive member home folders live on.
async fn member_home(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let conn = lock_db(&state)?;
    let effective = crate::db::member_home_drive(&conn).map_err(|_| busy())?;
    let configured = crate::db::member_home_drive_configured(&conn).map_err(|_| busy())?;
    let drive = effective
        .as_deref()
        .and_then(|id| crate::db::get_drive(&conn, id).ok().flatten());
    Ok(Json(json!({
        "drive_id": effective,
        "label": drive.as_ref().map(|d| d.label.clone()),
        "mounted": drive.as_ref().is_some_and(|d| !d.mount_point.is_empty()),
        // Automatic = the first-adopted-drive default, not an admin choice.
        "configured": configured.is_some(),
    })))
}

/// Switch the member-home drive. Existing homes move over one at a time as
/// real move jobs — the admin watches progress on the jobs page. Members
/// whose home never materialized just re-pin; nothing is copied twice.
async fn set_member_home(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Json(body): Json<MemberHomeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let new_id = body.drive_id.trim().to_string();
    // (user_id, username, old drive, old home rel)
    let mut movers: Vec<(String, String, String, String)> = Vec::new();
    let mut repinned = 0u64;
    // Members whose home drive is unplugged — their move is queued and
    // lands when the drive comes back; reported so the admin knows it's
    // pending, not done.
    let mut unplugged: Vec<String> = Vec::new();
    let dest_members = {
        let conn = lock_db(&state)?;
        let drive = crate::db::get_drive(&conn, &new_id)
            .map_err(|_| busy())?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
        if drive.state != "as_is" {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That drive isn't ready — only a ready drive can hold member files.",
            ));
        }
        if drive.mount_point.is_empty() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Plug that drive in first — member files have to move onto it.",
            ));
        }
        // No early-out when the drive already matches: an interrupted
        // earlier switch may have left some homes behind — the walk below
        // finishes them.
        let mount = std::path::PathBuf::from(&drive.mount_point);
        let members = crate::db::list_users(&conn)
            .map_err(|_| busy())?
            .into_iter()
            .filter(|u| u.role != "admin")
            .collect::<Vec<_>>();
        for member in &members {
            let Some(home) = crate::member_home::resolve(&conn, member).ok().flatten() else {
                // No current drive can hold this member's home — it will
                // pin to the new drive on first use anyway.
                let _ = crate::db::set_user_home_drive(&conn, &member.id, &new_id);
                repinned += 1;
                continue;
            };
            if home.drive_id == new_id {
                continue;
            }
            if home.rel.is_empty() {
                // The drive holding this member's home is unplugged — we
                // can't tell whether the folder exists, so pinning them to
                // the new drive now would split their files across drives.
                // Keep them pinned to the old drive and queue the move: it
                // runs inside the mount reconcile, before anything can
                // resolve the folder, once that drive comes back.
                let _ = crate::db::set_user_home_drive(&conn, &member.id, &home.drive_id);
                let _ = crate::db::queue_pending_home_op(
                    &conn,
                    "move",
                    &home.drive_id,
                    &member.username,
                    "",
                    &new_id,
                    &member.id,
                );
                unplugged.push(member.id.clone());
            } else if home.ready {
                // A stale home at the same username on the destination
                // would make the move job collide — park it in that
                // drive's trash first.
                if let Some(dest_rel) =
                    crate::member_home::home_rel(&conn, &new_id, &member.username)
                    && mount.join(&dest_rel).exists()
                {
                    let _ = crate::files::delete_to_trash(&conn, &new_id, &dest_rel);
                }
                movers.push((
                    member.id.clone(),
                    member.username.clone(),
                    home.drive_id.clone(),
                    home.rel.clone(),
                ));
            } else {
                // Nothing on disk to move — just repoint them.
                let _ = crate::db::set_user_home_drive(&conn, &member.id, &new_id);
                repinned += 1;
            }
        }
        crate::db::set_member_home_drive(&conn, &new_id).map_err(|_| busy())?;
        crate::drives::drive_db::prefix_for(&mount)
            .map(|p| crate::member_home::members_dir_name(&p))
    };

    // Jobs run after the lock is released — enqueue takes the same mutex.
    // The destination is the new drive's members container; the move lands
    // the home under `<members>/<username>`.
    let mut job_ids: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for (uid, _username, from_drive, rel) in &movers {
        let Some(dest_members) = dest_members.as_deref() else {
            failed.push(uid.clone());
            continue;
        };
        match state
            .job_manager
            .enqueue("move", from_drive, rel, &new_id, dest_members, &admin.id)
            .await
        {
            Ok(job) => job_ids.push(job.id),
            Err(_) => failed.push(uid.clone()),
        }
    }
    Ok(Json(json!({
        "ok": failed.is_empty(),
        "jobs": job_ids,
        "failed": failed,
        "unplugged": unplugged,
        "repinned": repinned,
        "message": if !unplugged.is_empty() {
            format!(
                "{} member{} will move when their drive is connected.",
                unplugged.len(),
                if unplugged.len() == 1 { " " } else { "s" },
            )
        } else if job_ids.is_empty() {
            "Member files now live on the new drive.".to_string()
        } else {
            format!("Luna is moving {} member folder{} in the background.", job_ids.len(), if job_ids.len() == 1 { "" } else { "s" })
        },
    })))
}

fn busy() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna's index is busy. Try again.",
    )
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "Only an Admin can manage users.")
        }
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        AuthError::PasswordPolicy(msg) => json_error(StatusCode::BAD_REQUEST, &msg),
        AuthError::Taken => json_error(StatusCode::CONFLICT, "That username is already taken."),
        AuthError::BadUsername => json_error(
            StatusCode::BAD_REQUEST,
            "Usernames are 3-32 letters, numbers, dots, dashes, or underscores.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update users. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};
    use tower::ServiceExt;

    fn app_with_admin_and_member() -> (tempfile::TempDir, AppState, String, String) {
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
        let admin_token = auth.issue(&admin).unwrap();
        let member_token = auth.issue(&member).unwrap();
        (dir, state, admin_token, member_token)
    }

    #[tokio::test]
    async fn directory_is_available_to_members() {
        let (_dir, state, _admin_token, member_token) = app_with_admin_and_member();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/users/directory")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.as_array().unwrap().len() >= 2);
        assert!(v[0].get("password_hash").is_none());
        assert!(v[0].get("role").is_none());
        assert!(v[0].get("id").is_some());
        assert!(v[0].get("username").is_some());
    }

    #[tokio::test]
    async fn list_users_rejects_members() {
        let (_dir, state, _admin_token, member_token) = app_with_admin_and_member();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/users")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
