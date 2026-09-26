use axum::extract::{ConnectInfo, Extension, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError, CurrentUser};

#[derive(Deserialize)]
struct RegisterBody {
    username: String,
    display_name: Option<String>,
    password: String,
    setup_secret: Option<String>,
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/register", post(register))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/revoke-sessions", post(revoke_sessions))
        .route("/api/v1/auth/revoke-devices", post(revoke_devices))
        .route("/api/v1/auth/me", get(me).patch(update_me))
        .route("/api/v1/auth/status", get(status))
}

#[derive(Deserialize)]
struct UpdateMeBody {
    display_name: Option<String>,
    current_password: Option<String>,
    new_password: Option<String>,
}

/// Self-service profile: display name, and password change with the
/// current password as proof. Admins use the same endpoint; resetting
/// other people's passwords is an Admin action on /api/v1/users.
async fn update_me(
    State(state): State<AppState>,
    current: Option<Extension<CurrentUser>>,
    Json(body): Json<UpdateMeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let Some(Extension(user)) = current else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Sign in to Luna first.",
        ));
    };
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let mut changed_password = false;

    if let Some(name) = body.display_name.as_deref() {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Names are 1-80 characters.",
            ));
        }
        crate::db::set_user_display_name(&conn, &user.id, name).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that. Try again.",
            )
        })?;
    }

    if let Some(new_password) = body.new_password.as_deref() {
        let current_password = body.current_password.as_deref().unwrap_or("");
        state
            .auth
            .verify_password_for_user(&user.id, current_password)
            .map_err(|_| json_error(StatusCode::FORBIDDEN, "That's not your current password."))?;
        if let Err(e) = crate::password::validate_password(new_password) {
            return Err(json_error(StatusCode::BAD_REQUEST, e.message()));
        }
        if let Err(e) = crate::hibp::ensure_password_not_breached(new_password) {
            return Err(json_error(StatusCode::BAD_REQUEST, e.message()));
        }
        let hash = auth::hash_password(new_password).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that. Try again.",
            )
        })?;
        crate::db::set_user_password_hash(&conn, &user.id, &hash).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that. Try again.",
            )
        })?;
        // Every session and device token signed in with the old password is
        // suspect — sign them all out, this browser included.
        let _ = crate::db::bump_user_token_version(&conn, &user.id);
        let _ = crate::db::revoke_device_tokens_for_user(&conn, &user.id);
        changed_password = true;
    }

    let row = crate::db::get_user(&conn, &user.id).ok().flatten();
    Ok(Json(json!({
        "ok": true,
        "id": user.id,
        "username": user.username,
        "display_name": row.as_ref().map(|r| r.display_name.clone()).unwrap_or_default(),
        "role": user.role,
        "signed_out": changed_password,
        "message": if changed_password {
            "Password changed. Sign in again with your new password."
        } else {
            "Saved."
        },
    })))
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<CurrentUser>>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state
        .login_limiter
        .allow(&client_ip(&addr, &headers).to_string())
    {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    let has_users = state.auth.count_users().map_err(map_auth_err)? > 0;
    if has_users {
        let Some(Extension(user)) = current else {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "Sign in to Luna first.",
            ));
        };
        if user.role != "admin" {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only an Admin can manage accounts.",
            ));
        }
    } else if !is_lan_request(&addr, &headers) {
        // Setup is open on the LAN. Off it, the first login can only be
        // created by someone holding the full device token — the flow
        // Connect's onboarding finishes with.
        if let Err(msg) = first_user_device_token(&state, &body) {
            return Err(json_error(StatusCode::FORBIDDEN, msg));
        }
    }
    let user = state
        .auth
        .register(
            &body.username,
            body.display_name.as_deref().unwrap_or(&body.username),
            &body.password,
            "user",
        )
        .map_err(map_auth_err)?;
    if !has_users {
        let _ = state.connect.clear_first_user_secret();
    }
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
    })))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if !state
        .login_limiter
        .allow(&client_ip(&addr, &headers).to_string())
    {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    // Second bucket keyed on the account itself: behind the Connect tunnel
    // every request arrives from the same relay peer, so a shared-IP cap
    // alone either lets one attacker lock out every tunneled user or lets
    // them brute-force one account from rotating addresses. Ten tries per
    // window per username bounds both.
    if !state.login_limiter.allow(&login_user_key(&body.username)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    let (user, token) = state
        .auth
        .login(&body.username, &body.password)
        .map_err(map_auth_err)?;
    let secure = auth::request_is_https(&headers);
    let mut response = Json(json!({
        "ok": true,
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        auth::session_cookie(&token, secure).parse().unwrap(),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        auth::fresh_csrf_cookie(secure).parse().unwrap(),
    );
    Ok(response)
}

async fn logout(headers: HeaderMap) -> Response {
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            auth::clear_session_cookie(auth::request_is_https(&headers)),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn revoke_sessions(
    State(state): State<AppState>,
    current: Option<Extension<CurrentUser>>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(Extension(user)) = current else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Sign in to Luna first.",
        ));
    };
    state.auth.revoke_sessions(&user.id).map_err(map_auth_err)?;
    Ok((
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            auth::clear_session_cookie(auth::request_is_https(&headers)),
        )],
        Json(json!({
            "ok": true,
            "message": "Every browser is signed out. Sign in again on this one if you still need it.",
        })),
    )
        .into_response())
}

