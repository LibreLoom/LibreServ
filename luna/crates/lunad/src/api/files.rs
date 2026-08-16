use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::response::json_error;
use crate::files::{self, FileEntry, FilesError};

const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct ListQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
struct ContentQuery {
    path: Option<String>,
    download: Option<String>,
}

#[derive(Deserialize)]
struct UploadQuery {
    path: Option<String>,
    overwrite: Option<String>,
}

#[derive(Deserialize)]
struct RenameBody {
    path: String,
    new_name: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drives/{id}/files", get(list).delete(delete_entry))
        .route("/api/v1/drives/{id}/files/rename", post(rename_entry))
        .route("/api/v1/drives/{id}/files/content", get(content))
        .route(
            "/api/v1/drives/{id}/files/upload",
            post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    check_access(&state, &user, &id, &rel, false)?;
    let entries =
        with_db(&state, |conn| files::list_dir(conn, &id, &rel)).map_err(map_files_err)?;
    Ok(Json(entries))
}

async fn content(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ContentQuery>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    check_access(&state, &user, &id, &rel, false)?;
    let (path, meta) =
        with_db(&state, |conn| files::file_path(conn, &id, &rel)).map_err(map_files_err)?;
    let total = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{total:x}-{modified:x}\"");

    if let Some(if_none_match) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match.split(',').any(|c| c.trim() == etag)
    {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(Body::empty())
            .unwrap());
    }

    let mut file = tokio::fs::File::open(&path).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open this file. Try again.",
        )
    })?;

    let (status, stream_len, content_range) =
        match headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
            Some(spec) => match parse_range(spec, total) {
                Some((start, end)) => (
                    StatusCode::PARTIAL_CONTENT,
                    end - start + 1,
                    Some(format!("bytes {start}-{end}/{total}")),
                ),
                None => {
                    return Err(json_error(
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        "Luna couldn't understand that download range.",
                    ));
                }
            },
            None => (StatusCode::OK, total, None),
        };

    if status == StatusCode::PARTIAL_CONTENT {
        let start = content_range
            .as_deref()
            .and_then(parse_range_start)
            .unwrap_or(0);
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't read this file. Try again.",
                )
            })?;
    }

    let stream = ReaderStream::new(file.take(stream_len));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("download"));
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let disposition = if query.download.as_deref() == Some("1") {
        "attachment"
    } else {
        "inline"
    };

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, stream_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(
            header::CONTENT_DISPOSITION,
            format!("{disposition}; filename=\"{}\"", name.replace('"', "")),
        );
    if let Some(range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, range);
    }
    Ok(builder.body(Body::from_stream(stream)).unwrap())
}

async fn delete_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    check_access(&state, &user, &id, &rel, true)?;
    let trash_path =
        with_db(&state, |conn| files::delete_to_trash(conn, &id, &rel)).map_err(map_files_err)?;
    Ok(Json(json!({ "ok": true, "trash_path": trash_path })))
}

async fn rename_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(&state, &user, &id, &body.path, true)?;
    with_db(&state, |conn| {
        files::rename(conn, &id, &body.path, &body.new_name)
    })
    .map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Choose another name.",
        ),
        other => map_files_err(other),
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn upload(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<FileEntry>, (StatusCode, Json<Value>)> {
    let mut dest_rel = query.path.unwrap_or_default();
    check_access(&state, &user, &id, &dest_rel, true)?;
    let overwrite = query.overwrite.as_deref() == Some("1");

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "Luna couldn't read this upload."))?
    {
        match field.name() {
            Some("path") => {
                dest_rel = field.text().await.map_err(|_| {
                    json_error(
                        StatusCode::BAD_REQUEST,
                        "Luna couldn't read the upload destination.",
                    )
                })?;
            }
            Some("file") => {
                let original = field.file_name().unwrap_or("file").to_string();
                let name = files::safe_name(&original).map_err(|_| {
                    json_error(
                        StatusCode::BAD_REQUEST,
                        "That file name can't be used. Try renaming it.",
                    )
                })?;
                let dir = with_db(&state, |conn| files::dest_dir(conn, &id, &dest_rel))
                    .map_err(map_files_err)?;
                let dest = dir.join(&name);
                if dest.exists() && !overwrite {
                    return Err(json_error(
                        StatusCode::CONFLICT,
                        "A file with this name is already here. Rename it or choose another.",
                    ));
                }

                let temp = files::temp_path(&dir);
                let result = stream_to_temp(&mut field, &temp).await;
                if let Err(e) = result {
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Luna couldn't save this file. {}", plain_upload_error(&e)),
                    ));
                }
                if let Err(e) = files::install_temp(&temp, &dest) {
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Luna couldn't finish saving this file. {e}"),
                    ));
                }
                let meta = std::fs::symlink_metadata(&dest).map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "The file saved, but Luna couldn't confirm it.",
                    )
                })?;
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                return Ok(Json(FileEntry {
                    name,
                    kind: "file".into(),
                    size: meta.len(),
                    modified,
                    hidden: false,
                }));
            }
            _ => {}
        }
    }

    Err(json_error(
        StatusCode::BAD_REQUEST,
        "Choose a file to upload first.",
    ))
}

async fn stream_to_temp(
    field: &mut axum::extract::multipart::Field<'_>,
    temp: &std::path::Path,
) -> anyhow::Result<()> {
    let mut out = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .await?;
    while let Some(chunk) = field.chunk().await? {
        out.write_all(&chunk).await?;
    }
    out.flush().await?;
    out.sync_all().await?;
    Ok(())
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
            "You don't have permission to change this folder.",
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
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, FilesError>,
) -> Result<T, FilesError> {
    let conn = state.db.lock().map_err(|_| FilesError::UnknownDrive)?;
    f(&conn)
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive.")
        }
        FilesError::Path(
            luna_core::path::PathError::Absolute | luna_core::path::PathError::Escape,
        ) => json_error(StatusCode::BAD_REQUEST, "Luna can't open that path."),
        FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ),
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
            json_error(StatusCode::BAD_REQUEST, "That path is not a folder.")
        }
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::InvalidInput => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't open that path.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read this drive. Make sure it's connected and try again.",
        ),
    }
}

fn plain_upload_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    if text.contains("No space left") || text.contains("no space") {
        "This drive is full. Free up space or choose another drive.".into()
    } else if text.contains("Read-only") || text.contains("read-only") {
        "This drive is read-only, so Luna can't save to it.".into()
    } else {
        "Check that the drive is connected and try again.".into()
    }
}

pub(crate) fn parse_range(spec: &str, total: u64) -> Option<(u64, u64)> {
    let rest = spec.strip_prefix("bytes=")?;
    if rest.contains(',') {
        return None;
    }
    let (start_s, end_s) = rest.split_once('-')?;
    if start_s.is_empty() {
        // suffix range: last N bytes
        let n: u64 = end_s.parse().ok()?;
        if n == 0 || total == 0 {
            return None;
        }
        let start = total.saturating_sub(n);
        return Some((start, total - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() {
        total.checked_sub(1)?
    } else {
        end_s.parse().ok()?
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

fn parse_range_start(content_range: &str) -> Option<u64> {
    let rest = content_range.strip_prefix("bytes ")?;
    let (start, _) = rest.split_once('-')?;
    start.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-10", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=999-1000", 1000), Some((999, 999)));
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("bytes=1000-", 1000), None);
    }
}
