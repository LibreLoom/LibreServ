//! Luna Forms: `.lunaform` files shared through respond links (the
//! link-only `CAP_RESPOND` capability in `crate::access`). A respond link
//! lets anyone with the URL open the form and insert one row into the form's
//! answers database — a hidden `.<name>.lunaform.responses.sqlite` sidecar —
//! but never read other people's answers back (a respondent can only
//! re-fetch their own record by presenting the edit secret they were issued
//! at submit time).
//!
//! All respond-permission logic lives here so it stays small and can ride
//! whatever sharing rework lands: link resolution is self-contained, and
//! `shares.rs`' public GET only needs to hand `(drive_id, path)` over when a
//! resolved link carries `CAP_RESPOND`.
//!
//! Access to answers is deliberately two-layered, and this is the decided
//! model — not an oversight:
//!
//! - Reading answers — the Responses list, summary, export, usage, and the
//!   SQLite download/editor — requires `CAP_VIEW`. Read means read the
//!   answers.
//! - Changing them — delete, clear, and saving the SQLite editor — requires
//!   `CAP_EDIT`. View-only members and view links can open the form; view
//!   links cannot read its answers through the guest routes.
//! - Respond links are the exception: public routes never expose answers,
//!   so a guest with only `CAP_RESPOND` never reads anyone's answers.

use argon2::password_hash::rand_core::RngCore;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::io::Write;
use std::net::SocketAddr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path as FsPath, PathBuf};

use crate::AppState;
use crate::api::response::{json_error, json_error_code};
use crate::auth::{self, CurrentUser};
use crate::db;

pub(crate) mod store;
use store::{FormStore, response_json};

/// Share permission for answer links: the public page renders the form and
/// `POST /s/{token}/respond` inserts one answer. Respondents may
/// also upload a photo or PDF (`POST /s/{token}/respond-file`) and load a
/// picture the form already references (`GET /s/{token}/form-image`). No file
/// listing, no other downloads.
///
/// Attachments and question pictures live in the form's files folder (see
/// [`form_files_dir`]): a Luna-owned name, so listings, search, Photos, zips,
/// WebDAV, and the files API never show it. Only the form routes here read
/// it, with the same access as the answers themselves.
pub const PERMISSION_RESPOND: &str = "respond";

/// Form documents are `<name>.lunaform` JSON envelopes.
pub const FORM_FILE_SUFFIX: &str = ".lunaform";

/// Answers live next to the form in a hidden SQLite sidecar:
/// `.name.lunaform.responses.sqlite`. See [`store`] for the schema and the
/// snapshot rules. The old JSONL family is not read.
///
/// Highest `.lunaform` envelope version this build understands.
const FORM_DOC_VERSION: i64 = 1;

/// A form is a hand-editable JSON file — refuse absurdly large ones.
const MAX_FORM_BYTES: u64 = 1024 * 1024;
/// Answer payloads are small — a long-text essay is still kilobytes.
const RESPOND_BODY_BYTES: usize = 256 * 1024;
/// One text answer, in bytes. Far past any real essay; a submission is not a
/// file upload.
const MAX_ANSWER_TEXT_BYTES: usize = 32 * 1024;
/// Every answer on one submission, as JSON. Under [`RESPOND_BODY_BYTES`] so a
/// request that parses can always be stored.
const MAX_ANSWER_PAYLOAD_BYTES: usize = 128 * 1024;
/// One photo or PDF attached to an answer.
const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// A picture shown on a question, already on the drive.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Sanity cap on distinct question ids in one submission.
const MAX_ANSWER_KEYS: usize = 500;
/// `true` when a share path names a form document (case-insensitive ext).
pub fn is_form_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(FORM_FILE_SUFFIX)
}

/// Namespaced bucket key so respond limits don't share a raw-IP bucket with
/// login/DAV/share limiters — same convention as `public_limits.rs`. Each
/// endpoint gets its own bucket: a form with a few file questions spends
/// one upload per attachment and must still be able to send.
fn respond_key(kind: &str, ip: &str) -> String {
    crate::rate_limit::ip_key(&format!("form_respond_{kind}"), ip)
}

/// One form's answer budget, shared by every address. The path is hashed so a
/// form's location never lands in the rate-limit table; the bucket is still
/// per form, whatever address the submissions come from. A distributed flood
/// therefore cannot spend a form's whole `maxResponses` budget before the
/// people it was sent to arrive.
fn form_key(drive_id: &str, path: &str) -> String {
    let tag = blake3::hash(format!("{drive_id}\n{path}").as_bytes()).to_hex();
    format!("form_respond:form:{tag}")
}

/// The respondent's address for rate limiting. Behind Luna Connect every
/// request arrives from loopback, so the forwarded client IP is what tells
/// respondents apart (`client_ip` only trusts those headers from loopback).
fn respondent_ip(addr: &SocketAddr, headers: &HeaderMap) -> String {
    crate::api::auth::client_ip(addr, headers).to_string()
}

fn form_gone() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::NOT_FOUND,
        "This form moved or was deleted. Reload the page and try again.",
    )
}

fn too_many_tries() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many tries from this network just now. Wait a minute and try again.",
    )
}

fn form_busy() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::TOO_MANY_REQUESTS,
        "This form is busy. Wait a moment and try again.",
    )
}

/// Upload and picture routes carry the file body; everything else is small.
const PICTURE_BODY_BYTES: usize = MAX_IMAGE_BYTES as usize + 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/s/{token}/respond",
            get(respond_lookup)
                .post(respond_submit)
                .layer(DefaultBodyLimit::max(RESPOND_BODY_BYTES)),
        )
        .route(
            "/s/{token}/respond-file",
            post(respond_upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + 64 * 1024)),
        )
        .route("/s/{token}/form-image", get(respond_image))
        .route("/api/v1/forms/file", get(member_form_file))
        .route("/s/{token}/form-file", get(guest_form_file))
        .route(
            "/api/v1/forms/responses",
            get(member_form_responses).delete(member_delete_response),
        )
        .route("/api/v1/forms/summary", get(member_form_summary))
        .route("/api/v1/forms/export", get(member_form_export))
        .route("/api/v1/forms/usage", get(member_form_usage))
        .route(
            "/api/v1/forms/sqlite",
            get(member_form_sqlite)
                .put(member_save_sqlite)
                .layer(DefaultBodyLimit::max(
                    store::MAX_EDITOR_BYTES as usize + 64 * 1024,
                )),
        )
        .route(
            "/s/{token}/responses",
            get(guest_form_responses).delete(guest_delete_response),
        )
        .route("/s/{token}/summary", get(guest_form_summary))
        .route("/s/{token}/export", get(guest_form_export))
        .route("/api/v1/forms/picture", post(member_copy_picture))
        .route(
            "/api/v1/forms/picture-upload",
            post(member_upload_picture).layer(DefaultBodyLimit::max(PICTURE_BODY_BYTES)),
        )
        .route("/s/{token}/form-picture", post(guest_copy_picture))
        .route(
            "/s/{token}/form-picture-upload",
            post(guest_upload_picture).layer(DefaultBodyLimit::max(PICTURE_BODY_BYTES)),
        )
}

/// One lock per form. Answers writes on different forms never wait on each
/// other, and a slow edit on one form cannot stall every other form's intake.
fn form_write_lock(path: &FsPath) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<std::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();
    let map = LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut map = map.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(())))
        .clone()
}

/// The name a form file goes by. A private form sits on disk under its
/// `.luna-` name; its companions are named after the real one.
fn leaf_name(path: &FsPath) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if crate::drives::layout::Layout::is_luna_name(name) {
        return crate::private::name_for_disk(name);
    }
    Some(name.to_string())
}

/// Is the file at this on-disk path a form document?
pub fn is_form_file(path: &FsPath) -> bool {
    leaf_name(path).is_some_and(|n| is_form_path(&n))
}

/// Resolve a respond link on the same rails as every other `/s/` link —
/// `access::resolve_public_link` owns token lookup, expiry, and password +
/// proof-cookie auth — then narrow to `CAP_RESPOND` on a path subject.
fn resolve_respond_link(
    state: &AppState,
    addr: &SocketAddr,
    token: &str,
    headers: &HeaderMap,
) -> Result<(db::AccessLinkRow, Option<String>), (StatusCode, Json<Value>)> {
    let (link, proof) = crate::api::access::resolve_public_link(state, addr, token, headers)?;
    if link.subject_kind != crate::access::KIND_PATH || link.caps & crate::access::CAP_RESPOND == 0
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This link doesn't open a form.",
        ));
    }
    Ok((link, proof))
}

/// Resolve the link's form file. Respond links are only valid on a real
/// `.lunaform` file — anything else was minted before the file moved or the
/// rules tightened.
fn resolve_form_file(
    conn: &rusqlite::Connection,
    drive_id: &str,
    path: &str,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    if !is_form_path(path) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        ));
    }
    let (path, meta) = crate::files::resolve_any(conn, drive_id, path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        )
    })?;
    if !meta.is_file() {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        ));
    }
    Ok(path)
}

/// A resolved form file and the hidden folder that holds its files.
struct FormLoc {
    path: PathBuf,
    files: PathBuf,
    /// The answer database, already resolved for trash and private forms.
    db: PathBuf,
}

/// The form's files folder: `{drive prefix}-form-{hash}` beside the form.
/// The `.luna-<uuid>` prefix makes it Luna bookkeeping everywhere files are
/// listed or served (`files::is_internal_temp`), and it sits next to the
/// form so backups, which walk the whole tree, cover it.
/// The hash of the form's file name keeps two forms in one folder apart and
/// the name short. The name is derived from the form's *file name*, so
/// anything that renames, moves, trashes, or restores a form must call
/// [`repath_form_files`] in the same step or the folder is orphaned; folder
/// moves need nothing because the folder travels inside its parent.
pub fn files_dir_for(root: &FsPath, form_path: &FsPath) -> Option<PathBuf> {
    files_dir_named(root, form_path, &leaf_name(form_path)?)
}

