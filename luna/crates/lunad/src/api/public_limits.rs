//! Rate limits for unauthenticated public album routes (Photos guest uploads).

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;

/// Limit guest `POST .../public/albums/{token}/upload` by client IP.
pub async fn limit_public_album_uploads(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let is_public_upload = *req.method() == Method::POST
        && path.starts_with("/api/v1/public/albums/")
        && path.ends_with("/upload");
    if is_public_upload {
        let ip = req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        if !state.public_upload_limiter.allow(&ip) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "Too many uploads from this network. Wait a minute, then try again."
                })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use crate::rate_limit::RateLimiter;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn public_upload_limiter_caps_burst() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Mutex::new(
            crate::db::open(&dir.path().join("luna.db")).unwrap(),
        ));
        let limiter = RateLimiter::new(db, Duration::from_secs(60), 3);
        assert!(limiter.allow("203.0.113.9"));
        assert!(limiter.allow("203.0.113.9"));
        assert!(limiter.allow("203.0.113.9"));
        assert!(!limiter.allow("203.0.113.9"));
        assert!(limiter.allow("198.51.100.2"));
    }
}
