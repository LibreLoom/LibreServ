use argon2::password_hash::rand_core::RngCore;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::{Component, Path as FsPath};
use uuid::Uuid;

use crate::AppState;
use crate::api::files::parse_range;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};
use crate::uploads::{self, UploadError};

/// Share permissions: `read` (view + download), `write` (view + download +
/// upload), `upload` (upload only, folders only).
pub const PERMISSION_READ: &str = "read";
pub const PERMISSION_WRITE: &str = "write";
pub const PERMISSION_UPLOAD: &str = "upload";

const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024 * 1024; // 1 TiB

#[derive(Deserialize)]
struct CreateShare {
    drive_id: String,
    path: String,
    password: Option<String>,
    expires_in_days: Option<u32>,
    permission: Option<String>,
}

#[derive(Deserialize)]
struct PublicQuery {
    /// Deprecated: passwords must use X-Share-Password (ignored if present).
    #[allow(dead_code)]
    password: Option<String>,
    /// Path relative to the shared file or folder (never `..`).
    path: Option<String>,
    /// Force a file download even when the browser asked for a web page.
    download: Option<u8>,
    /// Ask for share metadata (file name, permission) instead of the raw bytes.
    meta: Option<u8>,
}

#[derive(Deserialize)]
struct PublicUploadCreate {
    name: String,
    size: u64,
    /// Relative folder inside a folder share; ignored for file shares.
    path: Option<String>,
}

#[derive(Deserialize)]
struct PublicUploadCompleteQuery {
    overwrite: Option<String>,
    hash: Option<String>,
}

pub fn router() -> Router<AppState> {
    // Chunk bodies are fully buffered (`Bytes`); cap them like the signed-in
    // upload flow so a public link cannot exhaust RAM in one request.
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    Router::new()
        .route("/api/v1/shares", get(list).post(create))
        .route("/api/v1/shares/{id}", delete(remove))
        .route("/s/{token}", get(public))
        .route(
            "/s/{token}/upload",
            post(public_upload_create).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/s/{token}/upload/{id}",
            put(public_upload_chunk).layer(DefaultBodyLimit::max(chunk_max)),
        )
        .route(
            "/s/{token}/upload/{id}/complete",
            post(public_upload_complete),
        )
        .route("/s/{token}/upload/{id}", delete(public_upload_cancel))
}