fn files_dir_named(root: &FsPath, form_path: &FsPath, name: &str) -> Option<PathBuf> {
    let layout = crate::drives::layout::Layout::detect(root)?;
    Some(form_path.parent()?.join(format!(
        "{}-form-{}",
        layout.prefix(),
        form_files_dir_hash(name)
    )))
}

/// The 16-hex tag a form's files folder carries, from the form's file name.
/// Shared with the backup walker, which must match folders to their forms.
pub(crate) fn form_files_dir_hash(name: &str) -> String {
    blake3::hash(name.as_bytes()).to_hex()[..16].to_string()
}

/// Where the form's answers database sits. Normally the hidden
/// `.<name>.lunaform.responses.sqlite` sibling; for a top-level trash entry
/// it is a Luna-owned name beside the files folder so the trash list never
/// shows it.
pub fn responses_db_for(root: &FsPath, form_path: &FsPath) -> Option<PathBuf> {
    store::db_path_for_root(root, form_path)
}

/// Compatibility alias for old call sites; the answers are a SQLite file now.
pub fn responses_file_for(root: &FsPath, form_path: &FsPath) -> Option<PathBuf> {
    responses_db_for(root, form_path)
}

fn move_if_present(from: &FsPath, to: &FsPath) {
    if from != to
        && std::fs::symlink_metadata(from).is_ok()
        && let Err(e) = crate::files::rename_noreplace(from, to)
    {
        tracing::warn!(from = %from.display(), to = %to.display(), error = %e, "form files did not follow the form");
    }
}

/// A form file was renamed, moved, trashed, or restored from `from` to `to`:
/// carry its files folder and answers file along. No-op when `from` is not
/// a form.
pub fn repath_form_files(from_root: &FsPath, from: &FsPath, to_root: &FsPath, to: &FsPath) {
    let (Some(from_name), Some(to_name)) = (leaf_name(from), leaf_name(to)) else {
        return;
    };
    repath_form_files_named(from_root, from, &from_name, to_root, to, &to_name);
}

/// [`repath_form_files`] with the names given, for a private form whose
/// disk name says nothing about what it is called.
pub fn repath_form_files_named(
    from_root: &FsPath,
    from: &FsPath,
    from_name: &str,
    to_root: &FsPath,
    to: &FsPath,
    to_name: &str,
) {
    if !is_form_path(from_name) {
        return;
    }
    // A private item's files folder is named from the real form name, not
    // its `.luna-` disk name or a trash entry name; `files_dir_for` uses the
    // same rule, so purge and later reads find what this move places.
    let folder_name = |path: &FsPath, fallback: &str| {
        let disk = path.file_name().and_then(|n| n.to_str());
        if disk.is_some_and(crate::drives::layout::Layout::is_luna_name) {
            leaf_name(path).unwrap_or_else(|| fallback.to_string())
        } else {
            fallback.to_string()
        }
    };
    let from_folder = folder_name(from, from_name);
    let to_folder = folder_name(to, to_name);
    let lock = form_write_lock(from);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if let (Some(a), Some(b)) = (
        files_dir_named(from_root, from, &from_folder),
        files_dir_named(to_root, to, &to_folder),
    ) {
        move_if_present(&a, &b);
    }
    if let (Some(a), Some(b)) = (
        store::db_path_for_root(from_root, from),
        store::db_path_for_root(to_root, to),
    ) {
        store::move_db_files(&a, &b);
    }
}

/// A form file is being deleted for good: remove its files folder, answers
/// file, and every numbered answers segment so they don't keep using drive
/// space. No-op for non-forms.
pub fn remove_form_files(root: &FsPath, form_path: &FsPath) {
    if !leaf_name(form_path).is_some_and(|n| is_form_path(&n)) {
        return;
    }
    let lock = form_write_lock(form_path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(dir) = files_dir_for(root, form_path) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(file) = responses_db_for(root, form_path) {
        store::remove_db_files(&file);
    }
}

/// [`resolve_form_file`] plus the form's files folder.
fn resolve_form(
    conn: &rusqlite::Connection,
    drive_id: &str,
    path: &str,
) -> Result<FormLoc, (StatusCode, Json<Value>)> {
    let path = resolve_form_file(conn, drive_id, path)?;
    let drive = crate::files::drive_root(conn, drive_id).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps files.",
        )
    })?;
    let root = FsPath::new(&drive.mount_point);
    let files = files_dir_for(root, &path).ok_or_else(|| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps files.",
        )
    })?;
    let db = store::db_path_for_root(root, &path).ok_or_else(|| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps its answers.",
        )
    })?;
    Ok(FormLoc { path, files, db })
}

/// Read and parse the form document. Returns the raw JSON object so
/// forward-compatible fields (new settings keys, question config shapes)
/// pass straight through to the SPA untouched.
fn read_form_document(path: &FsPath) -> Result<Map<String, Value>, (StatusCode, Json<Value>)> {
    let meta = std::fs::metadata(path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        )
    })?;
    if meta.len() > MAX_FORM_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This form file is too large for Luna to open.",
        ));
    }
    let text = std::fs::read_to_string(path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        )
    })?;
    let doc: Value = serde_json::from_str(&text).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "This form file is damaged. Ask the person who shared it to check it.",
        )
    })?;
    let obj = doc.as_object().cloned().ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "This form file is damaged. Ask the person who shared it to check it.",
        )
    })?;
    // A newer envelope might mean shapes we can't safely serve or score —
    // refuse rather than guess.
    let version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
    if version > FORM_DOC_VERSION {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This form was made with a newer version of Luna. Ask the person who shared it to update Luna.",
        ));
    }
    Ok(obj)
}

/// Whether the form is still accepting answers. Missing `settings.collecting`
/// counts as collecting — old forms predate the flag.
fn form_is_collecting(doc: &Map<String, Value>) -> bool {
    doc.get("settings")
        .and_then(|s| s.get("collecting"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Whether answers may be changed after sending. Unlike `responseLimit`
/// (a device-cookie expectation-setter) this is a real rule — the server
/// refuses edit-shaped submissions outright. Missing `settings.allowEdits`
/// counts as allowed — old forms predate the flag.
fn form_allows_edits(doc: &Map<String, Value>) -> bool {
    doc.get("settings")
        .and_then(|s| s.get("allowEdits"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn form_setting<'a>(doc: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    doc.get("settings").and_then(|s| s.get(key))
}

/// `YYYY-MM-DD` after which the form stops. Empty or missing means no date.
fn form_close_on(doc: &Map<String, Value>) -> Option<&str> {
    let date = form_setting(doc, "closeOn").and_then(|v| v.as_str())?;
    if date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-' {
        Some(date)
    } else {
        None
    }
}

/// Unique answers the form will take. Missing, zero, or junk means no cap.
fn form_max_responses(doc: &Map<String, Value>) -> Option<u64> {
    let n = form_setting(doc, "maxResponses")?.as_u64()?;
    if n == 0 { None } else { Some(n) }
}

fn local_ymd(unix: i64) -> String {
    let Some(tm) = crate::time::local_tm(unix) else {
        return String::new();
    };
    format!(
        "{:04}-{:02}-{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday
    )
}

/// Collecting switched off, or the close date has passed. The answer cap is
/// separate — someone with an edit link can still change an answer.
fn hard_closed_message(doc: &Map<String, Value>) -> Option<String> {
    if !form_is_collecting(doc) {
        return Some("This form isn't collecting answers anymore.".into());
    }
    if let Some(date) = form_close_on(doc) {
        let today = local_ymd(crate::db::now_unix());
        if today.as_str() > date {
            return Some(format!("This form stopped taking answers after {date}."));
        }
    }
    None
}

fn form_questions(doc: &Map<String, Value>) -> Vec<&Value> {
    doc.get("questions")
        .and_then(|q| q.as_array())
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn question_skipped(question: &Value, questions: &[&Value], answers: &Map<String, Value>) -> bool {
    let Some(logic) = question.get("logic").and_then(|l| l.as_object()) else {
        return false;
    };
    let Some(trigger_id) = logic.get("questionId").and_then(|v| v.as_str()) else {
        return false;
    };
    if trigger_id.is_empty() {
        return false;
    }
    let id = question.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let idx = questions
        .iter()
        .position(|q| q.get("id").and_then(|v| v.as_str()) == Some(id));
    let trigger_idx = questions
        .iter()
        .position(|q| q.get("id").and_then(|v| v.as_str()) == Some(trigger_id));
    let (Some(idx), Some(trigger_idx)) = (idx, trigger_idx) else {
        return false;
    };
    if trigger_idx >= idx {
        return false;
    }
    if question_skipped(questions[trigger_idx], questions, answers) {
        return false;
    }
    let expect = logic.get("equals").and_then(|v| v.as_str()).unwrap_or("");
    match answers.get(trigger_id) {
        Some(Value::Array(items)) => items.iter().any(|i| i.as_str() == Some(expect)),
        Some(Value::String(s)) => s == expect,
        Some(other) => other == expect,
        None => expect.is_empty(),
    }
}

/// `GET /s/{token}` for a respond link: hand the SPA the form document as
/// `kind: "form"`. Never response data, never edit hashes — the form file
/// doesn't contain them and we whitelist the envelope keys anyway. Call this
/// once the link is known to carry `CAP_RESPOND`.
pub fn public_form_document(
    state: &AppState,
    ip: &str,
    drive_id: &str,
    path: &str,
) -> Result<Response, (StatusCode, Json<Value>)> {
    // Every open re-reads the answers to count them, so a page-refresh loop is
    // bounded per address like the answer routes themselves.
    if !state.form_respond_limiter.allow(&respond_key("page", ip)) {
        return Err(too_many_tries());
    }
    let form = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this form right now. Try again.",
            )
        })?;
        resolve_form(&conn, drive_id, path)?
    };
    let doc = read_form_document(&form.path)?;
    let mut body = Map::new();
    for key in ["version", "title", "description", "settings", "questions"] {
        if let Some(v) = doc.get(key) {
            body.insert(key.to_string(), v.clone());
        }
    }
    let count = open_store_read(&form.db)?
        .map(|store| store.live_count())
        .transpose()
        .map_err(|_| answers_io_err())?
        .unwrap_or(0);
    let closed = hard_closed_message(&doc);
    let full = form_max_responses(&doc).is_some_and(|max| count >= max);
    Ok(Json(json!({
        "kind": "form",
        "permission": PERMISSION_RESPOND,
        "form": Value::Object(body),
        "accepting": closed.is_none(),
        "full": full,
        "closed_message": closed.unwrap_or_else(|| {
            if full {
                "This form has all the answers it can take.".into()
            } else {
                String::new()
            }
        }),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct MemberResponsesQuery {
    drive_id: String,
    #[serde(default)]
    path: String,
    /// `count=1` returns `{count}` only (the file list's badge).
    #[serde(default)]
    count: Option<String>,
    /// Page start. The Responses tab asks for 100 at a time.
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    /// DELETE: the response to remove.
    #[serde(default)]
    id: Option<String>,
    /// DELETE: `clear=1` removes every answer (owner-facing reset).
    #[serde(default)]
    clear: Option<String>,
}

#[derive(Deserialize)]
struct GuestResponsesQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    count: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

fn wants_count(raw: &Option<String>) -> bool {
    matches!(raw.as_deref(), Some("1") | Some("true"))
}

fn page_params(offset: &Option<usize>, limit: &Option<usize>) -> (usize, usize) {
    (offset.unwrap_or(0), limit.unwrap_or(DEFAULT_RESPONSE_PAGE))
}

fn index_busy() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't open this form right now. Try again.",
    )
}

fn answers_io_err() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't read this form's answers. Try again.",
    )
}

/// Open a form's answer database when it exists. Reads never create the
/// sidecar; only a first answer or an editor save does.
fn open_store(db: &FsPath) -> Result<Option<FormStore>, (StatusCode, Json<Value>)> {
    if !db.is_file() {
        return Ok(None);
    }
    FormStore::open(db).map(Some).map_err(|e| {
        tracing::warn!(path = %db.display(), error = %e, "could not open form answers");
        answers_io_err()
    })
}

/// Read-only form store for the manager views and the respondent's own
/// answer. It works on a read-only drive and never changes the journal mode.
fn open_store_read(db: &FsPath) -> Result<Option<FormStore>, (StatusCode, Json<Value>)> {
    if !db.is_file() {
        return Ok(None);
    }
    FormStore::open_read(db).map(Some).map_err(|e| {
        tracing::warn!(path = %db.display(), error = %e, "could not read form answers");
        answers_io_err()
    })
}

/// Open a form's answer database, creating the sidecar when this is the
/// first answer.
fn open_store_or_create(db: &FsPath) -> Result<FormStore, (StatusCode, Json<Value>)> {
    FormStore::open(db).map_err(|e| {
        tracing::warn!(path = %db.display(), error = %e, "could not open form answers");
        answers_io_err()
    })
}

/// Managing a form (reading or deleting its answers, adding pictures) is a
/// CAP_EDIT act on the form file itself; a file-only grant is enough.
fn member_managed_form(
    state: &AppState,
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<FormLoc, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| index_busy())?;
    if !auth::has_cap(user, &conn, drive_id, path, crate::access::CAP_EDIT) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You need Write access to this form to do this.",
        ));
    }
    resolve_form(&conn, drive_id, path)
}