async fn revoke_devices(
    State(state): State<AppState>,
    current: Option<Extension<CurrentUser>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let Some(Extension(user)) = current else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Sign in to Luna first.",
        ));
    };
    state
        .auth
        .revoke_all_device_tokens(&user.id)
        .map_err(map_auth_err)?;
    Ok(Json(json!({
        "ok": true,
        "message": "Apps on phones and computers need a new access token.",
    })))
}

async fn me(State(state): State<AppState>, req: Request) -> Json<Value> {
    match auth::current_user(&req) {
        Some(user) => {
            let conn = match state.db.lock() {
                Ok(c) => c,
                Err(_) => {
                    return Json(json!({
                        "id": user.id,
                        "username": user.username,
                        "role": user.role,
                    }));
                }
            };
            let row = crate::db::get_user(&conn, &user.id).ok().flatten();
            let (display_name, home) = match &row {
                Some(row) => {
                    // Materialize the member's home on first visit — a fresh
                    // account lands on a real folder, not an empty state.
                    let home = crate::member_home::ensure(&conn, row)
                        .ok()
                        .flatten()
                        .map(|h| {
                            json!({
                                "drive_id": h.drive_id,
                                "path": h.rel,
                                "ready": h.ready,
                            })
                        });
                    (row.display_name.clone(), home)
                }
                None => (String::new(), None),
            };
            Json(json!({
                "id": user.id,
                "username": user.username,
                "display_name": display_name,
                "role": user.role,
                "home": home,
            }))
        }
        None => Json(Value::Null),
    }
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    let has_admin = state.auth.count_users().map(|n| n > 0).unwrap_or(false);
    Json(json!({
        "has_admin": has_admin,
        "connect_active": state.connect.is_connect_active(),
    }))
}

/// The client IP security decisions key on. `CF-Connecting-IP`,
/// `X-Real-IP`, and `X-Forwarded-For` are honored only when the TCP peer is
/// loopback — that is the Luna Connect tunnel or an on-box proxy forwarding
/// the real address. From any other peer those headers are the caller
/// inventing an identity (a spoofed "192.168.x.x" must not buy LAN trust
/// or a fresh lockout bucket).
pub(crate) fn client_ip(addr: &std::net::SocketAddr, headers: &HeaderMap) -> std::net::IpAddr {
    if addr.ip().is_loopback() {
        if let Some(ip) = headers
            .get("cf-connecting-ip")
            .or_else(|| headers.get("x-real-ip"))
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse().ok())
        {
            return ip;
        }
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.split(',').next())
            .and_then(|s| s.trim().parse().ok())
        {
            return ip;
        }
    }
    addr.ip()
}

