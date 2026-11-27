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
    /// Off-LAN first-Admin proof: this Luna's device token.
    device_token: Option<String>,
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
    if let Some(name) = body.display_name.as_deref() {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Names are 1-80 characters.",
            ));
        }
    }
    // Password work happens BEFORE the db lock: the mutex is not reentrant
    // (AuthService calls would deadlock) and neither argon2 nor the breach
    // check's network call may run while it is held — or on the async worker.
    let mut new_hash = None;
    // True when the breach service could not answer, so the password was
    // allowed unchecked. The person is told about it in the response.
    let mut breach_check_unavailable = false;
    if let Some(new_password) = body.new_password.clone() {
        // The current-password proof is the same credential check login
        // performs, so it spends the same per-account bucket. Without this,
        // a stolen session or device token could guess the password at
        // Argon2 speed and then set a new one.
        if !state.login_limiter.allow(&login_user_key(&user.username)) {
            return Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many tries. Wait a few minutes and try again.",
            ));
        }
        let current_password = body.current_password.clone().unwrap_or_default();
        let stored_hash = {
            let conn = state.db.lock().map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna could not check your current password. Try again.",
                )
            })?;
            crate::db::get_user(&conn, &user.id)
                .map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna could not check your current password. Try again.",
                    )
                })?
                .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first."))?
                .password_hash
        };
        let (hash, unavailable) = tokio::task::spawn_blocking(move || {
            let parsed = argon2::password_hash::PasswordHash::new(&stored_hash).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna could not check your current password. Try again.",
                )
            })?;
            auth::verify_password_hash(&current_password, &parsed).map_err(|_| {
                json_error(StatusCode::FORBIDDEN, "That's not your current password.")
            })?;
            if let Err(e) = crate::password::validate_password(&new_password) {
                return Err(json_error(StatusCode::BAD_REQUEST, e.message()));
            }
            let breach = crate::hibp::check_password_breach(&new_password);
            if breach == crate::hibp::BreachCheck::Breached {
                return Err(json_error(
                    StatusCode::BAD_REQUEST,
                    crate::hibp::BREACHED_PASSWORD_MESSAGE,
                ));
            }
            let hash = auth::hash_password(&new_password).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna could not save your new password. Try again.",
                )
            })?;
            Ok((hash, breach == crate::hibp::BreachCheck::Unavailable))
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna could not change your password. Try again.",
            )
        })??;
        new_hash = Some(hash);
        breach_check_unavailable = unavailable;
    }

    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not save your changes. Try again.",
        )
    })?;
    let mut changed_password = false;

    if let Some(name) = body.display_name.as_deref() {
        crate::db::set_user_display_name(&conn, &user.id, name.trim()).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna could not save your name. Try again.",
            )
        })?;
    }

    if let Some(hash) = new_hash {
        crate::db::set_user_password_hash(&conn, &user.id, &hash).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna could not save your new password. Try again.",
            )
        })?;
        // Every session and device token signed in with the old password is
        // suspect — sign them all out, this browser included.
        let _ = crate::db::bump_user_token_version(&conn, &user.id);
        let _ = crate::db::revoke_device_tokens_for_user(&conn, &user.id);
        changed_password = true;
    }

    let row = crate::db::get_user(&conn, &user.id).ok().flatten();
    let mut response = json!({
        "ok": true,
        "id": user.id,
        "username": user.username,
        "display_name": row.as_ref().map(|r| r.display_name.clone()).unwrap_or_default(),
        "role": user.role,
        "signed_out": changed_password,
        "message": if changed_password {
            "Password changed. Every browser and app is now signed out."
        } else {
            "Saved."
        },
    });
    if breach_check_unavailable && let Some(object) = response.as_object_mut() {
        object.insert(
            "warning".to_string(),
            json!(crate::hibp::BREACH_CHECK_UNAVAILABLE_MESSAGE),
        );
    }
    Ok(Json(response))
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
    let has_users = state
        .auth
        .count_users()
        .map_err(|e| map_auth_err(e, "Luna could not create the account. Try again."))?
        > 0;
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
                "Only an Admin can add users.",
            ));
        }
    } else {
        // Anonymous first-account creation: a DNS-rebinding page makes its
        // Origin and Host agree on its own name, so only the Host allow-list
        // can tell Luna's own address from the attacker's.
        if !auth::setup_origin_allowed(&state, &headers) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Open Luna at its own address to create the first account.",
            ));
        }
        if !is_lan_request(&addr, &headers) {
            // Setup is open on the LAN. Off it, the person must hold this
            // Luna's device token before the account is made.
            if let Err(msg) = first_user_device_token(&state, &body) {
                return Err(json_error(StatusCode::FORBIDDEN, msg));
            }
        }
    }
    // Argon2 and the breach check's network call are blocking — off the
    // async worker.
    let auth = state.auth.clone();
    let username = body.username.clone();
    let display_name = body
        .display_name
        .clone()
        .unwrap_or_else(|| body.username.clone());
    // Checked here so a bad name gets the name message: the auth service
    // reports it as a bad username.
    let name_chars = display_name.trim().chars().count();
    if name_chars == 0 || name_chars > 80 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Names are 1-80 characters.",
        ));
    }
    let password = body.password.clone();
    let first_admin = !has_users;
    let (user, breach) = tokio::task::spawn_blocking(move || {
        if first_admin {
            auth.register_first_admin_with_breach_check(&username, &display_name, &password)
        } else {
            auth.register_with_breach_check(&username, &display_name, &password, "user")
        }
    })
    .await
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not create the account. Try again.",
        )
    })?
    .map_err(|e| map_auth_err(e, "Luna could not create the account. Try again."))?;
    let mut response = json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
    });
    if breach == crate::hibp::BreachCheck::Unavailable
        && let Some(object) = response.as_object_mut()
    {
        object.insert(
            "warning".to_string(),
            json!(crate::hibp::BREACH_CHECK_UNAVAILABLE_MESSAGE),
        );
    }
    Ok(Json(response))
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
    // Argon2 verification is CPU-bound — off the async worker.
    let auth = state.auth.clone();
    let (username, password) = (body.username.clone(), body.password.clone());
    let (user, token) = tokio::task::spawn_blocking(move || auth.login(&username, &password))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna could not sign you in. Try again.",
            )
        })?
        .map_err(|e| map_auth_err(e, "Luna could not sign you in. Try again."))?;
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
    state
        .auth
        .revoke_sessions(&user.id)
        .map_err(|e| map_auth_err(e, "Luna could not sign out every browser. Try again."))?;
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
        .map_err(|e| map_auth_err(e, "Luna could not sign out every app. Try again."))?;
    Ok(Json(json!({
        "ok": true,
        "message": "Every app is signed out. Your access tokens no longer work.",
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
            let display_name = row
                .as_ref()
                .map(|row| row.display_name.clone())
                .unwrap_or_default();
            // Whether this account has a recovery phrase yet. The web asks for one before the app opens.
            let phrase_set = crate::db::get_user_keys(&conn, &user.id)
                .ok()
                .flatten()
                .is_some();
            Json(json!({
                "id": user.id,
                "username": user.username,
                "display_name": display_name,
                "role": user.role,
                "phrase_set": phrase_set,
            }))
        }
        None => Json(Value::Null),
    }
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Json<Value> {
    let has_admin = state.auth.count_users().map(|n| n > 0).unwrap_or(false);
    Json(json!({
        "has_admin": has_admin,
        "connect_active": state.connect.is_connect_active(),
        // Without a device token, off-LAN setup cannot work at all.
        "device_token_set": state.connect.has_device_token(),
        // First registration from off the LAN needs the device token.
        "setup_off_lan": !has_admin && !is_lan_request(&addr, &headers),
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
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local()
        }
    }
}

/// Setup is open on the LAN: the first account may be created only by a
/// client on Luna's own network. Decided on the *resolved* client IP —
/// loopback/private/link-local counts, everything else needs the device token.
/// The Host header is deliberately ignored here: it is
/// client-supplied, so a remote caller claiming `luna.local` (or
/// `*.local`) must not win LAN trust. Every genuine LAN path — direct
/// connection, or a local proxy/tunnel forwarding the real address —
/// already resolves to a LAN client.
pub(crate) fn is_lan_request(addr: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    ip_is_lan(client_ip(addr, headers))
}

/// Re-checks the signed-in person's password before a step that can't be
/// undone (a reset, unbinding Luna Connect). Uses the same per-account tries
/// as signing in, so a signed-in session can't be used to guess it. `wrong`
/// is the refusal for a wrong password.
pub(crate) async fn confirm_password(
    state: &AppState,
    user: &CurrentUser,
    password: &str,
    wrong: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if !state.login_limiter.allow(&login_user_key(&user.username)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    // Argon2 verification is CPU-bound — off the async worker.
    let auth = state.auth.clone();
    let (user_id, password) = (user.id.clone(), password.to_string());
    tokio::task::spawn_blocking(move || auth.verify_password_for_user(&user_id, &password))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check your password. Try again.",
            )
        })?
        .map_err(|_| json_error(StatusCode::UNAUTHORIZED, wrong.to_string()))
}

/// Per-account lockout bucket for `login` — namespaced so it never shares a
/// key with the IP-keyed buckets (an address can never look like `login-user:*`).
pub(crate) fn login_user_key(username: &str) -> String {
    format!(
        "login-user:{}",
        auth::username_lookup_key(username)
            .chars()
            .take(40)
            .collect::<String>()
    )
}

/// Off-LAN first-user registration requires the device token, compared with
/// the saved `device-token` file (ignoring case and grouping, in constant
/// time). The rolling credential and the query string are not accepted.
fn first_user_device_token(state: &AppState, body: &RegisterBody) -> Result<(), String> {
    // An owed unbind means the old Connect account may still know this
    // token, so it proves nothing about who is setting Luna up.
    if state.connect.unbind_pending() {
        return Err(
            "Luna is still disconnecting from Luna Connect. Create the first account from the same network as Luna."
                .into(),
        );
    }
    // Connect is opt-in: with no token on this Luna, nothing can match.
    if !state.connect.has_device_token() {
        return Err(
            "This Luna has no device token. Create the first account from the same network as Luna."
                .into(),
        );
    }
    let Some(token) = body
        .device_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Err(
            "To create the first account from outside your home network, enter this Luna's device token from the quick-start guide. Or create it from the same network as Luna."
                .into(),
        );
    };
    if !state.connect.device_token_matches(token) {
        return Err(
            "That device token doesn't match this Luna. Check it against the quick-start guide and try again."
                .into(),
        );
    }
    Ok(())
}

