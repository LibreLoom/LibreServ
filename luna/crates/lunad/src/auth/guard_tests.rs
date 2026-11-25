//! Regression tests: the guard must attach a valid session to the request
//! even on public paths, so `/api/v1/auth/me` can report who is signed in.
//! (Before the fix, `me` always returned null, and the web UI lost its
//! sign-in state after finishing setup and after every login.)

use super::*;
use crate::api;
use crate::drives::DriveManager;
use crate::drives::mount::shared_mock;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request as HttpReq};
use tower::ServiceExt;

const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
    54321,
);
/// A public-internet peer — off-LAN, so first registration needs a setup
/// grant. `client_ip` won't trust its forwarding headers.
const REMOTE: std::net::SocketAddr = std::net::SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 9)),
    54321,
);

fn from_remote(mut r: HttpReq<Body>) -> HttpReq<Body> {
    r.extensions_mut().insert(ConnectInfo(REMOTE));
    r
}

fn test_app() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
        dir.path(),
        Some("http://127.0.0.1:1".into()),
    ));
    let state = crate::AppState::new(conn, drive_manager, dir.path()).with_connect(connect);
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state);
    (dir, app)
}

fn req(method: Method, uri: &str, body: Option<&str>, cookie: Option<&str>) -> HttpReq<Body> {
    req_with_csrf(method, uri, body, cookie, None)
}

fn req_with_csrf(
    method: Method,
    uri: &str,
    body: Option<&str>,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> HttpReq<Body> {
    let mut builder = HttpReq::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(t) = csrf {
        builder = builder.header("x-csrf-token", t);
    }
    let mut http = builder
        .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

fn auth_cookies(res: &axum::response::Response) -> (String, String) {
    let mut session = String::new();
    let mut csrf = String::new();
    for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
        let s = value.to_str().unwrap();
        let part = s.split(';').next().unwrap_or("");
        if part.starts_with("luna_session=") {
            session = part.to_string();
        } else if let Some(token) = part.strip_prefix("luna_csrf=") {
            csrf = token.to_string();
        }
    }
    (session, csrf)
}

fn cookie_header(session: &str, csrf: &str) -> String {
    if csrf.is_empty() {
        session.to_string()
    } else {
        format!("{session}; luna_csrf={csrf}")
    }
}

async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
    app.clone().oneshot(r).await.unwrap()
}

