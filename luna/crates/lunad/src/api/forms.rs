//! Luna Forms: `.lunaform` files shared through respond links (the
//! link-only `CAP_RESPOND` capability in `crate::access`). A respond link
//! lets anyone with the URL open the form and append one JSONL record to a
//! sibling `<name>.responses.jsonl` — never read other people's answers back
//! (a respondent can only re-fetch their own record by presenting the edit
//! secret they were issued at submit time).
//!
//! All respond-permission logic lives here so it stays small and can ride
//! whatever sharing rework lands: link resolution is self-contained, and
//! `shares.rs`' public GET only needs to hand `(drive_id, path)` over when a
//! resolved link carries `CAP_RESPOND`.

use argon2::password_hash::rand_core::RngCore;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path as FsPath, PathBuf};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser};
use crate::db;

/// Share permission for answer links: the public page renders the form and
/// `POST /s/{token}/respond` appends to the responses file. Respondents may
/// also upload a photo or PDF (`POST /s/{token}/respond-file`) into a sibling
/// folder, and load a picture the form already references
/// (`GET /s/{token}/form-image`). No file listing, no other downloads.
pub const PERMISSION_RESPOND: &str = "respond";

/// Form documents are `<name>.lunaform` JSON envelopes.
pub const FORM_FILE_SUFFIX: &str = ".lunaform";

/// Answers live next to the form as `<name>.responses.jsonl`.
pub const RESPONSES_SUFFIX: &str = ".responses.jsonl";

/// Highest `.lunaform` envelope version this build understands.
const FORM_DOC_VERSION: i64 = 1;

/// A form is a hand-editable JSON file — refuse absurdly large ones.
const MAX_FORM_BYTES: u64 = 1024 * 1024;
/// Scanning the JSONL for an edit-token match reads the whole file; cap that
/// read so a huge responses file can't exhaust RAM in one request.
const MAX_RESPONSES_READ_BYTES: u64 = 64 * 1024 * 1024;
/// Answer payloads are small — a long-text essay is still kilobytes.
const RESPOND_BODY_BYTES: usize = 256 * 1024;
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
/// login/DAV/share limiters — same convention as `public_limits.rs`.
fn respond_key(ip: &str) -> String {
    format!("form_respond:{ip}")
}

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
        .route("/api/v1/forms/responses", get(member_form_responses))
        .route("/s/{token}/responses", get(guest_form_responses))
}

/// The `<name>.responses.jsonl` that sits next to a resolved form file.
fn responses_path_for(form_path: &FsPath) -> Option<PathBuf> {
    let name = form_path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    if !name[dot..].eq_ignore_ascii_case(FORM_FILE_SUFFIX) {
        return None;
    }
    let sibling = format!("{}{}", &name[..dot], RESPONSES_SUFFIX);
    Some(form_path.parent()?.join(sibling))
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
            "This form was made with a newer version of Luna. Ask the person who shared it to update theirs.",
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

/// Tell open editors when a new answer arrives. Missing means yes.
fn form_notify(doc: &Map<String, Value>) -> bool {
    form_setting(doc, "notify")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn local_ymd(unix: i64) -> String {
    let t = unix as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let p = unsafe { libc::localtime_r(&t, &mut tm) };
    if p.is_null() {
        return String::new();
    }
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
        Some(other) => other.to_string() == expect,
        None => expect.is_empty(),
    }
}

/// `GET /s/{token}` for a respond link: hand the SPA the form document as
/// `kind: "form"`. Never response data, never edit hashes — the form file
/// doesn't contain them and we whitelist the envelope keys anyway. Call this
/// once the link is known to carry `CAP_RESPOND`.
pub fn public_form_document(
    state: &AppState,
    drive_id: &str,
    path: &str,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        resolve_form_file(&conn, drive_id, path)?
    };
    let doc = read_form_document(&form_path)?;
    let mut form = Map::new();
    for key in ["version", "title", "description", "settings", "questions"] {
        if let Some(v) = doc.get(key) {
            form.insert(key.to_string(), v.clone());
        }
    }
    let count = read_response_records(&form_path)
        .map(|records| latest_by_id(&records).len())
        .unwrap_or(0);
    let closed = hard_closed_message(&doc);
    let full = form_max_responses(&doc).is_some_and(|max| count >= max as usize);
    Ok(Json(json!({
        "kind": "form",
        "permission": PERMISSION_RESPOND,
        "form": Value::Object(form),
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
}

#[derive(Deserialize)]
struct GuestResponsesQuery {
    #[serde(default)]
    path: String,
}

fn index_busy() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna's index is busy. Try again.",
    )
}

fn answers_io_err() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't read this form's answers. Try again.",
    )
}

/// `GET /api/v1/forms/responses` — a member needs CAP_VIEW on the form file
/// itself; a file-only grant is enough, no parent folder access required.
async fn member_form_responses(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let form_path = {
        let conn = state.db.lock().map_err(|_| index_busy())?;
        if !auth::has_cap(&user, &conn, &q.drive_id, &q.path, crate::access::CAP_VIEW) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to open this form.",
            ));
        }
        resolve_form_file(&conn, &q.drive_id, &q.path)?
    };
    responses_response(&form_path)
}