/// The guest side of `member_managed_form`: the link must carry CAP_EDIT
/// and the form must sit inside it.
fn guest_managed_form(
    state: &AppState,
    link: &db::AccessLinkRow,
    rel: &str,
) -> Result<(String, FormLoc), (StatusCode, Json<Value>)> {
    if link.caps & crate::access::CAP_EDIT == 0 {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This link doesn't give Write access to this form.",
        ));
    }
    let path = crate::api::access::link_file(state, link, rel)?;
    let conn = state.db.lock().map_err(|_| index_busy())?;
    let form = resolve_form(&conn, &link.drive_id, &path)?;
    Ok((path, form))
}

/// `GET /api/v1/forms/responses` — collected answers for a member with
/// Read access. The list, summary, export and editor download all need
/// `CAP_VIEW`; delete, clear and saving need `CAP_EDIT`.
async fn member_form_responses(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if !state
        .form_read_limiter
        .allow(&crate::api::form_limits::response_read_key(&user.id))
    {
        return Err(too_many_tries());
    }
    let form = member_managed_form_view(&state, &user, &q.drive_id, &q.path)?;
    let (offset, limit) = page_params(&q.offset, &q.limit);
    responses_response(&form.db, wants_count(&q.count), offset, limit)
}

/// `DELETE /api/v1/forms/responses?drive_id=&path=&id=` — remove one
/// response (spam, a test run) and its attachments. `clear=1` resets the
/// form instead.
async fn member_delete_response(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    if q.clear.as_deref() == Some("1") {
        return clear_responses(&state, &form);
    }
    delete_response(&state, &q.drive_id, &form, q.id.as_deref())
}

/// The Responses tab's summary query: per-question counts without shipping
/// every answer.
async fn member_form_summary(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if !state
        .form_read_limiter
        .allow(&crate::api::form_limits::response_read_key(&user.id))
    {
        return Err(too_many_tries());
    }
    let form = member_managed_form_view(&state, &user, &q.drive_id, &q.path)?;
    summary_response(&form.db, &form.path)
}

/// How much of its allowance a form is using, for the builder's storage
/// line. Read access is enough; it exposes sizes, not answers.
async fn member_form_usage(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state
        .form_read_limiter
        .allow(&crate::api::form_limits::response_read_key(&user.id))
    {
        return Err(too_many_tries());
    }
    let form = member_managed_form_view(&state, &user, &q.drive_id, &q.path)?;
    let used = store::live_bytes(&form.db)
        .saturating_add(store::backup_bytes(&form.db))
        .saturating_add(dir_file_bytes(&form.files))
        .saturating_add(dir_file_bytes(&form.files.join(PENDING_DIR)));
    let space = crate::drives::summary::disk_space(form.files.parent().unwrap_or(&form.files));
    let (total, free) = space
        .map(|s| (s.total_bytes, s.free_bytes))
        .unwrap_or((0, 0));
    Ok(Json(json!({
        "used_bytes": used,
        "quota_bytes": crate::api::form_limits::form_quota_bytes(total),
        "free_bytes": free,
    })))
}

#[derive(Deserialize)]
struct MemberExportQuery {
    drive_id: String,
    path: String,
    #[serde(default)]
    format: Option<String>,
}

/// Download every answer as CSV or JSONL. Auth is the same as the manager
/// view; the browser uses a normal link so the session cookie is attached.
async fn member_form_export(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberExportQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if !state
        .form_read_limiter
        .allow(&crate::api::form_limits::response_read_key(&user.id))
    {
        return Err(too_many_tries());
    }
    let form = member_managed_form_view(&state, &user, &q.drive_id, &q.path)?;
    export_response(&form.db, &form.path, q.format.as_deref())
}

/// `GET /api/v1/forms/sqlite` — a consistent copy of the answers database
/// for the browser editor. `CAP_VIEW` is enough: Read members can read the
/// answers, and the editor refuses to save without `CAP_EDIT`.
async fn member_form_sqlite(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if !state
        .form_read_limiter
        .allow(&crate::api::form_limits::response_read_key(&user.id))
    {
        return Err(too_many_tries());
    }
    let form = member_managed_form_view(&state, &user, &q.drive_id, &q.path)?;
    let db = form.db.clone();
    if !db.is_file() {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This form has no answers database yet.",
        ));
    }
    if store::db_bytes(&db) > store::MAX_EDITOR_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "This form's answers are too large to edit in the browser. Use the Responses view.",
        ));
    }
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let bytes = store::read_snapshot(&db).map_err(|e| {
        tracing::warn!(path = %db.display(), error = %e, "could not snapshot form answers");
        answers_io_err()
    })?;
    if bytes.len() as u64 > store::MAX_EDITOR_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "This form's answers are too large to edit in the browser. Use the Responses view.",
        ));
    }
    let revision = FormStore::open_read(&db)
        .and_then(|s| s.revision())
        .map_err(|_| answers_io_err())?;
    let mut res = axum::response::Response::new(axum::body::Body::from(bytes));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.sqlite3"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"answers.sqlite\""),
    );
    h.insert(
        header::HeaderName::from_static("x-form-revision"),
        HeaderValue::from_str(&revision.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    Ok(no_store_headers(res))
}

#[derive(Deserialize)]
struct SaveSqliteQuery {
    drive_id: String,
    path: String,
    /// The revision the editor loaded. A mismatch means answers arrived
    /// while it was open; the server refuses to overwrite them.
    #[serde(default)]
    revision: Option<i64>,
}

/// `PUT /api/v1/forms/sqlite` — replace the answers database with the
/// browser editor's copy, but only when the revision still matches.
async fn member_save_sqlite(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<SaveSqliteQuery>,
    request: axum::extract::Request,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Check Write access before buffering the upload: a Read member should
    // not be able to make Luna hold a 16 MiB body just to refuse it.
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    let body = axum::body::to_bytes(
        request.into_body(),
        store::MAX_EDITOR_BYTES as usize + 64 * 1024,
    )
    .await
    .map_err(|_| {
        json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That database is too large for the browser editor.",
        )
    })?;
    if body.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "There was no database in that save.",
        ));
    }
    if body.len() as u64 > store::MAX_EDITOR_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That database is too large for the browser editor.",
        ));
    }
    let db = form.db.clone();
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !form.path.is_file() {
        return Err(form_gone());
    }
    check_form_replacement(&form, body.len() as u64)?;
    let current = if db.is_file() {
        FormStore::open_read(&db)
            .and_then(|s| s.revision())
            .map_err(|_| answers_io_err())?
    } else {
        0
    };
    let Some(expected) = q.revision else {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Reload the answers database before saving it.",
        ));
    };
    if expected != current {
        return Err(json_error_code(
            StatusCode::CONFLICT,
            "revision_conflict",
            "This form got new answers while you were editing. Reload it before saving.",
        ));
    }
    store::install_upload(&db, &body, current + 1).map_err(|e| {
        tracing::warn!(path = %db.display(), error = %e, "could not install form answers");
        let detail = e.to_string().to_ascii_lowercase();
        if detail.contains("space")
            || detail.contains("permission")
            || detail.contains("read-only")
            || detail.contains("readonly")
        {
            json_error(
                StatusCode::INSUFFICIENT_STORAGE,
                "Luna couldn't save the database. Check the drive has free space and isn't read-only.",
            )
        } else {
            json_error(
                StatusCode::BAD_REQUEST,
                "That database is missing the answers tables Luna needs. Nothing was changed.",
            )
        }
    })?;
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "revision": current + 1 })))
}

