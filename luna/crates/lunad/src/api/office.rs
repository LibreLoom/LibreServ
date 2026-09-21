//! EuroOffice client-side editing bridge.
//!
//! The editor pack runs in the browser; x2t.wasm converts OOXML ↔ the editor's
//! internal `Editor.bin` format on the client. Lunad only stores the converted
//! bundle (Editor.bin + media) and relays co-authoring traffic over the
//! docstorage socket — no Document Server, no server-side conversion.
//!
//! - `POST /api/v1/office/session` mints the doc key + office token.
//! - `GET/HEAD/PUT /api/v1/office/bundle/{key}/{*name}` serves the bundle.
//! - `GET /eurooffice/{ver}/doc/{key}/c` (in `office_ws`) is the socket.

use axum::body::{Body, Bytes};
use axum::extract::{Extension, Path, Query, State};
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

const OFFICE_TOKEN_TTL_SECS: i64 = 24 * 60 * 60; // all-day edit sessions
/// Bundle dirs outlive sessions; sweep ones untouched for a week at boot.
const BUNDLE_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const MAX_BUNDLE_FILE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct SessionBody {
    drive_id: String,
    path: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/office/session", post(create_session))
        .route(
            "/api/v1/office/bundle/{key}/{*name}",
            get(bundle_get).head(bundle_head).put(bundle_put),
        )
}

/// Open step 1: validate access, mint the doc key + office token the
/// docstorage socket will verify, and register key → file binding.
async fn create_session(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
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
    let document_type = match document_type_for(&file_type) {
        Some(t) => t,
        None => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "EuroOffice cannot open this file type.",
            ));
        }
    };

    let token = state
        .auth
        .issue_office_token(&user.id, &drive_id, &path, can_write, OFFICE_TOKEN_TTL_SECS)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare EuroOffice access. Try again.",
            )
        })?;

    // The key fingerprints the file's size+mtime — but only to keep a stale
    // converted bundle from ever opening for a changed file. When a room is
    // already live on this file its key embeds the meta from *its* first
    // open, which every save since has invalidated; minting a fresh key
    // would park the joiner in an isolated room. Co-editing clients reuse
    // the live key — its bundle + op replay delivers the live document, not
    // the disk bytes.
    //
    // Viewers are the exception: the editor mounts view-only when the user
    // lacks write access or the format can't be saved back, and a view-mode
    // participant is never sent the authChanges op replay. Reusing the key
    // there would open the bundle minus every op since — older than the
    // file itself — so viewers mint a fresh key and convert current disk.
    let key = if can_write && can_save_office_ext(&file_type) {
        state
            .office_docs
            .claim_live_key(&drive_id, &path)
            .await
            .unwrap_or_else(|| document_key(&drive_id, &path, size, modified))
    } else {
        document_key(&drive_id, &path, size, modified)
    };
    state.office_docs.register_key(&key, &drive_id, &path).await;

    // The docstorage shim never fetches document.url (the open reply names
    // bundle files instead), but DocsAPI wants a real URL in the config —
    // point it at the file's own content endpoint so it stays meaningful.
    let document_url = format!(
        "{}/api/v1/drives/{}/files/content?path={}",
        request_origin(&headers),
        urlencoding(&drive_id),
        urlencoding(&path),
    );

    Ok(Json(json!({
        "key": key,
        "title": title,
        "file_type": file_type,
        "document_type": document_type,
        "can_write": can_write,
        "token": token,
        "document_url": document_url,
        "user": {
            "id": user.id,
            "name": user.username,
        },
    })))
}

