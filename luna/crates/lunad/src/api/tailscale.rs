use crate::AppState;
use crate::api::response::json_error;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/tailscale/status", get(status))
        .route("/api/v1/tailscale/connect", post(connect))
        .route("/api/v1/tailscale/reconnect", post(reconnect))
        .route("/api/v1/tailscale/serve", post(serve))
        .route("/api/v1/tailscale/stop-serve", post(stop_serve))
        .route("/api/v1/tailscale/disable", post(disable))
        .route("/api/v1/tailscale/forget", post(forget))
}

#[derive(Deserialize)]
struct ServeBody {
    public: bool,
    #[serde(default)]
    confirm_public: bool,
}

fn admin(user: &crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can change remote access.",
        ))
    }
}
fn failure(message: String) -> (StatusCode, Json<Value>) {
    json_error(StatusCode::BAD_GATEWAY, &message)
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    Ok(Json(
        tokio::task::spawn_blocking(move || crate::net::tailscale::status(&dir, port))
            .await
            .unwrap_or_else(
                |_| json!({"state":"error","error":"Luna could not read Tailscale status."}),
            ),
    ))
}
async fn connect(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::connect(&dir, port))
        .await
        .map_err(|_| failure("Luna could not start Tailscale.".into()))?
        .map(Json)
        .map_err(failure)
}
async fn reconnect(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::reconnect(&dir, port))
        .await
        .map_err(|_| failure("Luna could not reconnect to Tailscale.".into()))?
        .map(Json)
        .map_err(failure)
}
async fn serve(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<ServeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    if body.public && !body.confirm_public {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Confirm public access before turning it on.",
        ));
    }
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::serve(&dir, port, body.public))
        .await
        .map_err(|_| failure("Luna could not configure Tailscale access.".into()))?
        .map(Json)
        .map_err(failure)
}
async fn disable(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::disable(&dir, port))
        .await
        .map_err(|_| failure("Luna could not turn off Tailscale.".into()))?
        .map(Json)
        .map_err(failure)
}
async fn stop_serve(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::stop_serve(&dir, port))
        .await
        .map_err(|_| failure("Luna could not turn off Tailscale web access.".into()))?
        .map(Json)
        .map_err(failure)
}
async fn forget(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || crate::net::tailscale::forget(&dir, port))
        .await
        .map_err(|_| failure("Luna could not forget this Tailscale device.".into()))?
        .map(Json)
        .map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[tokio::test]
    async fn public_funnel_requires_explicit_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = AppState::new(conn, drive_manager, dir.path());
        let app = router().with_state(state);
        let mut req = axum::http::Request::builder()
            .method("POST")
            .uri("/api/v1/tailscale/serve")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"public":true}"#))
            .unwrap();
        req.extensions_mut().insert(crate::auth::CurrentUser {
            id: "admin".into(),
            username: "admin".into(),
            role: "admin".into(),
        });
        let response = app.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
