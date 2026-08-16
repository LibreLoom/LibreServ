use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::connect::ConnectError;

#[derive(Deserialize)]
struct ActivateBody {
    connect_key: String,
    device_name: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connect/status", get(status))
        .route("/api/v1/connect/activate", post(activate))
        .route("/api/v1/connect/tunnel/enable", post(enable_tunnel))
        .route("/api/v1/connect/deactivate", post(deactivate))
}

async fn status(State(state): State<AppState>) -> Json<crate::connect::ConnectStatus> {
    Json(state.connect.status())
}

async fn activate(
    State(state): State<AppState>,
    Json(body): Json<ActivateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let service = state.connect.clone();
    let result = tokio::task::spawn_blocking(move || {
        service.activate(
            &body.connect_key,
            body.device_name.as_deref().unwrap_or("Luna"),
        )
    })
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

async fn enable_tunnel(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let service = state.connect.clone();
    let result = tokio::task::spawn_blocking(move || service.provision_tunnel())
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
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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

fn map_connect_err(err: ConnectError) -> (StatusCode, Json<Value>) {
    match err {
        ConnectError::Unreachable => json_error(
            StatusCode::BAD_GATEWAY,
            "Connect couldn't be reached. Check your internet connection and try again.",
        ),
        ConnectError::BadKey => json_error(
            StatusCode::UNAUTHORIZED,
            "That Connect key didn't work. Check it and try again.",
        ),
        ConnectError::Conflict => json_error(
            StatusCode::CONFLICT,
            "Connect is already in use. Turn it off and try again.",
        ),
        ConnectError::Other(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that. Try again.",
        ),
    }
}