fn document_type_for(ext: &str) -> Option<&'static str> {
    // Mirrors OFFICE_FORMATS in web/src/lib/fileKinds.js — the formats the
    // bundled x2t.wasm can actually read, verified by real conversions in
    // x2tFormats.test.js. api.js declares far more, but most of those
    // converters aren't in this build (doc, csv, pdf, epub, vsdx, iWork…).
    Some(match ext {
        "docx" | "docm" | "dotx" | "dotm" | "docxf" | "oform" | "odt" | "fodt" | "ott" | "rtf" => {
            "word"
        }
        "xls" | "xlsx" | "xlsm" | "xlsb" | "xlt" | "xltm" | "xltx" | "ods" | "fods" | "ots" => {
            "cell"
        }
        "ppt" | "pptx" | "pptm" | "pps" | "ppsm" | "ppsx" | "potm" | "potx" | "odp" | "fodp"
        | "otp" => "slide",
        _ => return None,
    })
}

fn can_save_office_ext(ext: &str) -> bool {
    // Mirrors OFFICE_SAVE_EXT in web/src/lib/fileKinds.js — the formats the
    // bundled x2t.wasm writes back without silent loss. Anything else mounts
    // the editor view-only even for users with write access.
    matches!(
        ext,
        "docx"
            | "dotx"
            | "docxf"
            | "oform"
            | "rtf"
            | "odt"
            | "ott"
            | "xlsx"
            | "xltx"
            | "xlsb"
            | "ods"
            | "ots"
            | "pptx"
            | "ppsx"
            | "potx"
            | "odp"
            | "otp"
    )
}

/// Bundle GET — the editor iframe fetches `Editor.bin`, `media/*`, and the
/// stored original from here. Cookie-authed (same-origin iframe), then
/// read-checked against the key's bound file.
async fn bundle_get(
    state: State<AppState>,
    user: Extension<CurrentUser>,
    path: Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    bundle_inner(state, user, path, false).await
}

async fn bundle_head(
    state: State<AppState>,
    user: Extension<CurrentUser>,
    path: Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    bundle_inner(state, user, path, true).await
}

async fn bundle_inner(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((key, name)): Path<(String, String)>,
    head_only: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let (drive_id, rel) = bound_file(&state, &user, &key, false).await?;
    let _ = (drive_id, rel);
    let file = bundle_file(&state, &key, &name)?;
    let meta = match tokio::fs::metadata(&file).await {
        Ok(m) if m.is_file() => m,
        _ => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "This document isn't prepared for editing yet.",
            ));
        }
    };
    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_TYPE, bundle_mime(&name));
    if head_only {
        return Ok(builder.body(Body::empty()).unwrap());
    }
    let file = tokio::fs::File::open(&file).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read the prepared document. Try opening it again.",
        )
    })?;
    Ok(builder
        .body(Body::from_stream(ReaderStream::new(file)))
        .unwrap())
}

/// Bundle PUT — the first opener uploads the wasm-converted `Editor.bin` +
/// media; the saver uploads a fresh `Editor.bin` + `origin.<ext>` after a
/// save. Write access on the bound file is required.
async fn bundle_put(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((key, name)): Path<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    bound_file(&state, &user, &key, true).await?;
    // A bundle file is never legitimately empty. An empty body means the
    // upload was emptied in flight (e.g. a detached typed-array buffer);
    // writing it would overwrite a good bundle with poison — and for
    // Editor.bin would also compact the replay log below.
    if body.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't store the converted document — the upload was empty. Try saving again.",
        ));
    }
    if body.len() > MAX_BUNDLE_FILE_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That document is too large for Luna to prepare for editing.",
        ));
    }
    let file = bundle_file(&state, &key, &name)?;
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare a place for the converted document.",
            )
        })?;
    }
    let temp = file.with_extension("part");
    tokio::fs::write(&temp, &body).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't store the converted document. Check that the drive still has space.",
        )
    })?;
    if let Err(e) = tokio::fs::rename(&temp, &file).await {
        let _ = tokio::fs::remove_file(&temp).await;
        tracing::warn!(error = %e, "office bundle install failed");
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish preparing the document. Try again.",
        ));
    }
    // A new Editor.bin bakes in every op the saver had been sent — drop them
    // from the replay log so joiners don't apply them twice. `coverage` is
    // the saver's own report of how far its serialized doc reached.
    if name == "Editor.bin" {
        let coverage = query.get("coverage").and_then(|v| v.parse::<i64>().ok());
        state
            .office_docs
            .bundle_refreshed(&key, &user.id, coverage)
            .await;
    }
    Ok(Json(json!({ "ok": true })))
}

