//! Rate limits for unauthenticated public album routes (Photos guest uploads).

use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;

/// Bucket key for public album upload limits (namespaced so it does not share
/// raw-IP keys with login/DAV/share limiters in `rate_limit_buckets`).
fn public_upload_key(ip: &str) -> String {
    format!("public_upload:{ip}")
}

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
        // ConnectInfo only (not X-Forwarded-For): behind cloudflared this may be
        // the proxy IP, so the limiter can act as a coarse global cap.
        let ip = req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        if !state.public_upload_limiter.allow(&public_upload_key(&ip)) {
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
    use super::public_upload_key;
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
        let k1 = public_upload_key("203.0.113.9");
        let k2 = public_upload_key("198.51.100.2");
        assert!(limiter.allow(&k1));
        assert!(limiter.allow(&k1));
        assert!(limiter.allow(&k1));
        assert!(!limiter.allow(&k1));
        assert!(limiter.allow(&k2));
        // Namespaced keys must not collide with raw-IP login/DAV/share buckets.
        assert!(limiter.allow("203.0.113.9"));
    }
}
