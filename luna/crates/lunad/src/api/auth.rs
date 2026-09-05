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
        .route("/api/v1/auth/me", get(me))
        .route("/api/v1/auth/status", get(status))
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<CurrentUser>>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.login_limiter.allow(&addr.ip().to_string()) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries. Wait a few minutes and try again.",
        ));
    }
    let has_users = state.auth.count_users().map_err(map_auth_err)? > 0;
    if !has_users {
        crate::setup_access::check(&state, &addr, &headers)?;
    }
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
    } else if let Err(msg) = first_user_on_public_host(&state, &headers, &body) {
        return Err(json_error(StatusCode::FORBIDDEN, msg));
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
    if !state.login_limiter.allow(&addr.ip().to_string()) {
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

async fn me(req: Request) -> Json<Value> {
    match auth::current_user(&req) {
        Some(user) => Json(json!({
            "id": user.id,
            "username": user.username,
            "role": user.role,
        })),
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

fn first_user_on_public_host(
    state: &AppState,
    headers: &HeaderMap,
    body: &RegisterBody,
) -> Result<(), String> {
    if !state.connect.is_connect_active() {
        return Ok(());
    }
    let Some(hostname) = state.connect.public_hostname() else {
        return Ok(());
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    if !host.eq_ignore_ascii_case(&hostname) {
        return Ok(());
    }
    let Some(want) = state.connect.first_user_secret() else {
        return Err(
            "Open this Luna from the address on its screen first. If you opened it from the internet, paste the device token from Luna Connect into the setup field.".into(),
        );
    };
    let offered = body.setup_secret.clone().unwrap_or_default();
    if offered != want {
        return Err(
            "This address is on the internet. Paste the device token from Luna Connect into the setup field, or open Luna from the address on its screen instead.".into(),
        );
    }
    Ok(())
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
        AuthError::Forbidden => json_error(StatusCode::FORBIDDEN, "Only an Admin can manage accounts."),
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
    })
}

pub fn current_or_null(req: &Request) -> Option<CurrentUser> {
    auth::current_user(req).cloned()
}
