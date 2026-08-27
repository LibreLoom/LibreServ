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

// A destination folder path never needs to come close to this.
const MAX_PATH_FIELD_BYTES: usize = 4 * 1024;

/// Reads a multipart text field with a hard cap so an oversized field cannot
/// exhaust memory before validation. A mid-stream read error, truncation, or
/// invalid UTF-8 fails the whole field rather than accepting a partial destination.
async fn read_bounded_text(
    field: &mut axum::extract::multipart::Field<'_>,
    max: usize,
) -> Result<String, (StatusCode, Json<Value>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(128);
    while let Some(chunk) = field.chunk().await.map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't read the upload destination.",
        )
    })? {
        if buf.len() + chunk.len() > max {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That upload destination is too long.",
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That upload destination is not valid text.",
        )
    })
}

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

#[derive(Deserialize)]
struct RestoreBody {
    path: String,
    dest: String,
}

#[derive(Deserialize)]
struct PurgeBody {
    path: String,
}

pub fn router() -> Router<AppState> {
    // Multipart is streamed to disk, but the body limit still bounds DoS.
    // Sized from MemAvailable; floor matches the web client's 32 MiB switchover.
    let multipart_max = crate::budget::limits().multipart_upload_bytes;
    Router::new()
        .route("/api/v1/drives/{id}/files", get(list).delete(delete_entry))
        .route("/api/v1/drives/{id}/files/rename", post(rename_entry))
        .route("/api/v1/drives/{id}/files/restore", post(restore_entry))
        .route("/api/v1/drives/{id}/files/purge", post(purge_entry))
        .route("/api/v1/drives/{id}/trash", get(list_trash))
        .route("/api/v1/drives/{id}/files/content", get(content))
        .route(
            "/api/v1/drives/{id}/files/upload",
            post(upload).layer(DefaultBodyLimit::max(multipart_max)),
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

    let mut file = {
        let drive =
            with_db(&state, |conn| crate::files::drive_root(conn, &id)).map_err(map_files_err)?;
        let root = std::path::PathBuf::from(&drive.mount_point);
        // Open the file against a re-verified descriptor so a mid-request
        // symlink swap on the drive cannot read outside the jail.
        let (file, _) = luna_core::path::open_verified(&root, &rel).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this file. Try again.",
            )
        })?;
        tokio::fs::File::from_std(file)
    };

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
    if files::is_internal_temp(&name) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ));
    }
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let disposition =
        if query.download.as_deref() == Some("1") || !files::inline_safe(mime.as_ref()) {
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
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                files::content_disposition_filename(&name)
            ),
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

async fn list_trash(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    check_access(&state, &user, &id, ".luna-trash", false)?;
    let entries = with_db(&state, |conn| files::list_trash(conn, &id)).map_err(map_files_err)?;
    Ok(Json(
        entries
            .into_iter()
            .map(|e| {
                json!({
                    "name": e.name,
                    "kind": e.kind,
                    "size": e.size,
                    "modified": e.modified,
                    "path": format!(".luna-trash/{}", e.name),
                    "original_name": files::original_name_from_trash(&e.name),
                })
            })
            .collect(),
    ))
}

async fn restore_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RestoreBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(&state, &user, &id, &body.path, true)?;
    check_access(&state, &user, &id, &body.dest, true)?;
    with_db(&state, |conn| {
        files::restore_from_trash(conn, &id, &body.path, &body.dest)
    })
    .map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already there. Choose another name.",
        ),
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::InvalidInput => json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only put files back from the trash on this drive.",
        ),
        other => map_files_err(other),
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn purge_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PurgeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(&state, &user, &id, &body.path, true)?;
    with_db(&state, |conn| files::purge_trash(conn, &id, &body.path)).map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::InvalidInput => json_error(
            StatusCode::BAD_REQUEST,
            "Luna only permanently removes files that are already in the trash.",
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
    let query_path = query.path.unwrap_or_default();
    let mut dest_rel = query_path.clone();
    check_access(&state, &user, &id, &dest_rel, true)?;
    let overwrite = query.overwrite.as_deref() == Some("1");

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "Luna couldn't read this upload."))?
    {
        match field.name() {
            Some("path") => {
                dest_rel = read_bounded_text(&mut field, MAX_PATH_FIELD_BYTES).await?;
                if !query_path.is_empty() && dest_rel != query_path {
                    return Err(json_error(
                        StatusCode::FORBIDDEN,
                        "You don't have permission to change this folder.",
                    ));
                }
                check_access(&state, &user, &id, &dest_rel, true)?;
            }
            Some("file") => {
                check_access(&state, &user, &id, &dest_rel, true)?;
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
                    if let Ok(conn) = state.db.lock() {
                        files::note_write_failure(&conn, &id, &e.to_string());
                    }
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Luna couldn't save this file. {}", plain_upload_error(&e)),
                    ));
                }
                if let Err(e) = files::install_temp(&temp, &dest, overwrite) {
                    let _ = tokio::fs::remove_file(&temp).await;
                    if let Ok(conn) = state.db.lock() {
                        files::note_write_failure(&conn, &id, &e.to_string());
                    }
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!(
                            "Luna couldn't finish saving this file. {}",
                            plain_upload_error(&anyhow::Error::from(e))
                        ),
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
    } else if text.contains("Operation not permitted")
        || text.contains("os error 1")
        || text.contains("not supported")
    {
        "This drive wouldn't accept the file. If it's a USB stick, try ejecting it and plugging it back in, then save again.".into()
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

    #[test]
    fn disposition_header_cannot_split() {
        let name = files::content_disposition_filename("a\r\nContent-Type: text/html");
        assert!(!name.contains('\r'));
        assert!(!name.contains('\n'));
        assert!(!name.contains(':'));
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use crate::api;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 11)),
        54321,
    );

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::upsert_drive(
            &conn,
            "photos",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        (dir, app)
    }

    fn json_req(
        method: Method,
        uri: &str,
        body: &str,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        if let Some(t) = csrf {
            builder = builder.header("x-csrf-token", t);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn auth_cookies(res: &axum::response::Response) -> (String, String) {
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (session, csrf)
    }

    fn cookie_header(session: &str, csrf: &str) -> String {
        format!("{session}; luna_csrf={csrf}")
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    async fn admin_and_sam(app: &axum::Router) -> (String, String, String) {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (admin_session, admin_csrf) = auth_cookies(&res);
        let admin_cookie = cookie_header(&admin_session, &admin_csrf);
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let sam_id = v["id"].as_str().unwrap().to_string();
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"sam","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (sam_session, sam_csrf) = auth_cookies(&res);
        (cookie_header(&sam_session, &sam_csrf), sam_csrf, sam_id)
    }

    #[tokio::test]
    async fn multipart_path_mismatch_is_forbidden() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g1", &sam_id, "photos", "family", "write").unwrap();
        }

        let boundary = "----luna";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nsecret\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=family")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(!mount.path().join("secret/x.txt").exists());
    }

    #[tokio::test]
    async fn oversized_multipart_path_field_is_refused() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g1", &sam_id, "photos", "family", "write").unwrap();
        }

        let boundary = "----luna";
        let big_path = "a".repeat(MAX_PATH_FIELD_BYTES + 1);
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{big_path}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=family")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(!mount.path().join("family/a/a/x.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn grant_symlink_list_is_forbidden() {
        use std::os::unix::fs::symlink;
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("secret/note.txt"), b"nope").unwrap();
        symlink(
            mount.path().join("secret"),
            mount.path().join("family/escape"),
        )
        .unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g1", &sam_id, "photos", "family", "read").unwrap();
        }
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/files?path=family/escape")
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }
}