/// Normalize a client-supplied share permission; anything unknown is `read`.
fn normalize_permission(raw: Option<&str>) -> &'static str {
    match raw {
        Some(PERMISSION_WRITE) => PERMISSION_WRITE,
        Some(PERMISSION_UPLOAD) => PERMISSION_UPLOAD,
        _ => PERMISSION_READ,
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
    let shares = crate::db::list_shares(&conn).map_err(|e| map_err(AuthError::Db(e)))?;
    let drives = crate::db::list_drives(&conn).map_err(|e| map_err(AuthError::Db(e)))?;
    let shares = if user.role == "admin" {
        shares
    } else {
        shares
            .into_iter()
            .filter(|s| s.created_by == user.id)
            .collect()
    };
    Ok(Json(
        shares
            .into_iter()
            .map(|s| {
                let drive_label = drives
                    .iter()
                    .find(|d| d.id == s.drive_id)
                    .map(|d| d.label.clone())
                    .unwrap_or_else(|| s.drive_id.clone());
                json!({
                    "id": s.id,
                    "drive_id": s.drive_id,
                    "drive_label": drive_label,
                    "path": s.path,
                    "has_password": !s.password_hash.is_empty(),
                    "expires_at": s.expires_at,
                    "created_by": s.created_by,
                    "permission": s.permission,
                })
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Json(body): Json<CreateShare>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let permission = normalize_permission(body.permission.as_deref());
    // A share is a public link to a file or folder, so the creator needs at
    // least read access to it — otherwise any user could link out other
    // people's drives they have never been granted. Links that let strangers
    // upload are write access, so minting them needs a write grant too: a
    // Member with Read-only access must not be able to open other people's
    // files up to the world.
    let requires_write = permission == PERMISSION_WRITE || permission == PERMISSION_UPLOAD;
    if !auth::can_access(&user, &conn, &body.drive_id, &body.path, requires_write) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            if requires_write {
                "You can only see this folder, so a link that lets people upload wouldn't be safe. Ask an Admin for upload access."
            } else {
                "You don't have permission to share this folder."
            },
        ));
    }
    // Validate the path resolves before creating the link.
    let (_resolved, meta) =
        crate::files::resolve_any(&conn, &body.drive_id, &body.path).map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Luna can't find that file or folder.",
            )
        })?;
    // Upload-only links are drop boxes: there is nothing to list or serve on
    // a single file, so they only make sense on a folder.
    if permission == PERMISSION_UPLOAD && meta.is_file() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Upload-only links need a folder. Pick a folder, or use Read only or Read and write.",
        ));
    }

    let token = generate_token();
    let token_hash = blake3::hash(token.as_bytes()).to_hex().to_string();
    let password_hash = match &body.password {
        Some(pw) if !pw.is_empty() => auth::hash_password(pw).map_err(map_err)?,
        _ => String::new(),
    };
    let expires_at = body.expires_in_days.map(|days| {
        let secs = days.clamp(1, 3650) as i64 * 24 * 60 * 60;
        crate::db::now_unix() + secs
    });
    let id = Uuid::new_v4().to_string();
    crate::db::insert_share(
        &conn,
        &id,
        &token_hash,
        &body.drive_id,
        &body.path,
        &password_hash,
        expires_at,
        permission,
        &user.id,
    )
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({
        "id": id,
        "url": format!("/s/{token}"),
        "token": token,
        "expires_at": expires_at,
        "permission": permission,
    })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let share = crate::db::list_shares(&conn)
        .map_err(|e| map_err(AuthError::Db(e)))?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this link."))?;
    if user.role != "admin" && share.created_by != user.id {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only the person who made this link can remove it.",
        ));
    }
    crate::db::delete_share(&conn, &id).map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({ "ok": true })))
}

/// Public share access. Browsers opening `/s/{token}` get the Luna page so a
/// household member sees files and a password box — not a raw data dump.
/// Apps and the page itself send `Accept: application/json` (or `download=1`)
/// to list a folder or stream a file. Password via `X-Share-Password` header only.
/// Optional `path=` walks inside a shared folder.
async fn public(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<PublicQuery>,
    headers: HeaderMap,
) -> axum::response::Response {
    if prefers_html(&headers) && query.download.unwrap_or(0) == 0 {
        return crate::staticweb::handle("");
    }
    let result: Result<axum::response::Response, (StatusCode, Json<Value>)> =
        public_inner(state, addr.ip().to_string(), token, query, headers).await;
    match result {
        Ok(response) => with_referrer_policy(response),
        Err(err) => with_referrer_policy(err.into_response()),
    }
}

fn with_referrer_policy(response: axum::response::Response) -> axum::response::Response {
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    axum::response::Response::from_parts(parts, body)
}

