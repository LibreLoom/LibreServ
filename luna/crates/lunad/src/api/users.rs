use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
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
    username: Option<String>,
    role: Option<String>,
    /// Admin-set new password. The target's current password is not needed
    /// — the admin's own authority is the check.
    password: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/users", get(list).post(create))
        .route("/api/v1/users/directory", get(directory))
        .route("/api/v1/users/{id}", delete(remove).patch(update))
        .route("/api/v1/users/{id}/private-count", get(private_count))
        .route("/api/v1/private/ownerless", get(ownerless_count))
        .route("/api/v1/users/{id}/adopt-private", post(adopt_private))
        .route("/api/v1/private/orphans", get(orphans))
        .route("/api/v1/private/orphans/{owner}", delete(purge_orphan))
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
            "Luna couldn't do that. Try again.",
        )
    })
}

/// Household people picker (album invites, shares, etc.).
/// Returns only non-sensitive identity fields — not an Admin user-management API.
async fn directory(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
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
                    // Anyone but yourself can receive a share. Admins already
                    // hold everything, so the sheet uses `admin` to leave
                    // them out.
                    "shareable": u.id != user.id,
                    "admin": u.role == "admin",
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
            crate::db::set_user_username(&conn, &id, &new_username)
                .map_err(|e| map_err(AuthError::Db(e)))?;
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
    state.auth.delete_user(&id).map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

/// How many private items deleting this person would delete.
async fn private_count(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    Ok(Json(
        json!({ "count": crate::private::owned_total(&conn, &id) }),
    ))
}

/// Private items that came with a drive from another Luna and have no owner.
async fn ownerless_count(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    Ok(Json(
        json!({ "count": crate::private::ownerless_total(&conn) }),
    ))
}

/// Give every ownerless private item to this person.
async fn adopt_private(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    if crate::db::get_user(&conn, &id)
        .map_err(|_| map_err(AuthError::Db(anyhow::anyhow!("db"))))?
        .is_none()
    {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know that person.",
        ));
    }
    Ok(Json(
        json!({ "count": crate::private::adopt_ownerless(&conn, &id) }),
    ))
}

/// Private folders a removed person still owns — their files stay on the
/// drives, walled off, until an Admin clears them here. Counts only cover
/// drives that are connected right now.
async fn orphans(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    let report = crate::private::orphaned(&conn);
    Ok(Json(json!({
        "owners": report.owners.iter().map(|o| json!({
            "user_id": o.user_id,
            "username": o.username,
            "display_name": o.display_name,
            "deleted_at": o.deleted_at,
            "total": o.drives.iter().map(|d| d.count).sum::<usize>(),
            "drives": o.drives.iter().map(|d| json!({
                "drive_id": d.drive_id,
                "drive_label": d.drive_label,
                "count": d.count,
                "trash_count": d.trash_count,
                "readonly": d.readonly,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "offline_drives": report.offline_drives,
    })))
}

/// Permanently delete every private folder this removed person still owns,
/// on every writable drive. Private folders inside them that belong to other
/// people are kept. Read-only drives are reported, not cleaned.
async fn purge_orphan(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(owner): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&admin)?;
    let conn = lock_db(&state)?;
    let is_orphan = conn
        .prepare("SELECT 1 FROM deleted_users WHERE id = ?1")
        .and_then(|mut s| s.exists(rusqlite::params![owner]))
        .unwrap_or(false);
    if !is_orphan {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only clear private folders after their owner is removed.",
        ));
    }
    let report = crate::private::purge_orphan(&conn, &owner).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the cleanup. Refresh this page and try again.",
        )
    })?;
    let drives = crate::db::list_drives(&conn).unwrap_or_default();
    drop(conn);
    for drive in drives {
        state.ram_cache.invalidate_listing_tree(&drive.id, "");
        state.gallery.rescan(&drive.id);
    }
    Ok(Json(json!({
        "ok": report.failed_drives.is_empty() && report.skipped_readonly.is_empty() && report.offline_drives.is_empty(),
        "skipped_readonly": report.skipped_readonly,
        "failed_drives": report.failed_drives,
        "offline_drives": report.offline_drives,
    })))
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
