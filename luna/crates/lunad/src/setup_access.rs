//! Remote setup unlock: first two groups of the permanent device token.
//!
//! LAN origins are always allowed. Remote requests need `X-Setup-Token` matching
//! `prefix(device_token)` when a valid device token is present. Without a token,
//! remote setup is blocked (never fail-open).

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use crate::AppState;
use crate::api::response::json_error_code;
use crate::auth::setup_wizard_open;

const REMOTE_NO_TOKEN: &str = "Finish setup from a device on the same home network as Luna (same Wi‑Fi or ethernet). Luna works fully without Luna Connect.";
const REMOTE_WRONG_PREFIX: &str =
    "Enter the first eight characters of your device token (****-****).";

/// Wrong or missing `X-Setup-Token` prefix when a device token is on disk.
pub const CODE_SETUP_TOKEN_REQUIRED: &str = "setup_token_required";
/// Remote setup while no device token exists (never fail-open).
pub const CODE_SETUP_REMOTE_NO_TOKEN: &str = "setup_remote_no_token";

/// Enforce the remote setup unlock for an incomplete wizard.
/// Returns `Ok(())` when the request may proceed.
pub fn check(
    state: &AppState,
    addr: &std::net::SocketAddr,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<Value>)> {
    if !setup_wizard_open(state) {
        return Ok(());
    }
    if is_lan_request(addr, headers) {
        return Ok(());
    }

    if state.connect.setup_prefix().is_none() {
        return Err(json_error_code(
            StatusCode::FORBIDDEN,
            CODE_SETUP_REMOTE_NO_TOKEN,
            REMOTE_NO_TOKEN,
        ));
    }

    let token = headers
        .get("X-Setup-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state.connect.matches_setup_prefix(token) {
        return Err(json_error_code(
            StatusCode::FORBIDDEN,
            CODE_SETUP_TOKEN_REQUIRED,
            REMOTE_WRONG_PREFIX,
        ));
    }
    Ok(())
}

/// `"lan"` or `"remote"` for setup UI hints.
pub fn setup_origin(addr: &std::net::SocketAddr, headers: &HeaderMap) -> &'static str {
    if is_lan_request(addr, headers) {
        "lan"
    } else {
        "remote"
    }
}

pub fn is_lan_request(addr: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    if is_local_hostname(headers) {
        return true;
    }
    let ip = client_ip(addr, headers);
    is_private_or_loopback_ip(ip)
}

pub fn is_loopback_request(addr: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    is_lan_request(addr, headers)
        && matches!(client_ip(addr, headers), std::net::IpAddr::V4(v4) if v4.is_loopback())
}

fn client_ip(addr: &std::net::SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    if let Some(ip) = header_ip(headers, "cf-connecting-ip")
        .or_else(|| header_ip(headers, "x-real-ip"))
        .or_else(|| forwarded_for_first(headers))
    {
        return ip;
    }
    addr.ip()
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<std::net::IpAddr> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
}

fn forwarded_for_first(headers: &HeaderMap) -> Option<std::net::IpAddr> {
    let raw = headers.get("x-forwarded-for")?.to_str().ok()?;
    raw.split(',').next().and_then(|s| s.trim().parse().ok())
}

fn is_local_hostname(headers: &HeaderMap) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    host.ends_with(".local") || host == "luna.local"
}

fn is_private_or_loopback_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.octets()[0] == 169 && v4.octets()[1] == 254
        }
        std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const REMOTE: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 9)),
        54321,
    );
    const LAN: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 50)),
        54321,
    );
    const LOOPBACK: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    fn app(dir: &std::path::Path) -> axum::Router {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let state = crate::AppState::new(
            conn,
            std::sync::Arc::new(crate::drives::DriveManager::new(
                crate::mount::shared_mock(),
                dir,
            )),
            dir,
        );
        crate::api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state)
    }

    async fn call(
        app: &axum::Router,
        method: Method,
        path: &str,
        body: &str,
        addr: std::net::SocketAddr,
        setup_token: Option<&str>,
    ) -> axum::http::Response<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(tok) = setup_token {
            builder = builder.header("X-Setup-Token", tok);
        }
        let mut req = builder.body(Body::from(body.to_string())).unwrap();
        req.extensions_mut().insert(ConnectInfo(addr));
        app.clone().oneshot(req).await.unwrap()
    }

    #[tokio::test]
    async fn lan_setup_without_token_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            LAN,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
    }

    #[tokio::test]
    async fn remote_setup_without_token_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            REMOTE,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json.get("code").and_then(|v| v.as_str()),
            Some(CODE_SETUP_REMOTE_NO_TOKEN)
        );
        assert!(
            json.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("home network"),
            "{json}"
        );
    }

    #[tokio::test]
    async fn remote_setup_missing_prefix_returns_setup_token_required() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device-token"),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            REMOTE,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json.get("code").and_then(|v| v.as_str()),
            Some(CODE_SETUP_TOKEN_REQUIRED)
        );
        assert_eq!(
            json.get("error").and_then(|v| v.as_str()),
            Some(REMOTE_WRONG_PREFIX)
        );
    }

    #[tokio::test]
    async fn loopback_setup_without_token_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            LOOPBACK,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
    }

    #[tokio::test]
    async fn remote_setup_accepts_matching_prefix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device-token"),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let app = app(dir.path());
        let denied = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            REMOTE,
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let ok = call(
            &app,
            Method::POST,
            "/api/v1/setup",
            r#"{"current_step":"network"}"#,
            REMOTE,
            Some("ABCD-EFGH"),
        )
        .await;
        assert_eq!(ok.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn validate_code_works_without_prior_token_on_lan() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device-token"),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let app = app(dir.path());
        let good = call(
            &app,
            Method::POST,
            "/api/v1/setup/validate-code",
            r#"{"code":"ABCD-EFGH"}"#,
            LAN,
            None,
        )
        .await;
        assert_eq!(good.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn fetch_mag_reports_existing_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device-token"),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::POST,
            "/api/v1/setup/fetch-mag",
            "{}",
            LOOPBACK,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json.get("source").and_then(|v| v.as_str()),
            Some("existing")
        );
    }

    #[tokio::test]
    async fn remote_preflight_without_token_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device-token"),
            "ABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        let app = app(dir.path());
        let res = call(
            &app,
            Method::GET,
            "/api/v1/setup/preflight",
            "",
            REMOTE,
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            json.get("code").and_then(|v| v.as_str()),
            Some(CODE_SETUP_TOKEN_REQUIRED)
        );
    }

    #[test]
    fn private_ranges_are_lan() {
        let addr = std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 5)),
            80,
        );
        assert!(is_lan_request(&addr, &HeaderMap::new()));
    }

    #[test]
    fn forwarded_for_public_is_remote() {
        let addr = LOOPBACK;
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        assert!(!is_lan_request(&addr, &headers));
    }
}