async fn public_inner(
    state: AppState,
    ip: String,
    token: String,
    query: PublicQuery,
    headers: HeaderMap,
) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    let share = resolve_public_share(&state, &ip, &token, &headers)?;
    // Upload-only links are drop boxes: never list or stream anything, and
    // never reveal the drive id or path (folder names can be sensitive).
    if share.permission == PERMISSION_UPLOAD {
        if query.path.as_deref().is_some_and(|p| !p.trim().is_empty()) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            ));
        }
        return Ok(Json(json!({
            "kind": "upload",
            "permission": PERMISSION_UPLOAD,
        }))
        .into_response());
    }
    // Keep the SQLite lock scoped to this block: the file-streaming await
    // below must not hold a MutexGuard across an await point.
    let (meta, drive_id, path_label, entries) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        let rel = child_under_share(&share.path, query.path.as_deref().unwrap_or("")).ok_or_else(
            || {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "That folder isn't part of this shared link.",
                )
            },
        )?;
        let (_resolved, meta) =
            crate::files::resolve_any(&conn, &share.drive_id, &rel).map_err(|_| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "The shared files aren't available right now.",
                )
            })?;
        let entries = if meta.is_dir() {
            crate::files::list_dir(&conn, &share.drive_id, &rel).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this folder.",
                )
            })?
        } else {
            Vec::new()
        };
        (meta, share.drive_id, rel, entries)
    };

    if meta.is_file() {
        // The SPA asks for metadata (file name, permission) so it can offer a
        // Replace action on read-write file links; other clients stream bytes.
        if query.meta.unwrap_or(0) != 0 {
            let name = path_label
                .rsplit('/')
                .next()
                .filter(|n| !n.is_empty())
                .unwrap_or("download");
            return Ok(Json(json!({
                "kind": "file",
                "permission": share.permission,
                "drive_id": drive_id,
                "path": path_label,
                "name": name,
            }))
            .into_response());
        }
        return serve_file(&state, &drive_id, &path_label).await;
    }
    Ok(Json(json!({
        "kind": "folder",
        "permission": share.permission,
        "drive_id": drive_id,
        "path": path_label,
        "entries": entries.into_iter().filter(|e| !e.hidden).collect::<Vec<_>>(),
    }))
    .into_response())
}

/// Validate a public share token: exists, not expired, and the password (when
/// set) matches. Returns the share row, or an error response.
fn resolve_public_share(
    state: &AppState,
    ip: &str,
    token: &str,
    headers: &HeaderMap,
) -> Result<crate::db::ShareRow, (StatusCode, Json<Value>)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AuthError::Unauthenticated)
        .map_err(map_err)?;
    let token_hash = blake3::hash(token.as_bytes()).to_hex().to_string();
    let share = crate::db::get_share_by_token_hash(&conn, &token_hash)
        .map_err(|e| map_err(AuthError::Db(e)))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "This link doesn't exist."))?;

    if let Some(expiry) = share.expires_at
        && crate::db::now_unix() > expiry
    {
        return Err(json_error(StatusCode::GONE, "This link has expired."));
    }
    if !share.password_hash.is_empty() {
        if state.share_auth.is_locked(&share.id, ip) {
            return Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many wrong passwords. Wait a few minutes and try again.",
            ));
        }
        let provided = share_password(headers);
        if provided.is_empty() {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "This link needs its password.",
            ));
        }
        let parsed =
            argon2::password_hash::PasswordHash::new(&share.password_hash).map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open this link.",
                )
            })?;
        if auth::verify_password_hash(&provided, &parsed).is_err() {
            state.share_auth.record_failure(&share.id, ip);
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "This link needs its password.",
            ));
        }
        state.share_auth.clear_success(&share.id, ip);
    }
    Ok(share)
}

/// Public links can only upload when the link is `write` or `upload`.
fn require_share_upload(share: &crate::db::ShareRow) -> Result<(), (StatusCode, Json<Value>)> {
    if share.permission == PERMISSION_WRITE || share.permission == PERMISSION_UPLOAD {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "This link is view-only, so it can't receive files. Ask for a link that allows uploads.",
        ))
    }
}

/// Upload-only drop boxes are rooted at the shared folder: a nested `path`
/// would let a link-holder probe which subfolders exist.
fn upload_rel<'a>(permission: &str, path: Option<&'a str>) -> Option<&'a str> {
    match permission {
        PERMISSION_UPLOAD => None,
        _ => path,
    }
}

