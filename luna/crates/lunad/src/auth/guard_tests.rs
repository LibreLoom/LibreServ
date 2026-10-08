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
/// A public-internet peer — off-LAN, so first registration needs the
/// device token. `client_ip` won't trust its forwarding headers.
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
    let (_dir, app) = test_app();
    let res = call(
        &app,
        req(
            Method::POST,
            "/api/v1/setup",
            Some(
                r#"{"current_step":"name","step_data":{"account_completed":true},"name":"Kitchen","setup_completed":true}"#,
            ),
            None,
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
async fn first_account_on_public_hostname_needs_setup_secret() {
    let (dir, _) = test_app();
    let connect =
        crate::net::connect::ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
    connect.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
    connect
        .apply_claimed(&serde_json::json!({
            "device_token": "tok",
            "hostname": "photos.luna.servers.libreloom.org",
            "tunnel_token": "mock",
            "setup_secret": "one-time-secret"
        }))
        .unwrap();
    let connect = std::sync::Arc::new(connect);
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = crate::AppState::new(conn, drive_manager, dir.path()).with_connect(connect.clone());
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state);

    // A genuinely remote client (public peer IP): the public hostname
    // alone no longer opens setup — the device token is the proof.
    let mut denied = from_remote(req(
        Method::POST,
        "/api/v1/auth/register",
        Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        None,
    ));
    denied
        .headers_mut()
        .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
    let res = call(&app, denied).await;
    assert_eq!(res.status(), 403, "{}", text(res).await);

    let mut via_query = from_remote(req(
        Method::POST,
        "/api/v1/auth/register?setup=one-time-secret",
        Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        None,
    ));
    via_query
        .headers_mut()
        .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
    let res = call(&app, via_query).await;
    assert_eq!(
        res.status(),
        403,
        "setup secret in the URL must not pass: {}",
        text(res).await
    );

    let mut via_cookie = from_remote(req(
        Method::POST,
        "/api/v1/auth/register",
        Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
        None,
    ));
    via_cookie
        .headers_mut()
        .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
    via_cookie
        .headers_mut()
        .insert("cookie", "luna_setup=one-time-secret".parse().unwrap());
    let res = call(&app, via_cookie).await;
    assert_eq!(
        res.status(),
        403,
        "setup secret in a cookie must not pass: {}",
        text(res).await
    );

    let mut ok = from_remote(req(
        Method::POST,
        "/api/v1/auth/register",
        Some(r#"{"username":"max","password":"hunter22hunter1","setup_secret":"one-time-secret"}"#),
        None,
    ));
    ok.headers_mut()
        .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
    let res = call(&app, ok).await;
    assert_eq!(res.status(), 200, "{}", text(res).await);
    assert!(
        connect.first_user_secret().is_none(),
        "first-user secret must be one-time"
    );
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

    let (action, detail) = categorize_api_request(&Method::GET, "/api/v1/gallery/d1");
    assert_eq!(action, "Photos");
    assert_eq!(detail, "Browsed photos");

    let (action, _) = categorize_api_request(&Method::GET, "/api/v1/search");
    assert_eq!(action, "Search");
}
