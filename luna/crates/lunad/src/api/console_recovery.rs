//! Localhost-only admin password reset for the `pwreset` Linux login shell.

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
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

/// Client-identity headers that tunnel / reverse-proxy peers typically set.
/// A non-empty value means the TCP peer is not the real client (e.g. Luna
/// Connect terminating to 127.0.0.1), so console recovery must refuse.
const PROXY_CLIENT_HEADERS: &[&str] = &[
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-real-ip",
    "forwarded",
    "true-client-ip",
    "cdn-loop",
];

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/console/reset-password", post(reset_password))
}

fn is_loopback(addr: &std::net::SocketAddr) -> bool {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn has_proxy_client_headers(headers: &HeaderMap) -> bool {
    for name in PROXY_CLIENT_HEADERS {
        if let Some(value) = headers.get(*name) {
            if let Ok(s) = value.to_str() {
                if !s.trim().is_empty() {
                    return true;
                }
            } else if !value.is_empty() {
                // Non-UTF8 but present — treat as a real client-identity signal.
                return true;
            }
        }
    }
    false
}

fn recovery_forbidden() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::FORBIDDEN,
        "Password recovery only works on Luna's screen keyboard.",
    )
}

async fn reset_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResetBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !is_loopback(&addr) || has_proxy_client_headers(&headers) {
        return Err(recovery_forbidden());
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
            _other => json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong. Try again.",
            ),
        })?;
    Ok(Json(json!({
        "ok": true,
        "username": user.username,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const LOOPBACK: std::net::SocketAddr =
        std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 12345);
    const REMOTE: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 9)),
        54321,
    );

    fn test_state(dir: &std::path::Path) -> AppState {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir));
        AppState::new(conn, drive_manager, dir)
    }

    fn router_with(dir: &std::path::Path) -> (AppState, axum::Router) {
        let state = test_state(dir);
        let router = super::router().with_state(state.clone());
        (state, router)
    }

    fn req(
        addr: std::net::SocketAddr,
        body: &str,
        extra_headers: &[(&str, &str)],
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/console/reset-password")
            .header("content-type", "application/json");
        for (k, v) in extra_headers {
            builder = builder.header(*k, *v);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(addr));
        http
    }

    async fn call(app: axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.oneshot(r).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn proxy_headers_detect_non_empty_case_insensitive() {
        let mut headers = HeaderMap::new();
        assert!(!has_proxy_client_headers(&headers));
        headers.insert("X-Forwarded-For", "1.2.3.4".parse().unwrap());
        assert!(has_proxy_client_headers(&headers));
        let mut empty = HeaderMap::new();
        empty.insert("cf-connecting-ip", "  ".parse().unwrap());
        assert!(!has_proxy_client_headers(&empty));
    }

    #[tokio::test]
    async fn non_loopback_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = router_with(dir.path());
        state
            .auth
            .register("max", "Max", "hunter22hunter1", "user")
            .unwrap();
        let res = call(
            app,
            req(
                REMOTE,
                r#"{"username":"max","password":"new-password12"}"#,
                &[],
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let v = body_json(res).await;
        assert_eq!(
            v["error"],
            "Password recovery only works on Luna's screen keyboard."
        );
    }

    #[tokio::test]
    async fn loopback_ok_resets_admin_password() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = router_with(dir.path());
        state
            .auth
            .register("max", "Max", "old-password12", "user")
            .unwrap();
        let res = call(
            app,
            req(
                LOOPBACK,
                r#"{"username":"max","password":"new-password12"}"#,
                &[],
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["username"], "max");
        state.auth.login("max", "new-password12").unwrap();
    }

    #[tokio::test]
    async fn loopback_with_cf_connecting_ip_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        let (state, app) = router_with(dir.path());
        state
            .auth
            .register("max", "Max", "hunter22hunter1", "user")
            .unwrap();
        let res = call(
            app,
            req(
                LOOPBACK,
                r#"{"username":"max","password":"new-password12"}"#,
                &[("Cf-Connecting-Ip", "198.51.100.7")],
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let v = body_json(res).await;
        assert_eq!(
            v["error"],
            "Password recovery only works on Luna's screen keyboard."
        );
        // Password must be unchanged.
        state.auth.login("max", "hunter22hunter1").unwrap();
    }

    // empty_password_is_rejected deferred: needs auth.rs reset_user_password
    // policy push (MCP payload limit on this runner). Re-add with auth.rs.
}
