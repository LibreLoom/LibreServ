//! Remote setup unlock: first two groups of the permanent device code.
//!
//! Loopback (on-box display / local browser) is always allowed. Non-loopback
//! requests need `X-Setup-Token` matching `prefix(device_code)`. Missing or
//! malformed device-code files refuse remote setup (never fail-open).

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::setup_wizard_open;

const SETUP_FORBIDDEN: &str = "This setup step needs a setup code. Open the setup screen on Luna itself, or enter the first eight characters (****-****) from your device code.";

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
    if is_loopback_request(addr, headers) {
        return Ok(());
    }

    if state.connect.is_connect_disabled() {
        return Ok(());
    }

    if state.connect.setup_prefix().is_none() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Remote setup is not available on this Luna. Finish setup on Luna itself (the screen plugged into it), or add a device code in Settings and try again.",
        ));
    }

    let token = headers
        .get("X-Setup-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state.connect.matches_setup_prefix(token) {
        return Err(json_error(StatusCode::FORBIDDEN, SETUP_FORBIDDEN));
    }
    Ok(())
}

pub fn is_loopback_request(addr: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    // Tunnel / reverse-proxy clients must not count as local even if the
    // immediate TCP peer is loopback (Caddy → lunad).
    if has_proxy_client_headers(headers) {
        return false;
    }
    match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn has_proxy_client_headers(headers: &HeaderMap) -> bool {
    headers.get("cf-connecting-ip").is_some()
        || headers.get("x-forwarded-for").is_some()
        || headers.get("x-real-ip").is_some()
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
    async fn remote_setup_allowed_when_connect_disabled() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("disable-connect"), b"").unwrap();
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
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
    }

    #[tokio::test]
    async fn remote_setup_without_code_file_is_forbidden() {
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
    }

    #[tokio::test]
    async fn loopback_setup_without_code_file_is_allowed() {
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
        std::fs::write(dir.path().join("setup-token"), "ABCD-EFGH-JKMN-PQRS-TVWX\n").unwrap();
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
    async fn validate_code_works_without_prior_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("setup-token"), "ABCD-EFGH-JKMN-PQRS-TVWX\n").unwrap();
        let app = app(dir.path());
        let bad = call(
            &app,
            Method::POST,
            "/api/v1/setup/validate-code",
            r#"{"code":"XXXX-YYYY"}"#,
            REMOTE,
            None,
        )
        .await;
        assert_eq!(bad.status(), StatusCode::FORBIDDEN);

        let good = call(
            &app,
            Method::POST,
            "/api/v1/setup/validate-code",
            r#"{"code":"ABCD-EFGH"}"#,
            REMOTE,
            None,
        )
        .await;
        assert_eq!(good.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn disable_connect_requires_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let denied = call(
            &app,
            Method::POST,
            "/api/v1/setup/disable-connect",
            "{}",
            REMOTE,
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let ok = call(
            &app,
            Method::POST,
            "/api/v1/setup/disable-connect",
            "{}",
            LOOPBACK,
            None,
        )
        .await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert!(dir.path().join("disable-connect").is_file());
    }

    #[tokio::test]
    async fn fetch_mag_peels_valid_code_from_assets() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            assets.join("TOKENS"),
            "BAD\nABCD-EFGH-JKMN-PQRS-TVWX\n",
        )
        .unwrap();
        std::env::set_var("LUNA_TEST_MAG_ASSETS", assets.to_str().unwrap());
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
        std::env::remove_var("LUNA_TEST_MAG_ASSETS");
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json.get("source").and_then(|v| v.as_str()), Some("mag"));
        assert_eq!(json.get("attempts").and_then(|v| v.as_u64()), Some(2));
        assert!(dir.path().join("setup-token").is_file());
    }
}
