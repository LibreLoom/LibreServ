//! Short-lived EuroOffice / Document Server bridges.
//!
//! DocsAPI's Document Server fetches `document.url` server-side with no browser
//! cookies, and posts saves to `callbackUrl`. These routes mint a scoped JWT
//! and expose public content + callback endpoints for that token.

use axum::body::Body;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::files::{self, FilesError};

const OFFICE_TOKEN_TTL_SECS: i64 = 60 * 60; // 1 hour — covers long edit sessions

#[derive(Debug, Deserialize)]
struct SessionBody {
    drive_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

#[derive(Debug, Deserialize)]
struct CallbackBody {
    status: i32,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    key: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/office/session", post(create_session))
        .route("/api/v1/public/office/content", get(public_content))
        .route("/api/v1/public/office/callback", post(public_callback))
}

async fn create_session(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let path = normalize_rel(&body.path);
    if path.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a file to open in EuroOffice.",
        ));
    }
    let drive_id = body.drive_id.trim().to_string();
    if drive_id.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a drive that holds this file.",
        ));
    }

    ensure_file(&state, &drive_id, &path)?;
    if !user_can(&state, &user, &drive_id, &path, false)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to open this file.",
        ));
    }
    let can_write = user_can(&state, &user, &drive_id, &path, true).unwrap_or(false);

    let (abs, meta) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        files::file_path(&conn, &drive_id, &path).map_err(map_files_err)?
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();
    let title = abs
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let file_type = title
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    if file_type.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "EuroOffice needs a file with an extension like .docx, .xlsx, or .pptx.",
        ));
    }

    let token = state
        .auth
        .issue_office_token(&user.id, &drive_id, &path, can_write, OFFICE_TOKEN_TTL_SECS)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare EuroOffice access. Try again.",
            )
        })?;

    let origin = office_fetch_origin();
    let document_url = format!("{origin}/api/v1/public/office/content?token={token}");
    let callback_url = format!("{origin}/api/v1/public/office/callback?token={token}");
    let key = document_key(&drive_id, &path, size, modified);
    let document_type = match file_type.as_str() {
        "doc" | "docx" | "odt" | "rtf" | "txt" => "word",
        "xls" | "xlsx" | "ods" | "csv" => "cell",
        "ppt" | "pptx" | "odp" => "slide",
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "EuroOffice cannot open this file type.",
            ));
        }
    };

    Ok(Json(json!({
        "document_url": document_url,
        "callback_url": callback_url,
        "key": key,
        "title": title,
        "file_type": file_type,
        "document_type": document_type,
        "can_write": can_write,
        "user": {
            "id": user.id,
            "name": user.username,
        },
    })))
}

async fn public_content(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let claims = state.auth.verify_office_token(&query.token).map_err(|_| {
        json_error(
            StatusCode::UNAUTHORIZED,
            "This EuroOffice link expired. Close the file and open it again.",
        )
    })?;

    let (path, meta) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        files::file_path(&conn, &claims.drive_id, &claims.path).map_err(map_files_err)?
    };

    let file = tokio::fs::File::open(&path).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read that file for EuroOffice.",
        )
    })?;
    let stream = ReaderStream::new(file);
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                files::content_disposition_filename(name)
            ),
        )
        .body(Body::from_stream(stream))
        .unwrap())
}

