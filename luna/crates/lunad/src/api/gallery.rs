use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

const THUMB_CACHE_CONTROL: &str = "private, no-store";

#[derive(Deserialize)]
struct GalleryQuery {
    #[serde(default)]
    drive_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
struct ThumbQuery {
    drive_id: String,
    path: String,
}

#[derive(Deserialize, Default)]
struct ScanBody {
    #[serde(default)]
    drive_id: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/gallery", get(timeline))
        .route("/api/v1/gallery/thumb", get(thumb))
        .route("/api/v1/gallery/scan", post(scan))
}

async fn timeline(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<GalleryQuery>,
) -> Result<Json<Vec<crate::gallery::Photo>>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if let Some(drive_id) = query.drive_id.as_deref()
        && !crate::auth::has_drive_access(&user, &conn, drive_id)
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this drive.",
        ));
    }
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0);
    let photos = crate::gallery::list_photos(&conn, query.drive_id.as_deref(), limit, offset)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open the gallery.",
            )
        })?;
    let photos = photos
        .into_iter()
        .filter(|photo| crate::auth::can_access(&user, &conn, &photo.drive_id, &photo.path, false))
        .collect();
    Ok(Json(photos))
}

async fn scan(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<ScanBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let drive_ids = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if let Some(drive_id) = body.drive_id.as_deref() {
            if !crate::auth::has_drive_access(&user, &conn, drive_id) {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "You don't have permission to view this drive.",
                ));
            }
            vec![drive_id.to_string()]
        } else {
            crate::db::list_drives(&conn)
                .map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna couldn't list your drives.",
                    )
                })?
                .into_iter()
                .filter(|drive| crate::auth::has_drive_access(&user, &conn, &drive.id))
                .map(|drive| drive.id)
                .collect::<Vec<_>>()
        }
    };
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        // Resolve mounts under a short lock, then scan one drive at a time so
        // other API handlers can use the DB between drives.
        let mounts: Vec<(String, String)> = {
            let conn = db.lock().unwrap();
            drive_ids
                .into_iter()
                .filter_map(|drive_id| {
                    let drive = crate::db::get_drive(&conn, &drive_id).ok().flatten()?;
                    if drive.state != "as_is" || drive.mount_point.is_empty() {
                        return None;
                    }
                    Some((drive.id, drive.mount_point))
                })
                .collect()
        };
        for (id, mount) in mounts {
            let _ = crate::gallery::scan_drive(&db, &id, std::path::Path::new(&mount));
        }
    });
    Ok(Json(
        json!({ "started": true, "message": "Luna is building your photo gallery in the background." }),
    ))
}

async fn thumb(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ThumbQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let mount = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::can_access(&user, &conn, &query.drive_id, &query.path, false) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this.",
            ));
        }
        crate::db::get_drive(&conn, &query.drive_id)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this drive.",
                )
            })?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know that drive."))?
            .mount_point
    };
    if mount.is_empty() {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This drive isn't mounted.",
        ));
    }
    let root = std::path::PathBuf::from(&mount);
    let thumb_path = crate::gallery::thumb_path(&root, &query.drive_id, &query.path);
    if !thumb_path.exists() {
        let (drive_id, path) = (query.drive_id.clone(), query.path.clone());
        let root2 = root.clone();
        tokio::task::spawn_blocking(move || -> Result<(), ()> {
            let src = luna_core::path::resolve_child(&root2, &path).map_err(|_| ())?;
            let dest = crate::gallery::thumb_path(&root2, &drive_id, &path);
            crate::gallery::ensure_thumb(&src, &dest).map_err(|_| ())?;
            Ok(())
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't build the thumbnail.",
            )
        })?
        .map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "Luna couldn't make a thumbnail for this photo.",
            )
        })?;
    }
    serve_thumb(thumb_path).await
}

async fn serve_thumb(path: std::path::PathBuf) -> Result<Response, (StatusCode, Json<Value>)> {
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let meta = std::fs::metadata(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "This thumbnail isn't ready yet."))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "image/jpeg")
        .header(axum::http::header::CONTENT_LENGTH, meta.len().to_string())
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CACHE_CONTROL, THUMB_CACHE_CONTROL)
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::THUMB_CACHE_CONTROL;
    #[test]
    fn thumbs_are_private() {
        assert_eq!(THUMB_CACHE_CONTROL, "private, no-store");
        assert!(!THUMB_CACHE_CONTROL.contains("public"));
    }
}