/// `GET /s/{token}/responses` — same answers for a link guest whose link
/// carries CAP_VIEW on the form (or a folder containing it). Respond-only
/// links fail `link_file`'s view requirement, so answer links can never read
/// other people's answers back.
async fn guest_form_responses(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Query(q): Query<GuestResponsesQuery>,
) -> Response {
    crate::api::access::run_public(&state, &addr, &token, &headers, move |state, link| {
        let rel = q.path.clone();
        async move {
            let path = crate::api::access::link_file(&state, &link, &rel)?;
            let form_path = {
                let conn = state.db.lock().map_err(|_| index_busy())?;
                resolve_form_file(&conn, &link.drive_id, &path)?
            };
            responses_response(&form_path)
        }
    })
    .await
}

fn responses_response(form_path: &FsPath) -> Result<Response, (StatusCode, Json<Value>)> {
    let mut records = read_response_records_guarded(form_path)?;
    for rec in &mut records {
        if let Some(obj) = rec.as_object_mut() {
            obj.remove("edit");
        }
    }
    let mut res = Json(json!({ "responses": records })).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    Ok(res)
}

/// Read the sibling responses file for an authorized viewer. Unlike the
/// respond-path reader (which treats every anomaly as "no answers"), this
/// one must report real problems: a planted symlink, a non-file sibling, an
/// oversized file, or an I/O error all surface as errors — only a genuinely
/// missing file means "no answers yet".
fn read_response_records_guarded(
    form_path: &FsPath,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    // resolve_any bound the form under the drive root; still refuse a leaf
    // swapped for a symlink between resolution and read.
    let form_meta = std::fs::symlink_metadata(form_path).map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            "This form isn't available right now.",
        )
    })?;
    if form_meta.file_type().is_symlink() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form isn't safe to open.",
        ));
    }
    let Some(path) = responses_path_for(form_path) else {
        return Ok(Vec::new());
    };
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(answers_io_err()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form's answers file isn't safe to open.",
        ));
    }
    if meta.len() > MAX_RESPONSES_READ_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "This form's answers file is too large to open.",
        ));
    }
    // O_NOFOLLOW closes the symlink_metadata→open race.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| answers_io_err())?;
    let mut text = String::new();
    file.take(MAX_RESPONSES_READ_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| answers_io_err())?;
    if text.len() as u64 > MAX_RESPONSES_READ_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "This form's answers file is too large to open.",
        ));
    }
    Ok(parse_response_records(&text))
}

/// Read the sibling responses JSONL (empty when nobody has answered yet).
fn read_response_records(form_path: &FsPath) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let Some(path) = responses_path_for(form_path) else {
        return Ok(Vec::new());
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(Vec::new());
    };
    if !meta.is_file() || meta.len() > MAX_RESPONSES_READ_BYTES {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read this form's answers. Try again.",
        )
    })?;
    Ok(parse_response_records(&text))
}

/// Parse JSONL, skipping lines that aren't objects with a string `id`.
fn parse_response_records(text: &str) -> Vec<Value> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| v.get("id").and_then(|id| id.as_str()).is_some())
        .collect()
}

/// Latest record per response id — edits append a new line with the same id,
/// so the last line for an id wins.
fn latest_by_id(records: &[Value]) -> Map<String, Value> {
    let mut latest = Map::new();
    for rec in records {
        if let Some(id) = rec.get("id").and_then(|id| id.as_str()) {
            latest.insert(id.to_string(), rec.clone());
        }
    }
    latest
}

/// Find the response a respondent may edit: an explicit `response_id` must
/// exist AND carry this edit secret; without an id, any record stamped with
/// the secret identifies its response (edit-link flow).
fn find_editable<'a>(
    latest: &'a Map<String, Value>,
    response_id: Option<&str>,
    edit_hash: &str,
) -> Result<Option<String>, (StatusCode, Json<Value>)> {
    let matches = |rec: &Value| rec.get("edit").and_then(|e| e.as_str()) == Some(edit_hash);
    if let Some(id) = response_id {
        return match latest.get(id) {
            Some(rec) if matches(rec) => Ok(Some(id.to_string())),
            Some(_) => Err(json_error(
                StatusCode::FORBIDDEN,
                "This edit link doesn't match a saved answer on this form.",
            )),
            None => Err(json_error(
                StatusCode::NOT_FOUND,
                "We couldn't find answers for that edit link.",
            )),
        };
    }
    Ok(latest
        .iter()
        .find(|(_, rec)| matches(rec))
        .map(|(id, _)| id.clone()))
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
        .map(|list| list.iter().filter_map(|o| o.as_str()).collect())
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

fn validate_answers(
    doc: &Map<String, Value>,
    answers: &Map<String, Value>,
    uploads_dir: Option<&FsPath>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let owned = form_questions(doc);
    let known: std::collections::HashMap<&str, &Value> = owned
        .iter()
        .filter_map(|q| q.get("id").and_then(|id| id.as_str()).map(|id| (id, *q)))
        .collect();
    for key in answers.keys() {
        if !known.contains_key(key.as_str()) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "This form changed since you opened it. Reload the page and send again.",
            ));
        }
    }
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
            "file" => value.as_str().is_some_and(|name| {
                upload_name_ok(name)
                    && uploads_dir.is_none_or(|dir| {
                        let path = dir.join(name);
                        std::fs::metadata(&path).is_ok_and(|m| m.is_file())
                    })
            }),
            // A type from a newer Luna — store whatever flat value came in.
            _ => answer_value_ok(value),
        };
        if !ok {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                format!("The answer for \"{label}\" isn't in a shape Luna can store. Try again."),
            ));
        }
    }
    Ok(())
}