fn ip_is_lan(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// Setup is open on the LAN: the first account may be created only by a
/// client on Luna's own network. Decided on the *resolved* client IP —
/// loopback/private/link-local counts, everything else needs the device
/// token. The Host header is deliberately ignored here: it is
/// client-supplied, so a remote caller claiming `luna.local` (or
/// `*.local`) must not win LAN trust. Every genuine LAN path — direct
/// connection, or a local proxy/tunnel forwarding the real address —
/// already resolves to a LAN client.
fn is_lan_request(addr: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    ip_is_lan(client_ip(addr, headers))
}

/// Per-account lockout bucket for `login` — namespaced so it never shares a
/// key with the IP-keyed buckets (an address can never look like `login-user:*`).
fn login_user_key(username: &str) -> String {
    format!(
        "login-user:{}",
        username
            .trim()
            .to_ascii_lowercase()
            .chars()
            .take(40)
            .collect::<String>()
    )
}

/// Off-LAN first-user registration: allowed only with the full device
/// token — either the one-time `first_user_secret` Connect hands out during
/// onboarding or the permanent token on this Luna. Empty secret → a plain
/// refusal that says where to set up instead.
fn first_user_device_token(state: &AppState, body: &RegisterBody) -> Result<(), String> {
    let offered = body.setup_secret.as_deref().unwrap_or("").trim();
    if offered.is_empty() {
        return Err(
            "Create the first login while you're on the same network as Luna — or paste the device token from connect.luna.libreloom.org, which proves you finished setup there.".into(),
        );
    }

    let norm_offered = crate::net::connect::normalize_setup_code(offered);

    // 1. Check against first_user_secret if set by Connect
    if let Some(want) = state.connect.first_user_secret() {
        let norm_want = crate::net::connect::normalize_setup_code(&want);
        if offered.eq_ignore_ascii_case(want.trim())
            || (!norm_offered.is_empty() && norm_offered == norm_want)
        {
            return Ok(());
        }
    }

    // 2. Check against the device token on disk
    if let Ok(device_code) = state.connect.device_code() {
        let norm_code = crate::net::connect::normalize_setup_code(&device_code);
        if offered.eq_ignore_ascii_case(device_code.trim())
            || (!norm_offered.is_empty() && norm_offered == norm_code)
        {
            return Ok(());
        }
    }

    // 3. In case Connect just updated, attempt a refresh poll
    let _ = state.connect.poll_status();
    if let Some(want) = state.connect.first_user_secret() {
        let norm_want = crate::net::connect::normalize_setup_code(&want);
        if offered.eq_ignore_ascii_case(want.trim())
            || (!norm_offered.is_empty() && norm_offered == norm_want)
        {
            return Ok(());
        }
    }

    Err("That device token doesn't match. Paste the device token from connect.luna.libreloom.org, or check the card that came with Luna.".into())
}

fn map_auth_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::BadLogin => json_error(
            StatusCode::UNAUTHORIZED,
            "That username or password is wrong.",
        ),
        AuthError::BadUsername => json_error(
            StatusCode::BAD_REQUEST,
            "Usernames are 3-32 letters, numbers, dots, dashes, or underscores.",
        ),
        AuthError::PasswordPolicy(msg) => json_error(StatusCode::BAD_REQUEST, &msg),
        AuthError::Taken => json_error(StatusCode::CONFLICT, "That username is already taken."),
        AuthError::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "Only an Admin can manage accounts.")
        }
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't sign you in. Try again.",
        ),
    }
}

pub fn user_json(user: &crate::db::UserRow) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "home_drive_id": user.home_drive_id,
    })
}

