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

use std::net::SocketAddr;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::AppState;
use crate::access::{CAP_EDIT, CAP_VIEW, KIND_PATH, path_contains};
use crate::api::access;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser, OfficeClaims};
use crate::db::{self, AccessLinkRow};
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

#[derive(Debug, Deserialize)]
struct GuestSessionBody {
    /// Path relative to the link root; file links send "".
    #[serde(default)]
    path: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/office/session", post(create_session))
        .route("/s/{token}/office/session", post(guest_session))
        // Bundle PUT bodies run up to MAX_BUNDLE_FILE_BYTES — the layer
        // must sit on the PUT method router, not the route (session POSTs
        // keep the 2 MiB default) — or `Bytes` extracts hit axum's default
        // and large Editor.bin saves 413 before the size check runs.
        .route(
            "/api/v1/office/bundle/{key}/{*name}",
            get(bundle_get)
                .head(bundle_head)
                .merge(put(bundle_put).layer(DefaultBodyLimit::max(MAX_BUNDLE_FILE_BYTES))),
        )
        .route(
            "/s/office-bundle/{key}/{bundle_id}/{*name}",
            get(scoped_bundle_get)
                .head(scoped_bundle_head)
                .merge(put(scoped_bundle_put).layer(DefaultBodyLimit::max(MAX_BUNDLE_FILE_BYTES))),
        )
}

/// Open step 1: validate access, mint the doc key + office token the
/// docstorage socket will verify, and register key → file binding.
async fn create_session(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    headers: HeaderMap,
    Json(body): Json<SessionBody>,
) -> Result<Response, (StatusCode, Json<Value>)> {
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

    prepare_session(
        &state,
        &headers,
        drive_id,
        path,
        user.id.clone(),
        user.username.clone(),
        can_write,
        None,
        None,
    )
    .await
}

/// Guest open step 1: the link resolves the file (never a client drive_id),
/// then the session is minted the same way as a member's — with a unique
/// guest identity and the link's edit bit as the ceiling.
async fn guest_session(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<GuestSessionBody>,
) -> Response {
    let session_headers = headers.clone();
    let request_token = token.clone();
    access::run_public(&state, &addr, &token, &headers, move |state, link| {
        let headers = session_headers.clone();
        let rel = body.path.clone();
        let token = request_token.clone();
        async move {
            if !state
                .share_limiter
                .allow(&format!("office-session:{}", addr.ip()))
            {
                return Err(json_error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many attempts. Wait a few minutes and try again.",
                ));
            }
            let path = access::link_file(&state, &link, &rel)?;
            let can_write = link.caps & CAP_EDIT != 0;
            let user_id = format!("guest:{}", Uuid::new_v4().simple());
            // The editor's config URL must be fetchable by the guest — point
            // it at the link's own file endpoint, never the member API.
            let raw = if link.token.is_empty() {
                &token
            } else {
                &link.token
            };
            let rel_path = rel.trim();
            let document_url = if rel_path.is_empty() {
                format!("/s/{raw}/file")
            } else {
                format!("/s/{raw}/file?path={}", urlencoding(rel_path))
            };
            prepare_session(
                &state,
                &headers,
                link.drive_id.clone(),
                path,
                user_id,
                "Guest".to_string(),
                can_write,
                Some(&link),
                Some(document_url),
            )
            .await
        }
    })
    .await
}