/// Where an upload through `share` lands: inside the shared folder for folder
/// links, or replacing the shared file for read-write file links. Returns the
/// destination folder and the name override (None = client picks the name).
fn upload_dest(
    conn: &rusqlite::Connection,
    share: &crate::db::ShareRow,
    rel: Option<&str>,
) -> Result<(String, Option<String>), (StatusCode, Json<Value>)> {
    let (_resolved, meta) =
        crate::files::resolve_any(conn, &share.drive_id, &share.path).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared folder isn't available right now.",
            )
        })?;
    if meta.is_dir() {
        let dest = child_under_share(&share.path, rel.unwrap_or("")).ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "That folder isn't part of this shared link.",
            )
        })?;
        let (_resolved, dest_meta) = crate::files::resolve_any(conn, &share.drive_id, &dest)
            .map_err(|_| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "That folder isn't part of this shared link.",
                )
            })?;
        if !dest_meta.is_dir() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Uploads can only go into a folder.",
            ));
        }
        Ok((dest, None))
    } else {
        // Read-write link to a single file: uploading replaces that file.
        let parent = share
            .path
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();
        let name = share
            .path
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| {
                json_error(
                    StatusCode::BAD_REQUEST,
                    "Luna can't work out which file this link points at.",
                )
            })?
            .to_string();
        Ok((parent, Some(name)))
    }
}

/// An upload belongs to a share when it lands in the shared folder or any
/// folder inside it (folder links), or replaces the shared file (file links).
fn upload_in_share_scope(
    share: &crate::db::ShareRow,
    drive_id: &str,
    dest_path: &str,
    name: &str,
) -> bool {
    if share.drive_id != drive_id {
        return false;
    }
    // A whole-drive share (path == "") covers every folder on the drive.
    if share.path.is_empty() {
        return true;
    }
    if dest_path == share.path {
        return true;
    }
    if !share.path.is_empty()
        && dest_path.starts_with(&format!("{}/", share.path.trim_end_matches('/')))
    {
        return true;
    }
    let joined = if dest_path.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dest_path.trim_end_matches('/'), name)
    };
    joined == share.path
}

async fn public_upload_create(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PublicUploadCreate>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let share = resolve_public_share(&state, &addr.ip().to_string(), &token, &headers)?;
    require_share_upload(&share)?;
    // Public links make the drive writable by strangers; cap how many new
    // upload sessions one address can open so a drop box can't be used to
    // fill the disk with half-started uploads.
    if !state.share_limiter.allow(&addr.ip().to_string()) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many uploads from this address just now. Wait a minute and try again.",
        ));
    }
    if body.size > MAX_FILE_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't accept files larger than 1 TB.",
        ));
    }
    let (dest, name_override) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        upload_dest(
            &conn,
            &share,
            upload_rel(&share.permission, body.path.as_deref()),
        )?
    };
    let name = name_override.unwrap_or(body.name);
    let upload = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        uploads::create(&conn, &share.drive_id, &dest, &name, body.size).map_err(map_upload_err)?
    };
    Ok(Json(json!({
        "upload_id": upload.id,
        "received": upload.received,
        "size": upload.size,
        "name": upload.name,
    })))
}

async fn public_upload_chunk(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let share = resolve_public_share(&state, &addr.ip().to_string(), &token, &headers)?;
    require_share_upload(&share)?;
    let row = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        uploads::get_row(&conn, &id).map_err(map_upload_err)?
    };
    if !upload_in_share_scope(&share, &row.drive_id, &row.path, &row.name) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    let spec = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Each chunk needs a Content-Range header (bytes start-end/total).",
            )
        })?;
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
    let received = uploads::write_chunk(&state.db, &id, start, &body).map_err(map_upload_err)?;
    Ok(Json(json!({ "upload_id": id, "received": received })))
}

async fn public_upload_complete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    Query(query): Query<PublicUploadCompleteQuery>,
    headers: HeaderMap,
) -> Result<Json<crate::files::FileEntry>, (StatusCode, Json<Value>)> {
    let share = resolve_public_share(&state, &addr.ip().to_string(), &token, &headers)?;
    require_share_upload(&share)?;
    let row = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        uploads::get_row(&conn, &id).map_err(map_upload_err)?
    };
    if !upload_in_share_scope(&share, &row.drive_id, &row.path, &row.name) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    // Read-write links may replace an existing file (the shared file itself
    // for file links); upload-only drop boxes never overwrite silently —
    // instead a name collision is auto-renamed, because the link holder can't
    // see which names are taken and a bare error would leak that one exists.
    let overwrite = query.overwrite.as_deref() == Some("1") && share.permission == PERMISSION_WRITE;
    let rename_on_conflict = share.permission == PERMISSION_UPLOAD;
    let entry = uploads::complete(
        &state.db,
        &id,
        overwrite,
        rename_on_conflict,
        query.hash.as_deref(),
    )
    .map_err(map_upload_err)?;
    state.gallery.upsert(
        &row.drive_id,
        &crate::gallery_indexer::join_rel(&row.path, &entry.name),
    );
    state.touch_io_activity();
    Ok(Json(entry))
}