fn new_response_id() -> String {
    let mut bytes = [0u8; 6];
    argon2::password_hash::rand_core::OsRng.fill_bytes(&mut bytes);
    // Hash the random bytes for a hex-only id (`r_9c2e…` style) without
    // pulling in a hex crate.
    let hex = blake3::hash(&bytes).to_hex().to_string();
    format!("r_{}", &hex[..10])
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
    /// Per-response secret the respondent holds (cookie + edit link). The
    /// file only ever stores its blake3 hash.
    edit_token: Option<String>,
    /// Present when the respondent is re-editing a known response.
    response_id: Option<String>,
}

#[derive(Deserialize)]
struct RespondLookup {
    edit_token: Option<String>,
}

/// `POST /s/{token}/respond` — append one answer record to the sibling
/// `<name>.responses.jsonl`. Re-submits with a matching edit secret keep the
/// same response id; latest wins at read time.
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
            let res = respond_submit_inner(&state, &addr, &link, body)
                .await
                .map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

async fn respond_submit_inner(
    state: &AppState,
    addr: &SocketAddr,
    link: &db::AccessLinkRow,
    body: RespondSubmit,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ip = addr.ip().to_string();
    if !state.form_respond_limiter.allow(&respond_key(&ip)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries from this network just now. Wait a minute and try again.",
        ));
    }
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        resolve_form_file(&conn, &link.drive_id, &link.path)?
    };
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
    let answers = match body.answers {
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

    // With edits allowed the client's presented secret (or a fresh one) is
    // stored hashed so the respondent can amend later. With edits refused a
    // throwaway secret keeps the record shape — it is never handed back.
    let edit_token = body
        .edit_token
        .filter(|t| !t.is_empty())
        .unwrap_or_else(new_edit_token);
    let edit_hash = hash_edit_token(&edit_token);

    // Edits need the existing records: match the secret before validating —
    // a wrong secret is refused before it can probe answer shapes.
    let records = read_response_records(&form_path)?;
    let latest = latest_by_id(&records);
    let existing = find_editable(&latest, body.response_id.as_deref(), &edit_hash)?;
    let is_new = existing.is_none();
    if is_new && form_max_responses(&doc).is_some_and(|max| latest.len() >= max as usize) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form has all the answers it can take.",
        ));
    }
    let response_id = existing.unwrap_or_else(new_response_id);
    let uploads = uploads_dir_for(&form_path);
    validate_answers(&doc, &answers, uploads.as_deref())?;

    let record = json!({
        "v": 1,
        "id": response_id,
        "edit": edit_hash,
        "at": crate::db::now_unix(),
        "answers": Value::Object(answers),
    });
    let Some(responses_path) = responses_path_for(&form_path) else {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps its answers.",
        ));
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&responses_path)
        .map_err(|e| {
            crate::files::note_write_failure(
                &state.db.lock().unwrap_or_else(|p| p.into_inner()),
                &link.drive_id,
                &e.to_string(),
            );
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save your answers. Try again.",
            )
        })?;
    let line = serde_json::to_string(&record).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save your answers. Try again.",
        )
    })?;
    writeln!(file, "{line}").map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save your answers. Try again.",
        )
    })?;
    state.touch_io_activity();
    if is_new && form_notify(&doc) {
        let count = (latest.len() + 1) as u64;
        let room_key = crate::office::collab::CollabHub::room_key(&link.drive_id, &link.path);
        state
            .collab
            .broadcast(
                &room_key,
                crate::office::collab::ServerEvent::FormResponse { count },
            )
            .await;
    }
    Ok(Json(json!({
        "ok": true,
        "id": response_id,
        // Edit-link material only exists when the form allows changes: the
        // client may have omitted the secret, so hand back the one in use.
        "edit_token": if allow_edits { Value::String(edit_token) } else { Value::Null },
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
            let res =
                respond_lookup_inner(&state, &addr, &link, query).map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

fn respond_lookup_inner(
    state: &AppState,
    addr: &SocketAddr,
    link: &db::AccessLinkRow,
    query: RespondLookup,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ip = addr.ip().to_string();
    if !state.form_respond_limiter.allow(&respond_key(&ip)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries from this network just now. Wait a minute and try again.",
        ));
    }
    let edit_token = query.edit_token.filter(|t| !t.is_empty()).ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That edit link is incomplete. Ask for the full link and try again.",
        )
    })?;
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        resolve_form_file(&conn, &link.drive_id, &link.path)?
    };
    // The lookup only exists to power edit mode — when the form disallows
    // changes there is nothing to come back for.
    let doc = read_form_document(&form_path)?;
    if !form_allows_edits(&doc) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form doesn't let you change answers after you send them.",
        ));
    }
    let edit_hash = hash_edit_token(&edit_token);
    let records = read_response_records(&form_path)?;
    let latest = latest_by_id(&records);
    let Some((id, record)) = latest
        .iter()
        .find(|(_, rec)| rec.get("edit").and_then(|e| e.as_str()) == Some(edit_hash.as_str()))
    else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "We couldn't find answers for that edit link.",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "answers": record.get("answers").cloned().unwrap_or(Value::Object(Map::new())),
    })))
}