/// Shared session assembly for member and guest opens: file metadata → doc
/// key → scoped office token → session JSON. When `link` is present the
/// token is bound to the link's current password revision so a rotation or
/// removal revokes open guest editors.
#[allow(clippy::too_many_arguments)]
async fn prepare_session(
    state: &AppState,
    headers: &HeaderMap,
    drive_id: String,
    path: String,
    user_id: String,
    username: String,
    can_write: bool,
    link: Option<&AccessLinkRow>,
    guest_document_url: Option<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
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
    // participant is never sent the authChanges op replay. A viewer's key is
    // unique per session so its converted bundle can never overwrite (or be
    // mistaken for) the live editable one.
    let key = if can_write && can_save_office_ext(&file_type) {
        state
            .office_docs
            .claim_live_key(&drive_id, &path)
            .await
            .unwrap_or_else(|| document_key(&drive_id, &path, size, modified))
    } else {
        format!(
            "{}-view-{}",
            document_key(&drive_id, &path, size, modified),
            Uuid::new_v4().simple()
        )
    };
    state.office_docs.register_key(&key, &drive_id, &path).await;

    // The credential path carries a per-open bundle_id: a member and a guest
    // sharing one room key get different bundle URLs and cookie paths, so a
    // same-browser open never overwrites the other's credential.
    let bundle_id = Uuid::new_v4().simple().to_string();
    let bundle_url = format!("/s/office-bundle/{key}/{bundle_id}");
    let claims = OfficeClaims {
        typ: "luna_office".into(),
        sub: user_id.clone(),
        drive_id: drive_id.clone(),
        path: path.clone(),
        write: can_write && can_save_office_ext(&file_type),
        exp: 0,
        key: Some(key.clone()),
        bundle_id: Some(bundle_id.clone()),
        link_id: link.map(|l| l.id.clone()),
        link_revision: link.map(|l| {
            blake3::hash(l.password_hash.as_bytes())
                .to_hex()
                .to_string()
        }),
    };
    let token = state
        .auth
        .issue_scoped_office_token(claims, OFFICE_TOKEN_TTL_SECS)
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare EuroOffice access. Try again.",
            )
        })?;

    // The docstorage shim never fetches document.url (the open reply names
    // bundle files instead), but DocsAPI wants a real URL in the config —
    // point it at the file's own content endpoint so it stays meaningful.
    // Guests get the link-scoped URL their credential can actually fetch.
    let document_url = guest_document_url.unwrap_or_else(|| {
        format!(
            "{}/api/v1/drives/{}/files/content?path={}",
            request_origin(headers),
            urlencoding(&drive_id),
            urlencoding(&path),
        )
    });

    let mut res = Json(json!({
        "key": key,
        "title": title,
        "file_type": file_type,
        "document_type": document_type,
        "can_write": can_write,
        "token": token,
        "bundle_url": bundle_url,
        "document_url": document_url,
        "user": {
            "id": user_id,
            "name": username,
        },
    }))
    .into_response();
    // SameSite=Strict + per-open Path: the cookie only ever reaches this
    // session's own bundle URL, so an iframe can read without leaking the
    // credential into another open's requests.
    let mut cookie = format!(
        "luna_office={token}; Path={bundle_url}; HttpOnly; SameSite=Strict; Max-Age={OFFICE_TOKEN_TTL_SECS}"
    );
    if auth::request_is_https(headers) {
        cookie.push_str("; Secure");
    }
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().append(header::SET_COOKIE, v);
    }
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    Ok(res)
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
    bundle_read(&state, &key, &name, head_only).await
}

async fn bundle_read(
    state: &AppState,
    key: &str,
    name: &str,
    head_only: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let file = bundle_file(state, key, name)?;
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
        .header(header::CONTENT_TYPE, bundle_mime(name));
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
    bundle_write(&state, &key, &name, &query, body, Some(&user.id)).await
}

/// Shared bundle write: size/empty/path validation, UUID temp file + rename,
/// then Editor.bin replay-log compaction. `saver` is the identity whose op
/// coverage is reported — `None` for view-key uploads, which never compact.
async fn bundle_write(
    state: &AppState,
    key: &str,
    name: &str,
    query: &std::collections::HashMap<String, String>,
    body: Bytes,
    saver: Option<&str>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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
    let file = bundle_file(state, key, name)?;
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't prepare a place for the converted document.",
            )
        })?;
    }
    let temp = file.with_extension(format!("part-{}", Uuid::new_v4().simple()));
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
    if name == "Editor.bin"
        && let Some(saver) = saver
    {
        let coverage = query.get("coverage").and_then(|v| v.parse::<i64>().ok());
        state
            .office_docs
            .bundle_refreshed(key, saver, coverage)
            .await;
    }
    Ok(Json(json!({ "ok": true })))
}

