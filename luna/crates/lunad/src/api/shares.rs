use argon2::password_hash::rand_core::RngCore;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{delete, get};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Component, Path as FsPath};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, AuthError};

#[derive(Deserialize)]
struct CreateShare {
    drive_id: String,
    path: String,
    password: Option<String>,
    expires_in_days: Option<u32>,
}

#[derive(Deserialize)]
struct PublicQuery {
    password: Option<String>,
    /// Path relative to the shared file or folder (never `..`).
    path: Option<String>,
    /// Force a file download even when the browser asked for a web page.
    download: Option<u8>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/shares", get(list).post(create))
        .route("/api/v1/shares/{id}", delete(remove))
        .route("/s/{token}", get(public))
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
    // A share is a public link to a folder, so the creator needs at least
    // read access to it — otherwise any user could link out other people's
    // drives they have never been granted.
    if !auth::can_access(&user, &conn, &body.drive_id, &body.path, false) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to share this folder.",
        ));
    }
    // Validate the path resolves before creating the link.
    crate::files::resolve_any(&conn, &body.drive_id, &body.path).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't find that file or folder.",
        )
    })?;

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
        &user.id,
    )
    .map_err(|e| map_err(AuthError::Db(e)))?;
    Ok(Json(json!({
        "id": id,
        "url": format!("/s/{token}"),
        "token": token,
        "expires_at": expires_at,
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
/// to list a folder or stream a file. Password via `X-Share-Password` (preferred)
/// or `?password=` (kept for existing download links). Never log the raw query.
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
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn public_inner(
    state: AppState,
    ip: String,
    token: String,
    query: PublicQuery,
    headers: HeaderMap,
) -> Result<axum::response::Response, (StatusCode, Json<Value>)> {
    // Keep the SQLite lock scoped to this block: the file-streaming await
    // below must not hold a MutexGuard across an await point.
    let (meta, drive_id, path_label, entries) = {
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
            let provided = share_password(&headers, &query);
            // Rate-limit password attempts: `/s/` is a public, WAN-exposed
            // endpoint, so an unthrottled share password would be brute-forceable.
            // Keyed per share + IP so a brute-force on one link cannot exhaust
            // the budget for every other share behind the same NAT.
            if !state.share_limiter.allow(&format!("{}:{ip}", share.id)) {
                return Err(json_error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many tries. Wait a few minutes and try again.",
                ));
            }
            let parsed =
                argon2::password_hash::PasswordHash::new(&share.password_hash).map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna couldn't open this link.",
                    )
                })?;
            auth::verify_password_hash(&provided, &parsed).map_err(|_| {
                json_error(StatusCode::UNAUTHORIZED, "This link needs its password.")
            })?;
        }

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
        return serve_file(&state, &drive_id, &path_label).await;
    }
    Ok(Json(json!({
        "kind": "folder",
        "drive_id": drive_id,
        "path": path_label,
        "entries": entries.into_iter().filter(|e| !e.hidden).collect::<Vec<_>>(),
    }))
    .into_response())
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

/// Share password: prefer `X-Share-Password` so it does not appear in logs or
/// Referer. `?password=` remains for existing download links and bookmarks.
fn share_password(headers: &HeaderMap, query: &PublicQuery) -> String {
    headers
        .get("x-share-password")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| query.password.clone())
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

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
    fn share_password_prefers_header_over_query() {
        let mut headers = HeaderMap::new();
        headers.insert("x-share-password", HeaderValue::from_static("from-header"));
        let query = PublicQuery {
            password: Some("from-query".into()),
            path: None,
            download: None,
        };
        assert_eq!(share_password(&headers, &query), "from-header");
        assert_eq!(share_password(&HeaderMap::new(), &query), "from-query");
    }
}
