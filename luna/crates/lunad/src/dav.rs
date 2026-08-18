//! WebDAV for native desktop mounts (Finder, Explorer, davfs2).
//!
//! One endpoint per adopted drive: `/dav/{drive_id}/...`. The handler uses
//! dav-server's LocalFs rooted at the drive's mount point, so a client can
//! never address anything outside that drive.
//!
//! DAV hands out the whole drive with read/write access, so unlike the
//! grant-scoped file API it is limited to authenticated admins. Clients can
//! authenticate with a session cookie, `Authorization: Bearer <token>`, a
//! device token, or HTTP Basic auth — either the user's real username +
//! password (how Finder/Explorer/davfs2 prompt) or a token as the password.

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use base64::Engine;
use dav_server::fakels::FakeLs;
use dav_server::localfs::LocalFs;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/dav/{id}", any(handle_dav))
        .route("/dav/{id}/", any(handle_dav))
        .route("/dav/{id}/{*rest}", any(handle_dav_wild))
}

async fn handle_dav(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> axum::response::Response {
    handle_dav_inner(state, id, req).await
}

async fn handle_dav_wild(
    State(state): State<AppState>,
    Path((id, _rest)): Path<(String, String)>,
    req: Request,
) -> axum::response::Response {
    handle_dav_inner(state, id, req).await
}

async fn handle_dav_inner(state: AppState, id: String, req: Request) -> axum::response::Response {
    if let Err(err) = require_dav_admin(&state, &req) {
        return err.into_response();
    }
    let handler = match dav_handler_for(&state, &id) {
        Ok(handler) => handler,
        Err(err) => return err.into_response(),
    };
    let resp = handler.handle(req).await;
    let (parts, body) = resp.into_parts();
    axum::response::Response::from_parts(parts, axum::body::Body::new(body))
}

fn require_dav_admin(
    state: &AppState,
    req: &Request,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    // 1) A session JWT or device token (cookie, Bearer, or Basic-with-token).
    if let Ok(Some(user)) = state.auth.resolve_from_headers(req.headers()) {
        return require_admin_role(user);
    }
    // 2) The user's real username + password over Basic (what OS WebDAV
    //    clients send when the OS prompts for credentials).
    if let Some((username, password)) = basic_credentials(req.headers()) {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let Ok(Some(user)) = crate::db::get_user_by_username(&conn, &username) else {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "That username or password is wrong.",
            ));
        };
        let parsed =
            argon2::password_hash::PasswordHash::new(&user.password_hash).map_err(|_| {
                json_error(
                    StatusCode::UNAUTHORIZED,
                    "That username or password is wrong.",
                )
            })?;
        if auth::verify_password_hash(&password, &parsed).is_ok() {
            return require_admin_role(CurrentUser {
                id: user.id,
                username: user.username,
                role: user.role,
            });
        }
    }
    Err(json_error(
        StatusCode::UNAUTHORIZED,
        "Sign in to Luna first.",
    ))
}

fn require_admin_role(
    user: CurrentUser,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can mount drives as folders.",
        ));
    }
    Ok(())
}

/// Decode `Authorization: Basic base64(username:password)`.
fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let encoded = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = std::str::from_utf8(&decoded).ok()?;
    let (user, password) = text.split_once(':')?;
    Some((user.trim().to_lowercase(), password.to_string()))
}

fn dav_handler_for(
    state: &AppState,
    id: &str,
) -> Result<crate::DavHandler, (StatusCode, axum::Json<serde_json::Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let Some(drive) = crate::db::get_drive(&conn, id).map_err(|e| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not read drives. {e}"),
        )
    })?
    else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive.",
        ));
    };
    if drive.mount_point.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive is not connected.",
        ));
    }

    let mut cache = state.dav_handlers.lock().unwrap();
    if let Some(handler) = cache.get(&drive.id) {
        return Ok(handler.clone());
    }

    let handler = crate::DavHandler::builder()
        .filesystem(LocalFs::new(&drive.mount_point, false, false, false))
        .locksystem(FakeLs::new())
        .strip_prefix(format!("/dav/{}", drive.id))
        .build_handler();
    cache.insert(drive.id, handler.clone());
    Ok(handler)
}

pub fn drop_cached_handler(state: &AppState, drive_id: &str) {
    if let Ok(mut cache) = state.dav_handlers.lock() {
        cache.remove(drive_id);
    }
}