/// Scoped bundle endpoint — every session (member or guest) gets a token
/// pinned to its document key AND a per-open bundle id, so two opens of the
/// same room never share a credential path. GET/HEAD accept the
/// `luna_office` cookie (the iframe can't set headers); PUT always requires
/// the X-Office-Token header so a cookie alone can never write.
fn scoped_claims(
    state: &AppState,
    headers: &HeaderMap,
    key: &str,
    bundle_id: &str,
) -> Option<OfficeClaims> {
    let token = headers
        .get("x-office-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get(header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .and_then(|jar| {
                    jar.split(';')
                        .map(str::trim)
                        .find_map(|c| c.strip_prefix("luna_office=").map(str::to_string))
                })
        })?;
    let claims = state.auth.verify_office_token(&token).ok()?;
    if claims.key.as_deref() != Some(key) || claims.bundle_id.as_deref() != Some(bundle_id) {
        return None;
    }
    Some(claims)
}

fn forbidden() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::FORBIDDEN,
        "You don't have permission to open this file.",
    )
}

/// Bundle replies — including denials — must never be cached or navigated
/// into active same-origin content (a stored SVG answers image/svg+xml, and
/// the sandbox CSP keeps even a forced top-level navigation inert).
fn scoped_finish(res: Response) -> Response {
    let mut res = res;
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    res
}

async fn scoped_bundle_get_inner(
    state: &AppState,
    headers: &HeaderMap,
    key: &str,
    bundle_id: &str,
    name: &str,
    head_only: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(claims) = scoped_claims(state, headers, key, bundle_id) else {
        return Err(forbidden());
    };
    if current_office_access(state, &claims).is_none() {
        return Err(forbidden());
    }
    bundle_read(state, key, name, head_only).await
}

async fn scoped_bundle_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((key, bundle_id, name)): Path<(String, String, String)>,
) -> Response {
    scoped_finish(
        match scoped_bundle_get_inner(&state, &headers, &key, &bundle_id, &name, false).await {
            Ok(res) => res,
            Err(e) => e.into_response(),
        },
    )
}

async fn scoped_bundle_head(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((key, bundle_id, name)): Path<(String, String, String)>,
) -> Response {
    scoped_finish(
        match scoped_bundle_get_inner(&state, &headers, &key, &bundle_id, &name, true).await {
            Ok(res) => res,
            Err(e) => e.into_response(),
        },
    )
}

async fn scoped_bundle_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((key, bundle_id, name)): Path<(String, String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    scoped_finish(
        match scoped_bundle_put_inner(&state, &headers, &key, &bundle_id, &name, &query, body).await
        {
            Ok(v) => v.into_response(),
            Err(e) => e.into_response(),
        },
    )
}

async fn scoped_bundle_put_inner(
    state: &AppState,
    headers: &HeaderMap,
    key: &str,
    bundle_id: &str,
    name: &str,
    query: &std::collections::HashMap<String, String>,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Writes always require the header credential — the HttpOnly cookie is
    // read-only so a CSRF-style form post can never install a bundle.
    let token = headers
        .get("x-office-token")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(forbidden)?;
    let claims = state
        .auth
        .verify_office_token(token)
        .map_err(|_| forbidden())?;
    if claims.key.as_deref() != Some(key) || claims.bundle_id.as_deref() != Some(bundle_id) {
        return Err(forbidden());
    }
    let Some(can_write_now) = current_office_access(state, &claims) else {
        return Err(forbidden());
    };
    // A token that once had write loses it the moment the grant does —
    // never silently downgraded to a viewer upload.
    if claims.write && !can_write_now {
        return Err(forbidden());
    }
    let saver = if claims.write {
        Some(claims.sub.as_str())
    } else {
        None
    };
    bundle_write(state, key, name, query, body, saver).await
}