pub fn current_or_null(req: &Request) -> Option<CurrentUser> {
    auth::current_user(req).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use std::net::SocketAddr;
    use tower::ServiceExt;

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        // Poll-refreshes must fail fast, not reach the real Connect service.
        let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
            dir.path(),
            Some("http://127.0.0.1:1".into()),
        ));
        (dir, state.with_connect(connect))
    }

    fn addr(ip: &str) -> SocketAddr {
        format!("{ip}:40000").parse().unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::header::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn client_ip_only_trusts_forwarding_headers_from_loopback() {
        // A remote peer inventing LAN headers keeps its real address.
        let h = headers(&[("x-forwarded-for", "192.168.1.9")]);
        assert_eq!(
            client_ip(&addr("203.0.113.7"), &h),
            "203.0.113.7".parse::<std::net::IpAddr>().unwrap()
        );
        // Same header from the on-box tunnel/proxy resolves the real client.
        assert_eq!(
            client_ip(&addr("127.0.0.1"), &h),
            "192.168.1.9".parse::<std::net::IpAddr>().unwrap()
        );
        // CF-Connecting-IP and X-Real-IP outrank X-Forwarded-For.
        let h = headers(&[
            ("x-forwarded-for", "198.51.100.1"),
            ("x-real-ip", "198.51.100.2"),
        ]);
        assert_eq!(
            client_ip(&addr("127.0.0.1"), &h),
            "198.51.100.2".parse::<std::net::IpAddr>().unwrap()
        );
        // Nothing forwarded → the peer itself.
        let h = HeaderMap::new();
        assert_eq!(
            client_ip(&addr("127.0.0.1"), &h),
            "127.0.0.1".parse::<std::net::IpAddr>().unwrap()
        );
    }

    #[test]
    fn is_lan_request_cannot_be_spoofed() {
        // Real LAN peer.
        assert!(is_lan_request(&addr("192.168.1.20"), &HeaderMap::new()));
        // Remote peer spoofing LAN headers — never trusted.
        let h = headers(&[("x-forwarded-for", "10.0.0.5")]);
        assert!(!is_lan_request(&addr("203.0.113.7"), &h));
        let h = headers(&[("cf-connecting-ip", "10.0.0.5")]);
        assert!(!is_lan_request(&addr("203.0.113.7"), &h));
        // Remote peer claiming a LAN-only Host name.
        let h = headers(&[("host", "luna.local")]);
        assert!(!is_lan_request(&addr("203.0.113.7"), &h));
        // Tunnel peer forwarding a remote client → remote.
        let h = headers(&[("x-forwarded-for", "203.0.113.7")]);
        assert!(!is_lan_request(&addr("127.0.0.1"), &h));
        // Tunnel peer forwarding a client on Luna's own network → LAN.
        let h = headers(&[("x-forwarded-for", "192.168.4.9")]);
        assert!(is_lan_request(&addr("127.0.0.1"), &h));
    }

    async fn register_status(
        state: &AppState,
        peer: SocketAddr,
        header_pairs: &[(&str, &str)],
        body: &str,
    ) -> StatusCode {
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let mut req = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json");
        for (k, v) in header_pairs {
            req = req.header(*k, *v);
        }
        let mut http = req.body(axum::body::Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(peer));
        router.oneshot(http).await.unwrap().status()
    }

    const FIRST_USER: &str = r#"{"username":"max","password":"hunter22hunter1"}"#;

    #[tokio::test]
    async fn first_user_is_open_on_lan_and_closed_elsewhere() {
        let (_dir, state) = state();
        // LAN client creates the first login with no token.
        assert_eq!(
            register_status(&state, addr("192.168.1.30"), &[], FIRST_USER).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn first_user_from_internet_needs_the_device_token() {
        let (_dir, state) = state();
        // No Connect set up at all → nothing off-LAN can open setup.
        assert_eq!(
            register_status(&state, addr("203.0.113.7"), &[], FIRST_USER).await,
            StatusCode::FORBIDDEN
        );
        // Spoofed LAN headers do not help a remote peer.
        assert_eq!(
            register_status(
                &state,
                addr("203.0.113.7"),
                &[("x-forwarded-for", "192.168.1.5")],
                FIRST_USER
            )
            .await,
            StatusCode::FORBIDDEN
        );
        // Through the tunnel (loopback peer) the forwarded address is the
        // real one — a remote client still needs the token.
        assert_eq!(
            register_status(
                &state,
                addr("127.0.0.1"),
                &[("x-forwarded-for", "203.0.113.7")],
                FIRST_USER
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn first_user_off_lan_accepts_the_full_device_token() {
        let (_dir, state) = state();
        state
            .connect
            .set_oss_code("AAAA-BBBB-CCCC-DDDD-EEEE")
            .unwrap();
        let remote = addr("127.0.0.1");
        let fwd = [("x-forwarded-for", "203.0.113.7")];
        // Wrong token → refused.
        let body = r#"{"username":"max","password":"hunter22hunter1","setup_secret":"ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ"}"#;
        assert_eq!(
            register_status(&state, remote, &fwd, body).await,
            StatusCode::FORBIDDEN
        );
        // The full device token → first login created.
        let body = r#"{"username":"max","password":"hunter22hunter1","setup_secret":"AAAA-BBBB-CCCC-DDDD-EEEE"}"#;
        assert_eq!(
            register_status(&state, remote, &fwd, body).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn first_user_via_tunnel_from_a_lan_client_needs_no_token() {
        let (_dir, state) = state();
        // A household member browsing the public hostname from the sofa:
        // tunnel peer is loopback, forwarded client is on the LAN.
        assert_eq!(
            register_status(
                &state,
                addr("127.0.0.1"),
                &[("x-forwarded-for", "192.168.1.44")],
                FIRST_USER
            )
            .await,
            StatusCode::OK
        );
    }
}