async fn public_upload_cancel(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let share = resolve_public_share(&state, &addr.ip().to_string(), &token, &headers)?;
    require_share_upload(&share)?;
    let row = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AuthError::Unauthenticated)
            .map_err(map_err)?;
        uploads::get_row(&conn, &id).map_err(map_upload_err)?
    };
    if !upload_in_share_scope(&share, &row.drive_id, &row.path, &row.name) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload isn't part of this link.",
        ));
    }
    uploads::cancel(&state.db, &id).map_err(map_upload_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn map_upload_err(err: UploadError) -> (StatusCode, Json<Value>) {
    use std::io::ErrorKind;
    match err {
        UploadError::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this upload.")
        }
        UploadError::NotActive => json_error(
            StatusCode::BAD_REQUEST,
            "That upload is already finished or cancelled.",
        ),
        UploadError::SizeMismatch => json_error(
            StatusCode::BAD_REQUEST,
            "The upload isn't complete yet. Check the connection and try again.",
        ),
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::AlreadyExists =>
        {
            json_error(
                StatusCode::CONFLICT,
                "A file with this name is already here. Rename it or choose another.",
            )
        }
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == ErrorKind::NotADirectory =>
        {
            json_error(StatusCode::BAD_REQUEST, "That destination is not a folder.")
        }
        UploadError::Io(e) if e.kind() == ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Rename it or choose another.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish that upload. Check the drive and try again.",
        ),
    }
}

async fn serve_file(
    state: &AppState,
    drive_id: &str,
    rel: &str,
) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    // Open against a re-verified descriptor so a mid-request symlink swap on
    // the drive cannot read outside the jail.
    let (file, path) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let Some(drive) = crate::db::get_drive(&conn, drive_id).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared file isn't available right now.",
            )
        })?
        else {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "The shared file isn't available right now.",
            ));
        };
        let root = std::path::PathBuf::from(&drive.mount_point);
        let (file, path) = luna_core::path::open_verified(&root, rel).map_err(|_| {
            json_error(
                StatusCode::NOT_FOUND,
                "The shared file isn't available right now.",
            )
        })?;
        (file, path)
    };
    let file = tokio::fs::File::from_std(file);
    let meta = std::fs::metadata(&path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "The shared file isn't available right now.",
        )
    })?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let disposition = if crate::files::inline_safe(mime.as_ref()) {
        "inline"
    } else {
        "attachment"
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    let builder = axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
        .header(axum::http::header::CONTENT_LENGTH, meta.len().to_string())
        .header(axum::http::header::CACHE_CONTROL, "private, no-store")
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                crate::files::content_disposition_filename(&name)
            ),
        );
    let response = builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this link.",
            )
        })?;
    Ok(response)
}

/// Share password via `X-Share-Password` header only (never query strings).
fn share_password(headers: &HeaderMap) -> String {
    headers
        .get("x-share-password")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

/// Join a path under the shared root. Rejects `..` and absolute paths so a
/// public link cannot walk the rest of the drive.
fn child_under_share(share_path: &str, rel: &str) -> Option<String> {
    let extra = rel.trim();
    if extra.starts_with('/') {
        return None;
    }
    if extra.is_empty() {
        return Some(share_path.trim_start_matches('/').to_string());
    }
    let requested = FsPath::new(extra);
    if requested.is_absolute() {
        return None;
    }
    for component in requested.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return None;
        }
    }
    if share_path.is_empty() {
        Some(extra.to_string())
    } else {
        Some(format!("{}/{}", share_path.trim_end_matches('/'), extra))
    }
}

