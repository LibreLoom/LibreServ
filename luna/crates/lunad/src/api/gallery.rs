use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

#[derive(Deserialize)]
struct GalleryQuery {
    drive_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Deserialize)]
struct ThumbQuery {
    drive_id: String,
    path: String,
}

#[derive(Deserialize)]
struct ScanBody {
    drive_id: String,
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
    if !crate::auth::can_access(&user, &conn, &query.drive_id, "", false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this drive.",
        ));
    }
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0);
    let photos =
        crate::gallery::list_photos(&conn, &query.drive_id, limit, offset).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open the gallery.",
            )
        })?;
    Ok(Json(photos))
}

async fn scan(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<ScanBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::can_access(&user, &conn, &body.drive_id, "", false) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this drive.",
            ));
        }
    }
    let db = state.db.clone();
    let thumb_dir = state.thumb_dir.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        let Some(drive) = crate::db::get_drive(&conn, &body.drive_id).unwrap_or(None) else {
            return;
        };
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            return;
        }
        let _ = crate::gallery::scan_drive(
            &conn,
            &drive.id,
            std::path::Path::new(&drive.mount_point),
            &thumb_dir,
        );
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
    {
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
    }
    let thumb_path = crate::gallery::thumb_path(&state.thumb_dir, &query.drive_id, &query.path);
    if !thumb_path.exists() {
        let (db, thumb_dir) = (state.db.clone(), state.thumb_dir.clone());
        let (drive_id, path) = (query.drive_id.clone(), query.path.clone());
        tokio::task::spawn_blocking(move || -> Result<(), ()> {
            let conn = db.lock().map_err(|_| ())?;
            let drive = crate::db::get_drive(&conn, &drive_id)
                .map_err(|_| ())?
                .ok_or(())?;
            let src =
                luna_core::path::resolve_child(std::path::Path::new(&drive.mount_point), &path)
                    .map_err(|_| ())?;
            let dest = crate::gallery::thumb_path(&thumb_dir, &drive_id, &path);
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
        .header(
            axum::http::header::CACHE_CONTROL,
            "public, max-age=31536000, immutable",
        )
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
        .into_response())
}