/// `fallback` names the action that failed, for errors with no message of
/// their own.
fn map_auth_err(err: AuthError, fallback: &str) -> (StatusCode, Json<Value>) {
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
        _ => json_error(StatusCode::INTERNAL_SERVER_ERROR, fallback),
    }
}

pub fn user_json(user: &crate::db::UserRow) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
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
        state_at("http://127.0.0.1:1")
    }

    fn state_at(base_url: &str) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let connect = std::sync::Arc::new(crate::net::connect::ConnectService::new(
            dir.path(),
            Some(base_url.to_string()),
        ));
        (dir, state.with_connect(connect))
    }

    const TOKEN: &str = "7K4M2Q9XR8N36T5W1PZH";

    fn seed_token(state: &AppState) {
        state.connect.set_device_token(TOKEN).unwrap();
    }

    fn with_token(token: &str) -> String {
        format!(r#"{{"username":"max","password":"hunter22hunter1","device_token":"{token}"}}"#)
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
        // IPv6 link-local ethernet clients are LAN clients too.
        assert!(is_lan_request(&addr("[fe80::1234]"), &HeaderMap::new()));
        let h = headers(&[("x-forwarded-for", "fe80::1234")]);
        assert!(is_lan_request(&addr("127.0.0.1"), &h));
    }

    async fn register_status(
        state: &AppState,
        peer: SocketAddr,
        header_pairs: &[(&str, &str)],
        body: &str,
    ) -> StatusCode {
        register_status_at(state, peer, header_pairs, "/api/v1/auth/register", body).await
    }

    async fn register_status_at(
        state: &AppState,
        peer: SocketAddr,
        header_pairs: &[(&str, &str)],
        uri: &str,
        body: &str,
    ) -> StatusCode {
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let mut req = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri(uri)
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
    async fn concurrent_anonymous_registrations_create_only_the_first_admin() {
        let (_dir, state) = state();
        let (first, second) = tokio::join!(
            register_status(&state, addr("192.168.1.30"), &[], FIRST_USER),
            register_status(
                &state,
                addr("192.168.1.31"),
                &[],
                r#"{"username":"sam","password":"hunter22hunter1"}"#,
            ),
        );
        assert_ne!(first, second);
        assert!([first, second].contains(&StatusCode::OK));
        assert!([first, second].contains(&StatusCode::FORBIDDEN));
        assert_eq!(state.auth.count_users().unwrap(), 1);
    }

    #[tokio::test]
    async fn first_user_registration_rejects_a_rebinding_host() {
        let (_dir, state) = state();
        // A DNS-rebinding page makes Host and Origin agree on its own name;
        // only this allow-list can tell it from Luna's own address.
        assert_eq!(
            register_status(
                &state,
                addr("192.168.1.30"),
                &[("host", "evil.example:8090")],
                FIRST_USER
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn first_user_registration_rejects_a_cross_site_browser_request() {
        let (_dir, state) = state();
        assert_eq!(
            register_status(
                &state,
                addr("192.168.1.30"),
                &[
                    ("host", "luna.local:8090"),
                    ("sec-fetch-site", "cross-site"),
                ],
                FIRST_USER
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn first_user_registration_accepts_luna_addresses() {
        for host in ["luna.local:8090", "127.0.0.1:8090", "[::1]:8090"] {
            let (_dir, state) = state();
            assert_eq!(
                register_status(
                    &state,
                    addr("192.168.1.30"),
                    &[("host", host), ("sec-fetch-site", "same-origin")],
                    FIRST_USER
                )
                .await,
                StatusCode::OK,
                "{host}"
            );
        }
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
        // real one — a remote client still needs the device token.
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
    async fn first_user_off_lan_with_the_device_token_succeeds() {
        let (_dir, state) = state();
        seed_token(&state);
        // Case, grouping, and lookalike letters do not matter.
        let body = with_token("7k4m-2q9x-r8n3-6t5w-1pzh");
        assert_eq!(
            register_status(
                &state,
                addr("127.0.0.1"),
                &[("x-forwarded-for", "203.0.113.7")],
                &body
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(state.auth.count_users().unwrap(), 1);
    }

    #[tokio::test]
    async fn first_user_off_lan_with_a_wrong_or_missing_token_creates_no_account() {
        let (_dir, state) = state();
        seed_token(&state);
        let remote = addr("127.0.0.1");
        let fwd = [("x-forwarded-for", "203.0.113.7")];
        for body in [
            with_token("ZZZZYYYYXXXXWWWWVVVV"),
            with_token(""),
            with_token("7K4M"),
            FIRST_USER.to_string(),
        ] {
            assert_eq!(
                register_status(&state, remote, &fwd, &body).await,
                StatusCode::FORBIDDEN,
                "{body}"
            );
        }
        assert_eq!(state.auth.count_users().unwrap(), 0);
    }

    async fn register_body(
        state: &AppState,
        peer: SocketAddr,
        header_pairs: &[(&str, &str)],
        body: &str,
    ) -> (StatusCode, serde_json::Value) {
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
        let res = router.oneshot(http).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    #[tokio::test]
    async fn an_owed_connect_unbind_stops_the_device_token_proving_anything() {
        let (dir, state) = state();
        seed_token(&state);
        // A reset chose to disconnect, Connect didn't answer, the Admin skipped.
        std::fs::write(
            dir.path().join(crate::net::connect::UNBIND_PENDING_FILE),
            "{}",
        )
        .unwrap();
        assert!(state.connect.unbind_pending());
        let remote = addr("127.0.0.1");
        let fwd = [("x-forwarded-for", "203.0.113.7")];
        let (status, body) = register_body(&state, remote, &fwd, &with_token(TOKEN)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "the old account may know it");
        assert!(body.to_string().contains("still disconnecting"), "{body}");
        assert_eq!(state.auth.count_users().unwrap(), 0);
        // On the LAN, setup still works.
        assert_eq!(
            register_status(&state, addr("192.168.1.30"), &[], FIRST_USER).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn off_lan_setup_with_no_device_token_says_so() {
        let (_dir, state) = state();
        let (status, body) = register_body(
            &state,
            addr("127.0.0.1"),
            &[("x-forwarded-for", "203.0.113.7")],
            &with_token(TOKEN),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.to_string().contains("has no device token"), "{body}");
        // With a token on file the refusal is a different one.
        seed_token(&state);
        let (status, body) = register_body(
            &state,
            addr("127.0.0.1"),
            &[("x-forwarded-for", "203.0.113.7")],
            &with_token("ZZZZYYYYXXXXWWWWVVVV"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!body.to_string().contains("has no device token"), "{body}");
    }

    #[tokio::test]
    async fn auth_status_says_whether_a_device_token_is_set() {
        let (_dir, state) = state();
        let status = |state: AppState| async move {
            let router = axum::Router::new().merge(super::router()).with_state(state);
            let mut http = axum::http::Request::builder()
                .method(axum::http::Method::GET)
                .uri("/api/v1/auth/status")
                .body(axum::body::Body::empty())
                .unwrap();
            http.extensions_mut()
                .insert(ConnectInfo(addr("192.168.1.30")));
            let res = router.oneshot(http).await.unwrap();
            let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
                .await
                .unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };
        assert_eq!(status(state.clone()).await["device_token_set"], false);
        seed_token(&state);
        assert_eq!(status(state.clone()).await["device_token_set"], true);
    }

    #[tokio::test]
    async fn off_lan_setup_with_no_saved_token_is_refused_even_with_one_sent() {
        let (_dir, state) = state();
        assert_eq!(
            register_status(
                &state,
                addr("127.0.0.1"),
                &[("x-forwarded-for", "203.0.113.7")],
                &with_token(TOKEN)
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(state.auth.count_users().unwrap(), 0);
    }

    #[tokio::test]
    async fn setup_query_strings_and_the_rolling_credential_are_not_the_token() {
        let (dir, state) = state();
        seed_token(&state);
        std::fs::write(
            dir.path()
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
        )
        .unwrap();
        let remote = addr("127.0.0.1");
        let fwd = [("x-forwarded-for", "203.0.113.7")];
        assert_eq!(
            register_status_at(
                &state,
                remote,
                &fwd,
                &format!("/api/v1/auth/register?device_token={TOKEN}"),
                FIRST_USER
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            register_status(
                &state,
                remote,
                &fwd,
                r#"{"username":"max","password":"hunter22hunter1","auth_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#
            )
            .await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(state.auth.count_users().unwrap(), 0);
    }

    #[tokio::test]
    async fn lan_setup_needs_no_token_even_when_one_is_saved() {
        let (_dir, state) = state();
        seed_token(&state);
        assert_eq!(
            register_status(&state, addr("192.168.1.30"), &[], FIRST_USER).await,
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

    #[tokio::test]
    async fn me_reports_phrase_set() {
        let (_dir, state) = state();
        let user = state
            .auth
            .register("max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let me = |router: axum::Router| {
            let u = user.clone();
            async move {
                let mut http = axum::http::Request::builder()
                    .method(axum::http::Method::GET)
                    .uri("/api/v1/auth/me")
                    .body(axum::body::Body::empty())
                    .unwrap();
                http.extensions_mut().insert(CurrentUser {
                    id: u.id,
                    username: u.username,
                    role: u.role,
                });
                let res = router.oneshot(http).await.unwrap();
                let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
                    .await
                    .unwrap();
                serde_json::from_slice::<Value>(&bytes).unwrap()
            }
        };
        assert_eq!(me(router.clone()).await["phrase_set"], json!(false));
        {
            let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
            crate::db::set_user_keys(
                &conn,
                &crate::db::UserKeys {
                    user_id: user.id.clone(),
                    seal_public: vec![1; 32],
                    auth_public: vec![2; 32],
                    self_sealed: vec![3; 48],
                    phrase_set_at: 1,
                    last_checked_at: 0,
                    phrase_words: 12,
                },
            )
            .unwrap();
        }
        assert_eq!(me(router).await["phrase_set"], json!(true));
    }

    /// The current-password proof spends the same per-account bucket as
    /// login: guesses stop at ten, not at Argon2 speed.
    #[tokio::test]
    async fn password_guesses_share_the_login_lockout() {
        let (_dir, state) = state();
        let user = state
            .auth
            .register("max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let patch = |body: &'static str| {
            let router = router.clone();
            let u = user.clone();
            async move {
                let mut http = axum::http::Request::builder()
                    .method(axum::http::Method::PATCH)
                    .uri("/api/v1/auth/me")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap();
                http.extensions_mut().insert(CurrentUser {
                    id: u.id,
                    username: u.username,
                    role: u.role,
                });
                router.oneshot(http).await.unwrap()
            }
        };
        for _ in 0..10 {
            let res =
                patch(r#"{"current_password":"nope-not-it1","new_password":"hunter22hunter2"}"#)
                    .await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
        }
        let res =
            patch(r#"{"current_password":"nope-not-it1","new_password":"hunter22hunter2"}"#).await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        // The right password does not get a free pass through the lockout,
        // and the change never lands.
        let res =
            patch(r#"{"current_password":"hunter22hunter1","new_password":"hunter22hunter2"}"#)
                .await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(state.auth.login("max", "hunter22hunter1").is_ok());
    }

    #[tokio::test]
    async fn changing_own_password_finishes_and_rekeys_login() {
        // Regression: update_me used to hold the db mutex across the
        // AuthService password check — a guaranteed self-deadlock. The
        // timeout is the assertion that matters.
        let (_dir, state) = state();
        let user = state
            .auth
            .register("max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .with_state(state.clone());
        let patch = |body: &str| {
            let router = router.clone();
            let u = user.clone();
            let body = body.to_string();
            async move {
                let mut http = axum::http::Request::builder()
                    .method(axum::http::Method::PATCH)
                    .uri("/api/v1/auth/me")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap();
                // The guard inserts a bare CurrentUser — the
                // `Option<Extension<CurrentUser>>` extractor reads that.
                http.extensions_mut().insert(CurrentUser {
                    id: u.id,
                    username: u.username,
                    role: u.role,
                });
                tokio::time::timeout(std::time::Duration::from_secs(20), router.oneshot(http))
                    .await
                    .expect("PATCH /api/v1/auth/me must not deadlock")
                    .unwrap()
            }
        };
        // A wrong current password is refused — without hanging.
        let res =
            patch(r#"{"current_password":"nope-not-it1","new_password":"hunter22hunter2"}"#).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        // The right one rotates the stored hash.
        let res =
            patch(r#"{"current_password":"hunter22hunter1","new_password":"hunter22hunter2"}"#)
                .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(state.auth.login("max", "hunter22hunter2").is_ok());
        assert!(state.auth.login("max", "hunter22hunter1").is_err());
    }
}