/// Read access to the form itself, without needing `CAP_EDIT`.
fn member_managed_form_view(
    state: &AppState,
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<FormLoc, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| index_busy())?;
    if !auth::has_cap(user, &conn, drive_id, path, crate::access::CAP_VIEW) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You need Read access to this form to open its answers.",
        ));
    }
    resolve_form(&conn, drive_id, path)
}

/// `GET /s/{token}/responses` — same answers for a link guest whose link
/// carries CAP_EDIT on the form (or a folder containing it). View and
/// respond links can open the form but never read other people's answers
/// back — collected data is for the people running the form.
async fn guest_form_responses(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestResponsesQuery>,
) -> Response {
    let ip = respondent_ip(&addr, &headers);
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            if !state
                .form_respond_limiter
                .allow(&respond_key("responses", &ip))
            {
                return Err(too_many_tries());
            }
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            let (offset, limit) = page_params(&q.offset, &q.limit);
            responses_response(&form.db, wants_count(&q.count), offset, limit)
        },
    )
    .await
}

/// `DELETE /s/{token}/responses?path=&id=` — the guest side of deleting.
async fn guest_delete_response(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestResponsesQuery>,
) -> Response {
    let ip = respondent_ip(&addr, &headers);
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            if !state
                .form_respond_limiter
                .allow(&respond_key("responses_delete", &ip))
            {
                return Err(too_many_tries());
            }
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            delete_response(&state, &link.drive_id, &form, q.id.as_deref())
                .map(IntoResponse::into_response)
        },
    )
    .await
}

/// `GET /s/{token}/summary` — the guest-side manager summary, for a link
/// that can already read the answers.
async fn guest_form_summary(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestResponsesQuery>,
) -> Response {
    let ip = respondent_ip(&addr, &headers);
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            if !state
                .form_respond_limiter
                .allow(&respond_key("summary", &ip))
            {
                return Err(too_many_tries());
            }
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            summary_response(&form.db, &form.path)
        },
    )
    .await
}

/// `GET /s/{token}/export` — CSV/JSONL for a manager link.
async fn guest_form_export(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestResponsesQuery>,
) -> Response {
    let ip = respondent_ip(&addr, &headers);
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            if !state
                .form_respond_limiter
                .allow(&respond_key("export", &ip))
            {
                return Err(too_many_tries());
            }
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            export_response(&form.db, &form.path, q.format.as_deref())
        },
    )
    .await
}

fn delete_response(
    state: &AppState,
    _drive_id: &str,
    form: &FormLoc,
    id: Option<&str>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let id = id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Luna didn't get which response to delete. Reload the page and try again.",
            )
        })?;
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !form.path.is_file() {
        return Err(form_gone());
    }
    let Some(mut store) = open_store(&form.db)? else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That response is already gone. Reload the page to see the latest answers.",
        ));
    };
    let Some(record) = store.get(id).map_err(|_| answers_io_err())? else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That response is already gone. Reload the page to see the latest answers.",
        ));
    };
    // Read the document before deleting: without its question list Luna
    // cannot tell an answer attachment from a question picture, and the
    // confirmation promises both the answer and its files go.
    let doc = read_form_document(&form.path)?;
    if !store.delete(id).map_err(|_| answers_io_err())? {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That response is already gone. Reload the page to see the latest answers.",
        ));
    }
    let names = record_attachments(&doc, &response_json(&record));
    remove_attachments(&doc, &form.files, names.iter());
    state.touch_io_activity();
    Ok(Json(json!({
        "ok": true,
        "revision": store.revision().unwrap_or(0),
    })))
}

/// Remove every answer and every respondent attachment, keeping question
/// pictures. The owner-facing reset behind the confirmation in the Responses
/// tab; the revision moves so an open editor cannot save over it.
fn clear_responses(
    state: &AppState,
    form: &FormLoc,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !form.path.is_file() {
        return Err(form_gone());
    }
    let Some(mut store) = open_store(&form.db)? else {
        return Ok(Json(json!({ "ok": true, "revision": 0 })));
    };
    // The form document says which files are question pictures, so a
    // damaged document must stop the reset rather than leave attachments
    // behind under a "cleared" message.
    let doc = read_form_document(&form.path)?;
    let names: Vec<String> = [
        std::fs::read_dir(&form.files).ok(),
        std::fs::read_dir(form.files.join(PENDING_DIR)).ok(),
    ]
    .into_iter()
    .flatten()
    .flat_map(|entries| entries.flatten())
    .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
    .collect();
    store.clear().map_err(|_| answers_io_err())?;
    // A reset must not leave the old answers behind in the editor's restore
    // snapshot.
    let mut backup = form.db.as_os_str().to_os_string();
    backup.push(".bak");
    let _ = std::fs::remove_file(PathBuf::from(backup));
    remove_attachments(&doc, &form.files, names.iter());
    for name in names {
        let _ = std::fs::remove_file(form.files.join(PENDING_DIR).join(name));
    }
    state.touch_io_activity();
    Ok(Json(json!({
        "ok": true,
        "revision": store.revision().unwrap_or(0),
    })))
}

/// The page size the Responses tab asks for by default, and the largest a
/// caller may request. A page is small enough to stay bounded on a phone.
const DEFAULT_RESPONSE_PAGE: usize = 100;
const MAX_RESPONSE_PAGE: usize = 500;

/// Collected answers, latest state of each live response, never the edit
/// hashes. `count_only` answers the file list's badge without shipping the
/// answers to the browser. `offset`/`limit` page the rest.
fn responses_response(
    db: &FsPath,
    count_only: bool,
    offset: usize,
    limit: usize,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(store) = open_store_read(db)? else {
        let body = if count_only {
            json!({ "count": 0 })
        } else {
            json!({ "responses": [], "total": 0, "next_offset": Value::Null, "revision": 0 })
        };
        return Ok(no_store_headers(Json(body).into_response()));
    };
    let total = store.live_count().map_err(|_| answers_io_err())?;
    let revision = store.revision().map_err(|_| answers_io_err())?;
    let body = if count_only {
        json!({ "count": total })
    } else {
        let limit = limit.clamp(1, MAX_RESPONSE_PAGE);
        let rows = store.page(offset, limit).map_err(|_| answers_io_err())?;
        let next = offset.saturating_add(rows.len());
        let next_offset = if next < total as usize {
            Value::from(next)
        } else {
            Value::Null
        };
        json!({
            "responses": rows.iter().map(response_json).collect::<Vec<_>>(),
            "total": total,
            "next_offset": next_offset,
            "revision": revision,
        })
    };
    Ok(no_store_headers(Json(body).into_response()))
}

