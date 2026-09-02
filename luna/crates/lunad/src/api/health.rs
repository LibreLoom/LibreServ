use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/health", get(health))
        .route("/api/v1/system/health/check", get(comprehensive_check))
        .route(
            "/api/v1/system/health/check/refresh",
            post(comprehensive_check),
        )
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "product": "Luna",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime(),
    }))
}

async fn comprehensive_check(
    State(state): State<AppState>,
    method: axum::http::Method,
) -> (StatusCode, Json<Value>) {
    let force = method == axum::http::Method::POST;
    let cache = state.health_cache.clone();
    let result = if force || cache.should_refresh() {
        cache.mark_refreshing();
        let data_dir = state.data_dir.clone();
        let db = state.db.clone();
        let computed = tokio::task::spawn_blocking(move || {
            let (preflight, drives) = {
                let conn = db.lock().unwrap();
                let preflight = crate::system_health::run_preflight(&data_dir, &conn);
                let drives = crate::db::list_drives(&conn).unwrap_or_default();
                (preflight, drives)
            };
            crate::system_health::finish_comprehensive(&data_dir, preflight, drives)
        })
        .await
        .unwrap_or_else(|_| crate::system_health::ComprehensiveHealthResponse {
            status: "error".into(),
            timestamp: crate::db::now_unix(),
            overall_pass: false,
            checks: Default::default(),
            summary: Default::default(),
        });
        cache.set(computed.clone());
        computed
    } else {
        cache.get().unwrap_or_else(|| {
            let data_dir = state.data_dir.clone();
            let db = state.db.clone();
            let (preflight, drives) = {
                let conn = db.lock().unwrap();
                let preflight = crate::system_health::run_preflight(&data_dir, &conn);
                let drives = crate::db::list_drives(&conn).unwrap_or_default();
                (preflight, drives)
            };
            crate::system_health::finish_comprehensive(&data_dir, preflight, drives)
        })
    };

    let status = if result.overall_pass {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(serde_json::to_value(result).unwrap_or(json!({}))),
    )
}

fn uptime() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use crate::{AppState, db};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_shape() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let router = super::router().with_state(AppState::new(conn, drive_manager, dir.path()));
        let response = tower::ServiceExt::oneshot(
            router,
            axum::http::Request::builder()
                .uri("/health")
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
        assert_eq!(v["status"], "ok");
        assert_eq!(v["product"], "Luna");
    }

    #[tokio::test]
    async fn comprehensive_check_returns_checks() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let mut state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
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
                    .uri("/api/v1/system/health/check")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["overall_pass"], true);
        assert!(v["checks"]["database"].is_object());
        assert!(v["checks"]["disk_space"].is_object());
    }
}