async fn text(res: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// Registers the first account and signs in. Returns the cookie header and the CSRF token.
async fn sign_in_first_admin(app: &axum::Router) -> (String, String) {
    let res = call(
        app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "register failed: {}", text(res).await);
    let res = call(
        app,
        req(
            Method::POST,
            "/api/v1/auth/login",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "login failed: {}", text(res).await);
    let (session, csrf) = auth_cookies(&res);
    (cookie_header(&session, &csrf), csrf)
}

/// Gives the signed-in account a recovery phrase the way the web does: the Luna id first, then
/// the phrase's public keys. The keys come from the shared test vectors; no real phrase is needed.
async fn seed_phrase(app: &axum::Router, cookie: &str, csrf: &str) {
    use base64::Engine;
    let res = call(
        app,
        req_with_csrf(
            Method::POST,
            "/api/v1/cloud/identity",
            None,
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "identity failed: {}", text(res).await);

    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../backup/cloud/vectors.json")).unwrap();
    let b64_of_hex = |hex: &str| {
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };
    let body = format!(
        r#"{{"seal_public":"{}","auth_public":"{}","self_sealed":"AA=="}}"#,
        b64_of_hex(vectors["seal_public"].as_str().unwrap()),
        b64_of_hex(vectors["auth_public"].as_str().unwrap()),
    );
    let res = call(
        app,
        req_with_csrf(
            Method::PUT,
            "/api/v1/cloud/phrase",
            Some(&body),
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "set phrase failed: {}", text(res).await);
}

#[tokio::test]
async fn me_reports_the_signed_in_session() {
    let (_dir, app) = test_app();

    // No session -> null.
    let res = call(&app, req(Method::GET, "/api/v1/auth/me", None, None)).await;
    assert_eq!(res.status(), 200);
    assert_eq!(text(res).await, "null");

    // Create the first account (setup mode) and log in.
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "register failed: {}", text(res).await);

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/login",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "login failed: {}", text(res).await);
    let (session, _csrf) = auth_cookies(&res);
    assert!(
        session.starts_with("luna_session="),
        "login must set session cookie, got {:?}",
        res.headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap_or(""))
            .collect::<Vec<_>>()
    );

    // The session must be visible to /auth/me — this is what keeps the
    // web UI signed in after setup and across page reloads.
    let res = call(
        &app,
        req(Method::GET, "/api/v1/auth/me", None, Some(&session)),
    )
    .await;
    assert_eq!(res.status(), 200);
    let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(v["username"], "max");
    assert_eq!(v["role"], "admin");
}

#[tokio::test]
async fn adding_users_requires_a_signed_in_admin() {
    let (_dir, app) = test_app();

    // First account is open (setup mode), then log in.
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/login",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    let (session, csrf) = auth_cookies(&res);
    let cookie = cookie_header(&session, &csrf);

    // Anonymous second account -> sign in first.
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"sam","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 401);

    // A signed-in admin can add a household member.
    let res = call(
        &app,
        req_with_csrf(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"sam","password":"hunter22hunter1"}"#),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(
        res.status(),
        200,
        "admin register failed: {}",
        text(res).await
    );
    let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(v["role"], "user");
}

#[tokio::test]
async fn data_endpoints_still_require_a_session() {
    let (_dir, app) = test_app();
    let res = call(&app, req(Method::GET, "/api/v1/users", None, None)).await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn setup_post_requires_admin_once_an_account_exists() {
    let (_dir, app) = test_app();
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"name":"Kitchen"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(
        res.status(),
        200,
        "first-run setup is open: {}",
        text(res).await
    );

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"setup_completed":false}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 401);

    let get = call(&app, req(Method::GET, "/api/v1/setup", None, None)).await;
    assert_eq!(get.status(), 401);
}

#[tokio::test]
async fn spoofed_https_headers_do_not_mark_cookies_secure() {
    let (_dir, app) = test_app();
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // auth_cookies truncates at the first ';' — read the raw Set-Cookie to
    // see the Secure flag.
    let session_cookie = |res: &axum::response::Response| {
        res.headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap_or("").to_string())
            .find(|s| s.starts_with("luna_session="))
            .expect("login sets a session cookie")
    };

    // A remote peer inventing `X-Forwarded-Proto` — the guard strips it, so
    // the cookie must not be marked Secure. (Marking it would also make the
    // browser drop the cookie on the plain-http page it really got.)
    let mut r = req(
        Method::POST,
        "/api/v1/auth/login",
        Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        None,
    );
    r.headers_mut()
        .insert("x-forwarded-proto", "https".parse().unwrap());
    let res = call(&app, from_remote(r)).await;
    assert_eq!(res.status(), 200);
    let session = session_cookie(&res);
    assert!(!session.contains("; Secure"), "{session}");

    // From a loopback peer — the tunnel or an on-box proxy — the header is
    // genuine and the cookie is marked Secure.
    let mut r = req(
        Method::POST,
        "/api/v1/auth/login",
        Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        None,
    );
    r.headers_mut()
        .insert("x-forwarded-proto", "https".parse().unwrap());
    let res = call(&app, r).await;
    assert_eq!(res.status(), 200);
    let session = session_cookie(&res);
    assert!(session.contains("; Secure"), "{session}");
}

