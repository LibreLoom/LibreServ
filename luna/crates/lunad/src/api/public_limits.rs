//! Rate limits for unauthenticated public link routes (guest uploads on /s/ links).

use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;
use crate::rate_limit::RateLimiter;

/// Bucket key for public album upload limits (namespaced so it does not share
/// raw-IP keys with login/DAV/share limiters in `rate_limit_buckets`).
fn public_upload_key(ip: &str) -> String {
    format!("public_upload:{ip}")
}

/// Per-link aggregate key: bounds upload sessions created through one share
/// link no matter how many source IPs an attacker rotates behind it. The
/// token is hashed — raw link secrets never land in the rate-limit table.
fn public_upload_link_key(token: &str) -> String {
    format!(
        "public_upload_link:{}",
        blake3::hash(token.as_bytes()).to_hex()
    )
}

/// The client key the limiter sees. `client_ip` trusts forwarding headers
/// only from a loopback peer (the Connect tunnel/on-box proxy), so spoofed
/// `X-Forwarded-For` can't mint fresh buckets and tunneled guests still get
/// their own.
fn request_ip(req: &Request) -> String {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| crate::api::auth::client_ip(&c.0, req.headers()).to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// Extract `{token}` from `/s/{token}/upload` (the caller already matched
/// the shape). Returns "" on a mismatch — still a valid bucket key.
fn upload_link_token(path: &str) -> &str {
    path.strip_prefix("/s/")
        .and_then(|rest| rest.strip_suffix("/upload"))
        .unwrap_or("")
        .trim_matches('/')
}

/// Both budgets must have room: the per-IP bucket limits one client's
/// burst, while the per-link aggregate bounds the link as a whole — an
/// attacker spraying rotating source IPs (or one proxy IP shared by every
/// tunneled guest) still hits the link-wide cap.
fn allow_public_upload(limiter: &RateLimiter, ip: &str, link_token: &str) -> bool {
    limiter.allow(&public_upload_key(ip)) && limiter.allow(&public_upload_link_key(link_token))
}

/// Limit guest `POST /s/{token}/upload` (new upload session) by client IP
/// and by link.
pub async fn limit_public_album_uploads(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let is_public_upload =
        *req.method() == Method::POST && path.starts_with("/s/") && path.ends_with("/upload");
    if is_public_upload {
        let ip = request_ip(&req);
        let token = upload_link_token(path);
        if !allow_public_upload(&state.public_upload_limiter, &ip, token) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "Too many uploads through this link. Wait a minute, then try again."
                })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::{
        allow_public_upload, public_upload_key, public_upload_link_key, upload_link_token,
    };
    use crate::rate_limit::RateLimiter;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// The tempdir must outlive the limiter — it holds the backing SQLite
    /// file — so the helper returns it alongside.
    fn limiter(max: usize) -> (tempfile::TempDir, RateLimiter) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Mutex::new(
            crate::db::open(&dir.path().join("luna.db")).unwrap(),
        ));
        (dir, RateLimiter::new(db, Duration::from_secs(60), max))
    }

    #[test]
    fn public_upload_limiter_caps_burst() {
        let (_dir, limiter) = limiter(3);
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

    #[test]
    fn per_link_bucket_bounds_rotating_ips() {
        let (_dir, limiter) = limiter(3);
        // Every request comes from a fresh IP — the per-IP bucket never
        // trips, but the link's aggregate bucket still caps the burst.
        for i in 0..3 {
            assert!(allow_public_upload(
                &limiter,
                &format!("203.0.113.{i}"),
                "tok-A"
            ));
        }
        assert!(!allow_public_upload(&limiter, "203.0.113.99", "tok-A"));
        // A different link is unaffected — the budget is per link, not global.
        assert!(allow_public_upload(&limiter, "203.0.113.99", "tok-B"));
    }

    #[test]
    fn per_ip_bucket_still_bounds_one_client() {
        let (_dir, limiter) = limiter(3);
        // One IP hammering many links is still capped per IP.
        for tok in ["a", "b", "c"] {
            assert!(allow_public_upload(&limiter, "198.51.100.7", tok));
        }
        assert!(!allow_public_upload(&limiter, "198.51.100.7", "d"));
    }

    #[test]
    fn link_keys_hide_the_raw_token() {
        let key = public_upload_link_key("s3cret-token");
        assert!(key.starts_with("public_upload_link:"));
        assert!(!key.contains("s3cret-token"));
        assert_eq!(upload_link_token("/s/abc123/upload"), "abc123");
        // Anything off the exact `/s/{token}/upload` shape keys on "" —
        // the middleware only calls this for matching paths anyway.
        assert_eq!(upload_link_token("/s/abc123/upload/"), "");
        assert_eq!(upload_link_token("/api/v1/other"), "");
    }
}