async fn public_callback(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    Json(body): Json<CallbackBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let _ = headers;
    let claims = state.auth.verify_office_token(&query.token).map_err(|_| {
        json_error(
            StatusCode::UNAUTHORIZED,
            "This EuroOffice link expired. Close the file and open it again.",
        )
    })?;

    // ONLYOFFICE / EuroOffice: 2 = ready to save, 6 = force-save.
    if matches!(body.status, 2 | 6) {
        if !claims.write {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "This EuroOffice session is view-only, so Luna can't save changes.",
            ));
        }
        let Some(raw_url) = body.url.as_deref().filter(|u| !u.is_empty()) else {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "EuroOffice did not send a download link for the saved file.",
            ));
        };
        let download_url = rewrite_document_server_url(raw_url);
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let mut response = ureq::get(&download_url)
                .call()
                .map_err(|e| format!("download failed: {e}"))?;
            response
                .body_mut()
                .read_to_vec()
                .map_err(|e| format!("read failed: {e}"))
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish saving this file.",
            )
        })?
        .map_err(|e| {
            tracing::warn!(error = %e, key = ?body.key, "eurooffice callback download failed");
            json_error(
                StatusCode::BAD_GATEWAY,
                "Luna couldn't download the saved file from EuroOffice. Try saving again.",
            )
        })?;

        let drive_id = claims.drive_id.clone();
        let rel = claims.path.clone();
        tokio::task::spawn_blocking(move || -> Result<(), (StatusCode, Json<Value>)> {
            let (dest, _meta) = {
                let conn = state.db.lock().map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Luna's index is busy. Try again.",
                    )
                })?;
                files::file_path(&conn, &drive_id, &rel).map_err(map_files_err)?
            };
            let parent = dest.parent().ok_or_else(|| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't find where to save this file.",
                )
            })?;
            let temp = files::temp_path(parent);
            std::fs::write(&temp, &bytes).map_err(|_| {
                let _ = std::fs::remove_file(&temp);
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't write the saved file. Check that the drive still has space.",
                )
            })?;
            if let Err(e) = files::install_temp(&temp, &dest, true) {
                let _ = std::fs::remove_file(&temp);
                tracing::warn!(error = %e, "eurooffice save install failed");
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't replace the file with the EuroOffice save.",
                ));
            }
            state.gallery.upsert(&drive_id, &rel);
            state.touch_io_activity();
            let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            state.ram_cache.invalidate_listing(&drive_id, parent_rel);
            state.ram_cache.invalidate_listing_tree(&drive_id, &rel);
            state.ram_cache.invalidate_thumb(&drive_id, &rel);
            Ok(())
        })
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish saving this file.",
            )
        })??;
    }

    Ok(Json(json!({ "error": 0 })))
}

fn office_fetch_origin() -> String {
    if let Ok(raw) = std::env::var("LUNA_OFFICE_FETCH_ORIGIN") {
        let trimmed = raw.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let port = std::env::var("LUNA_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8090);
    // Document Server runs in a container and must reach lunad on the host.
    format!("http://host.containers.internal:{port}")
}

fn rewrite_document_server_url(raw: &str) -> String {
    let configured = std::env::var("LUNA_DOCUMENT_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8088".into());
    let configured = configured.trim().trim_end_matches('/');
    for prefix in [
        "http://localhost/",
        "https://localhost/",
        "http://127.0.0.1/",
        "https://127.0.0.1/",
        "http://localhost:80/",
        "http://127.0.0.1:80/",
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return format!("{configured}/{rest}");
        }
    }
    if let Some(rest) = raw.strip_prefix("http://localhost:8088/") {
        return format!("{configured}/{rest}");
    }
    raw.to_string()
}

fn document_key(drive_id: &str, path: &str, size: u64, modified: u64) -> String {
    let raw = format!("{drive_id}\n{path}\n{size}\n{modified}");
    let mut hash: u32 = 2166136261;
    for b in raw.bytes() {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(16777619);
    }
    let safe = format!("{drive_id}-{path}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>();
    format!("{safe}-{hash:08x}")
}

fn normalize_rel(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

fn ensure_file(
    state: &AppState,
    drive_id: &str,
    path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let (_abs, meta) = files::file_path(&conn, drive_id, path).map_err(map_files_err)?;
    if !meta.is_file() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only open files in EuroOffice — not folders.",
        ));
    }
    Ok(())
}

fn user_can(
    state: &AppState,
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
    write: bool,
) -> Result<bool, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    Ok(crate::auth::can_access(user, &conn, drive_id, path, write))
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive. Make sure it is plugged in.",
        ),
        FilesError::Path(_) => json_error(StatusCode::NOT_FOUND, "Luna can't find that file."),
        FilesError::Io(_) | FilesError::Db(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that file. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_maps_localhost_to_host_ds() {
        let got = rewrite_document_server_url("http://localhost/cache/files/abc/output.xlsx");
        assert_eq!(got, "http://127.0.0.1:8088/cache/files/abc/output.xlsx");
    }

    #[test]
    fn document_key_changes_with_mtime() {
        let a = document_key("d1", "a.xlsx", 10, 1);
        let b = document_key("d1", "a.xlsx", 10, 2);
        assert_ne!(a, b);
    }
}