/// Resolve `key` → bound (drive_id, path) and check this user's access.
/// Returns the binding for callers that need it.
async fn bound_file(
    state: &AppState,
    user: &CurrentUser,
    key: &str,
    write: bool,
) -> Result<(String, String), (StatusCode, Json<Value>)> {
    if !valid_key(key) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That editing session key is not valid.",
        ));
    }
    let Some((drive_id, rel)) = state.office_docs.binding(key).await else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This editing session expired. Close the file and open it again.",
        ));
    };
    if !user_can(state, user, &drive_id, &rel, write)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            if write {
                "You don't have permission to change this file."
            } else {
                "You don't have permission to open this file."
            },
        ));
    }
    Ok((drive_id, rel))
}

fn bundle_file(
    state: &AppState,
    key: &str,
    name: &str,
) -> Result<std::path::PathBuf, (StatusCode, Json<Value>)> {
    if !valid_key(key) || !valid_bundle_name(name) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That bundle path is not valid.",
        ));
    }
    Ok(state.data_dir.join("office_bundles").join(key).join(name))
}

/// Bundle member names are flat (`Editor.bin`, `origin.docx`) or `media/x` —
/// reject anything that could escape the key directory.
fn valid_bundle_name(name: &str) -> bool {
    let name = name.trim_matches('/');
    if name.is_empty() || name.len() > 200 || name.starts_with("..") || name.contains("..") {
        return false;
    }
    name.split('/').all(|seg| {
        !seg.is_empty()
            && seg.chars().all(|c| {
                c.is_ascii_alphanumeric()
                    || matches!(
                        c,
                        '.' | '_' | '-' | ' ' | '(' | ')' | '+' | '=' | ',' | '\''
                    )
            })
    })
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn bundle_mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("bin") => "application/octet-stream",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("mp3") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Delete bundle dirs untouched for a week — they only help while a document
/// is (or was just) being edited.
pub fn sweep_old_bundles(data_dir: &std::path::Path) {
    let root = data_dir.join("office_bundles");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(BUNDLE_MAX_AGE_SECS);
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1:8090");
    let scheme = if crate::auth::request_is_https(headers) {
        "https"
    } else {
        "http"
    };
    format!("{scheme}://{host}")
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '~') {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
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

    #[test]
    fn bundle_name_rules() {
        assert!(valid_bundle_name("Editor.bin"));
        assert!(valid_bundle_name("media/image1.png"));
        assert!(valid_bundle_name("origin.docx"));
        assert!(!valid_bundle_name("../x"));
        assert!(!valid_bundle_name("media/../../etc/passwd"));
        assert!(!valid_bundle_name(""));
        assert!(!valid_bundle_name("a//b"));
    }

    /// The session gate must mirror OFFICE_FORMATS in web/src/lib/fileKinds.js:
    /// only formats the bundled x2t.wasm verifiably reads (x2tFormats.test.js).
    /// Formats api.js declares but this build can't convert must be rejected
    /// here so a session never starts just to fail inside x2t.
    #[test]
    fn document_type_matches_verified_formats() {
        for (ext, want) in [
            ("docx", "word"),
            ("docm", "word"),
            ("dotx", "word"),
            ("dotm", "word"),
            ("docxf", "word"),
            ("oform", "word"),
            ("odt", "word"),
            ("fodt", "word"),
            ("ott", "word"),
            ("rtf", "word"),
            ("xls", "cell"),
            ("xlsx", "cell"),
            ("xlsm", "cell"),
            ("xlsb", "cell"),
            ("xlt", "cell"),
            ("xltm", "cell"),
            ("xltx", "cell"),
            ("ods", "cell"),
            ("fods", "cell"),
            ("ots", "cell"),
            ("ppt", "slide"),
            ("pptx", "slide"),
            ("pptm", "slide"),
            ("pps", "slide"),
            ("ppsm", "slide"),
            ("ppsx", "slide"),
            ("potm", "slide"),
            ("potx", "slide"),
            ("odp", "slide"),
            ("fodp", "slide"),
            ("otp", "slide"),
        ] {
            assert_eq!(document_type_for(ext), Some(want), "{ext}");
        }
        for ext in [
            "doc", "csv", "tsv", "pdf", "djvu", "xps", "oxps", "epub", "fb2", "mht", "mhtml",
            "vsdx", "pages", "numbers", "key", "hwp", "hwpx", "wps", "gdoc", "gsheet", "gslides",
            "txt", "md", "html", "xml", "odg",
        ] {
            assert_eq!(document_type_for(ext), None, "{ext}");
        }
    }
}

#[cfg(test)]
mod http_tests {
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq, StatusCode};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    fn test_app() -> (tempfile::TempDir, axum::Router, crate::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        (dir, app, state)
    }

    fn req(method: Method, uri: &str, body: Body, cookie: &str, csrf: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .header("content-type", "application/json")
            .body(body)
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn call(app: &axum::Router, req: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(req).await.unwrap()
    }

    fn json_req(method: Method, uri: &str, body: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn admin_login(app: &axum::Router) -> (String, String) {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
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
            ),
        )
        .await;
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
        (format!("{session}; luna_csrf={csrf}"), csrf)
    }

    /// A zero-byte `Editor.bin` PUT used to silently overwrite a healthy
    /// bundle — `bundleHas` then skipped re-conversion and the editor opened
    /// an empty document. The PUT must be rejected and the prior file kept.
    #[tokio::test]
    async fn bundle_put_rejects_empty_and_preserves_prior_file() {
        let (dir, app, _state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;

        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        std::fs::write(mount.join("Letter.rtf"), b"{\\rtf1 hello}").unwrap();
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(
                &conn,
                "drive-a",
                "A",
                "mounted",
                "ext4",
                "sda",
                mount.to_str().unwrap(),
            )
            .unwrap();
        }

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/office/session",
                Body::from(r#"{"drive_id":"drive-a","path":"Letter.rtf"}"#),
                &cookie,
                &csrf,
            ),
        )
        .await;
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(
            status,
            200,
            "session body: {}",
            String::from_utf8_lossy(&body)
        );
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let key = v["key"].as_str().unwrap().to_string();
        let uri = format!("/api/v1/office/bundle/{key}/Editor.bin");

        // A real upload lands.
        let res = call(
            &app,
            req(
                Method::PUT,
                &uri,
                Body::from(vec![1u8, 2, 3, 4]),
                &cookie,
                &csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let bin = dir
            .path()
            .join("office_bundles")
            .join(&key)
            .join("Editor.bin");
        assert_eq!(std::fs::metadata(&bin).unwrap().len(), 4);

        // An emptied upload (detached buffer client-side) is refused and the
        // good file survives — before this check it silently wrote 0 bytes
        // and still compacted the replay log.
        let res = call(&app, req(Method::PUT, &uri, Body::empty(), &cookie, &csrf)).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::metadata(&bin).unwrap().len(), 4);
    }

    /// Regression: the doc key fingerprints the file's size+mtime, so a save
    /// landing under an open editor changed what a second opener computed —
    /// the two landed in different docstorage rooms and never saw each
    /// other. While a room is live on the file, session create must return
    /// its key instead of minting a fresh fingerprint.
    #[tokio::test]
    async fn session_reuses_live_room_across_file_writes() {
        let (dir, app, state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;

        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        let doc = mount.join("Letter.rtf");
        std::fs::write(&doc, b"{\\rtf1 hello}").unwrap();
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(
                &conn,
                "drive-a",
                "A",
                "mounted",
                "ext4",
                "sda",
                mount.to_str().unwrap(),
            )
            .unwrap();
        }

        async fn open_key(app: &axum::Router, cookie: &str, csrf: &str, path: &str) -> String {
            let res = call(
                app,
                req(
                    Method::POST,
                    "/api/v1/office/session",
                    Body::from(format!(r#"{{"drive_id":"drive-a","path":"{path}"}}"#)),
                    cookie,
                    csrf,
                ),
            )
            .await;
            let status = res.status();
            let body = axum::body::to_bytes(res.into_body(), 1 << 20)
                .await
                .unwrap();
            assert_eq!(
                status,
                200,
                "session body: {}",
                String::from_utf8_lossy(&body)
            );
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            v["key"].as_str().unwrap().to_string()
        }

        // A opens the file and its editor auths on the docstorage socket —
        // the room is now live.
        let key_a = open_key(&app, &cookie, &csrf, "Letter.rtf").await;
        state
            .office_docs
            .auth(
                &key_a,
                1,
                &serde_json::json!({
                    "type": "auth",
                    "docid": key_a,
                    "user": { "id": "u-max", "username": "Max" },
                    "mode": "edit",
                }),
                true,
            )
            .await
            .unwrap();

        // An autosave lands — the file's size+mtime now differ from what
        // A's key was minted from.
        std::fs::write(&doc, b"{\\rtf1 hello, a longer saved body}").unwrap();

        // B opens mid-dirty-session: same room, not a fresh isolated key.
        let key_b = open_key(&app, &cookie, &csrf, "Letter.rtf").await;
        assert_eq!(key_b, key_a);

        // B's claim also covers the gap between A's disconnect and B's
        // socket auth — a concurrent opener still lands in the live room.
        state.office_docs.disconnect(&key_a, 1).await;
        let key_d = open_key(&app, &cookie, &csrf, "Letter.rtf").await;
        assert_eq!(key_d, key_a);

        // Once the room is empty and no joiner's claim is pending, the next
        // open mints a fresh fingerprint again — the old bundle must not
        // shadow the changed file.
        state.office_docs.expire_claim(&key_a).await;
        let key_c = open_key(&app, &cookie, &csrf, "Letter.rtf").await;
        assert_ne!(key_c, key_a);
    }

    /// The same live room must NOT be reused for a client that will mount
    /// view-only — view participants are never sent the authChanges replay,
    /// so they'd open the bundle minus every op since. fodt is openable but
    /// not writable by this x2t build, so even a writer mounts view mode.
    #[tokio::test]
    async fn session_for_view_only_format_mints_fresh_keys() {
        let (dir, app, state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;

        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        let doc = mount.join("Letter.fodt");
        std::fs::write(&doc, b"<office:document/>").unwrap();
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(
                &conn,
                "drive-a",
                "A",
                "mounted",
                "ext4",
                "sda",
                mount.to_str().unwrap(),
            )
            .unwrap();
        }

        async fn open_fodt(app: &axum::Router, cookie: &str, csrf: &str) -> String {
            let res = call(
                app,
                req(
                    Method::POST,
                    "/api/v1/office/session",
                    Body::from(r#"{"drive_id":"drive-a","path":"Letter.fodt"}"#),
                    cookie,
                    csrf,
                ),
            )
            .await;
            let status = res.status();
            let body = axum::body::to_bytes(res.into_body(), 1 << 20)
                .await
                .unwrap();
            assert_eq!(
                status,
                200,
                "session body: {}",
                String::from_utf8_lossy(&body)
            );
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            v["key"].as_str().unwrap().to_string()
        }

        // A view-mode room can even be live (someone is watching) — the key
        // is still minted fresh, because reuse would open the bundle without
        // the ops layered over it.
        let key_a = open_fodt(&app, &cookie, &csrf).await;
        state
            .office_docs
            .auth(
                &key_a,
                1,
                &serde_json::json!({
                    "type": "auth",
                    "docid": key_a,
                    "user": { "id": "u-max", "username": "Max" },
                    "mode": "view",
                }),
                false,
            )
            .await
            .unwrap();

        std::fs::write(&doc, b"<office:document>edited</office:document>").unwrap();
        let key_b = open_fodt(&app, &cookie, &csrf).await;
        assert_ne!(key_b, key_a);
    }
}
