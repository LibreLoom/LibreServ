use axum::extract::{ConnectInfo, Extension, Query, Request, State};
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
    Query(query): Query<std::collections::HashMap<String, String>>,
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
                "Only an admin can do that.",
            ));
        }
    } else if let Err(msg) = first_user_on_public_host(&state, &headers, &query, &body) {
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
    let cookie = auth::session_cookie(&token, auth::request_is_https(&headers));
    Ok((
        StatusCode::OK,
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(json!({
            "ok": true,
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "role": user.role,
        })),
    )
        .into_response())
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
        "message": "Phones and computers must set up backup again.",
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
    Json(json!({ "has_admin": has_admin }))
}

fn first_user_on_public_host(
    state: &AppState,
    headers: &HeaderMap,
    query: &std::collections::HashMap<String, String>,
    body: &RegisterBody,
) -> Result<(), String> {
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
        return Err("Open this Luna from the address on its screen first, or add ?setup= from the Luna Connect page.".into());
    };
    let mut offered = body.setup_secret.clone().unwrap_or_default();
    if offered.is_empty() {
        offered = query.get("setup").cloned().unwrap_or_default();
    }
    if offered.is_empty()
        && let Some(c) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok())
    {
        for part in c.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("luna_setup=") {
                offered = v.to_string();
            }
        }
    }
    if offered != want {
        return Err("This address is on the internet. Use the one-time link from Luna Connect, or open Luna on your home Wi-Fi instead.".into());
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
        AuthError::BadPassword => json_error(
            StatusCode::BAD_REQUEST,
            "Passwords need at least 8 characters.",
        ),
        AuthError::Taken => json_error(StatusCode::CONFLICT, "That username is already taken."),
        AuthError::Forbidden => json_error(StatusCode::FORBIDDEN, "Only an admin can do that."),
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that. Try again.",
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