#[tokio::test]
async fn network_status_public_while_setup_incomplete_even_with_user() {
    let (_dir, app) = test_app();

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"devadmin","password":"hunter22hunter"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "register failed: {}", text(res).await);

    let res = call(&app, req(Method::GET, "/api/v1/network/status", None, None)).await;
    assert_eq!(
        res.status(),
        200,
        "network status must stay public during setup: {}",
        text(res).await
    );
    let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert!(v.get("ethernet_connected").is_some());

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"setup_completed":true}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 401);

    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/auth/login",
            Some(r#"{"username":"devadmin","password":"hunter22hunter"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (session, csrf) = auth_cookies(&res);
    let cookie = cookie_header(&session, &csrf);

    // Finishing setup needs the Admin's recovery phrase first.
    seed_phrase(&app, &cookie, &csrf).await;

    // The CSRF guard (added after this test was written) requires the
    // double-submit token on cookie-authenticated mutations — pass it.
    let res = call(
        &app,
        req_with_csrf(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"setup_completed":true}"#),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    let res = call(&app, req(Method::GET, "/api/v1/network/status", None, None)).await;
    assert_eq!(
        res.status(),
        401,
        "network status requires a session after setup: {}",
        text(res).await
    );
}

#[tokio::test]
async fn setup_progress_saves_and_resumes_before_account() {
    let (_dir, app) = test_app();
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"current_step":"network","step_data":{"network_connected":false}}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "{}", text(res).await);

    let get = call(&app, req(Method::GET, "/api/v1/setup", None, None)).await;
    assert_eq!(get.status(), 200);
    let body: serde_json::Value = serde_json::from_str(&text(get).await).unwrap();
    assert_eq!(body["current_step"], "network");
    assert_eq!(body["step_data"]["network_connected"], false);
    assert_eq!(body["setup_completed"], false);
}

