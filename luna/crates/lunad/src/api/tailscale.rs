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

#[derive(Default, Deserialize)]
struct ConnectBody {
    #[serde(default)]
    control_server: String,
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
async fn mutation_guard(
    state: &AppState,
    user: &crate::auth::CurrentUser,
) -> Result<tokio::sync::OwnedRwLockReadGuard<()>, (StatusCode, Json<Value>)> {
    let guard = state.tailscale_reset_gate.clone().read_owned().await;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let current = crate::db::get_user(&conn, &user.id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not check your account.",
        )
    })?;
    if !current.is_some_and(|account| account.role == "admin") {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Sign in as an Admin again.",
        ));
    }
    drop(conn);
    Ok(guard)
}
fn failure(message: String) -> (StatusCode, Json<Value>) {
    json_error(StatusCode::BAD_GATEWAY, &message)
}

fn stopped_status(value: Value) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if value["residual_exposure"] == true {
        return Err(failure("Tailscale may still be reachable. Luna could not verify that its remote connection stopped.".into()));
    }
    Ok(Json(value))
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
    body: Option<Json<ConnectBody>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    let server = body
        .map(|Json(body)| body.control_server)
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::connect_with_control(&dir, port, &server)
    })
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
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::reconnect(&dir, port)
    })
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
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::serve(&dir, port, body.public)
    })
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
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::disable(&dir, port)
    })
    .await
    .map_err(|_| failure("Luna could not turn off Tailscale.".into()))?
    .map_err(failure)
    .and_then(stopped_status)
}
async fn stop_serve(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::stop_serve(&dir, port)
    })
    .await
    .map_err(|_| failure("Luna could not turn off Tailscale web access.".into()))?
    .map_err(failure)
    .and_then(stopped_status)
}
async fn forget(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    admin(&user)?;
    let _reset_guard = mutation_guard(&state, &user).await?;
    let dir = state.data_dir.clone();
    let port = state.http_port;
    tokio::task::spawn_blocking(move || {
        let _guard = _reset_guard;
        crate::net::tailscale::forget(&dir, port)
    })
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

    #[test]
    fn unverified_stop_is_an_http_failure() {
        let error = stopped_status(json!({"residual_exposure": true})).unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        assert!(stopped_status(json!({"residual_exposure": false})).is_ok());
    }

    #[tokio::test]
    async fn queued_mutation_rechecks_admin_after_reset() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_user(&conn, "old", "old", "Old", "hash", "admin").unwrap();
        let manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = AppState::new(conn, manager, dir.path());
        let reset = state.tailscale_reset_gate.write().await;
        let queued_state = state.clone();
        let task = tokio::spawn(async move {
            let user = crate::auth::CurrentUser {
                id: "old".into(),
                username: "old".into(),
                role: "admin".into(),
            };
            mutation_guard(&queued_state, &user).await.is_err()
        });
        tokio::task::yield_now().await;
        {
            let conn = state.db.lock().unwrap();
            conn.execute("DELETE FROM users WHERE id = ?1", ["old"])
                .unwrap();
            crate::db::insert_user(&conn, "new", "new", "New", "hash", "admin").unwrap();
        }
        drop(reset);
        assert!(task.await.unwrap());
        let new_user = crate::auth::CurrentUser {
            id: "new".into(),
            username: "new".into(),
            role: "admin".into(),
        };
        assert!(mutation_guard(&state, &new_user).await.is_ok());
    }

    #[tokio::test]
    async fn status_records_the_real_off_response_for_the_fake_contract() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let app = router().with_state(AppState::new(conn, manager, dir.path()));
        let mut req = axum::http::Request::builder()
            .uri("/api/v1/tailscale/status")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(crate::auth::CurrentUser {
            id: "admin".into(),
            username: "admin".into(),
            role: "admin".into(),
        });
        let response = app.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let _ =
            crate::api::contract::observe(Some("GET /api/v1/tailscale/status".into()), response)
                .await;
        std::fs::create_dir(dir.path().join("tailscale")).unwrap();
        std::fs::write(dir.path().join("tailscale/approval-type"), "funnel").unwrap();
        let mut req = axum::http::Request::builder()
            .uri("/api/v1/tailscale/status")
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(crate::auth::CurrentUser {
            id: "admin".into(),
            username: "admin".into(),
            role: "admin".into(),
        });
        let response = app.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let _ =
            crate::api::contract::observe(Some("GET /api/v1/tailscale/status".into()), response)
                .await;
    }

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
