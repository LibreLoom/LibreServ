use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::auth::user_json;
use crate::api::response::json_error;
use crate::auth::AuthError;

#[derive(Deserialize)]
struct CreateUser {
    username: String,
    display_name: Option<String>,
    password: String,
    role: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/users", get(list).post(create))
        .route("/api/v1/users/{id}", delete(remove))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    let users = state.auth.list_users().map_err(map_err)?;
    Ok(Json(users.iter().map(user_json).collect()))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    let role = body.role.as_deref().unwrap_or("user");
    let user = state
        .auth
        .register(
            &body.username,
            body.display_name.as_deref().unwrap_or(&body.username),
            &body.password,
            role,
        )
        .map_err(map_err)?;
    Ok(Json(user_json(&user)))
}

async fn remove(
    State(state): State<AppState>,
    Extension(admin): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage users.",
        ));
    }
    if admin.id == id {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "You can't remove your own account.",
        ));
    }
    state.auth.delete_user(&id).map_err(map_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "Only an Admin can manage users.")
        }
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update users. Try again.",
        ),
    }
}