#[tokio::test]
async fn remote_wizard_saves_every_step_before_account_but_cannot_finish() {
    let (_dir, app) = test_app();
    // Exactly what the wizard posts: Begin setup, then preflight pass.
    for (step, data) in [
        ("preflight", r#"{"network_connected":true}"#),
        (
            "account",
            r#"{"network_connected":true,"preflight_passed":true}"#,
        ),
    ] {
        let body = format!(r#"{{"current_step":"{step}","step_data":{data}}}"#);
        let res = call(
            &app,
            from_remote(req(Method::POST, "/api/v1/setup", Some(&body), None)),
        )
        .await;
        assert_eq!(res.status(), 200, "{step}: {}", text(res).await);
    }
    // A refresh resumes where it left off.
    let get = call(
        &app,
        from_remote(req(Method::GET, "/api/v1/setup", None, None)),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&text(get).await).unwrap();
    assert_eq!(body["current_step"], "account");
    assert_eq!(body["step_data"]["preflight_passed"], true);
    // But a remote caller still can't close the wizard or name Luna.
    for body in [r#"{"setup_completed":true}"#, r#"{"name":"Kitchen"}"#] {
        let res = call(
            &app,
            from_remote(req(Method::POST, "/api/v1/setup", Some(body), None)),
        )
        .await;
        assert_eq!(res.status(), 403, "{body}");
    }
}

#[tokio::test]
async fn setup_progress_rejects_unknown_step() {
    let (_dir, app) = test_app();
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"current_step":"smtp"}"#),
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn completing_setup_clears_step_data() {
    const FINISH: &str = r#"{"current_step":"name","step_data":{"account_completed":true},"name":"Kitchen","setup_completed":true}"#;
    let (_dir, app) = test_app();

    // (a) No account yet: setup can't finish, and the wizard is told to make one first.
    let res = call(&app, req(Method::POST, "/api/v1/setup", Some(FINISH), None)).await;
    assert_eq!(res.status(), 409, "{}", text(res).await);
    let body: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(
        body["error"],
        "Create your Luna account before you finish setup."
    );

    // (b) With an Admin, finishing works and clears the draft. No recovery phrase is needed:
    // it opens cloud backups, which are off until someone turns them on.
    let (cookie, csrf) = sign_in_first_admin(&app).await;
    let res = call(
        &app,
        req_with_csrf(
            Method::POST,
            "/api/v1/setup",
            Some(FINISH),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "{}", text(res).await);
    let body: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(body["setup_completed"], true);
    assert_eq!(body["current_step"], "done");
    assert_eq!(body["name"], "Kitchen");
    assert!(body["step_data"].as_object().unwrap().is_empty());
}

#[tokio::test]
async fn finishing_setup_needs_no_recovery_phrase() {
    let (_dir, app) = test_app();
    let (cookie, csrf) = sign_in_first_admin(&app).await;

    // Signed in with no phrase: setup still finishes. The phrase opens cloud backups,
    // which are off until someone turns them on, so it is asked for there instead.
    let res = call(
        &app,
        req_with_csrf(
            Method::POST,
            "/api/v1/setup",
            Some(r#"{"setup_completed":true}"#),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200, "{}", text(res).await);
    let body: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
    assert_eq!(body["setup_completed"], true);
}

#[tokio::test]
async fn lan_guard_uses_the_bound_credential_not_pairing_material() {
    let (dir, _, state) = test_app_with_state();
    std::fs::write(
        dir.path().join(crate::net::connect::DEVICE_UID_FILE),
        "7K4M2Q9XR8N36T5W1PZH\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(crate::net::connect::PAIRING_CODE_FILE),
        "A3F91C\n",
    )
    .unwrap();
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            lan_guard,
        ))
        .with_state(state.clone());
    let lan_request = || {
        let mut request = req(Method::GET, "/api/v1/auth/status", None, None);
        request.extensions_mut().insert(ConnectInfo(
            "192.168.1.44:54321"
                .parse::<std::net::SocketAddr>()
                .unwrap(),
        ));
        request
    };

    // UID and code alone keep Luna unbound and leave the LAN open.
    assert_eq!(call(&app, lan_request()).await.status(), 200);

    std::fs::write(
        dir.path()
            .join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    )
    .unwrap();
    state
        .connect
        .save(&serde_json::json!({
            "state": "bound",
            "bound": true,
            "paired": true,
            "hostname": "photos.luna.servers.libreloom.org",
            "tunnel_token": "mock-token",
            "tunnel_active": true,
        }))
        .unwrap();
    assert_eq!(call(&app, lan_request()).await.status(), 403);

    std::fs::write(dir.path().join(crate::net::connect::LAN_OVERRIDE_FILE), "").unwrap();
    assert_eq!(call(&app, lan_request()).await.status(), 200);
}

#[tokio::test]
async fn cross_origin_unsafe_requests_are_blocked() {
    let (_dir, app) = test_app();

    // Mismatched Origin on an unsafe method is refused before any auth
    // logic runs — this also covers login CSRF, since auth paths are just
    // as cookie-exposed as the data API.
    let mut r = req(Method::POST, "/api/v1/auth/login", Some("{}"), None);
    r.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    r.headers_mut()
        .insert("host", "luna.local".parse().unwrap());
    let res = call(&app, r).await;
    assert_eq!(res.status(), 403, "cross-origin POST must be refused");

    // Same authority (scheme may differ, explicit port must match) makes
    // it through the guard and into the handler.
    let mut r = req(Method::POST, "/api/v1/auth/login", Some("{}"), None);
    r.headers_mut()
        .insert("origin", "http://luna.local".parse().unwrap());
    r.headers_mut()
        .insert("host", "luna.local".parse().unwrap());
    let res = call(&app, r).await;
    assert_ne!(res.status(), 403, "same-origin POST must reach the handler");

    // Unsafe method without any Origin (curl, device tokens, WebDAV)
    // passes through untouched.
    let res = call(
        &app,
        req(Method::POST, "/api/v1/auth/login", Some("{}"), None),
    )
    .await;
    assert_ne!(res.status(), 403, "Origin-less POST must reach the handler");

    // Safe methods are never Origin-checked.
    let res = call(&app, req(Method::GET, "/api/v1/auth/me", None, None)).await;
    assert_eq!(res.status(), 200);
}

#[test]
fn parses_client_app_name() {
    let mut headers = HeaderMap::new();
    assert_eq!(client_app_name(&headers), "App or script");

    headers.insert(
        axum::http::header::USER_AGENT,
        "WebDAVFS/3.0.0 (03008000) Darwin/23.4.0 (arm64)"
            .parse()
            .unwrap(),
    );
    assert_eq!(client_app_name(&headers), "macOS Finder");

    headers.insert(
        axum::http::header::USER_AGENT,
        "Microsoft-WebDAV-Miniredir/10.0.19041".parse().unwrap(),
    );
    assert_eq!(client_app_name(&headers), "Windows Explorer");

    headers.insert(
        axum::http::header::USER_AGENT,
        "Luna Desktop/1.0.0".parse().unwrap(),
    );
    assert_eq!(client_app_name(&headers), "Luna Desktop");

    headers.insert(
        axum::http::header::USER_AGENT,
        "Luna-Android/1.2".parse().unwrap(),
    );
    assert_eq!(client_app_name(&headers), "Luna for Android");

    headers.insert(
        axum::http::header::USER_AGENT,
        "Luna-iOS/1.4 iPhone15,2".parse().unwrap(),
    );
    assert_eq!(client_app_name(&headers), "Luna for iOS");

    headers.insert(
        axum::http::header::USER_AGENT,
        "rclone/v1.65.0".parse().unwrap(),
    );
    assert_eq!(client_app_name(&headers), "rclone");
}

#[test]
fn parses_client_origin_label() {
    let mut headers = HeaderMap::new();
    let local_addr: std::net::SocketAddr = "192.168.1.55:54321".parse().unwrap();
    assert_eq!(
        client_origin_label(Some(&local_addr), &headers, None),
        "Home network (192.168.1.55)"
    );

    let public_addr: std::net::SocketAddr = "93.184.216.34:12345".parse().unwrap();
    assert_eq!(
        client_origin_label(Some(&public_addr), &headers, None),
        "Remote (93.184.216.34)"
    );

    headers.insert("cf-connecting-ip", "203.0.113.195".parse().unwrap());
    // Tunnel request from different IP -> Remote via Connect
    assert_eq!(
        client_origin_label(
            Some(&local_addr),
            &headers,
            Some("198.51.100.1".parse().unwrap())
        ),
        "Remote via Connect (203.0.113.195)"
    );
    // Tunnel request from client on the SAME home network (matching Luna's WAN IP)
    assert_eq!(
        client_origin_label(
            Some(&local_addr),
            &headers,
            Some("203.0.113.195".parse().unwrap())
        ),
        "Home network (via Connect tunnel · 203.0.113.195)"
    );
}

#[test]
fn categorizes_api_requests() {
    let (action, detail) = categorize_api_request(&Method::POST, "/api/v1/uploads/chunk");
    assert_eq!(action, "File upload");
    assert_eq!(detail, "Uploaded files");

    let (action, detail) = categorize_api_request(&Method::GET, "/api/v1/files/d1/content");
    assert_eq!(action, "File download");
    assert_eq!(detail, "Downloaded file");

    let (action, detail) = categorize_api_request(&Method::GET, "/api/v1/photos/d1");
    assert_eq!(action, "Photos");
    assert_eq!(detail, "Browsed photos");

    let (action, _) = categorize_api_request(&Method::GET, "/api/v1/search");
    assert_eq!(action, "Search");
}

/// The refusal every closed route gives before Luna has its first account.
const NOT_SET_UP: &str = "Luna isn't set up yet. Finish setup first.";

fn test_app_with_state() -> (tempfile::TempDir, axum::Router, crate::AppState) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
        dir.path(),
        Some("http://127.0.0.1:1".into()),
    ));
    let state = crate::AppState::new(conn, drive_manager, dir.path()).with_connect(connect);
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state.clone());
    (dir, app, state)
}

