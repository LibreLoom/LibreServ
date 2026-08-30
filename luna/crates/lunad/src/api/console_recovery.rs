//! Localhost-only admin password reset for the `pwreset` Linux login shell.

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::AuthError;

#[derive(Deserialize)]
struct ResetBody {
    username: String,
    password: String,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/console/reset-password", post(reset_password))
}

fn is_loopback(addr: &std::net::SocketAddr) -> bool {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

async fn reset_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<ResetBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !is_loopback(&addr) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Password recovery only works on Luna's screen keyboard.",
        ));
    }
    let user = state
        .auth
        .reset_user_password(&body.username, &body.password)
        .map_err(|e| match e {
            AuthError::BadLogin => json_error(
                StatusCode::BAD_REQUEST,
                "No admin account with that username. Check the spelling and try again.",
            ),
            AuthError::Forbidden => json_error(
                StatusCode::FORBIDDEN,
                "Only an admin password can be reset this way.",
            ),
            AuthError::PasswordPolicy(msg) => json_error(StatusCode::BAD_REQUEST, msg),
            other => json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                other.to_string(),
            ),
        })?;
    Ok(Json(json!({
        "ok": true,
        "username": user.username,
    })))
}
