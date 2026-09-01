use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::connect::ConnectError;

#[derive(Deserialize)]
struct DomainBody {
    subdomain: String,
}

#[derive(Deserialize)]
struct SourcesBody {
    sources: Vec<Value>,
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connect/config", get(config))
        .route("/api/v1/connect/status", get(status))
        .route("/api/v1/connect/domain", post(set_domain))
        .route("/api/v1/connect/deactivate", post(deactivate))
        .route("/api/v1/connect/setup-code", post(setup_code))
        .route("/api/v1/connect/sync", post(sync))
        .route(
            "/api/v1/connect/device-token",
            axum::routing::delete(remove_device_token),
        )
        .route("/api/v1/connect/backup-sources", post(set_sources))
}

async fn config(State(state): State<AppState>) -> Json<Value> {
    let active = state.connect.is_connect_active();
    let prefix = state.connect.setup_prefix().is_some();
    let st = state.connect.status();
    Json(json!({
        "connect_active": active,
        "device_token": {
            "present": active,
            "prefix_available": prefix,
        },
        "cloud_bind": {
            "state": if !active { "n/a" } else if st.enabled { "claimed" } else { "unclaimed" },
        },
    }))
}

async fn status(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Json<crate::connect::ConnectStatus> {
    if state.connect.is_connect_active() {
        let connect = state.connect.clone();
        let _ = tokio::task::spawn_blocking(move || connect.sync_status_from_cloud()).await;
    }
    let setup = state.auth.count_users().unwrap_or(1) == 0;
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    Json(state.connect.status_for(setup || admin))
}

fn setup_or_admin(state: &AppState, current: Option<&Extension<crate::auth::CurrentUser>>) -> bool {
    if state.auth.count_users().unwrap_or(1) == 0 {
        return true;
    }
    current.map(|u| u.role == "admin").unwrap_or(false)
}

async fn setup_code(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<CodeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !setup_or_admin(&state, current.as_ref()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can enter a device token.",
        ));
    }
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.set_oss_code(&body.code))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that device token.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({
        "ok": true,
        "message": "Luna will use this device token to meet Luna Connect. Keep this page open."
    })))
}

async fn sync(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.connect.is_connect_active() {
        return Err(connect_inactive_error());
    }
    require_admin(user)?;
    let service = state.connect.clone();
    let bound = tokio::task::spawn_blocking(move || service.poll_status())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't sync with Luna Connect.",
            )
        })?;
    Ok(Json(json!({ "ok": true, "bound": bound })))
}

async fn remove_device_token(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(user)?;
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.remove_device_token())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't remove the device token.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn set_domain(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<DomainBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.connect.is_connect_active() {
        return Err(connect_inactive_error());
    }
    require_admin(user)?;
    let service = state.connect.clone();
    let result = tokio::task::spawn_blocking(move || service.set_domain(&body.subdomain))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't reach Connect.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(result))
}

async fn deactivate(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.connect.is_connect_active() {
        return Err(connect_inactive_error());
    }
    require_admin(user)?;
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.deactivate())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't turn Connect off.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn set_sources(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<SourcesBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.connect.is_connect_active() {
        return Err(connect_inactive_error());
    }
    require_admin(user)?;
    let sources = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let drives = crate::db::list_drives(&conn).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read your drives.",
            )
        })?;
        crate::cloud_backup::validate_backup_sources(body.sources, &drives)
            .map_err(map_connect_err)?
    };
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.set_backup_sources(sources))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save those folders.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn require_admin(user: crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can change remote access.",
        ));
    }
    Ok(())
}

fn connect_inactive_error() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::NOT_FOUND,
        "Luna Connect is not set up on this Luna. Add a device token in Settings → About → Advanced.",
    )
}

fn map_connect_err(err: ConnectError) -> (StatusCode, Json<Value>) {
    match err {
        ConnectError::Unreachable => json_error(
            StatusCode::BAD_GATEWAY,
            "Connect couldn't be reached. Check your internet connection and try again.",
        ),
        ConnectError::Conflict => json_error(
            StatusCode::CONFLICT,
            "That name is already in use, or Connect is already on. Pick another name or turn it off first.",
        ),
        ConnectError::Other(msg) => json_error(StatusCode::BAD_REQUEST, msg),
    }
}