/// Per-question counts for the Responses tab. One bounded query; the client
/// never has to hold every answer to draw the summary.
fn summary_response(
    db: &FsPath,
    form_path: &FsPath,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(store) = open_store_read(db)? else {
        return Ok(no_store_headers(
            Json(json!({ "total": 0, "questions": [] })).into_response(),
        ));
    };
    let total = store.live_count().map_err(|_| answers_io_err())?;
    // Only choice and number summaries need every distinct value. A form
    // with tens of thousands of free-text answers must not ship all of them
    // just to draw an "answered" count.
    let summarizable: std::collections::HashSet<String> = read_form_document(form_path)
        .ok()
        .map(|doc| {
            form_questions(&doc)
                .into_iter()
                .filter(|q| {
                    matches!(
                        q.get("type").and_then(Value::as_str),
                        Some("choice" | "multi_choice" | "dropdown" | "yes_no" | "number")
                    )
                })
                .filter_map(|q| q.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let questions = store.summary(&summarizable).map_err(|_| answers_io_err())?;
    let questions: Vec<Value> = questions
        .into_iter()
        .map(|q| {
            let values: Vec<Value> = if summarizable.contains(&q.question_id) {
                q.values
                    .into_iter()
                    .map(|v| json!({ "value": v.value, "count": v.count }))
                    .collect()
            } else {
                Vec::new()
            };
            json!({
                "id": q.question_id,
                "answered": q.answered,
                "values": values,
            })
        })
        .collect();
    Ok(no_store_headers(
        Json(json!({ "total": total, "questions": questions })).into_response(),
    ))
}

fn no_store_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    res
}

/// A single download is capped so one export cannot exhaust a 2 GiB box.
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

/// CSV or JSONL download of every live answer. The CSV columns follow the
/// form document; removed questions keep their answers in JSONL but have no
/// label here. Large exports are bounded by the form's storage quota.
fn export_response(
    db: &FsPath,
    form_path: &FsPath,
    format: Option<&str>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let Some(store) = open_store_read(db)? else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "This form has no answers yet.",
        ));
    };
    let jsonl = format.is_some_and(|f| f.eq_ignore_ascii_case("jsonl"));
    if jsonl {
        let mut out = Vec::new();
        store.export_jsonl(&mut out).map_err(|_| answers_io_err())?;
        if out.len() > MAX_EXPORT_BYTES {
            return Err(json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "This form is too large for one download. Delete some answers and try again.",
            ));
        }
        let mut res = axum::response::Response::new(axum::body::Body::from(out));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-ndjson"),
        );
        res.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"answers.jsonl\""),
        );
        return Ok(no_store_headers(res));
    }

    let doc = read_form_document(form_path)?;
    let questions: Vec<(String, String)> = form_questions(&doc)
        .into_iter()
        .filter_map(|q| {
            let id = q.get("id").and_then(Value::as_str)?.to_string();
            let label = q
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Untitled question")
                .to_string();
            Some((id, label))
        })
        .collect();
    let total = store.live_count().map_err(|_| answers_io_err())? as usize;
    let mut out = String::new();
    out.push_str("id,sent_at");
    for (_, label) in &questions {
        out.push(',');
        out.push_str(&csv_cell(label));
    }
    out.push_str("\r\n");
    let mut offset = 0usize;
    while offset < total {
        let page = store.page(offset, 500).map_err(|_| answers_io_err())?;
        if page.is_empty() {
            break;
        }
        for rec in &page {
            out.push_str(&csv_cell(&rec.id));
            out.push(',');
            out.push_str(&rec.sent_at.to_string());
            for (id, _) in &questions {
                out.push(',');
                out.push_str(&csv_cell(&csv_value(rec.answers.get(id))));
            }
            out.push_str("\r\n");
            if out.len() > MAX_EXPORT_BYTES {
                return Err(json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "This form is too large for one download. Delete some answers and try again.",
                ));
            }
        }
        offset += page.len();
    }
    let mut res = axum::response::Response::new(axum::body::Body::from(out));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    res.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"answers.csv\""),
    );
    Ok(no_store_headers(res))
}

/// One CSV cell, with formula injection neutralized the way the client does
/// it: a leading = + - @ (or tab/CR) is prefixed with an apostrophe.
fn csv_cell(value: &str) -> String {
    let mut text = value.to_string();
    if text
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        text.insert(0, '\'');
    }
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn csv_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join("; "),
        Some(other) => other.to_string(),
    }
}

/// Values Luna will store as an answer: strings, numbers, booleans, null, or
/// a list of those (multi_choice). Anything nested is dropped.
fn answer_value_ok(value: &Value) -> bool {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => true,
        Value::Array(items) => items
            .iter()
            .all(|item| matches!(item, Value::String(_) | Value::Number(_) | Value::Bool(_))),
        _ => false,
    }
}

/// An answer counts as filled in when it's a non-empty string, a non-empty
/// list, or any scalar.
fn is_answered(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

/// Check a submission against the form's questions: unknown ids mean the
/// form changed under the respondent (say so and stop), required questions
/// need something, and each v1 type expects a particular shape. Unknown
/// *types* accept any flat value — a newer Luna's question collects whatever
/// it collects.
fn question_options(question: &Value) -> Vec<&str> {
    question
        .get("config")
        .and_then(|c| c.get("options"))
        .and_then(|o| o.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|o| o.as_str())
                .filter(|o| !o.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn allows_other(question: &Value) -> bool {
    question
        .get("config")
        .and_then(|c| c.get("allowOther"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn email_ok(value: &str) -> bool {
    let value = value.trim();
    let mut parts = value.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    parts.next().is_none()
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !value.contains(char::is_whitespace)
}

/// Server-minted attachment names: 16 hex chars and a photo/PDF extension.
fn upload_name_ok(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 16
        && stem
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && matches!(ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "pdf")
}

fn number_in_range(question: &Value, n: f64) -> bool {
    if !n.is_finite() {
        return false;
    }
    let min = question
        .get("config")
        .and_then(|c| c.get("min"))
        .and_then(|v| v.as_f64());
    let max = question
        .get("config")
        .and_then(|c| c.get("max"))
        .and_then(|v| v.as_f64());
    min.is_none_or(|m| n >= m) && max.is_none_or(|m| n <= m)
}

/// Drop answers to questions the form no longer has (the owner removed one
/// while someone was filling it in).
fn keep_known_answers(doc: &Map<String, Value>, answers: &mut Map<String, Value>) {
    let known: std::collections::HashSet<&str> = form_questions(doc)
        .into_iter()
        .filter_map(|q| q.get("id").and_then(|id| id.as_str()))
        .filter(|id| !id.is_empty())
        .collect();
    answers.retain(|key, _| known.contains(key.as_str()));
}

/// A question's own `config.maxLength`, when the form sets one. Only a
/// smaller limit matters: [`MAX_ANSWER_TEXT_BYTES`] always applies.
fn question_max_length(question: &Value) -> Option<usize> {
    question
        .get("config")
        .and_then(|c| c.get("maxLength"))
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0)
        .map(|n| n as usize)
}

/// Is this text too long for its question? The byte cap protects the drive;
/// a form's smaller `maxLength` counts characters, the way the person typing
/// sees it.
fn answer_text_too_long(question: &Value, text: &str) -> bool {
    text.len() > MAX_ANSWER_TEXT_BYTES
        || question_max_length(question).is_some_and(|max| text.chars().count() > max)
}

/// Name the question that is too long, or say it generally when the form has
/// no label for it. Never truncate an answer silently.
fn too_long_answer(question: &Value) -> (StatusCode, Json<Value>) {
    let label = question
        .get("label")
        .and_then(|l| l.as_str())
        .map(str::trim)
        .filter(|l| !l.is_empty());
    let message = match label {
        Some(label) => format!("\"{label}\" is too long to save. Shorten it and try again."),
        None => "One answer is too long to save. Shorten it and try again.".to_string(),
    };
    json_error(StatusCode::BAD_REQUEST, message)
}

/// Every answer on one submission, serialized the way it is stored. A request
/// body that parses must fit here or be refused, never cut.
fn answers_payload_len(answers: &Map<String, Value>) -> usize {
    serde_json::to_string(answers)
        .map(|text| text.len())
        .unwrap_or(usize::MAX)
}

/// `can_attach` decides whether this respondent may name a file in a file
/// answer (their own pending upload, or one already on the answer they're
/// editing). `None` skips that check — shape only.
fn validate_answers(
    doc: &Map<String, Value>,
    answers: &Map<String, Value>,
    can_attach: Option<&dyn Fn(&str) -> bool>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let owned = form_questions(doc);
    let known: std::collections::HashMap<&str, &Value> = owned
        .iter()
        .filter_map(|q| q.get("id").and_then(|id| id.as_str()).map(|id| (id, *q)))
        .collect();
    // Unknown ids are dropped by the caller (`keep_known_answers`) before we
    // get here — a question removed while someone was answering must not
    // cost them everything they typed.
    debug_assert!(answers.keys().all(|k| known.contains_key(k.as_str())));
    for question in &owned {
        let Some(id) = question.get("id").and_then(|i| i.as_str()) else {
            continue;
        };
        // A hidden question is not required. A value that was sent anyway
        // still has to be a real answer — skip does not turn off type checks.
        let skipped = question_skipped(question, &owned, answers);
        let label = question
            .get("label")
            .and_then(|l| l.as_str())
            .filter(|l| !l.trim().is_empty())
            .unwrap_or("A question");
        let required = question
            .get("required")
            .and_then(|r| r.as_bool())
            .unwrap_or(false);
        let value = answers.get(id);
        let answered = is_answered(value);
        if required && !skipped && !answered {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                format!("\"{label}\" still needs an answer."),
            ));
        }
        let Some(value) = value.filter(|_| answered) else {
            continue;
        };
        // Text is bounded before the shape checks so a multi-megabyte string
        // is refused without comparing it against every option.
        let too_long = value
            .as_str()
            .is_some_and(|text| answer_text_too_long(question, text))
            || value.as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item.as_str()
                        .is_some_and(|text| answer_text_too_long(question, text))
                })
            });
        if too_long {
            return Err(too_long_answer(question));
        }
        let qtype = question.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let options = question_options(question);
        let other = allows_other(question);
        let ok = match qtype {
            "multi_choice" => value.as_array().is_some_and(|items| {
                items.iter().all(|i| i.is_string())
                    && (other
                        || options.is_empty()
                        || items
                            .iter()
                            .all(|i| i.as_str().is_some_and(|s| options.contains(&s))))
            }),
            "choice" | "dropdown" => {
                value.is_string()
                    && (other
                        || options.is_empty()
                        || value.as_str().is_some_and(|s| options.contains(&s)))
            }
            "yes_no" => matches!(value.as_str(), Some("yes") | Some("no")),
            "date" | "short_text" | "long_text" => value.is_string(),
            "email" => value.as_str().is_some_and(email_ok),
            "number" => value.as_f64().is_some_and(|n| number_in_range(question, n)),
            "file" => value
                .as_str()
                .is_some_and(|name| upload_name_ok(name) && can_attach.is_none_or(|ok| ok(name))),
            // A type from a newer Luna — store whatever flat value came in.
            _ => answer_value_ok(value),
        };
        if !ok {
            // An unsent attachment expires after an hour, so a file answer
            // that no longer matches needs the file again, not a new value.
            let message = if qtype == "file" {
                format!("Attach the file for \"{label}\" again.")
            } else {
                format!("Check the answer for \"{label}\" and try again.")
            };
            return Err(json_error(StatusCode::BAD_REQUEST, message));
        }
    }
    Ok(())
}