fn prefers_html(headers: &HeaderMap) -> bool {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let html = accept.find("text/html");
    let json = accept.find("application/json");
    match (html, json) {
        (Some(h), Some(j)) => h < j,
        (Some(_), None) => true,
        _ => false,
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn map_err(err: AuthError) -> (StatusCode, Json<Value>) {
    match err {
        AuthError::Forbidden => json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage shared links.",
        ),
        AuthError::Unauthenticated => {
            json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't update shared links. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn test_drive() -> (tempfile::TempDir, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let marker = luna_core::marker::Marker::new("d1", "Test");
        crate::drive_db::create(&root, &marker).unwrap();
        crate::db::upsert_drive(
            &conn,
            "d1",
            "Test",
            "as_is",
            "ext4",
            "sdz",
            root.to_str().unwrap(),
        )
        .unwrap();
        (dir, conn)
    }

    fn share(path: &str, permission: &str) -> crate::db::ShareRow {
        crate::db::ShareRow {
            id: "s1".into(),
            token_hash: "tok".into(),
            drive_id: "d1".into(),
            path: path.into(),
            password_hash: String::new(),
            expires_at: None,
            created_by: "u1".into(),
            permission: permission.into(),
        }
    }

    #[test]
    fn child_under_share_stays_inside_the_shared_folder() {
        assert_eq!(
            child_under_share("photos/summer", "beach.jpg").as_deref(),
            Some("photos/summer/beach.jpg")
        );
        assert_eq!(child_under_share("photos", "").as_deref(), Some("photos"));
        assert_eq!(child_under_share("", "a/b").as_deref(), Some("a/b"));
        assert!(child_under_share("photos", "../etc").is_none());
        assert!(child_under_share("photos", "/etc/passwd").is_none());
    }

    #[test]
    fn prefers_html_follows_accept_order() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("text/html,application/xhtml+xml,application/json"),
        );
        assert!(prefers_html(&headers));
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
        assert!(!prefers_html(&headers));
    }

    #[test]
    fn share_password_uses_header_only() {
        let mut headers = HeaderMap::new();
        headers.insert("x-share-password", HeaderValue::from_static("from-header"));
        assert_eq!(share_password(&headers), "from-header");
        assert_eq!(share_password(&HeaderMap::new()), "");
    }

    #[test]
    fn permission_defaults_to_read_and_accepts_write_and_upload() {
        assert_eq!(normalize_permission(None), "read");
        assert_eq!(normalize_permission(Some("bogus")), "read");
        assert_eq!(normalize_permission(Some("write")), "write");
        assert_eq!(normalize_permission(Some("upload")), "upload");
    }

    #[test]
    fn upload_requires_write_or_upload_link() {
        assert!(require_share_upload(&share("photos", "write")).is_ok());
        assert!(require_share_upload(&share("photos", "upload")).is_ok());
        assert!(require_share_upload(&share("photos", "read")).is_err());
    }

    #[test]
    fn upload_rel_roots_upload_only_links_at_the_share_root() {
        assert_eq!(upload_rel("upload", Some("secret")), None);
        assert_eq!(upload_rel("upload", None), None);
        assert_eq!(upload_rel("write", Some("summer")), Some("summer"));
        assert_eq!(upload_rel("read", None), None);
    }

    #[test]
    fn upload_scope_covers_whole_drive_shares() {
        let share = share("", "write");
        assert!(upload_in_share_scope(&share, "d1", "photos", "beach.jpg"));
        assert!(upload_in_share_scope(&share, "d1", "anywhere", "deep.txt"));
        assert!(upload_in_share_scope(&share, "d1", "", "rootfile.txt"));
        assert!(!upload_in_share_scope(&share, "d2", "photos", "beach.jpg"));
    }

    #[test]
    fn upload_scope_is_shared_folder_for_folder_links() {
        let share = share("photos", "write");
        assert!(upload_in_share_scope(&share, "d1", "photos", "beach.jpg"));
        assert!(upload_in_share_scope(
            &share,
            "d1",
            "photos",
            "anything.zip"
        ));
        assert!(upload_in_share_scope(
            &share,
            "d1",
            "photos/summer",
            "beach.jpg"
        ));
        assert!(!upload_in_share_scope(
            &share,
            "d1",
            "photos2024",
            "beach.jpg"
        ));
        assert!(!upload_in_share_scope(&share, "d1", "records", "beach.jpg"));
        assert!(!upload_in_share_scope(&share, "d2", "photos", "beach.jpg"));
    }

    #[test]
    fn upload_scope_replaces_the_shared_file_for_file_links() {
        let share = share("photos/beach.jpg", "write");
        assert!(upload_in_share_scope(&share, "d1", "photos", "beach.jpg"));
        assert!(!upload_in_share_scope(&share, "d1", "photos", "other.jpg"));
        assert!(!upload_in_share_scope(&share, "d1", "", "beach.jpg"));
    }

    #[test]
    fn upload_dest_lands_in_folders_and_replaces_files() {
        let (_dir, conn) = test_drive();
        std::fs::create_dir_all(
            std::path::Path::new(
                &conn
                    .query_row("SELECT mount_point FROM drives WHERE id='d1'", [], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap(),
            )
            .join("photos/summer"),
        )
        .unwrap();
        std::fs::write(
            std::path::Path::new(
                &conn
                    .query_row("SELECT mount_point FROM drives WHERE id='d1'", [], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap(),
            )
            .join("photos/beach.jpg"),
            b"jpg",
        )
        .unwrap();

        let folder = share("photos", "upload");
        assert_eq!(
            upload_dest(&conn, &folder, None).unwrap(),
            ("photos".into(), None)
        );
        assert_eq!(
            upload_dest(&conn, &folder, Some("summer")).unwrap(),
            ("photos/summer".into(), None)
        );
        assert!(upload_dest(&conn, &folder, Some("../etc")).is_err());

        let file = share("photos/beach.jpg", "write");
        assert_eq!(
            upload_dest(&conn, &file, None).unwrap(),
            ("photos".into(), Some("beach.jpg".into()))
        );
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
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
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

    fn get_json(uri: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri(uri)
            .header("accept", "application/json")
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn put_chunk(uri: &str, bytes: &[u8]) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(Method::PUT)
            .uri(uri)
            .header(
                "content-range",
                format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()),
            )
            .header("content-type", "application/octet-stream")
            .body(Body::from(bytes.to_vec()))
            .unwrap();
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

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn admin_and_sam(app: &axum::Router) -> (String, String, String, String, String) {
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
        let v = body_json(res).await;
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
        (
            admin_cookie,
            admin_csrf,
            cookie_header(&sam_session, &sam_csrf),
            sam_csrf,
            sam_id,
        )
    }

    async fn create_share(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        path: &str,
        permission: &str,
    ) -> String {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/shares",
                &format!(r#"{{"drive_id":"photos","path":"{path}","permission":"{permission}"}}"#),
                Some(cookie),
                Some(csrf),
            ),
        )
        .await;
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "create share {permission} on {path}"
        );
        body_json(res).await["token"].as_str().unwrap().to_string()
    }

    /// Drive a full public chunked upload through create + chunk + complete and
    /// return the final response.
    async fn public_upload(
        app: &axum::Router,
        token: &str,
        name: &str,
        bytes: &[u8],
        path: Option<&str>,
    ) -> axum::response::Response {
        let path_json = path
            .map(|p| format!(r#","path":"{p}""#))
            .unwrap_or_default();
        let res = call(
            app,
            json_req(
                Method::POST,
                &format!("/s/{token}/upload"),
                &format!(r#"{{"name":"{name}","size":{}{path_json}}}"#, bytes.len()),
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK, "public upload create {name}");
        let upload_id = body_json(res).await["upload_id"]
            .as_str()
            .unwrap()
            .to_string();
        let res = call(
            app,
            put_chunk(&format!("/s/{token}/upload/{upload_id}"), bytes),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK, "public upload chunk {name}");
        call(
            app,
            json_req(
                Method::POST,
                &format!("/s/{token}/upload/{upload_id}/complete"),
                "{}",
                None,
                None,
            ),
        )
        .await
    }

    #[tokio::test]
    async fn read_grant_cannot_mint_write_or_upload_links() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (admin_cookie, admin_csrf, sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g1", &sam_id, "photos", "family", "read").unwrap();
        }

        // A read grant still lets the member make a read-only link.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/shares",
                r#"{"drive_id":"photos","path":"family","permission":"read"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        // But not a link that lets strangers write.
        for permission in ["write", "upload"] {
            let res = call(
                &app,
                json_req(
                    Method::POST,
                    "/api/v1/shares",
                    &format!(
                        r#"{{"drive_id":"photos","path":"family","permission":"{permission}"}}"#
                    ),
                    Some(&sam_cookie),
                    Some(&sam_csrf),
                ),
            )
            .await;
            assert_eq!(
                res.status(),
                StatusCode::FORBIDDEN,
                "{permission} link from a read grant"
            );
        }

        // A write grant unlocks them.
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_grant(&conn, "g2", &sam_id, "photos", "family", "write").unwrap();
        }
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/shares",
                r#"{"drive_id":"photos","path":"family","permission":"upload"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);

        // Sanity: the admin path still works.
        let _token = create_share(&app, &admin_cookie, &admin_csrf, "family", "read").await;
    }

    #[tokio::test]
    async fn upload_only_get_returns_only_kind_and_permission() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (admin_cookie, admin_csrf, _s, _c, _i) = admin_and_sam(&app).await;
        let token = create_share(&app, &admin_cookie, &admin_csrf, "family", "upload").await;

        let res = call(&app, get_json(&format!("/s/{token}"))).await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["kind"], "upload");
        assert_eq!(v["permission"], "upload");
        assert!(v.get("drive_id").is_none(), "must not leak drive id: {v}");
        assert!(v.get("path").is_none(), "must not leak share path: {v}");
    }

    #[tokio::test]
    async fn upload_only_ignores_nested_path() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("family/secret")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (admin_cookie, admin_csrf, _s, _c, _i) = admin_and_sam(&app).await;
        let token = create_share(&app, &admin_cookie, &admin_csrf, "family", "upload").await;

        // Even though `secret` exists, the drop box must treat it as absent.
        let res = public_upload(&app, &token, "pic.txt", b"abc", Some("secret")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(mount.path().join("family/pic.txt").exists());
        assert!(!mount.path().join("family/secret/pic.txt").exists());
    }

    #[tokio::test]
    async fn read_only_link_rejects_upload_and_upload_only_never_overwrites() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/pic.txt"), b"old").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (admin_cookie, admin_csrf, _s, _c, _i) = admin_and_sam(&app).await;
        let read_token = create_share(&app, &admin_cookie, &admin_csrf, "family", "read").await;
        let upload_token = create_share(&app, &admin_cookie, &admin_csrf, "family", "upload").await;

        // Read-only links can't even open an upload session.
        let res = call(
            &app,
            json_req(
                Method::POST,
                &format!("/s/{read_token}/upload"),
                r#"{"name":"x.txt","size":1}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // Upload-only: the duplicate is auto-renamed, the original survives,
        // and the response reports the name that actually landed.
        let res = public_upload(&app, &upload_token, "pic.txt", b"new", None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["name"], "pic (1).txt");
        assert_eq!(
            std::fs::read_to_string(mount.path().join("family/pic.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(mount.path().join("family/pic (1).txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn whole_drive_write_link_can_upload_into_subfolders() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (admin_cookie, admin_csrf, _s, _c, _i) = admin_and_sam(&app).await;
        // path "" = whole drive
        let token = create_share(&app, &admin_cookie, &admin_csrf, "", "write").await;

        let res = public_upload(&app, &token, "pic.txt", b"abc", Some("family")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(mount.path().join("family/pic.txt").exists());
    }
}