/// `<name>.uploads` next to the form. Created on the first attachment.
fn uploads_dir_for(form_path: &FsPath) -> Option<PathBuf> {
    let name = form_path.file_name()?.to_str()?;
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(FORM_FILE_SUFFIX)?;
    // Keep the original stem's casing from the file name.
    let stem = &name[..stem.len()];
    Some(form_path.parent()?.join(format!("{stem}.uploads")))
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
            let res = respond_upload_inner(&state, &addr, &link, &mut multipart)
                .await
                .map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

async fn respond_upload_inner(
    state: &AppState,
    addr: &SocketAddr,
    link: &db::AccessLinkRow,
    multipart: &mut Multipart,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ip = addr.ip().to_string();
    if !state.form_respond_limiter.allow(&respond_key(&ip)) {
        return Err(json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many tries from this network just now. Wait a minute and try again.",
        ));
    }
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        resolve_form_file(&conn, &link.drive_id, &link.path)?
    };
    let doc = read_form_document(&form_path)?;
    if hard_closed_message(&doc).is_some() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This form isn't collecting answers anymore.",
        ));
    }
    let mut saved: Option<(String, Vec<u8>)> = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That file didn't come through whole. Try choosing it again.",
        )
    })? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("").to_string();
        let Some(ext) = upload_ext(&filename) else {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Attach a photo (JPG, PNG, GIF, or WebP) or a PDF.",
            ));
        };
        let mut bytes = Vec::new();
        let mut field = field;
        while let Some(chunk) = field.chunk().await.map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "That file didn't come through whole. Try choosing it again.",
            )
        })? {
            if bytes.len().saturating_add(chunk.len()) > MAX_UPLOAD_BYTES {
                return Err(json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "That file is over 10 MB. Choose a smaller photo or PDF.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That file was empty. Choose a photo or PDF and try again.",
            ));
        }
        saved = Some((ext.to_string(), bytes));
        break;
    }
    let Some((ext, bytes)) = saved else {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a photo or PDF to attach.",
        ));
    };
    let Some(dir) = uploads_dir_for(&form_path) else {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps files.",
        ));
    };
    if let Ok(meta) = std::fs::symlink_metadata(&dir)
        && meta.file_type().is_symlink()
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Luna couldn't save that file. Try again.",
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save that file. Try again.",
        )
    })?;
    let name = new_upload_name(&ext);
    let dest = dir.join(&name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that file. Try again.",
            )
        })?;
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "name": name })))
}

#[derive(Deserialize)]
struct FormImageQuery {
    path: String,
}

/// `GET /s/{token}/form-image?path=` — a picture the form itself names.
/// Anything else on the drive stays private.
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
                respond_image_inner(&state, &link, &query.path).map(IntoResponse::into_response);
            (link.id.clone(), proof, res)
        }
    };
    crate::api::access::finish_public(res, &link_id, proof, &headers)
}

