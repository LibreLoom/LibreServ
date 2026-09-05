use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

#[derive(Deserialize)]
struct CreateProtection {
    source_drive_id: String,
    source_path: String,
    target_drive_id: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/protections", get(list).post(create))
        .route("/api/v1/protections/{id}", delete(remove))
        .route("/api/v1/protections/{id}/run", post(run))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage protected folders.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let rows = crate::db::list_protections(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list protected folders.",
        )
    })?;
    Ok(Json(
        rows.into_iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "source_drive": p.source_drive,
                    "source_path": p.source_path,
                    "target_drive": p.target_drive,
                    "target_path": p.target_path,
                    "last_run": p.last_run,
                })
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateProtection>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if !crate::auth::can_access(&user, &conn, &body.source_drive_id, &body.source_path, true) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to protect this folder.",
        ));
    }
    if !crate::auth::can_access(&user, &conn, &body.target_drive_id, "", true) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save on the second drive.",
        ));
    }
    let row = crate::protect::create(
        &conn,
        &body.source_drive_id,
        &body.source_path,
        &body.target_drive_id,
    )
    .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(json!({ "id": row.id, "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage protected folders.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    crate::db::delete_protection(&conn, &id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't remove this protection.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn run(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can run a protection now.",
        ));
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let Some(row) = crate::db::get_protection(&conn, &id).unwrap_or(None) else {
            return 0;
        };
        crate::protect::sync(&conn, &row).unwrap_or(0)
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is refreshing the protected copy." }),
    ))
}
