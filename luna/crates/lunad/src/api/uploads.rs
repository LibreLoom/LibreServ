use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::{delete, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::files::parse_range;
use crate::api::response::json_error;
use crate::uploads::{self, UploadError};

const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024 * 1024; // 1 TiB

#[derive(Deserialize)]
struct CreateBody {
    drive_id: String,
    path: Option<String>,
    name: String,
    size: u64,
}

#[derive(Deserialize)]
struct CompleteQuery {
    overwrite: Option<String>,
    hash: Option<String>,
}

pub fn router() -> Router<AppState> {
    // Chunk bodies are fully buffered (`Bytes`). Size from MemAvailable so a
    // 2 GiB Wyse never accepts a 1 GiB chunk into RAM. Floor matches the web UI.
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    Router::new()
        .route(
            "/api/v1/uploads",
            post(create).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/v1/uploads/{id}",
            put(write_chunk).layer(DefaultBodyLimit::max(chunk_max)),
        )
        .route("/api/v1/uploads/{id}/complete", post(complete))
        .route("/api/v1/uploads/{id}", delete(cancel))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(
        &state,
        &user,
        &body.drive_id,
        body.path.as_deref().unwrap_or(""),
        true,
    )?;
    if body.size > MAX_FILE_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't accept files larger than 1 TB.",
        ));
    }
    let path = body.path.unwrap_or_default();
    let upload = with_db(&state, |conn| {
        uploads::create(conn, &body.drive_id, &path, &body.name, body.size)
    })
    .map_err(map_upload_err)?;
    Ok(Json(json!({
        "upload_id": upload.id,
        "received": upload.received,
        "size": upload.size,
        "name": upload.name,
    })))
}

async fn write_chunk(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id, true)?;
    let spec = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Each chunk needs a Content-Range header (bytes start-end/total).",
            )
        })?;

    // Content-Range for chunks is "bytes start-end/total". Strip the total —
    // the upload row's promised size is authoritative, not the client's claim.
    let range = spec
        .strip_prefix("bytes ")
        .and_then(|rest| rest.split('/').next())
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
    let (start, end) = parse_range(&format!("bytes={range}"), MAX_FILE_BYTES)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
    let expected = (end - start + 1) as usize;
    if body.len() != expected {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The chunk size doesn't match its range.",
        ));
    }
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    if body.len() > chunk_max {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That upload chunk is too large for the free memory on this Luna. Try a smaller piece, or free some space and try again.",
        ));
    }

    let received = uploads::write_chunk(&state.db, &id, start, &body).map_err(map_upload_err)?;
    Ok(Json(json!({ "upload_id": id, "received": received })))
}

async fn complete(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<CompleteQuery>,
) -> Result<Json<crate::files::FileEntry>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id, true)?;
    let overwrite = query.overwrite.as_deref() == Some("1");
    let (drive_id, rel) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let row = uploads::get_row(&conn, &id).map_err(map_upload_err)?;
        (
            row.drive_id,
            crate::gallery_indexer::join_rel(&row.path, &row.name),
        )
    };
    let entry = uploads::complete(&state.db, &id, overwrite, query.hash.as_deref())
        .map_err(map_upload_err)?;
    state.gallery.upsert(&drive_id, &rel);
    state.touch_io_activity();
    Ok(Json(entry))
}

async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id, true)?;
    uploads::cancel(&state.db, &id).map_err(map_upload_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn check_access(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
    write: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::can_access(user, &conn, drive_id, path, write) {
        Ok(())
    } else if write {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save here.",
        ))
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this folder.",
        ))
    }
}

fn check_upload_access(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    upload_id: &str,
    write: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let row = uploads::get_row(&conn, upload_id).map_err(map_upload_err)?;
    // Reuse this lock — do not call check_access (it would deadlock on the
    // non-reentrant Mutex).
    if crate::auth::can_access(user, &conn, &row.drive_id, &row.path, write) {
        Ok(())
    } else if write {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save here.",
        ))
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this folder.",
        ))
    }
}

fn with_db<T>(
    state: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, UploadError>,
) -> Result<T, UploadError> {
    let conn = state.db.lock().map_err(|_| UploadError::NotFound)?;
    f(&conn)
}

fn map_upload_err(err: UploadError) -> (StatusCode, Json<Value>) {
    match err {
        UploadError::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this upload.")
        }
        UploadError::NotActive => json_error(
            StatusCode::CONFLICT,
            "This upload is already finished or cancelled.",
        ),
        UploadError::SizeMismatch => json_error(
            StatusCode::BAD_REQUEST,
            "That chunk doesn't fit this upload.",
        ),
        UploadError::Files(crate::files::FilesError::UnknownDrive) => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive.")
        }
        UploadError::Files(crate::files::FilesError::Path(_)) => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't use that destination.")
        }
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            json_error(
                StatusCode::CONFLICT,
                "A file with this name is already here. Rename it or choose another.",
            )
        }
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == std::io::ErrorKind::NotADirectory =>
        {
            json_error(StatusCode::BAD_REQUEST, "That destination is not a folder.")
        }
        UploadError::Io(e) if e.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Rename it or choose another.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish this upload. Check the drive and try again.",
        ),
    }
}