fn respond_image_inner(
    state: &AppState,
    link: &db::AccessLinkRow,
    image_path: &str,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let wanted = image_path.trim().trim_start_matches('/');
    if wanted.is_empty() || wanted.contains("..") || wanted.contains('\\') {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That picture isn't on this form.",
        ));
    }
    let path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let form_path = resolve_form_file(&conn, &link.drive_id, &link.path)?;
        let doc = read_form_document(&form_path)?;
        let listed = form_questions(&doc).into_iter().any(|q| {
            q.get("image")
                .and_then(|v| v.as_str())
                .is_some_and(|p| p.trim().trim_start_matches('/') == wanted)
        });
        if !listed {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "That picture isn't on this form.",
            ));
        }
        let (path, meta) = crate::files::resolve_any(&conn, &link.drive_id, wanted)
            .map_err(|_| json_error(StatusCode::NOT_FOUND, "That picture isn't on this form."))?;
        if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "That picture isn't on this form.",
            ));
        }
        path
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let content_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "That picture isn't on this form.",
            ));
        }
    };
    let bytes = std::fs::read(&path)
        .map_err(|_| json_error(StatusCode::NOT_FOUND, "That picture isn't on this form."))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_path_match_is_case_insensitive() {
        assert!(is_form_path("forms/rsvp.lunaform"));
        assert!(is_form_path("RSVP.LUNAFORM"));
        assert!(!is_form_path("forms/rsvp.json"));
        assert!(!is_form_path("forms"));
    }

    #[test]
    fn responses_path_swaps_the_extension() {
        assert_eq!(
            responses_path_for(FsPath::new("/d/forms/rsvp.lunaform")).unwrap(),
            PathBuf::from("/d/forms/rsvp.responses.jsonl")
        );
        assert_eq!(
            responses_path_for(FsPath::new("/d/rsvp.LUNAFORM")).unwrap(),
            PathBuf::from("/d/rsvp.responses.jsonl")
        );
        assert!(responses_path_for(FsPath::new("/d/rsvp.json")).is_none());
    }

    #[test]
    fn latest_record_per_id_wins() {
        let records = parse_response_records(
            r#"{"v":1,"id":"r_1","edit":"h1","at":1,"answers":{"q":"Yes"}}
not json
{"v":1,"id":"r_2","edit":"h2","at":2,"answers":{"q":"No"}}
{"v":1,"id":"r_1","edit":"h1","at":3,"answers":{"q":"Maybe"}}
{"noid":true}
"#,
        );
        assert_eq!(records.len(), 3);
        let latest = latest_by_id(&records);
        assert_eq!(latest.len(), 2);
        assert_eq!(latest["r_1"]["answers"]["q"], "Maybe");
        assert_eq!(latest["r_2"]["answers"]["q"], "No");
    }

    #[test]
    fn editable_needs_the_secret_or_the_right_id() {
        let records = parse_response_records(
            r#"{"v":1,"id":"r_1","edit":"h1","at":1,"answers":{}}
{"v":1,"id":"r_2","edit":"h2","at":2,"answers":{}}"#,
        );
        let latest = latest_by_id(&records);
        // Known id + matching secret → same id back.
        assert_eq!(
            find_editable(&latest, Some("r_1"), "h1")
                .unwrap()
                .as_deref(),
            Some("r_1")
        );
        // Known id + wrong secret → forbidden.
        assert!(find_editable(&latest, Some("r_1"), "h2").is_err());
        // Unknown id → not found.
        assert!(find_editable(&latest, Some("r_9"), "h1").is_err());
        // No id: the secret alone picks the response (edit-link flow).
        assert_eq!(
            find_editable(&latest, None, "h2").unwrap().as_deref(),
            Some("r_2")
        );
        // A fresh secret matches nothing → caller mints a new id.
        assert_eq!(find_editable(&latest, None, "h9").unwrap(), None);
    }

    #[test]
    fn allow_edits_defaults_to_allowed() {
        // Missing settings or flag → allowed (old forms predate it).
        assert!(form_allows_edits(&Map::new()));
        let doc: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "collecting": true } })).unwrap();
        assert!(form_allows_edits(&doc));
        let doc: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "allowEdits": false } })).unwrap();
        assert!(!form_allows_edits(&doc));
    }

    #[test]
    fn answers_accept_flat_values_only() {
        assert!(answer_value_ok(&json!("Yes")));
        assert!(answer_value_ok(&json!(3)));
        assert!(answer_value_ok(&json!(true)));
        assert!(answer_value_ok(&json!(null)));
        assert!(answer_value_ok(&json!(["a", "b"])));
        assert!(!answer_value_ok(&json!({"nested": 1})));
        assert!(!answer_value_ok(&json!([{"nested": 1}])));
    }

    fn doc() -> Map<String, Value> {
        serde_json::from_value(json!({
            "version": 1,
            "questions": [
                { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
                  "config": { "options": ["Yes", "No"] } },
                { "id": "q_2", "type": "multi_choice", "label": "Sides",
                  "config": { "options": ["Slaw", "Beans"] } },
                { "id": "q_3", "type": "short_text", "label": "Name" },
                { "id": "q_4", "type": "yes_no", "label": "Kids?" },
                { "id": "q_5", "type": "future_widget", "label": "Future" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn validation_enforces_required_types_and_known_ids() {
        let doc = doc();
        // Required question missing → refused.
        let answers = Map::new();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // Required answered + optional empty → fine.
        let answers: Map<String, Value> = serde_json::from_value(json!({ "q_1": "Yes" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        // Unknown question id → refused.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_99": "x" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // An option nobody offered → refused.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Maybe" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // multi_choice needs an array of offered strings.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_2": "Slaw" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_2": ["Slaw", "Beans"] })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_2": ["Slaw", "Pasta"] })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // yes_no is the two strings only.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_4": "yes" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_4": "maybe" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // A type this build doesn't know accepts any flat value.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_5": {"anything": "goes-ish"} }))
                .unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err()); // nested → no
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_5": 42 })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
    }

    #[test]
    fn email_number_other_and_skip_are_enforced() {
        let doc: Map<String, Value> = serde_json::from_value(json!({
            "questions": [
                { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
                  "config": { "options": ["Yes", "No"] } },
                { "id": "q_2", "type": "email", "label": "Email", "required": true },
                { "id": "q_3", "type": "number", "label": "Guests",
                  "config": { "min": 1, "max": 8 } },
                { "id": "q_4", "type": "short_text", "label": "Meal", "required": true,
                  "logic": { "questionId": "q_1", "equals": "No" } },
                { "id": "q_5", "type": "choice", "label": "Dish",
                  "config": { "options": ["Salad"], "allowOther": true } }
            ]
        }))
        .unwrap();
        // A skipped required question doesn't block a "No".
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "No", "q_2": "a@b.co" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        // A value sent for that hidden question still has to match its type.
        let answers: Map<String, Value> = serde_json::from_value(json!({
            "q_1": "No", "q_2": "a@b.co", "q_4": ["not text"]
        }))
        .unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        let answers: Map<String, Value> = serde_json::from_value(json!({
            "q_1": "No", "q_2": "a@b.co", "q_4": "Fish"
        }))
        .unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        // Coming Yes makes the meal required.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "Yes", "q_2": "a@b.co" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        // Bad email, out-of-range number, and a free-text Other.
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "q_1": "No", "q_2": "not-an-email" })).unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        let answers: Map<String, Value> = serde_json::from_value(json!({
            "q_1": "Yes", "q_2": "a@b.co", "q_3": 9, "q_4": "Fish"
        }))
        .unwrap();
        assert!(validate_answers(&doc, &answers, None).is_err());
        let answers: Map<String, Value> = serde_json::from_value(json!({
            "q_1": "Yes", "q_2": "a@b.co", "q_3": 2, "q_4": "Fish", "q_5": "My stew"
        }))
        .unwrap();
        assert!(validate_answers(&doc, &answers, None).is_ok());
        assert!(upload_name_ok("0123456789abcdef.pdf"));
        assert!(!upload_name_ok("photo.pdf"));
        assert!(!upload_name_ok("0123456789abcdef.exe"));
    }

    #[test]
    fn close_date_and_cap_are_separate_from_edits() {
        let open: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "closeOn": "1999-01-01" } })).unwrap();
        assert!(hard_closed_message(&open).is_some());
        let future: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "closeOn": "2999-01-01" } })).unwrap();
        assert!(hard_closed_message(&future).is_none());
        let capped: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "maxResponses": 2 } })).unwrap();
        assert_eq!(form_max_responses(&capped), Some(2));
        assert!(form_notify(&Map::new()));
        let quiet: Map<String, Value> =
            serde_json::from_value(json!({ "settings": { "notify": false } })).unwrap();
        assert!(!form_notify(&quiet));
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
    use serde_json::Value;
    use std::net::SocketAddr;
    use tower::ServiceExt;
    use uuid::Uuid;

    const CLIENT: SocketAddr = SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        54321,
    );

    const FORM_DOC: &str = r#"{
        "version": 1,
        "title": "Family reunion RSVP",
        "settings": { "collecting": true, "allowEdits": true, "responseLimit": "one" },
        "questions": [
            { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
              "config": { "options": ["Yes", "No"] } }
        ]
    }"#;

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router, crate::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::drives::drive_db::create(
            mount,
            &luna_core::marker::Marker::new("photos", "Photos"),
            &luna_core::marker::pick_prefix(mount).unwrap(),
        )
        .unwrap();
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
            .with_state(state.clone());
        (dir, app, state)
    }

    /// Insert an access link row directly — tests shouldn't depend on the
    /// link-management endpoint's shape while sharing is reworked.
    fn insert_link(state: &crate::AppState, path: &str, caps: i64) -> String {
        let token = Uuid::new_v4().simple().to_string();
        let conn = state.db.lock().unwrap();
        crate::db::insert_access_link(
            &conn,
            &crate::db::AccessLinkRow {
                id: Uuid::new_v4().to_string(),
                token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
                token: token.clone(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: path.into(),
                album_id: String::new(),
                caps,
                password_hash: String::new(),
                expires_at: None,
                created_by: "test".into(),
                created_at: 0,
            },
        )
        .unwrap();
        token
    }

    fn req(method: Method, uri: &str, body: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    async fn body_json(res: axum::response::Response) -> Value {
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn respond_get_serves_the_form_not_the_bytes() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        // GET /s/{token} must dispatch respond links to the form document —
        // never a file listing, never the raw bytes.
        let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["kind"], "form");
        assert_eq!(v["form"]["title"], "Family reunion RSVP");
        assert_eq!(v["form"]["questions"][0]["id"], "q_1");
        assert!(v.get("entries").is_none(), "must not list files: {v}");
    }

    #[tokio::test]
    async fn respond_appends_jsonl_and_edits_reuse_the_id() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        // New answer → appended to the sibling file.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{"q_1":"Yes"},"edit_token":"secret-one"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        let id = v["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("r_"));

        let jsonl = std::fs::read_to_string(mount.path().join("rsvp.responses.jsonl")).unwrap();
        let rec: Value = serde_json::from_str(jsonl.trim()).unwrap();
        // The file stores the blake3 hash, never the raw secret.
        assert_eq!(
            rec["edit"].as_str().unwrap(),
            blake3::hash(b"secret-one").to_hex().to_string()
        );
        assert_ne!(rec["edit"].as_str().unwrap(), "secret-one");

        // The respondent can re-fetch their own answers with the secret.
        let res = call(
            &app,
            req(
                Method::GET,
                &format!("/s/{token}/respond?edit_token=secret-one"),
                "",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["id"], id);
        assert_eq!(v["answers"]["q_1"], "Yes");

        // An edit appends a second line with the SAME id.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                &format!(
                    r#"{{"answers":{{"q_1":"No"}},"edit_token":"secret-one","response_id":"{id}"}}"#
                ),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["id"], id);
        let jsonl = std::fs::read_to_string(mount.path().join("rsvp.responses.jsonl")).unwrap();
        assert_eq!(jsonl.lines().count(), 2);

        // The wrong secret can't touch someone else's response.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                &format!(
                    r#"{{"answers":{{"q_1":"Maybe"}},"edit_token":"wrong","response_id":"{id}"}}"#
                ),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // A view-only link can't collect answers at all.
        let view_token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_VIEW);
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{view_token}/respond"),
                r#"{"answers":{"q_1":"Yes"},"edit_token":"x"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn respond_requires_the_required_answers() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        // q_1 is required — an empty submission is refused with 400.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{},"edit_token":"x"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(!mount.path().join("rsvp.responses.jsonl").exists());
    }

    #[tokio::test]
    async fn respond_refuses_edits_when_the_form_disallows_them() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(
            mount.path().join("rsvp.lunaform"),
            FORM_DOC.replace("\"allowEdits\": true", "\"allowEdits\": false"),
        )
        .unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        // A first answer with no edit material still goes through…
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{"q_1":"Yes"}}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        let id = v["id"].as_str().unwrap().to_string();
        // …and no usable edit secret comes back.
        assert!(v["edit_token"].is_null(), "no edit secret returned: {v}");

        // …but anything shaped like an edit is refused outright.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{"q_1":"No"},"edit_token":"whatever"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                &format!(r#"{{"answers":{{"q_1":"No"}},"response_id":"{id}"}}"#),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // The answer lookup that powers edit mode is refused too.
        let res = call(
            &app,
            req(
                Method::GET,
                &format!("/s/{token}/respond?edit_token=whatever"),
                "",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // None of the refusals touched the file — still just the one record.
        let jsonl = std::fs::read_to_string(mount.path().join("rsvp.responses.jsonl")).unwrap();
        assert_eq!(jsonl.lines().count(), 1);
    }

    #[tokio::test]
    async fn respond_refuses_a_closed_form() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(
            mount.path().join("rsvp.lunaform"),
            FORM_DOC.replace("\"collecting\": true", "\"collecting\": false"),
        )
        .unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        // The form document still loads (so the SPA can say it's closed)…
        let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            body_json(res).await["form"]["settings"]["collecting"],
            false
        );

        // …but answers are refused.
        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{"q_1":"Yes"},"edit_token":"x"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn cap_blocks_new_answers_and_uploads_land_beside_the_form() {
        let mount = tempfile::tempdir().unwrap();
        let doc = r#"{
            "version": 1,
            "title": "Potluck",
            "settings": { "collecting": true, "allowEdits": true, "maxResponses": 1 },
            "questions": [
                { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
                  "config": { "options": ["Yes", "No"] } },
                { "id": "q_file", "type": "file", "label": "Photo" }
            ]
        }"#;
        std::fs::write(mount.path().join("rsvp.lunaform"), doc).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

        let boundary = "----lunaformboundary";
        let mut raw = Vec::new();
        raw.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"note.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
            )
            .as_bytes(),
        );
        raw.extend(b"%PDF-1.1\n");
        raw.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri(format!("/s/{token}/respond-file"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("accept", "application/json")
            .body(Body::from(raw))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
        let uploaded = body_json(res).await;
        let name = uploaded["name"].as_str().unwrap().to_string();
        assert!(super::upload_name_ok(&name), "{name}");
        assert!(mount.path().join("rsvp.uploads").join(&name).is_file());

        let body =
            format!(r#"{{"answers":{{"q_1":"Yes","q_file":"{name}"}},"edit_token":"secret-one"}}"#);
        let res = call(
            &app,
            req(Method::POST, &format!("/s/{token}/respond"), &body),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let id = body_json(res).await["id"].as_str().unwrap().to_string();

        let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
        let loaded = body_json(res).await;
        assert_eq!(loaded["full"], true);
        assert_eq!(loaded["accepting"], true);

        let res = call(
            &app,
            req(
                Method::POST,
                &format!("/s/{token}/respond"),
                r#"{"answers":{"q_1":"No"},"edit_token":"someone-else"}"#,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        let edit = format!(
            r#"{{"answers":{{"q_1":"No","q_file":"{name}"}},"edit_token":"secret-one","response_id":"{id}"}}"#
        );
        let res = call(
            &app,
            req(Method::POST, &format!("/s/{token}/respond"), &edit),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    fn insert_link_full(
        state: &crate::AppState,
        path: &str,
        caps: i64,
        password_hash: &str,
        expires_at: Option<i64>,
    ) -> String {
        let token = Uuid::new_v4().simple().to_string();
        let conn = state.db.lock().unwrap();
        crate::db::insert_access_link(
            &conn,
            &crate::db::AccessLinkRow {
                id: Uuid::new_v4().to_string(),
                token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
                token: token.clone(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: path.into(),
                album_id: String::new(),
                caps,
                password_hash: password_hash.into(),
                expires_at,
                created_by: "test".into(),
                created_at: 0,
            },
        )
        .unwrap();
        token
    }

    fn write_answers(mount: &std::path::Path) {
        std::fs::write(
            mount.join("rsvp.responses.jsonl"),
            concat!(
                r#"{"id":"r_1","edit":"HASHSECRET","answers":{"q_1":"Yes"},"at":1}"#,
                "\n",
                r#"{"id":"r_1","edit":"HASHSECRET","answers":{"q_1":"No"},"at":2}"#,
                "\n"
            ),
        )
        .unwrap();
    }

    async fn register_and_login(
        app: &axum::Router,
        username: &str,
        password: &str,
    ) -> (String, String) {
        let res = call(
            app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                &format!(
                    r#"{{"username":"{username}","display_name":"{username}","password":"{password}"}}"#
                ),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        login(app, username, password).await
    }

    async fn login(app: &axum::Router, username: &str, password: &str) -> (String, String) {
        let res = call(
            app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                &format!(r#"{{"username":"{username}","password":"{password}"}}"#),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(t) = part.strip_prefix("luna_csrf=") {
                csrf = t.to_string();
            }
        }
        (format!("{session}; luna_csrf={csrf}"), csrf)
    }

    fn authed_req(method: Method, uri: &str, cookie: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    /// A view link on the form opens its answers — minus the stored edit
    /// hashes — with no-store/no-referrer headers.
    #[tokio::test]
    async fn guest_view_link_reads_responses_without_edit_hashes() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        write_answers(mount.path());
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_VIEW);

        let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(res.headers()["referrer-policy"], "no-referrer");
        let v = body_json(res).await;
        let answers = v["responses"].as_array().unwrap();
        assert_eq!(answers.len(), 2);
        assert!(answers.iter().all(|r| r.get("edit").is_none()));
        assert_eq!(answers[1]["answers"]["q_1"], "No");

        // Folder links resolve the file beneath their root.
        let folder = insert_link(&state, "", crate::access::CAP_VIEW);
        let res = call(
            &app,
            req(
                Method::GET,
                &format!("/s/{folder}/responses?path=rsvp.lunaform"),
                "",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            body_json(res).await["responses"].as_array().unwrap().len(),
            2
        );
    }

    /// Respond links collect answers but must never read anyone's back;
    /// traversal, expired, and wrong-password links all fail.
    #[tokio::test]
    async fn responses_route_denies_respond_traversal_expired_and_password() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        write_answers(mount.path());
        let (_dir, app, state) = test_app(mount.path());

        let respond = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);
        let res = call(
            &app,
            req(Method::GET, &format!("/s/{respond}/responses"), ""),
        )
        .await;
        assert_eq!(
            res.status(),
            StatusCode::FORBIDDEN,
            "respond can't read answers"
        );

        let folder = insert_link(&state, "", crate::access::CAP_VIEW);
        let res = call(
            &app,
            req(
                Method::GET,
                &format!("/s/{folder}/responses?path=../rsvp.lunaform"),
                "",
            ),
        )
        .await;
        assert!(res.status().is_client_error(), "traversal must fail");

        // A path that names the sibling file itself is not a form.
        let res = call(
            &app,
            req(
                Method::GET,
                &format!("/s/{folder}/responses?path=rsvp.responses.jsonl"),
                "",
            ),
        )
        .await;
        assert!(res.status().is_client_error());

        let expired = insert_link_full(
            &state,
            "rsvp.lunaform",
            crate::access::CAP_VIEW,
            "",
            Some(crate::db::now_unix() - 60),
        );
        let res = call(
            &app,
            req(Method::GET, &format!("/s/{expired}/responses"), ""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::GONE);

        let gated = insert_link_full(
            &state,
            "rsvp.lunaform",
            crate::access::CAP_VIEW,
            &crate::auth::hash_password_unchecked("right-password").unwrap(),
            None,
        );
        let res = call(&app, req(Method::GET, &format!("/s/{gated}/responses"), "")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let mut wrong = req(Method::GET, &format!("/s/{gated}/responses"), "");
        *wrong.headers_mut() = wrong.headers().clone();
        wrong
            .headers_mut()
            .insert("x-share-password", "wrong-password".parse().unwrap());
        let res = call(&app, wrong).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    /// A missing sibling means "no answers yet" — but a symlinked sibling or
    /// an oversized one is a real error, never a silent empty list.
    #[tokio::test]
    async fn responses_missing_empty_symlink_and_oversize_denied() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_VIEW);

        let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            body_json(res).await["responses"].as_array().unwrap().len(),
            0
        );

        let sibling = mount.path().join("rsvp.responses.jsonl");
        std::os::unix::fs::symlink("/etc/hostname", &sibling).unwrap();
        let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
        assert!(res.status().is_client_error(), "symlink answers must fail");
        std::fs::remove_file(&sibling).unwrap();

        let f = std::fs::File::create(&sibling).unwrap();
        f.set_len(super::MAX_RESPONSES_READ_BYTES + 1).unwrap();
        drop(f);
        let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// A member with a file-only grant reads the form's answers — no parent
    /// folder access required — while a stranger gets nothing.
    #[tokio::test]
    async fn member_file_only_grant_reads_responses() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
        write_answers(mount.path());
        let (_dir, app, state) = test_app(mount.path());
        let (admin_cookie, _csrf) = register_and_login(&app, "max", "hunter22hunter1").await;

        {
            let conn = state.db.lock().unwrap();
            crate::db::insert_user(&conn, "u-ann", "ann", "Ann", "unused", "member").unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "m-ann".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "rsvp.lunaform".into(),
                    album_id: String::new(),
                    user_id: "u-ann".into(),
                    caps: crate::access::CAP_VIEW,
                    created_by: "u".into(),
                },
            )
            .unwrap();
        }
        // Give Ann a real session row by minting her a login — simplest is
        // the HTTP flow, so set her password to something she can use.
        {
            let conn = state.db.lock().unwrap();
            let hash = crate::auth::hash_password_unchecked("ann-password").unwrap();
            conn.execute(
                "UPDATE users SET password_hash=?1 WHERE id='u-ann'",
                rusqlite::params![hash],
            )
            .unwrap();
        }
        let (ann_cookie, _ann_csrf) = login(&app, "ann", "ann-password").await;

        let res = call(
            &app,
            authed_req(
                Method::GET,
                "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
                &ann_cookie,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["responses"].as_array().unwrap().len(), 2);
        assert!(
            v["responses"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r.get("edit").is_none())
        );

        // Admin reads them too; a member with no grant is refused.
        let res = call(
            &app,
            authed_req(
                Method::GET,
                "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
                &admin_cookie,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        {
            let conn = state.db.lock().unwrap();
            crate::db::delete_access_member(&conn, "m-ann").unwrap();
        }
        let res = call(
            &app,
            authed_req(
                Method::GET,
                "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
                &ann_cookie,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }
}
