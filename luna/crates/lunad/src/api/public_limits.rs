//! Rate limits for unauthenticated public link routes (`/s/...`).
//!
//! Every public request is counted before a handler or a body extractor sees
//! it: once per client address (IPv6 by /64) and once per link, with the link
//! token hashed so no raw secret reaches the rate-limit table. The budgets are
//! deliberately loose enough for a form page and its pictures, but a flood or
//! a scraper still runs out.
//!
//! Guest album uploads keep their own tighter budget on top: the public
//! limiter bounds the whole link, while a separate per-link upload bucket
//! bounds how many upload sessions one link can start.

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;

use crate::AppState;
use crate::api::form_limits;
use crate::rate_limit::RateLimiter;

/// Bucket key for one public uploader's address (hashed; IPv6 by /64).
fn public_upload_key(ip: &str) -> String {
    crate::rate_limit::ip_key("public_upload", ip)
}

/// Per-link upload key: bounds upload sessions created through one share link
/// no matter how many source IPs an attacker rotates behind it. The token is
/// hashed — raw link secrets never land in the rate-limit table.
fn public_upload_link_key(token: &str) -> String {
    crate::rate_limit::secret_key("public_upload_link", token)
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

/// The `{token}` segment of any `/s/{token}/...` path. An empty string is a
/// valid bucket key for malformed paths; the limiter still applies to them.
fn link_token(path: &str) -> &str {
    path.strip_prefix("/s/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("")
}

/// Extract `{token}` from `/s/{token}/upload` (the caller already matched
/// the shape). Returns "" on a mismatch — still a valid bucket key.
fn upload_link_token(path: &str) -> &str {
    path.strip_prefix("/s/")
        .and_then(|rest| rest.strip_suffix("/upload"))
        .unwrap_or("")
        .trim_matches('/')
}

/// Both upload budgets must have room: the per-IP bucket limits one client's
/// burst, while the per-link aggregate bounds the link as a whole — an
/// attacker spraying rotating source IPs (or one proxy IP shared by every
/// tunneled guest) still hits the link-wide cap.
fn allow_public_upload(limiter: &RateLimiter, ip: &str, link_token: &str) -> bool {
    limiter.allow(&public_upload_key(ip)) && limiter.allow(&public_upload_link_key(link_token))
}

fn too_many_requests(message: &str) -> Response {
    crate::api::response::json_error(StatusCode::TOO_MANY_REQUESTS, message).into_response()
}

/// Limit every public `/s/...` request by client address and by link, before
/// the route's handler or any body extraction runs. Guest `POST /upload` also
/// spends the tighter album-upload budget.
pub async fn limit_public_requests(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    if !path.starts_with("/s/") {
        return next.run(req).await;
    }

    let ip = request_ip(&req);
    if !state
        .public_asset_ip_limiter
        .allow(&form_limits::public_asset_ip_key(&ip))
    {
        return too_many_requests(
            "Too many requests from this network just now. Wait a minute, then try again.",
        );
    }
    if !state
        .public_asset_link_limiter
        .allow(&form_limits::public_link_key(link_token(path)))
    {
        return too_many_requests(
            "This link is getting too many requests. Wait a minute, then try again.",
        );
    }

    let is_public_upload = req.method() == Method::POST && path.ends_with("/upload");
    if is_public_upload
        && !allow_public_upload(&state.public_upload_limiter, &ip, upload_link_token(path))
    {
        return too_many_requests(
            "Too many uploads through this link. Wait a minute, then try again.",
        );
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::{
        allow_public_upload, limit_public_requests, link_token, public_upload_key,
        public_upload_link_key, upload_link_token,
    };
    use crate::AppState;
    use crate::rate_limit::RateLimiter;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq, StatusCode};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    const CLIENT: SocketAddr = SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    /// The tempdir must outlive the limiter — it holds the backing SQLite
    /// file — so the helper returns it alongside.
    fn limiter(max: usize) -> (tempfile::TempDir, RateLimiter) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(crate::Db::new(
            crate::db::open(&dir.path().join("luna.db")).unwrap(),
        ));
        (dir, RateLimiter::new(db, Duration::from_secs(60), max))
    }

    fn test_state(
        ip_max: usize,
        link_max: usize,
        upload_max: usize,
    ) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drives = Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let mut state = AppState::new(conn, drives, dir.path());
        let db = state.db.clone();
        let make = |max| Arc::new(RateLimiter::new(db.clone(), Duration::from_secs(60), max));
        state.public_asset_ip_limiter = make(ip_max);
        state.public_asset_link_limiter = make(link_max);
        state.public_upload_limiter = make(upload_max);
        (dir, state)
    }

    /// A handler that only runs when the middleware lets the request through;
    /// an invalid JSON body must fail here, so a 429 in front of it proves the
    /// limiter ran before body extraction.
    async fn echo_json(axum::Json(_): axum::Json<serde_json::Value>) -> StatusCode {
        StatusCode::NO_CONTENT
    }

    fn app(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/s/{token}", axum::routing::post(echo_json))
            .route("/s/{token}/upload", axum::routing::post(echo_json))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                limit_public_requests,
            ))
            .with_state(state)
    }

    fn request(uri: &str, ip: &str, body: &str) -> HttpReq<Body> {
        let mut req = HttpReq::builder()
            .method(Method::POST)
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-forwarded-for", ip)
            .body(Body::from(body.to_owned()))
            .unwrap();
        // A loopback peer is what makes `client_ip` trust the forwarded
        // address, exactly as the Connect tunnel does in production.
        req.extensions_mut().insert(ConnectInfo(CLIENT));
        req
    }

    async fn post(app: &axum::Router, uri: &str, ip: &str, body: &str) -> StatusCode {
        app.clone()
            .oneshot(request(uri, ip, body))
            .await
            .unwrap()
            .status()
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

    #[test]
    fn link_token_is_the_first_segment_of_any_public_path() {
        assert_eq!(link_token("/s/abc123"), "abc123");
        assert_eq!(link_token("/s/abc123/form-image"), "abc123");
        assert_eq!(link_token("/s/"), "");
        assert_eq!(link_token("/api/v1/other"), "");
    }

    #[test]
    fn address_keys_hide_the_raw_address() {
        let key = public_upload_key("203.0.113.9");
        assert!(key.starts_with("public_upload:"));
        assert!(!key.contains("203.0.113.9"), "{key}");
    }

    #[tokio::test]
    async fn public_requests_are_limited_before_the_body_is_read() {
        let (_dir, state) = test_state(3, 100, 100);
        let app = app(state);
        for token in ["a", "b", "c"] {
            assert_eq!(
                post(&app, &format!("/s/{token}"), "203.0.113.9", "{}").await,
                StatusCode::NO_CONTENT
            );
        }
        // The fourth request has a broken JSON body. A body extractor that
        // ran first would answer 400/422; the limiter must answer 429.
        assert_eq!(
            post(&app, "/s/d", "203.0.113.9", "not json").await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn one_link_is_bounded_across_rotating_addresses() {
        let (_dir, state) = test_state(100, 3, 100);
        let app = app(state);
        for i in 0..3 {
            assert_eq!(
                post(&app, "/s/same", &format!("203.0.113.{i}"), "{}").await,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            post(&app, "/s/same", "203.0.113.99", "{}").await,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Another link from the same address is untouched.
        assert_eq!(
            post(&app, "/s/other", "203.0.113.99", "{}").await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn ipv6_addresses_in_one_64_share_one_address_budget() {
        let (_dir, state) = test_state(2, 100, 100);
        let app = app(state);
        assert_eq!(
            post(&app, "/s/a", "2001:db8:1:2::a", "{}").await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            post(&app, "/s/b", "2001:db8:1:2::b", "{}").await,
            StatusCode::NO_CONTENT
        );
        // A third address in the same /64 is the same client for limiting.
        assert_eq!(
            post(&app, "/s/c", "2001:db8:1:2::c", "{}").await,
            StatusCode::TOO_MANY_REQUESTS
        );
        // A different /64 has its own budget.
        assert_eq!(
            post(&app, "/s/d", "2001:db8:1:3::a", "{}").await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn album_upload_budget_survives_the_public_limiter() {
        let (_dir, state) = test_state(100, 100, 2);
        let app = app(state);
        for _ in 0..2 {
            assert_eq!(
                post(&app, "/s/tok/upload", "203.0.113.9", "{}").await,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            post(&app, "/s/tok/upload", "203.0.113.9", "{}").await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}
