//! Short-lived EuroOffice / Document Server bridges.
//!
//! DocsAPI's Document Server fetches `document.url` server-side with no browser
//! cookies, and posts saves to `callbackUrl`. These routes mint a scoped JWT
//! and expose public content + callback endpoints for that token.

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::office_public::{public_callback, public_content};
use crate::api::office_save_url::document_server_origin;
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
struct ForceSaveBody {
    drive_id: String,
    path: String,
    /// Document key the editor session was opened with. It already binds the
    /// drive, path, size, and mtime at open time, and it cannot be recomputed
    /// here once a save changes the file — so the client echoes it back and we
    /// still check write access on the claimed drive/path.
    key: String,
}


pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/office/session", post(create_session))
        .route("/api/v1/office/forcesave", post(force_save))
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
    // Mirrors the fileType table the bundled DocsAPI validates against
    // (web-apps/apps/api/documents/api.js, `_checkConfigParams`) and
    // fileKinds.js OFFICE_EXT. DocsAPI accepts word/cell/slide/pdf/diagram;
    // djvu/xps/oxps open in the pdf editor, vsdx & co. in the visio editor.
    let document_type = match file_type.as_str() {
        "doc" | "docx" | "odt" | "gdoc" | "txt" | "rtf" | "mht" | "htm" | "html" | "mhtml"
        | "epub" | "docm" | "dot" | "dotm" | "dotx" | "fodt" | "ott" | "fb2" | "xml" | "oform"
        | "docxf" | "sxw" | "stw" | "wps" | "wpt" | "pages" | "hwp" | "hwpx" | "md" | "hml" => {
            "word"
        }
        "xls" | "xlsx" | "ods" | "csv" | "tsv" | "gsheet" | "xlsm" | "xlt" | "xltm" | "xltx"
        | "fods" | "ots" | "xlsb" | "sxc" | "et" | "ett" | "numbers" => "cell",
        "pps" | "ppsx" | "ppt" | "pptx" | "odp" | "gslides" | "pot" | "potm" | "potx" | "ppsm"
        | "pptm" | "fodp" | "otp" | "sxi" | "dps" | "dpt" | "key" | "odg" => "slide",
        "pdf" | "djvu" | "xps" | "oxps" => "pdf",
        "vsdx" | "vssx" | "vstx" | "vsdm" | "vssm" | "vstm" => "diagram",
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

/// Forward a `forcesave` to the Document Server command service. The DS then
/// posts the saved file back through `public_callback` (status 6), so the write
/// itself stays on the one existing callback path.
async fn force_save(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<ForceSaveBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let path = normalize_rel(&body.path);
    let drive_id = body.drive_id.trim().to_string();
    let key = body.key.trim().to_string();
    if path.is_empty() || drive_id.is_empty() || key.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna needs the open document to save it. Close the file and open it again.",
        ));
    }
    if !user_can(&state, &user, &drive_id, &path, true)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save this file.",
        ));
    }

    let command_url = format!("{}/command", document_server_origin());
    let reply = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, Json<Value>)> {
        let mut response = ureq::post(&command_url)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(15)))
            .build()
            .send_json(json!({ "c": "forcesave", "key": key }))
            .map_err(|e| {
                tracing::warn!(error = %e, "eurooffice forcesave request failed");
                json_error(
                    StatusCode::BAD_GATEWAY,
                    "Luna couldn't reach EuroOffice to save. Try again.",
                )
            })?;
        response.body_mut().read_json::<Value>().map_err(|e| {
            tracing::warn!(error = %e, "eurooffice forcesave reply unreadable");
            json_error(
                StatusCode::BAD_GATEWAY,
                "EuroOffice answered in a way Luna could not read. Try saving again.",
            )
        })
    })
    .await
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish saving this file.",
        )
    })??;

    // Command service answers {"error": N}; 0 = saved, 4 = nothing new to save.
    match reply.get("error").and_then(Value::as_i64) {
        Some(0) | Some(4) => Ok(Json(json!({ "error": 0 }))),
        other => {
            tracing::warn!(code = ?other, "eurooffice forcesave rejected");
            Err(json_error(
                StatusCode::BAD_GATEWAY,
                "EuroOffice couldn't save this file. Try closing it and opening it again.",
            ))
        }
    }
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
    path.trim().replace('\\', "/").trim_matches('/').to_string()
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
    fn document_key_changes_with_mtime() {
        let a = document_key("d1", "a.xlsx", 10, 1);
        let b = document_key("d1", "a.xlsx", 10, 2);
        assert_ne!(a, b);
    }
}
