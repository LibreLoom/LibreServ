use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};

#[derive(Deserialize)]
struct CreateGrant {
    user_id: String,
    drive_id: String,
    path: Option<String>,
    permission: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/grants", get(list).post(create))
        .route("/api/v1/grants/{id}", delete(remove))
        .route("/api/v1/me/access", get(my_access))
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
    let grants = if user.role == "admin" {
        crate::db::list_all_grants(&conn)
    } else {
        crate::db::list_grants_for_user(&conn, &user.id)
    }
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(
        grants
            .into_iter()
            .map(|g| {
                json!({
                    "id": g.id,
                    "user_id": g.user_id,
                    "drive_id": g.drive_id,
                    "path": g.path,
                    "permission": g.permission,
                })
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<auth::CurrentUser>,
    Json(body): Json<CreateGrant>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let permission = body.permission;
    if permission != "read" && permission != "write" {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Access is either read or read + write.",
        ));
    }
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let id = Uuid::new_v4().to_string();
    crate::db::insert_grant(
        &conn,
        &id,
        &body.user_id,
        &body.drive_id,
        body.path.as_deref().unwrap_or(""),
        &permission,
    )
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "id": id, "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(admin): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if admin.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    crate::db::delete_grant(&conn, &id).map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "ok": true })))
}

async fn my_access(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let grants =
        crate::db::list_grants_for_user(&conn, &user.id).map_err(|e| map_err(AuthError::Db(e)))?;
    let drives = crate::db::list_drives(&conn).map_err(|e| map_err(AuthError::Db(e)))?;
    let mut out = Vec::new();
    for grant in grants {
        let label = drives
            .iter()
            .find(|d| d.id == grant.drive_id)
            .map(|d| d.label.clone())
            .unwrap_or_else(|| grant.drive_id.clone());
        out.push(json!({
            "id": grant.id,
            "drive_id": grant.drive_id,
            "drive_label": label,
            "path": grant.path,
            "permission": grant.permission,
        }));
    }
    Ok(Json(out))
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
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