fn new_response_id() -> String {
    let mut bytes = [0u8; 16];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    // 128 bits: a collision must never merge two people's answers.
    let hex = blake3::hash(&bytes).to_hex().to_string();
    format!("r_{}", &hex[..32])
}

fn hash_edit_token(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

fn new_edit_token() -> String {
    let mut bytes = [0u8; 18];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[derive(Deserialize)]
struct RespondSubmit {
    answers: Value,
    /// Per-response secret the respondent holds (cookie + edit link). Only
    /// used to identify an existing answer being amended — new submissions
    /// always get a fresh server-minted secret. The file only ever stores
    /// its blake3 hash.
    edit_token: Option<String>,
    /// Present when the respondent is re-editing a known response.
    response_id: Option<String>,
}

#[derive(Deserialize)]
struct RespondLookup {
    edit_token: Option<String>,
}

/// `POST /s/{token}/respond` — insert one answer row into the sibling
/// `.<name>.lunaform.responses.sqlite`. Re-submits with a matching edit
/// secret keep the same response id.
async fn respond_submit(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RespondSubmit>,
) -> Response {
    let resolved = resolve_respond_link(&state, &addr, &token, &headers);
    let (link_id, proof, res) = match resolved {
        Err(e) => (String::new(), None, Err(e)),
        Ok((link, proof)) => {
            let ip = respondent_ip(&addr, &headers);
            let res = respond_submit_inner(&state, &ip, &link, body)
                .await
                .map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

async fn respond_submit_inner(
    state: &AppState,
    ip: &str,
    link: &db::AccessLinkRow,
    body: RespondSubmit,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.form_respond_limiter.allow(&respond_key("submit", ip)) {
        return Err(too_many_tries());
    }
    // Per form, from every address together: one respondent must not be able
    // to spend the form's whole answer budget and close it for everyone.
    if !state
        .form_submit_limiter
        .allow(&form_key(&link.drive_id, &link.path))
    {
        return Err(form_busy());
    }
    let form = {
        let conn = state.db.lock().map_err(|_| index_busy())?;
        resolve_form(&conn, &link.drive_id, &link.path)?
    };
    let form_path = form.path.clone();
    let doc = read_form_document(&form_path)?;
    if let Some(message) = hard_closed_message(&doc) {
        return Err(json_error(StatusCode::FORBIDDEN, message));
    }
    let allow_edits = form_allows_edits(&doc);
    // When the form disallows changes, anything that smells like an edit —
    // a presented edit secret or a target response id — is refused before
    // it can reach the response file.
    if !allow_edits
        && (body
            .edit_token
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty())
            || body
                .response_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()))
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form doesn't let you change answers after you send them.",
        ));
    }
    let mut answers = match body.answers {
        Value::Object(map) => map,
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Those answers didn't come through whole. Try sending them again.",
            ));
        }
    };
    if answers.len() > MAX_ANSWER_KEYS || !answers.values().all(answer_value_ok) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Some answers are in a shape Luna can't store. Try again.",
        ));
    }
    keep_known_answers(&doc, &mut answers);
    if answers_payload_len(&answers) > MAX_ANSWER_PAYLOAD_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Those answers are too long to save. Shorten them and try again.",
        ));
    }

    // A presented secret only ever identifies an existing answer to amend —
    // a new submission always gets a fresh server-minted secret, so a client
    // can't store a weak or reused token. With edits refused the minted
    // secret is throwaway: it keeps the record shape and is never handed back.
    let presented_token = body
        .edit_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let presented_hash = presented_token.map(hash_edit_token);

    let pending = form.files.join(PENDING_DIR);
    sweep_pending(&pending);
    let save_err = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save the answers. Try again.",
        )
    };
    let edit_mismatch = || {
        json_error(
            StatusCode::FORBIDDEN,
            "This edit link doesn't match a saved answer on this form.",
        )
    };
    // Cap check, secret match, attachment claim and write are one step under
    // this form's lock. Other forms never wait on it.
    let (response_id, edit_token, is_new, revision) = {
        let lock = form_write_lock(&form_path);
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        if !form_path.is_file() {
            return Err(form_gone());
        }
        let mut store = open_store_or_create(&form.db)?;
        let editing_id = match presented_hash.as_deref() {
            Some(hash) => {
                if let Some(id) = body
                    .response_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    match store.get(id).map_err(|_| save_err())? {
                        Some(rec) if rec.edit_hash == hash => Some(id.to_string()),
                        _ => return Err(edit_mismatch()),
                    }
                } else {
                    store.find_by_edit_hash(hash).map_err(|_| save_err())?
                }
            }
            // A target id without its secret is an edit attempt too — refuse
            // it with the same message as a mismatched secret.
            None if body
                .response_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()) =>
            {
                return Err(edit_mismatch());
            }
            None => None,
        };
        let is_new = editing_id.is_none();
        if is_new && let Some(max) = form_max_responses(&doc) {
            let live = store.live_count().map_err(|_| save_err())?;
            if live >= max {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "This form has all the answers it can take.",
                ));
            }
        }
        let (response_id, edit_hash, edit_token) = match editing_id.clone() {
            // An amendment keeps the secret the respondent already holds.
            Some(id) => (
                id,
                presented_hash.unwrap_or_default(),
                presented_token.unwrap_or_default().to_string(),
            ),
            None => {
                let token = new_edit_token();
                (new_response_id(), hash_edit_token(&token), token)
            }
        };
        // Files the answer may name: this respondent's own pending uploads
        // (their names are secrets only the uploader got back), or — when
        // editing — files already on this answer. Never another answer's
        // file or a question picture.
        let previous_files = editing_id
            .as_deref()
            .and_then(|id| store.get(id).ok().flatten())
            .map(|rec| record_attachments(&doc, &response_json(&rec)))
            .unwrap_or_default();
        let can_attach =
            |name: &str| previous_files.contains(name) || regular_file(&pending.join(name));
        validate_answers(&doc, &answers, Some(&can_attach))?;
        let new_files = attachments_in(&doc, &answers);
        check_form_room(&form, answers_payload_len(&answers) as u64)?;
        // Claim the pending uploads before the answer is written, so a
        // stored answer never names a file the sweep could still remove.
        let mut claimed: Vec<&String> = Vec::new();
        // Best effort: put claimed files back so the respondent can retry.
        let release = |claimed: &[&String]| {
            for name in claimed {
                let _ = std::fs::rename(form.files.join(name), pending.join(name));
            }
        };
        for name in new_files.difference(&previous_files) {
            if std::fs::rename(pending.join(name), form.files.join(name)).is_err() {
                release(&claimed);
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't keep that attachment. Attach it again and send.",
                ));
            }
            claimed.push(name);
        }
        let at = crate::db::now_unix();
        let written = if is_new {
            store.insert(&response_id, &edit_hash, at, &answers)
        } else {
            store.update(&response_id, at, &answers)
        };
        if let Err(e) = written {
            release(&claimed);
            tracing::warn!(error = %e, path = %form_path.display(), "could not save form answer");
            return Err(save_err());
        }
        // An edit that swapped or removed a file drops the old one.
        let dropped: Vec<String> = previous_files.difference(&new_files).cloned().collect();
        remove_attachments(&doc, &form.files, dropped.iter());
        state.touch_io_activity();
        (
            response_id,
            edit_token,
            is_new,
            store.revision().unwrap_or(0),
        )
    };
    if is_new {
        // Open builders refresh their Responses tab; nothing is shown.
        let room_key = crate::office::collab::CollabHub::room_key(&link.drive_id, &link.path);
        state
            .collab
            .broadcast(&room_key, crate::office::collab::ServerEvent::FormResponse)
            .await;
    }
    Ok(Json(json!({
        "ok": true,
        "id": response_id,
        // Edit-link material only exists when the form allows changes: the
        // client may have omitted the secret, so hand back the one in use.
        "edit_token": if allow_edits { Value::String(edit_token) } else { Value::Null },
        "revision": revision,
    })))
}

/// `GET /s/{token}/respond?edit_token=…` — a returning respondent re-fetches
/// their own answers (and only theirs) by presenting the edit secret. This
/// is what makes the copyable edit link work on a different device.
async fn respond_lookup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<RespondLookup>,
    headers: HeaderMap,
) -> Response {
    let resolved = resolve_respond_link(&state, &addr, &token, &headers);
    let (link_id, proof, res) = match resolved {
        Err(e) => (String::new(), None, Err(e)),
        Ok((link, proof)) => {
            let ip = respondent_ip(&addr, &headers);
            let res =
                respond_lookup_inner(&state, &ip, &link, query).map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

fn respond_lookup_inner(
    state: &AppState,
    ip: &str,
    link: &db::AccessLinkRow,
    query: RespondLookup,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.form_respond_limiter.allow(&respond_key("lookup", ip)) {
        return Err(too_many_tries());
    }
    let edit_token = query.edit_token.filter(|t| !t.is_empty()).ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That edit link is incomplete. Ask for the full link and try again.",
        )
    })?;
    let form = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this form right now. Try again.",
            )
        })?;
        resolve_form(&conn, &link.drive_id, &link.path)?
    };
    // The lookup only exists to power edit mode — when the form disallows
    // changes there is nothing to come back for.
    let doc = read_form_document(&form.path)?;
    if !form_allows_edits(&doc) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form doesn't let you change answers after you send them.",
        ));
    }
    let edit_hash = hash_edit_token(&edit_token);
    let Some(store) = open_store_read(&form.db)? else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find answers for that edit link.",
        ));
    };
    let Some(id) = store
        .find_by_edit_hash(&edit_hash)
        .map_err(|_| answers_io_err())?
    else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find answers for that edit link.",
        ));
    };
    let Some(record) = store.get(&id).map_err(|_| answers_io_err())? else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find answers for that edit link.",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "answers": Value::Object(record.answers),
    })))
}

