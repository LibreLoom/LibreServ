//! Revocable access tokens for apps, desktop, WebDAV, and helper scripts.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    /// Optional expiry in days from now (not required).
    expires_in_days: Option<u32>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/device-tokens", get(list).post(create))
        .route("/api/v1/device-tokens/{id}", delete(remove))
        .route("/api/v1/device-tokens/{id}/usage", get(usage))
}

fn token_row_json(dt: &crate::db::DeviceTokenRow) -> Value {
    json!({
        "id": dt.id,
        "name": dt.name,
        "created_at": dt.created_at,
        "last_used_at": dt.last_used_at,
        "expires_at": dt.expires_at,
        "revoked": dt.revoked_at.is_some(),
    })
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => json_error(StatusCode::FORBIDDEN, "Only an Admin can manage access tokens."),
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update access tokens. Try again.",
        ),
    }
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let tokens = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(Json(
        tokens
            .iter()
            .filter(|t| t.revoked_at.is_none())
            .map(token_row_json)
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Give this device a name between 1 and 80 characters.",
        ));
    }

    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't generate a token. Try again.",
            )
        })?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let id = Uuid::new_v4().to_string();
    let expires_at = body.expires_in_days.map(|days| {
        let secs = days.clamp(1, 3650) as i64 * 24 * 60 * 60;
        crate::db::now_unix() + secs
    });

    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    crate::db::insert_device_token(
        &conn,
        &id,
        &user.id,
        name,
        &auth::hash_device_token(&token),
        expires_at,
    )
    .map_err(AuthError::Db)
    .map_err(map_err)?;
    drop(conn);

    Ok(Json(json!({
        "id": id,
        "name": name,
        "created_at": crate::db::now_unix(),
        "last_used_at": 0,
        "expires_at": expires_at,
        "revoked": false,
        "token": token,
    })))
}

async fn usage(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let owned = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?
        .into_iter()
        .any(|t| t.id == id);
    if !owned {
        return Err(json_error(StatusCode::NOT_FOUND, "No such device token."));
    }
    let rows = crate::db::list_device_token_usage(&conn, &id, 50)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                json!({
                    "action": r.action,
                    "detail": r.detail,
                    "used_at": r.used_at,
                })
            })
            .collect(),
    ))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let owned = crate::db::list_device_tokens_for_user(&conn, &user.id)
        .map_err(AuthError::Db)
        .map_err(map_err)?
        .into_iter()
        .any(|t| t.id == id);
    if !owned {
        return Err(json_error(StatusCode::NOT_FOUND, "No such device token."));
    }
    crate::db::revoke_device_token(&conn, &id)
        .map_err(AuthError::Db)
        .map_err(map_err)?;
    Ok(StatusCode::NO_CONTENT)
}
