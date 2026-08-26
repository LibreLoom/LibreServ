use axum::{Json, Router, routing::get};
use serde_json::{Value, json};

pub fn router() -> Router<crate::AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/health", get(health))
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "product": "Luna",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime(),
    }))
}

fn uptime() -> u64 {
    // No extra dep for one number.
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
}