/// Uploads wait here until the answer that names them is sent.
const PENDING_DIR: &str = "pending";
/// An upload nobody sent an answer for is removed after this long.
const PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// Unsent uploads on one form, together. Enough for many people answering
/// at once; past it new uploads wait until older ones are sent or expire.
const MAX_PENDING_BYTES: u64 = 256 * 1024 * 1024;

/// A plain file (not a symlink, not a folder) at `path`.
fn regular_file(path: &FsPath) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// Remove unsent uploads older than [`PENDING_TTL`], and anything in the
/// pending folder that isn't a plain file.
fn sweep_pending(pending: &FsPath) {
    let Ok(entries) = std::fs::read_dir(pending) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let expired = meta
            .modified()
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > PENDING_TTL);
        if expired {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Bytes in the plain files directly inside `dir`.
fn dir_file_bytes(dir: &FsPath) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| std::fs::symlink_metadata(e.path()).ok())
                .filter(|m| m.file_type().is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Pictures named on the form's questions — never removed with an answer
/// and never claimable by one.
fn question_images(doc: &Map<String, Value>) -> std::collections::HashSet<String> {
    form_questions(doc)
        .into_iter()
        .filter_map(|q| q.get("image").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect()
}

/// File names an answer set points at, from the form's file questions.
fn attachments_in(
    doc: &Map<String, Value>,
    answers: &Map<String, Value>,
) -> std::collections::HashSet<String> {
    form_questions(doc)
        .into_iter()
        .filter(|q| q.get("type").and_then(|t| t.as_str()) == Some("file"))
        .filter_map(|q| q.get("id").and_then(|id| id.as_str()))
        .filter_map(|id| answers.get(id).and_then(|v| v.as_str()))
        .filter(|name| upload_name_ok(name))
        .map(str::to_string)
        .collect()
}

/// [`attachments_in`] for a stored record.
fn record_attachments(
    doc: &Map<String, Value>,
    record: &Value,
) -> std::collections::HashSet<String> {
    match record.get("answers") {
        Some(Value::Object(answers)) => attachments_in(doc, answers),
        _ => std::collections::HashSet::new(),
    }
}

/// Delete attachments from the form's files folder. Question pictures stay.
fn remove_attachments<'a>(
    doc: &Map<String, Value>,
    files: &FsPath,
    names: impl Iterator<Item = &'a String>,
) {
    let keep = question_images(doc);
    for name in names {
        if keep.contains(name) || !upload_name_ok(name) {
            continue;
        }
        let path = files.join(name);
        if regular_file(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn upload_ext(filename: &str) -> Option<&'static str> {
    let ext = filename.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "pdf" => Some("pdf"),
        _ => None,
    }
}

fn new_upload_name(ext: &str) -> String {
    let mut bytes = [0u8; 8];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}.{ext}")
}

/// `POST /s/{token}/respond-file` — store one photo or PDF beside the form.
/// The answer later names the file Luna minted; the client never picks the path.
async fn respond_upload(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let resolved = resolve_respond_link(&state, &addr, &token, &headers);
    let (link_id, proof, res) = match resolved {
        Err(e) => (String::new(), None, Err(e)),
        Ok((link, proof)) => {
            let ip = respondent_ip(&addr, &headers);
            let res = respond_upload_inner(&state, &ip, &link, &mut multipart)
                .await
                .map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

async fn respond_upload_inner(
    state: &AppState,
    ip: &str,
    link: &db::AccessLinkRow,
    multipart: &mut Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.form_respond_limiter.allow(&respond_key("upload", ip)) {
        return Err(too_many_tries());
    }
    if !state
        .form_upload_ip_limiter
        .allow(&crate::api::form_limits::form_upload_ip_key(ip))
    {
        return Err(too_many_tries());
    }
    if !state
        .form_upload_limiter
        .allow(&crate::api::form_limits::form_upload_key(
            &link.drive_id,
            &link.path,
        ))
    {
        return Err(form_busy());
    }
    let form = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this form right now. Try again.",
            )
        })?;
        resolve_form(&conn, &link.drive_id, &link.path)?
    };
    let doc = read_form_document(&form.path)?;
    if hard_closed_message(&doc).is_some() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form isn't collecting answers anymore.",
        ));
    }
    // Attachments only exist to answer a file question — a form without one
    // takes no uploads, so the link can't be used as free storage.
    let has_file_question = form_questions(&doc)
        .iter()
        .any(|q| q.get("type").and_then(|t| t.as_str()) == Some("file"));
    if !has_file_question {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This form doesn't ask for files.",
        ));
    }
    let (ext, bytes) =
        read_multipart_file(multipart, MAX_UPLOAD_BYTES, upload_ext, ATTACH_KIND_MESSAGE).await?;
    // The quota check and the write are one step, so two uploads cannot both
    // squeeze into the last few bytes of a form's allowance.
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !form.path.is_file() {
        return Err(form_gone());
    }
    // Unsent: it waits in `pending` until an answer names it, and expires
    // if none does — an upload without an answer can't keep space.
    let pending = form.files.join(PENDING_DIR);
    sweep_pending(&pending);
    let incoming = bytes.len() as u64;
    if dir_file_bytes(&pending).saturating_add(incoming) > MAX_PENDING_BYTES {
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Too many files are waiting to be sent on this form. Attach it again in an hour.",
        ));
    }
    check_form_room(&form, incoming)?;
    ensure_real_dir(&form.files)?;
    let name = write_new_file(state, &pending, ext, &bytes)?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

/// A checked file: its minted extension and its bytes.
type PickedFile = (&'static str, Vec<u8>);

const ATTACH_KIND_MESSAGE: &str = "Attach a photo (JPG, PNG, GIF, or WebP) or a PDF.";
const PICTURE_KIND_MESSAGE: &str = "Choose a photo: JPG, PNG, GIF, or WebP.";

fn picture_ext(filename: &str) -> Option<&'static str> {
    upload_ext(filename).filter(|ext| *ext != "pdf")
}

/// The bytes really are the kind of file the extension says. The name is
/// minted from the extension, so this keeps a renamed page or script from
/// sitting in the uploads folder as a "photo".
fn content_matches(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "jpg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "pdf" => bytes.starts_with(b"%PDF-"),
        _ => false,
    }
}

/// The first `file` part of a multipart body, capped at `max` bytes, with
/// the extension `ext_of` allows for its file name.
async fn read_multipart_file(
    multipart: &mut Multipart,
    max: usize,
    ext_of: fn(&str) -> Option<&'static str>,
    wrong_kind_message: &'static str,
) -> Result<PickedFile, (StatusCode, Json<Value>)> {
    let torn = || {
        json_error(
            StatusCode::BAD_REQUEST,
            "That file didn't come through whole. Try choosing it again.",
        )
    };
    let wrong_kind = || json_error(StatusCode::BAD_REQUEST, wrong_kind_message);
    while let Some(mut field) = multipart.next_field().await.map_err(|_| torn())? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("").to_string();
        let Some(ext) = ext_of(&filename) else {
            return Err(wrong_kind());
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|_| torn())? {
            if bytes.len().saturating_add(chunk.len()) > max {
                return Err(json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!(
                        "That file is over {} MB. Choose a smaller one.",
                        max / (1024 * 1024)
                    ),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That file was empty. Choose another one and try again.",
            ));
        }
        if !content_matches(ext, &bytes) {
            return Err(wrong_kind());
        }
        return Ok((ext, bytes));
    }
    Err(json_error(
        StatusCode::BAD_REQUEST,
        "Choose a file to attach.",
    ))
}

/// Everything on one form — answers database, sent attachments, pictures,
/// and unsent uploads — stays under the form quota, and the drive keeps a
/// reserve.
fn check_form_room(form: &FormLoc, incoming: u64) -> Result<(), (StatusCode, Json<Value>)> {
    let used = store::live_bytes(&form.db)
        .saturating_add(store::backup_bytes(&form.db))
        .saturating_add(dir_file_bytes(&form.files))
        .saturating_add(dir_file_bytes(&form.files.join(PENDING_DIR)));
    check_quota(form, used, incoming)
}

/// The editor replaces the whole database, so its own bytes do not count
/// twice against the form's allowance.
fn check_form_replacement(form: &FormLoc, new_db: u64) -> Result<(), (StatusCode, Json<Value>)> {
    // The previous database becomes `.bak` during install, so the save must
    // fit both the new copy and that restore point.
    let used = dir_file_bytes(&form.files)
        .saturating_add(dir_file_bytes(&form.files.join(PENDING_DIR)))
        .saturating_add(store::db_bytes(&form.db))
        .saturating_add(new_db);
    check_quota(form, used, 0)
}

fn check_quota(form: &FormLoc, used: u64, incoming: u64) -> Result<(), (StatusCode, Json<Value>)> {
    let space = crate::drives::summary::disk_space(form.files.parent().unwrap_or(&form.files));
    let (total, free) = space
        .map(|s| (s.total_bytes, s.free_bytes))
        .unwrap_or((0, 0));
    crate::api::form_limits::room_for_upload(
        used,
        incoming,
        crate::api::form_limits::form_quota_bytes(total),
        free,
    )
    .map_err(|e| {
        let status = match e {
            crate::api::form_limits::QuotaError::FileTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            crate::api::form_limits::QuotaError::FormFull
            | crate::api::form_limits::QuotaError::DriveLow => StatusCode::INSUFFICIENT_STORAGE,
        };
        json_error(status, e.message())
    })
}

/// Refuse a folder that's been replaced by a symlink or a file.
fn ensure_real_dir(dir: &FsPath) -> Result<(), (StatusCode, Json<Value>)> {
    if let Ok(meta) = std::fs::symlink_metadata(dir)
        && !meta.file_type().is_dir()
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Luna couldn't save that file to this form.",
        ));
    }
    Ok(())
}

