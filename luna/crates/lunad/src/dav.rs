//! WebDAV for native desktop mounts (Finder, Explorer, davfs2).
//!
//! One endpoint per adopted drive: `/dav/{drive_id}/...`. The handler uses
//! dav-server's LocalFs rooted at the drive's mount point, so a client can
//! never address anything outside that drive.

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::any;
use dav_server::fakels::FakeLs;
use dav_server::localfs::LocalFs;

use crate::AppState;
use crate::api::response::json_error;

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
    let handler = match dav_handler_for(&state, &id) {
        Ok(handler) => handler,
        Err(err) => return err.into_response(),
    };
    let resp = handler.handle(req).await;
    let (parts, body) = resp.into_parts();
    axum::response::Response::from_parts(parts, axum::body::Body::new(body))
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
