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
        .route("/api/v1/system/scrub", get(scrub_status).post(start_scrub))
        .route("/api/v1/system/factory-reset", post(factory_reset))
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
        if full == ".luna-trash" || full.starts_with(".luna-trash/") {
            continue;
        }
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

async fn scrub_status(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let report = crate::db::get_meta(&conn, "last_scrub_report")
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read scrub status.",
            )
        })?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(json!({ "files_hashed": 0, "files_checked": 0, "mismatches": 0 }));
    Ok(Json(report))
}

async fn start_scrub(
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
        let mut total = crate::scrub::ScrubReport {
            files_checked: 0,
            files_hashed: 0,
            mismatches: 0,
            bytes_hashed: 0,
        };
        for drive in drives {
            if drive.state != "as_is" || drive.mount_point.is_empty() {
                continue;
            }
            let root = std::path::PathBuf::from(&drive.mount_point);
            if let Ok(report) = crate::scrub::hash_drive(&conn, &drive.id, &root) {
                total.files_hashed += report.files_hashed;
                total.bytes_hashed += report.bytes_hashed;
            }
            if let Ok(report) = crate::scrub::scrub_drive(&conn, &drive.id, &root) {
                total.files_checked += report.files_checked;
                total.mismatches += report.mismatches;
            }
        }
        let _ = crate::db::set_meta(
            &conn,
            "last_scrub_report",
            &serde_json::to_string(&total).unwrap_or_default(),
        );
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is checking your files in the background." }),
    ))
}

/// Wipe all accounts, shares, and settings and return the box to first-run,
/// leaving the actual files on the drives untouched.
async fn factory_reset(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // Un-adopt every drive (remove the `.luna` marker and unmount Luna-owned
    // mounts) so the data is left intact but no longer owned by Luna.
    let drives = crate::db::list_drives(&conn).unwrap_or_default();
    for drive in drives {
        if !drive.mount_point.is_empty() {
            let _ = std::fs::remove_file(std::path::Path::new(&drive.mount_point).join(".luna"));
            let _ = state.drive_manager.eject(&conn, &drive.id);
        }
    }
    crate::db::factory_reset(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish the reset. Try again.",
        )
    })?;
    // Regenerate the JWT signing secret for the new first-run.
    let _ = crate::auth::AuthService::ensure_secret(&conn);
    Ok(Json(
        json!({ "ok": true, "message": "Luna has been reset. Set it up again from the start." }),
    ))
}