/// Write `bytes` into `dir` under a fresh server-minted name, refusing a
/// symlinked folder and never following or overwriting an existing entry.
fn write_new_file(
    state: &AppState,
    dir: &FsPath,
    ext: &str,
    bytes: &[u8],
) -> Result<String, (StatusCode, Json<Value>)> {
    let save_err = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save that file. Try again.",
        )
    };
    ensure_real_dir(dir)?;
    std::fs::create_dir_all(dir).map_err(|_| save_err())?;
    ensure_real_dir(dir)?;
    let name = new_upload_name(ext);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(&name))
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .map_err(|_| save_err())?;
    state.touch_io_activity();
    Ok(name)
}

#[derive(Deserialize)]
struct FormImageQuery {
    /// The picture's name inside the form's uploads folder.
    name: String,
}

/// `GET /s/{token}/form-image?name=` — a picture on one of the form's
/// questions. Pictures are copied into the form's uploads folder when the
/// editor adds them (`/api/v1/forms/picture`), so a respond link can only
/// ever show files that sit beside the form — never anything else on the
/// drive, whatever path someone types into the form file.
async fn respond_image(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<FormImageQuery>,
    headers: HeaderMap,
) -> Response {
    let resolved = resolve_respond_link(&state, &addr, &token, &headers);
    let (link_id, proof, res) = match resolved {
        Err(e) => (String::new(), None, Err(e)),
        Ok((link, proof)) => {
            let res =
                respond_image_inner(&state, &link, &query.name).map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

fn respond_image_inner(
    state: &AppState,
    link: &db::AccessLinkRow,
    name: &str,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let missing = || json_error(StatusCode::NOT_FOUND, "That picture isn't on this form.");
    let name = name.trim();
    if !upload_name_ok(name) || name.ends_with(".pdf") {
        return Err(missing());
    }
    let form = {
        let conn = state.db.lock().map_err(|_| index_busy())?;
        resolve_form(&conn, &link.drive_id, &link.path)?
    };
    let doc = read_form_document(&form.path)?;
    if !question_images(&doc).contains(name) {
        return Err(missing());
    }
    serve_form_file(&form, name).map_err(|_| missing())
}

/// One file from the form's files folder: photos inline, PDFs as a
/// download. Callers decide who may see `name`.
fn serve_form_file(form: &FormLoc, name: &str) -> Result<Response, (StatusCode, Json<Value>)> {
    let missing = || {
        json_error(
            StatusCode::NOT_FOUND,
            "That file isn't on this form anymore.",
        )
    };
    if !upload_name_ok(name) {
        return Err(missing());
    }
    let path = form.files.join(name);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| missing())?;
    if !meta.file_type().is_file() || meta.len() > MAX_IMAGE_BYTES {
        return Err(missing());
    }
    let (content_type, disposition) = match name.rsplit('.').next().unwrap_or("") {
        "jpg" | "jpeg" => ("image/jpeg", "inline"),
        "png" => ("image/png", "inline"),
        "gif" => ("image/gif", "inline"),
        "webp" => ("image/webp", "inline"),
        "pdf" => ("application/pdf", "attachment"),
        _ => return Err(missing()),
    };
    let bytes = std::fs::read(&path).map_err(|_| missing())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("{disposition}; filename=\"{name}\""),
        )
        // Question pictures are minted once and never overwritten, so a
        // respondent opening the form repeatedly should reuse them. The URL
        // still stays private to the link.
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::ETAG, format!("\"{:x}-{:x}\"", meta.len(), modified))
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("x-content-type-options", "nosniff")
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

#[derive(Deserialize)]
struct MemberFormFileQuery {
    drive_id: String,
    path: String,
    name: String,
}

#[derive(Deserialize)]
struct GuestFormFileQuery {
    #[serde(default)]
    path: String,
    name: String,
}

/// `GET /api/v1/forms/file?drive_id=&path=&name=` — a question picture for
/// anyone who can open the form; an attachment only for people who can
/// manage its answers (the same access as the responses themselves).
async fn member_form_file(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberFormFileQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let name = q.name.trim();
    let form = {
        let conn = state.db.lock().map_err(|_| index_busy())?;
        if !auth::has_cap(&user, &conn, &q.drive_id, &q.path, crate::access::CAP_VIEW) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have access to this form.",
            ));
        }
        resolve_form(&conn, &q.drive_id, &q.path)?
    };
    let doc = read_form_document(&form.path)?;
    if question_images(&doc).contains(name) {
        return serve_form_file(&form, name);
    }
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    serve_form_file(&form, name)
}

/// `GET /s/{token}/form-file?path=&name=` — the guest side: pictures for a
/// link that can view the form, attachments only when it can edit it.
async fn guest_form_file(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestFormFileQuery>,
) -> Response {
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            let name = q.name.trim().to_string();
            let rel = crate::api::access::link_file(&state, &link, &q.path)?;
            let form = {
                let conn = state.db.lock().map_err(|_| index_busy())?;
                resolve_form(&conn, &link.drive_id, &rel)?
            };
            let doc = read_form_document(&form.path)?;
            if question_images(&doc).contains(&name) {
                return serve_form_file(&form, &name);
            }
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            serve_form_file(&form, &name)
        },
    )
    .await
}

#[derive(Deserialize)]
struct MemberPictureCopy {
    drive_id: String,
    /// The form the picture goes on.
    path: String,
    /// A picture already on the drive.
    source: String,
}

#[derive(Deserialize)]
struct MemberPictureQuery {
    drive_id: String,
    path: String,
}

#[derive(Deserialize)]
struct GuestPictureCopy {
    #[serde(default)]
    path: String,
    source: String,
}

#[derive(Deserialize)]
struct GuestPictureQuery {
    #[serde(default)]
    path: String,
}

/// Read a picture that is already on the drive, for copying onto a form.
fn read_source_picture(source: &FsPath) -> Result<PickedFile, (StatusCode, Json<Value>)> {
    let not_picture = || json_error(StatusCode::BAD_REQUEST, PICTURE_KIND_MESSAGE);
    let name = crate::files::leaf_of(source).unwrap_or_default();
    let name = name.as_str();
    let ext = picture_ext(name).ok_or_else(not_picture)?;
    let meta = std::fs::symlink_metadata(source).map_err(|_| not_picture())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(not_picture());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That picture is over 20 MB. Choose a smaller one.",
        ));
    }
    let bytes = std::fs::read(source).map_err(|_| not_picture())?;
    if !content_matches(ext, &bytes) {
        return Err(not_picture());
    }
    Ok((ext, bytes))
}

fn store_picture(
    state: &AppState,
    form: &FormLoc,
    ext: &str,
    bytes: &[u8],
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let lock = form_write_lock(&form.path);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !form.path.is_file() {
        return Err(form_gone());
    }
    check_form_room(form, bytes.len() as u64)?;
    let name = write_new_file(state, &form.files, ext, bytes)?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

/// `POST /api/v1/forms/picture` — copy a picture from the drive onto a
/// form. The editor must be able to see the picture: copying is what keeps
/// a respond link from showing files its form's editors can't open.
async fn member_copy_picture(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<MemberPictureCopy>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let form = member_managed_form(&state, &user, &body.drive_id, &body.path)?;
    let source = {
        let conn = state.db.lock().map_err(|_| index_busy())?;
        if !auth::has_cap(
            &user,
            &conn,
            &body.drive_id,
            &body.source,
            crate::access::CAP_VIEW,
        ) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You can't open that picture, so it can't go on the form.",
            ));
        }
        crate::files::resolve_any(&conn, &body.drive_id, &body.source)
            .map_err(|_| json_error(StatusCode::NOT_FOUND, "Luna can't find that picture."))?
            .0
    };
    let (ext, bytes) = read_source_picture(&source)?;
    store_picture(&state, &form, ext, &bytes)
}

/// `POST /api/v1/forms/picture-upload?drive_id=&path=` — a picture from
/// this device, straight onto the form.
async fn member_upload_picture(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberPictureQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    let (ext, bytes) = read_multipart_file(
        &mut multipart,
        MAX_IMAGE_BYTES as usize,
        picture_ext,
        PICTURE_KIND_MESSAGE,
    )
    .await?;
    store_picture(&state, &form, ext, &bytes)
}

/// `POST /s/{token}/form-picture` — the guest side of copying a picture.
async fn guest_copy_picture(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<GuestPictureCopy>,
) -> Response {
    crate::api::access::run_public(&state, &addr, &token, &headers, move |state, link| {
        async move {
            let (_, form) = guest_managed_form(&state, &link, &body.path)?;
            // link_file only resolves paths the link can view.
            let source_rel = crate::api::access::link_file(&state, &link, &body.source)?;
            let source = {
                let conn = state.db.lock().map_err(|_| index_busy())?;
                crate::files::resolve_any(&conn, &link.drive_id, &source_rel)
                    .map_err(|_| {
                        json_error(StatusCode::NOT_FOUND, "Luna can't find that picture.")
                    })?
                    .0
            };
            let (ext, bytes) = read_source_picture(&source)?;
            store_picture(&state, &form, ext, &bytes).map(IntoResponse::into_response)
        }
    })
    .await
}

/// `POST /s/{token}/form-picture-upload?path=` — the guest side of uploading.
async fn guest_upload_picture(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestPictureQuery>,
    mut multipart: Multipart,
) -> Response {
    crate::api::access::run_public(
        &state,
        &addr,
        &token,
        &headers,
        move |state, link| async move {
            let (_, form) = guest_managed_form(&state, &link, &q.path)?;
            let (ext, bytes) = read_multipart_file(
                &mut multipart,
                MAX_IMAGE_BYTES as usize,
                picture_ext,
                PICTURE_KIND_MESSAGE,
            )
            .await?;
            store_picture(&state, &form, ext, &bytes).map(IntoResponse::into_response)
        },
    )
    .await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod http_tests;
