use axum::extract::{ConnectInfo, Extension, Request, State};
use axum::http::{StatusCode, header};
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
        .route("/api/v1/auth/me", get(me))
        .route("/api/v1/auth/status", get(status))
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
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
    let cookie = auth::session_cookie(&token);
    let bearer = token.clone();
    Ok((
        StatusCode::OK,
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(json!({
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "role": user.role,
            "token": bearer,
        })),
    )
        .into_response())
}

async fn logout() -> Response {
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            format!("{}=; Path=/; HttpOnly; Max-Age=0", auth::SESSION_COOKIE),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
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
