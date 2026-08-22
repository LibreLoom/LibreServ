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
struct EnableBody {
    subdomain: String,
}

#[derive(Deserialize)]
struct DomainBody {
    subdomain: String,
}

#[derive(Deserialize)]
struct SourcesBody {
    sources: Vec<Value>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connect/status", get(status))
        .route("/api/v1/connect/enable", post(enable))
        .route("/api/v1/connect/domain", post(set_domain))
        .route("/api/v1/connect/deactivate", post(deactivate))
        .route("/api/v1/connect/pairing-code", post(pairing_code))
        .route("/api/v1/connect/backup-sources", post(set_sources))
}

async fn status(State(state): State<AppState>) -> Json<crate::connect::ConnectStatus> {
    let connect = state.connect.clone();
    let _ = tokio::task::spawn_blocking(move || connect.sync_status_from_cloud()).await;
    Json(state.connect.status())
}

async fn enable(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<EnableBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(user)?;
    let service = state.connect.clone();
    let port = 8090u16;
    let result = tokio::task::spawn_blocking(move || service.enable(&body.subdomain, port))
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

async fn set_domain(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<DomainBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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

async fn pairing_code(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(user)?;
    let service = state.connect.clone();
    let code = tokio::task::spawn_blocking(move || service.pairing_code())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't get a pairing code.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "pairing_code": code })))
}

async fn set_sources(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<SourcesBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(user)?;
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.set_backup_sources(body.sources))
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
        ConnectError::Other(msg) => json_error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    }
}
