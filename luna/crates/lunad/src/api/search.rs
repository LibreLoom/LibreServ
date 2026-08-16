use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/search", get(search))
        .route("/api/v1/system/reindex", post(reindex))
}

async fn search(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let q = query.q.trim();
    if q.len() < 2 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type at least 2 letters to search.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let rows = crate::index::search(&conn, q).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let mut out = Vec::new();
    for (drive_id, parent, name) in rows {
        let full = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        if crate::auth::can_access(&user, &conn, &drive_id, &full, false) {
            out.push(json!({ "drive_id": drive_id, "path": full, "name": name }));
        }
    }
    Ok(Json(out))
}

async fn reindex(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let drives = crate::db::list_drives(&conn).unwrap_or_default();
        let mut dirs = 0u64;
        for drive in drives {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            if let Ok(n) =
                crate::index::scan_drive(&conn, &drive.id, std::path::Path::new(&drive.mount_point))
            {
                dirs += n;
            }
        }
        dirs
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is reading your drives in the background." }),
    ))
}