#[test]
fn pre_setup_surface_lists_only_what_setup_calls() {
    let allowed = [
        (Method::GET, "/"),
        (Method::GET, "/setup"),
        (Method::GET, "/assets/index-abc.js"),
        (Method::GET, "/fonts/FreeMono.ttf"),
        (Method::GET, "/health"),
        (Method::GET, "/api/v1/health"),
        (Method::GET, "/api/v1/setup"),
        (Method::POST, "/api/v1/setup"),
        (Method::GET, "/api/v1/setup/preflight"),
        (Method::POST, "/api/v1/setup/fetch-mag"),
        (Method::POST, "/api/v1/auth/register"),
        (Method::POST, "/api/v1/auth/login"),
        (Method::POST, "/api/v1/auth/logout"),
        (Method::GET, "/api/v1/auth/status"),
        (Method::GET, "/api/v1/auth/me"),
        (Method::GET, "/api/v1/network/status"),
        (Method::GET, "/api/v1/connect/status"),
        (Method::POST, "/api/v1/connect/device-token"),
    ];
    for (method, path) in allowed {
        assert!(pre_setup_route_allowed(&method, path), "{method} {path}");
    }
    let refused = [
        (Method::GET, "/s/abc"),
        (Method::GET, "/s/abc/list"),
        (Method::POST, "/s/abc/respond"),
        (Method::POST, "/s/abc/upload"),
        (Method::GET, "/s/abc/collab/ws"),
        (Method::GET, "/s/office-bundle/k/b/Editor.bin"),
        (Method::GET, "/dav/photos/"),
        (Method::GET, "/eurooffice/doc/key/c/"),
        (Method::GET, "/sdkjs/word/sdk-all.js"),
        (Method::GET, "/drawio/index.html"),
        (Method::POST, "/api/v1/auth/revoke-sessions"),
        (Method::POST, "/api/v1/auth/revoke-devices"),
        (Method::PATCH, "/api/v1/auth/me"),
        (Method::DELETE, "/api/v1/connect/device-token"),
        (Method::GET, "/api/v1/public/anything"),
        (Method::GET, "/api/v1/users"),
        (Method::POST, "/api/v1/system/factory-reset"),
    ];
    for (method, path) in refused {
        assert!(!pre_setup_route_allowed(&method, path), "{method} {path}");
    }
}