/// Re-check a scoped (or legacy member) office token against the *current*
/// grant: link rows must still exist, be unexpired, carry the same password
/// revision, and still cover the claimed path; member claims re-run the
/// capability check for the live user. Returns the current write bit —
/// `Some(false)` means the session is a valid viewer.
pub(crate) fn current_office_access(state: &AppState, claims: &OfficeClaims) -> Option<bool> {
    if claims.exp <= db::now_unix() {
        return None;
    }
    if let Some(link_id) = claims.link_id.as_deref() {
        let conn = state.db.lock().ok()?;
        let link = db::get_access_link(&conn, link_id).ok()??;
        if link.subject_kind != KIND_PATH || crate::access::link_expired(&link) {
            return None;
        }
        let revision = blake3::hash(link.password_hash.as_bytes())
            .to_hex()
            .to_string();
        if claims.link_revision.as_deref() != Some(revision.as_str()) {
            return None;
        }
        if link.drive_id != claims.drive_id || !path_contains(&link.path, &claims.path) {
            return None;
        }
        let (root, root_meta) = files::resolve_any(&conn, &link.drive_id, &link.path).ok()?;
        // file_path (not resolve_any): the target must be a live file, so a
        // deleted file or a directory immediately invalidates access.
        let (target, target_meta) = files::file_path(&conn, &link.drive_id, &claims.path).ok()?;
        if !target_meta.is_file() {
            return None;
        }
        let inside = if root_meta.is_dir() {
            target.starts_with(&root)
        } else {
            target == root
        };
        if !inside || link.caps & CAP_VIEW == 0 {
            return None;
        }
        return Some(claims.write && (link.caps & CAP_EDIT != 0));
    }
    let conn = state.db.lock().ok()?;
    let row = db::get_user(&conn, &claims.sub).ok()??;
    let user = CurrentUser {
        id: row.id,
        username: row.username,
        role: row.role,
    };
    if !auth::has_cap(&user, &conn, &claims.drive_id, &claims.path, CAP_VIEW) {
        return None;
    }
    // The underlying file must still exist — an admin must not keep a live
    // bundle for a file that was deleted.
    let (_, meta) = files::file_path(&conn, &claims.drive_id, &claims.path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(claims.write && auth::has_cap(&user, &conn, &claims.drive_id, &claims.path, CAP_EDIT))
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
/// reject anything that could escape the key directory. The raw capture must
/// validate *as received*: an encoded leading slash or a `.` segment that
/// sailed through decoding would otherwise be joined verbatim.
fn valid_bundle_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('/')
        || name.ends_with('/')
        || name.contains("..")
        || name.contains('\\')
    {
        return false;
    }
    name.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
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
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
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
    Ok(crate::auth::has_cap(
        user,
        &conn,
        drive_id,
        path,
        if write {
            crate::access::CAP_EDIT
        } else {
            crate::access::CAP_VIEW
        },
    ))
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive. Make sure it is plugged in.",
        ),
        FilesError::MissingDriveDb => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            files::MISSING_DRIVE_DB_MSG,
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
        // Leading/trailing slashes and `.`/`..` segments must be refused
        // before the name is joined — never trimmed then joined.
        assert!(!valid_bundle_name("/Editor.bin"));
        assert!(!valid_bundle_name("Editor.bin/"));
        assert!(!valid_bundle_name("media/./image1.png"));
        assert!(!valid_bundle_name("media/image1.png/../../etc/passwd"));
        assert!(!valid_bundle_name("media\\image1.png"));
        assert!(!valid_bundle_name("..\\..\\win.ini"));
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

    /// Regression: `Bytes` extracts hit axum's 2 MiB `DefaultBodyLimit`
    /// long before `MAX_BUNDLE_FILE_BYTES` applied, so a large Editor.bin
    /// save 413'd at the extractor instead of reaching the handler. A
    /// body over the axum default but under the bundle cap must land.
    #[tokio::test]
    async fn bundle_put_accepts_bodies_over_the_axum_default() {
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
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let key = v["key"].as_str().unwrap().to_string();
        let uri = format!("/api/v1/office/bundle/{key}/Editor.bin");

        // 3 MiB — over the 2 MiB default, far under MAX_BUNDLE_FILE_BYTES.
        let res = call(
            &app,
            req(
                Method::PUT,
                &uri,
                Body::from(vec![7u8; 3 * 1024 * 1024]),
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
        assert_eq!(std::fs::metadata(&bin).unwrap().len(), 3 * 1024 * 1024);
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

    fn mount_drive_a(dir: &tempfile::TempDir, files: &[(&str, &[u8])]) {
        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        for (rel, bytes) in files {
            let f = mount.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, bytes).unwrap();
        }
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

    fn add_link(
        dir: &tempfile::TempDir,
        token: &str,
        path: &str,
        caps: i64,
        password_hash: &str,
        expires_at: Option<i64>,
    ) -> String {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let id = uuid::Uuid::new_v4().simple().to_string();
        crate::db::insert_access_link(
            &conn,
            &crate::db::AccessLinkRow {
                id: id.clone(),
                token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
                token: token.into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "drive-a".into(),
                path: path.into(),
                album_id: String::new(),
                caps,
                password_hash: password_hash.into(),
                expires_at,
                created_by: "u".into(),
                created_at: 0,
            },
        )
        .unwrap();
        id
    }

    async fn guest_session_call(
        app: &axum::Router,
        token: &str,
        body: &str,
        extra: &[(&str, &str)],
    ) -> axum::response::Response {
        let mut b = HttpReq::builder()
            .method(Method::POST)
            .uri(format!("/s/{token}/office/session"))
            .header("content-type", "application/json");
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        let mut http = b.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        call(app, http).await
    }

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn scoped_req(
        method: Method,
        uri: &str,
        body: Body,
        headers: &[(&str, &str)],
    ) -> HttpReq<Body> {
        let mut b = HttpReq::builder().method(method).uri(uri);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let mut http = b.body(body).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    /// A view-only file link still opens EuroOffice: the session is scoped
    /// to the link, gets a guest identity and a unique view key, and the
    /// converted bundle can only be written to that key with the header
    /// token — never with the cookie alone, never to another key.
    #[tokio::test]
    async fn guest_view_session_and_scoped_bundle() {
        let (dir, app, state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        let link_id = add_link(
            &dir,
            "tok-g1",
            "docs/Report.docx",
            crate::access::CAP_VIEW,
            "",
            None,
        );

        let res = guest_session_call(&app, "tok-g1", "{}", &[]).await;
        let status = res.status();
        let office_cookie = res
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .find(|c| c.starts_with("luna_office="))
            .expect("luna_office cookie");
        assert_eq!(status, 200);
        let v = body_json(res).await;
        assert_eq!(v["can_write"], false);
        assert!(v["user"]["id"].as_str().unwrap().starts_with("guest:"));
        assert_eq!(v["user"]["name"], "Guest");
        let key = v["key"].as_str().unwrap().to_string();
        assert!(key.contains("-view-"), "view key must be unique: {key}");
        let bundle_url = v["bundle_url"].as_str().unwrap().to_string();
        assert!(bundle_url.starts_with(&format!("/s/office-bundle/{key}/")));
        let jwt = v["token"].as_str().unwrap().to_string();
        let claims = state.auth.verify_office_token(&jwt).unwrap();
        assert_eq!(claims.key.as_deref(), Some(key.as_str()));
        assert_eq!(
            claims.bundle_id.as_deref(),
            bundle_url.rsplit('/').next().map(Some).unwrap_or(None)
        );
        assert_eq!(claims.link_id.as_deref(), Some(link_id.as_str()));
        assert_eq!(claims.path, "docs/Report.docx");
        assert!(!claims.write);
        assert!(office_cookie.contains("HttpOnly"));
        assert!(office_cookie.contains(&format!("Path={bundle_url}")));

        // Cookie read works (iframe can't set headers).
        let uri = format!("{bundle_url}/Editor.bin");
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![1u8, 2, 3]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &uri,
                Body::empty(),
                &[("cookie", &office_cookie)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // Key mismatch: this token may never touch another document's bundle.
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                "/s/office-bundle/other-key/other-open/Editor.bin",
                Body::from(vec![9u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                "/s/office-bundle/other-key/other-open/Editor.bin",
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);

        // Same key but a foreign open's bundle id: still denied.
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &format!("/s/office-bundle/{key}/another-open/Editor.bin"),
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &format!("/s/office-bundle/{key}/another-open/Editor.bin"),
                Body::from(vec![9u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);

        // Writes require the header credential — cookie alone is denied.
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![9u8]),
                &[("cookie", &office_cookie)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);

        // No credential at all: nothing.
        let res = call(&app, scoped_req(Method::GET, &uri, Body::empty(), &[])).await;
        assert_eq!(res.status(), 403);
    }

    /// A full-caps folder link edits files beneath its root; paths outside
    /// the share are refused before a session is ever minted.
    #[tokio::test]
    async fn guest_full_link_maps_relative_path_and_edits() {
        let (dir, app, state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        add_link(&dir, "tok-g2", "docs", crate::access::CAP_ALL, "", None);

        let res = guest_session_call(&app, "tok-g2", r#"{"path":"Report.docx"}"#, &[]).await;
        assert_eq!(res.status(), 200);
        let v = body_json(res).await;
        assert_eq!(v["can_write"], true);
        let claims = state
            .auth
            .verify_office_token(v["token"].as_str().unwrap())
            .unwrap();
        assert_eq!(claims.path, "docs/Report.docx");
        assert!(claims.write);
        assert!(!v["key"].as_str().unwrap().contains("-view-"));

        // Traversal and siblings of a file link are refused.
        let res = guest_session_call(&app, "tok-g2", r#"{"path":"../x.docx"}"#, &[]).await;
        assert_eq!(res.status(), 400);
        add_link(
            &dir,
            "tok-g3",
            "docs/Report.docx",
            crate::access::CAP_ALL,
            "",
            None,
        );
        let res = guest_session_call(&app, "tok-g3", r#"{"path":"Other.docx"}"#, &[]).await;
        assert_eq!(res.status(), 403);
    }

    /// Password links gate the session endpoint too: the header unlocks it
    /// and issues the link-scoped proof cookie, and rotating the password
    /// revokes both the proof and every minted office token.
    #[tokio::test]
    async fn guest_password_gates_and_rotation_revokes() {
        let (dir, app, state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        let hash = crate::auth::hash_password_unchecked("secretpassword1").unwrap();
        let link_id = add_link(
            &dir,
            "tok-g4",
            "docs/Report.docx",
            crate::access::CAP_ALL,
            &hash,
            None,
        );

        // No credential → needs password.
        let res = guest_session_call(&app, "tok-g4", "{}", &[]).await;
        assert_eq!(res.status(), 401);

        // Correct header → session + link proof cookie.
        let res = guest_session_call(
            &app,
            "tok-g4",
            "{}",
            &[("x-share-password", "secretpassword1")],
        )
        .await;
        assert_eq!(res.status(), 200);
        let proof_cookie = res
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .find(|c| c.starts_with(&format!("luna_link_{link_id}=")))
            .expect("link proof cookie")
            .split(';')
            .next()
            .unwrap()
            .to_string();
        let v = body_json(res).await;
        let jwt = v["token"].as_str().unwrap().to_string();

        // The proof cookie alone unlocks a second session.
        let res = guest_session_call(&app, "tok-g4", "{}", &[("cookie", &proof_cookie)]).await;
        assert_eq!(res.status(), 200);

        // Rotate the password: old proof dies AND minted office tokens die.
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let mut link = crate::db::get_access_link(&conn, &link_id)
            .unwrap()
            .unwrap();
        link.password_hash = crate::auth::hash_password_unchecked("newpassword22").unwrap();
        crate::db::update_access_link(&conn, &link).unwrap();
        drop(conn);

        let res = guest_session_call(&app, "tok-g4", "{}", &[("cookie", &proof_cookie)]).await;
        assert_eq!(res.status(), 401);
        let minted = state.auth.verify_office_token(&jwt).unwrap();
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &format!(
                    "/s/office-bundle/{}/{}/Editor.bin",
                    minted.key.as_deref().unwrap(),
                    minted.bundle_id.as_deref().unwrap()
                ),
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403, "rotated link must revoke minted tokens");
    }

    /// Downgrading a link after mint flips write off live; deleting it drops
    /// reads too — `current_office_access` is consulted on every bundle hit.
    #[tokio::test]
    async fn guest_revocation_and_downgrade_take_effect_live() {
        let (dir, app, state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        let link_id = add_link(&dir, "tok-g5", "docs", crate::access::CAP_ALL, "", None);

        let res = guest_session_call(&app, "tok-g5", r#"{"path":"Report.docx"}"#, &[]).await;
        assert_eq!(res.status(), 200);
        let v = body_json(res).await;
        let jwt = v["token"].as_str().unwrap().to_string();
        let uri = format!("{}/Editor.bin", v["bundle_url"].as_str().unwrap());
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![1u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // Downgrade to view: writes die, reads survive.
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let mut link = crate::db::get_access_link(&conn, &link_id)
            .unwrap()
            .unwrap();
        link.caps = crate::access::CAP_VIEW;
        crate::db::update_access_link(&conn, &link).unwrap();
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![2u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403, "downgrade must stop writes");
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &uri,
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "view still valid after downgrade");

        // Revoke entirely: reads die too.
        crate::db::delete_access_link(&conn, &link_id).unwrap();
        drop(conn);
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &uri,
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403, "deleted link must revoke reads");
        let _ = state;
    }

    /// Expired links never open a session; non-path subjects can't either.
    #[tokio::test]
    async fn guest_expired_and_wrong_subject_rejected() {
        let (dir, app, _state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        add_link(
            &dir,
            "tok-g6",
            "docs",
            crate::access::CAP_ALL,
            "",
            Some(crate::db::now_unix() - 60),
        );
        let res = guest_session_call(&app, "tok-g6", r#"{"path":"Report.docx"}"#, &[]).await;
        assert_eq!(res.status(), 410);
    }

    /// A member with only a view grant opens in view mode: fresh unique key,
    /// `write:false` claims — yet the conversion upload to its own key is
    /// allowed so the viewer can actually initialize.
    #[tokio::test]
    async fn member_read_only_session_uses_view_key() {
        let (dir, app, state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);

        // Second user with a view-only member grant on the file.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/users",
                Body::from(r#"{"username":"ann","password":"hunter22hunter2"}"#),
                &cookie,
                &csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let created = body_json(res).await;
        let ann_id = created["id"].as_str().unwrap().to_string();
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "m1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "drive-a".into(),
                    path: "docs/Report.docx".into(),
                    album_id: String::new(),
                    user_id: ann_id,
                    caps: crate::access::CAP_VIEW,
                    created_by: "u".into(),
                },
            )
            .unwrap();
        }
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"ann","password":"hunter22hunter2"}"#,
            ),
        )
        .await;
        let mut session = String::new();
        let mut ann_csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(t) = part.strip_prefix("luna_csrf=") {
                ann_csrf = t.to_string();
            }
        }
        let ann_cookie = format!("{session}; luna_csrf={ann_csrf}");

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/office/session",
                Body::from(r#"{"drive_id":"drive-a","path":"docs/Report.docx"}"#),
                &ann_cookie,
                &ann_csrf,
            ),
        )
        .await;
        let status = res.status();
        let v = body_json(res).await;
        assert_eq!(status, 200, "{v}");
        assert_eq!(v["can_write"], false);
        let key = v["key"].as_str().unwrap().to_string();
        assert!(key.contains("-view-"), "read-only member gets a view key");
        let jwt = v["token"].as_str().unwrap().to_string();
        let claims = state.auth.verify_office_token(&jwt).unwrap();
        assert!(!claims.write);
        assert_eq!(claims.link_id, None);

        // Viewer init upload to its own scoped key is allowed.
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &format!("{}/Editor.bin", v["bundle_url"].as_str().unwrap()),
                Body::from(vec![1u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let _ = (cookie, csrf, key);
    }

    /// Two opens of the same writable room — a member's and a guest's —
    /// share the document key but get different per-open bundle URLs, and
    /// each cookie is pinned to its own path so one tab's credential can
    /// never replace the other's.
    #[tokio::test]
    async fn member_and_guest_opens_get_isolated_bundle_paths() {
        let (dir, app, _state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        add_link(
            &dir,
            "tok-mg",
            "docs/Report.docx",
            crate::access::CAP_ALL,
            "",
            None,
        );

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/office/session",
                Body::from(r#"{"drive_id":"drive-a","path":"docs/Report.docx"}"#),
                &cookie,
                &csrf,
            ),
        )
        .await;
        let member_cookie = res
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .find(|c| c.starts_with("luna_office="))
            .expect("member luna_office cookie");
        assert_eq!(res.status(), 200);
        let mv = body_json(res).await;

        let res = guest_session_call(&app, "tok-mg", "{}", &[]).await;
        let guest_cookie = res
            .headers()
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .find(|c| c.starts_with("luna_office="))
            .expect("guest luna_office cookie");
        assert_eq!(res.status(), 200);
        let gv = body_json(res).await;

        assert_eq!(mv["key"], gv["key"], "writable room key is shared");
        let mu = mv["bundle_url"].as_str().unwrap();
        let gu = gv["bundle_url"].as_str().unwrap();
        assert_ne!(mu, gu, "each open gets its own bundle id");
        assert!(member_cookie.contains(&format!("Path={mu}")));
        assert!(guest_cookie.contains(&format!("Path={gu}")));

        // The guest's document URL is link-scoped — never the member API and
        // never carrying a password.
        assert_eq!(gv["document_url"], "/s/tok-mg/file");
        assert!(
            mv["document_url"]
                .as_str()
                .unwrap()
                .contains("/api/v1/drives/drive-a/files/content")
        );
    }

    /// Folder links hand the editor the link-scoped file URL with the
    /// relative path percent-encoded as UTF-8 bytes.
    #[tokio::test]
    async fn guest_folder_document_url_encodes_the_relative_path() {
        let (dir, app, _state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Mönch Report.docx", b"pk")]);
        add_link(&dir, "tok-fu", "docs", crate::access::CAP_VIEW, "", None);

        let res = guest_session_call(&app, "tok-fu", r#"{"path":"Mönch Report.docx"}"#, &[]).await;
        assert_eq!(res.status(), 200);
        let v = body_json(res).await;
        assert_eq!(
            v["document_url"],
            "/s/tok-fu/file?path=M%C3%B6nch%20Report.docx"
        );
    }

    /// Scoped bundle replies — success AND denial — carry the sandbox CSP,
    /// no-referrer, and no-store headers; the validator never joins a name
    /// that snuck a leading slash or dot segment past decoding.
    #[tokio::test]
    async fn scoped_bundle_headers_and_path_rejection() {
        let (dir, app, _state) = test_app();
        let _ = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        add_link(
            &dir,
            "tok-h",
            "docs/Report.docx",
            crate::access::CAP_ALL,
            "",
            None,
        );
        let res = guest_session_call(&app, "tok-h", "{}", &[]).await;
        assert_eq!(res.status(), 200);
        let v = body_json(res).await;
        let jwt = v["token"].as_str().unwrap().to_string();
        let base = v["bundle_url"].as_str().unwrap().to_string();
        let uri = format!("{base}/Editor.bin");
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![1u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &uri,
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        assert_eq!(
            res.headers()["content-security-policy"],
            "sandbox; default-src 'none'"
        );
        assert_eq!(res.headers()["referrer-policy"], "no-referrer");
        assert_eq!(res.headers()["cache-control"], "no-store");

        // Denials carry the same headers.
        let res = call(&app, scoped_req(Method::GET, &uri, Body::empty(), &[])).await;
        assert_eq!(res.status(), 403);
        assert_eq!(
            res.headers()["content-security-policy"],
            "sandbox; default-src 'none'"
        );
        assert_eq!(res.headers()["cache-control"], "no-store");

        // Names that would escape the key directory are refused — including
        // an encoded leading slash that decodes after route matching.
        for name in [
            "%2Fetc%2Fpasswd",
            "media/..%2F..%2Fetc",
            "media/./x.png",
            "media%5Cevil.png",
        ] {
            let res = call(
                &app,
                scoped_req(
                    Method::GET,
                    &format!("{base}/{name}"),
                    Body::empty(),
                    &[("x-office-token", &jwt)],
                ),
            )
            .await;
            assert!(
                res.status().is_client_error(),
                "{name} must not read: {}",
                res.status()
            );
        }
        // A safe nested media path still resolves past the validator.
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &format!("{base}/media/image1.png"),
                Body::from(vec![1u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
    }

    /// Deleting the underlying file kills live access — even for the admin
    /// who opened it.
    #[tokio::test]
    async fn deleted_file_invalidates_member_scoped_access() {
        let (dir, app, _state) = test_app();
        let (cookie, csrf) = admin_login(&app).await;
        mount_drive_a(&dir, &[("docs/Report.docx", b"pk")]);
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/office/session",
                Body::from(r#"{"drive_id":"drive-a","path":"docs/Report.docx"}"#),
                &cookie,
                &csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let v = body_json(res).await;
        let jwt = v["token"].as_str().unwrap().to_string();
        let uri = format!("{}/Editor.bin", v["bundle_url"].as_str().unwrap());
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![1u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        std::fs::remove_file(dir.path().join("drive-a/docs/Report.docx")).unwrap();
        let res = call(
            &app,
            scoped_req(
                Method::GET,
                &uri,
                Body::empty(),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403, "a deleted file must close the bundle");
        let res = call(
            &app,
            scoped_req(
                Method::PUT,
                &uri,
                Body::from(vec![2u8]),
                &[("x-office-token", &jwt)],
            ),
        )
        .await;
        assert_eq!(res.status(), 403);
    }
}