#[tokio::test]
async fn before_the_first_account_setup_routes_still_answer() {
    let (_dir, app) = test_app();
    for (method, path) in [
        (Method::GET, "/api/v1/health"),
        (Method::GET, "/api/v1/setup"),
        (Method::GET, "/api/v1/setup/preflight"),
        (Method::GET, "/api/v1/auth/status"),
        (Method::GET, "/api/v1/auth/me"),
        (Method::GET, "/api/v1/network/status"),
        (Method::GET, "/api/v1/connect/status"),
    ] {
        let res = call(&app, req(method.clone(), path, None, None)).await;
        let status = res.status();
        let body = text(res).await;
        assert_ne!(status, 401, "{method} {path}: {body}");
        assert!(!body.contains(NOT_SET_UP), "{method} {path}: {body}");
    }
}

#[tokio::test]
async fn before_the_first_account_other_anonymous_routes_are_closed() {
    let (_dir, app) = test_app();
    for (method, path) in [
        (Method::GET, "/s/some-link-token"),
        (Method::GET, "/s/some-link-token/list"),
        (Method::POST, "/s/some-link-token/respond"),
        (Method::POST, "/api/v1/auth/revoke-sessions"),
        (Method::DELETE, "/api/v1/connect/device-token"),
    ] {
        let body = if method == Method::GET {
            None
        } else {
            Some("{}")
        };
        let res = call(&app, req(method.clone(), path, body, None)).await;
        let status = res.status();
        let body = text(res).await;
        assert_eq!(status, 403, "{method} {path}: {body}");
        assert!(body.contains(NOT_SET_UP), "{method} {path}: {body}");
    }
    // Data routes keep asking for a session, as before.
    let res = call(&app, req(Method::GET, "/api/v1/users", None, None)).await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn share_links_answer_again_once_an_account_exists() {
    let (_dir, app) = test_app();
    let res = call(&app, req(Method::GET, "/s/some-link-token", None, None)).await;
    assert_eq!(res.status(), 403);

    let _ = sign_in_first_admin(&app).await;
    let res = call(&app, req(Method::GET, "/s/some-link-token", None, None)).await;
    let status = res.status();
    let body = text(res).await;
    assert_ne!(status, 403, "{body}");
    assert!(!body.contains(NOT_SET_UP), "{body}");
}

#[tokio::test]
async fn webdav_is_closed_before_the_first_account_and_asks_for_a_sign_in_after() {
    let (_dir, app, state) = test_app_with_state();
    let dav = crate::files::dav::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            pre_setup_gate,
        ))
        .with_state(state.clone());
    let propfind = || {
        let mut r = HttpReq::builder()
            .method(Method::from_bytes(b"PROPFIND").unwrap())
            .uri("/dav/photos/")
            .body(Body::empty())
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(CLIENT));
        r
    };
    let res = call(&dav, propfind()).await;
    assert_eq!(res.status(), 403);
    assert!(text(res).await.contains(NOT_SET_UP));

    let _ = sign_in_first_admin(&app).await;
    let res = call(&dav, propfind()).await;
    assert_eq!(
        res.status(),
        401,
        "after setup WebDAV answers with its own sign-in"
    );
}
