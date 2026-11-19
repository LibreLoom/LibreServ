//! Luna Forms: `.lunaform` files shared through respond links (the
//! link-only `CAP_RESPOND` capability in `crate::access`). A respond link
//! lets anyone with the URL open the form and append one JSONL record to the
//! form's answers — a hidden `.<name>.lunaform.responses` (plus numbered
//! `.1`, `.2`, … segments once a segment fills) — never read other people's
//! answers back (a respondent can only re-fetch their own record by presenting
//! the edit secret they were issued at submit time).
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

/// Answers live next to the form as a hidden `.<name>.lunaform.responses` —
/// one JSON record per line. When the active file reaches
/// [`RESPONSES_SEGMENT_BYTES`], the next records go to
/// `.<name>.lunaform.responses.1`, then `.2`, and so on; every reader merges
/// the files in order.
pub const RESPONSES_SUFFIX: &str = ".lunaform.responses";

/// Highest `.lunaform` envelope version this build understands.
const FORM_DOC_VERSION: i64 = 1;

/// A form is a hand-editable JSON file — refuse absurdly large ones.
const MAX_FORM_BYTES: u64 = 1024 * 1024;
/// Answers are written to one segment until it reaches this size, then the
/// next segment (`.1`, `.2`, …) is started. 8 MiB holds ~128 answers at the
/// per-answer cap and keeps each read small enough for a Pi-class box.
const RESPONSES_SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
/// One answers segment is never read past this. The unnumbered original can
/// predate rotation, so it is allowed the size the old whole-file reader
/// accepted; numbered segments rotate long before this.
const MAX_RESPONSES_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;
/// All segments together are read up to this. Past it the reader returns the
/// records that fit and says some answers couldn't be opened — never a silent
/// "no answers". Twice the old single-file read cap, and still bounded.
const MAX_RESPONSES_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
/// Numbered segments after the original. 15 × 8 MiB + the original is about
/// the total read cap; past it new answers are refused rather than written
/// where the owner's view can never show them.
const MAX_RESPONSES_SEGMENTS: u32 = 15;
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
/// Submissions one form takes per minute from every address together. A class
/// of 30 answering at once is normal; 60 leaves room for retries and edit
/// re-sends while still stopping a rotating-IP flood from burning the whole
/// `maxResponses` budget before real respondents arrive.
pub const FORM_SUBMIT_PER_MINUTE: usize = 60;

/// `true` when a share path names a form document (case-insensitive ext).
pub fn is_form_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(FORM_FILE_SUFFIX)
}

/// Namespaced bucket key so respond limits don't share a raw-IP bucket with
/// login/DAV/share limiters — same convention as `public_limits.rs`. Each
/// endpoint gets its own bucket: a form with a few file questions spends
/// one upload per attachment and must still be able to send.
fn respond_key(kind: &str, ip: &str) -> String {
    format!("form_respond:{kind}:{ip}")
}

/// One form's answer budget, shared by every address. The path is hashed so a
/// form's location never lands in the rate-limit table; the bucket is still
/// per form, whatever address the submissions come from. A distributed flood
/// therefore cannot spend a form's whole `maxResponses` budget before the
/// people it was sent to arrive.
fn form_key(drive_id: &str, path: &str) -> String {
    let tag = blake3::hash(format!("{drive_id}\n{path}").as_bytes()).to_hex();
    respond_key("form", tag.as_str())
}

/// The respondent's address for rate limiting. Behind Luna Connect every
/// request arrives from loopback, so the forwarded client IP is what tells
/// respondents apart (`client_ip` only trusts those headers from loopback).
fn respondent_ip(addr: &SocketAddr, headers: &HeaderMap) -> String {
    crate::api::auth::client_ip(addr, headers).to_string()
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

fn answers_full() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INSUFFICIENT_STORAGE,
        "This form has as many answers as Luna can keep. Ask the person who shared it to clear some out.",
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
        .route(
            "/s/{token}/responses",
            get(guest_form_responses).delete(guest_delete_response),
        )
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

/// One lock for every responses-file append: the cap check, the edit-secret
/// match, and the write happen as one step, so two people sending at once
/// can neither slip past `maxResponses` nor interleave their lines.
static RESPONSES_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

/// The `.<name>.lunaform.responses` that sits next to a resolved form file.
fn responses_path_for(form_path: &FsPath) -> Option<PathBuf> {
    responses_path_named(form_path, &leaf_name(form_path)?)
}

fn responses_path_named(form_path: &FsPath, name: &str) -> Option<PathBuf> {
    let dot = name.rfind('.')?;
    if !name[dot..].eq_ignore_ascii_case(FORM_FILE_SUFFIX) {
        return None;
    }
    // A private form's answers stay as private as the form: they sit under a
    // Luna-owned name next to its disk entry, not as a visible sibling file.
    if let Some(disk) = form_path.file_name().and_then(|n| n.to_str())
        && crate::drives::layout::Layout::is_luna_name(disk)
    {
        return Some(form_path.with_file_name(format!("{disk}.responses")));
    }
    let sibling = format!(".{}{}", &name[..dot], RESPONSES_SUFFIX);
    Some(form_path.parent()?.join(sibling))
}

/// The answers file for segment `n`: `0` is the original unnumbered sibling,
/// `1..` are `<original>.1`, `<original>.2`, … in the same folder.
///
/// The numbered names share the answers file's reserved family. No other form
/// can mint them (a form's answers always end `.lunaform.responses`, and a
/// form named after another's segment produces a different name), so only a
/// file a person deliberately named the same way could collide — and anyone
/// who can write that folder can already write the answers file itself, so
/// numbering adds no new access.
fn response_segment_path(base: &FsPath, n: u32) -> Option<PathBuf> {
    if n == 0 {
        return Some(base.to_path_buf());
    }
    let name = base.file_name()?.to_str()?;
    Some(base.with_file_name(format!("{name}.{n}")))
}

/// Every answers file that exists for a form, oldest first. Reads the folder
/// once; a number with a leading zero, or one past
/// [`MAX_RESPONSES_SEGMENTS`], is not one of ours. The original (segment 0)
/// is always returned so callers can tell "no file yet" from "an answers file
/// is there".
fn response_segment_paths(form_path: &FsPath) -> Vec<(u32, PathBuf)> {
    let Some(base) = responses_path_for(form_path) else {
        return Vec::new();
    };
    response_paths_from_base(&base)
}

fn response_paths_from_base(base: &FsPath) -> Vec<(u32, PathBuf)> {
    let mut found = vec![(0u32, base.to_path_buf())];
    let (Some(dir), Some(base_name)) = (base.parent(), base.file_name().and_then(|n| n.to_str()))
    else {
        return found;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(rest) = name
            .strip_prefix(base_name)
            .and_then(|rest| rest.strip_prefix('.'))
        else {
            continue;
        };
        if rest.is_empty()
            || rest.len() > 9
            || rest.starts_with('0')
            || !rest.bytes().all(|b| b.is_ascii_digit())
        {
            continue;
        }
        let Ok(n) = rest.parse::<u32>() else {
            continue;
        };
        if n == 0 || n > MAX_RESPONSES_SEGMENTS {
            continue;
        }
        found.push((n, entry.path()));
    }
    found.sort_by_key(|(n, _)| *n);
    found.dedup_by_key(|(n, _)| *n);
    found
}

/// The segment new answers go to: the highest-numbered one that exists, or
/// the original when the form has never rotated.
fn active_response_segment(form_path: &FsPath) -> Option<(u32, PathBuf)> {
    response_segment_paths(form_path).pop()
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

/// Where the form's answers file sits. Normally the visible
/// `.<name>.lunaform.responses` sibling; for a top-level trash entry it is a
/// Luna-owned name beside the files folder so the trash list never shows it.
pub fn responses_file_for(root: &FsPath, form_path: &FsPath) -> Option<PathBuf> {
    responses_file_named(root, form_path, &leaf_name(form_path)?)
}

fn responses_file_named(root: &FsPath, form_path: &FsPath, name: &str) -> Option<PathBuf> {
    let visible = responses_path_named(form_path, name)?;
    if form_path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(crate::drives::layout::Layout::is_luna_name)
    {
        return Some(visible);
    }
    let layout = crate::drives::layout::Layout::detect(root)?;
    let in_trash_root = form_path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n.to_str() == Some(layout.trash_name().as_str()));
    if in_trash_root {
        let dir = files_dir_named(root, form_path, name)?;
        let mut name = dir.file_name()?.to_os_string();
        name.push(".responses");
        return Some(dir.with_file_name(name));
    }
    Some(visible)
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
    if let (Some(a), Some(b)) = (
        files_dir_named(from_root, from, from_name),
        files_dir_named(to_root, to, to_name),
    ) {
        move_if_present(&a, &b);
    }
    if let (Some(a), Some(b)) = (
        responses_file_named(from_root, from, from_name),
        responses_file_named(to_root, to, to_name),
    ) {
        // The original answers file and every rotation segment travel with
        // the form; segment numbers stay the same on the other side.
        for (n, path) in response_paths_from_base(&a) {
            if let Some(target) = response_segment_path(&b, n) {
                move_if_present(&path, &target);
            }
        }
    }
}

/// A form file is being deleted for good: remove its files folder, answers
/// file, and every numbered answers segment so they don't keep using drive
/// space. No-op for non-forms.
pub fn remove_form_files(root: &FsPath, form_path: &FsPath) {
    if !leaf_name(form_path).is_some_and(|n| is_form_path(&n)) {
        return;
    }
    if let Some(dir) = files_dir_for(root, form_path) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(file) = responses_file_for(root, form_path) {
        for (_, path) in response_paths_from_base(&file) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn form_files_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    form_path: &FsPath,
) -> Option<PathBuf> {
    let drive = crate::files::drive_root(conn, drive_id).ok()?;
    files_dir_for(FsPath::new(&drive.mount_point), form_path)
}

/// [`resolve_form_file`] plus the form's files folder.
fn resolve_form(
    conn: &rusqlite::Connection,
    drive_id: &str,
    path: &str,
) -> Result<FormLoc, (StatusCode, Json<Value>)> {
    let path = resolve_form_file(conn, drive_id, path)?;
    let files = form_files_dir(conn, drive_id, &path).ok_or_else(|| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps files.",
        )
    })?;
    Ok(FormLoc { path, files })
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
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this form right now. Try again.",
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
    let count = latest_by_id(&read_response_records(&form_path).records).len();
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
    /// `count=1` returns `{count}` only (the file list's badge).
    #[serde(default)]
    count: Option<String>,
    /// DELETE: the response to remove.
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
struct GuestResponsesQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    count: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

fn wants_count(raw: &Option<String>) -> bool {
    matches!(raw.as_deref(), Some("1") | Some("true"))
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
/// edit access to the form.
async fn member_form_responses(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    responses_response(&form.path, wants_count(&q.count))
}

/// `DELETE /api/v1/forms/responses?drive_id=&path=&id=` — remove one
/// response (spam, a test run). Appends a tombstone; the JSONL stays
/// append-only.
async fn member_delete_response(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(q): Query<MemberResponsesQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let form = member_managed_form(&state, &user, &q.drive_id, &q.path)?;
    delete_response(&state, &q.drive_id, &form, q.id.as_deref())
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
            responses_response(&form.path, wants_count(&q.count))
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

fn delete_response(
    state: &AppState,
    drive_id: &str,
    form: &FormLoc,
    id: Option<&str>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let form_path = &form.path;
    let id = id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Luna didn't get which response to delete. Reload the page and try again.",
            )
        })?;
    let _guard = RESPONSES_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    let records = read_response_records_guarded(form_path)?.records;
    if !latest_by_id(&records).contains_key(id) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "That response is already gone. Reload the page to see the latest answers.",
        ));
    }
    let tombstone = json!({ "v": 1, "id": id, "deleted": true, "at": crate::db::now_unix() });
    append_record(state, drive_id, form_path, &tombstone)?;
    // The response's attachments go with it — every version's, since an
    // earlier edit may have named a different file.
    if let Ok(doc) = read_form_document(form_path) {
        let names: std::collections::HashSet<String> = records
            .iter()
            .filter(|rec| rec.get("id").and_then(|v| v.as_str()) == Some(id))
            .flat_map(|rec| record_attachments(&doc, rec))
            .collect();
        remove_attachments(&doc, &form.files, names.iter());
    }
    Ok(Json(json!({ "ok": true })))
}

/// Append one JSONL line to the form's active answers segment, starting the
/// next numbered segment when the active one is full. The line and its
/// newline go out in one `write_all` on an O_APPEND file, and callers hold
/// `RESPONSES_WRITE`, so concurrent appends never interleave and the rotation
/// decision belongs to the same step. A planted symlink is refused, and
/// O_NOFOLLOW closes the check→open race.
fn append_record(
    state: &AppState,
    drive_id: &str,
    form_path: &FsPath,
    record: &Value,
) -> Result<(), (StatusCode, Json<Value>)> {
    let save_err = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save the answers file. Try again.",
        )
    };
    let Some(base) = responses_path_for(form_path) else {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't find where this form keeps its answers.",
        ));
    };
    let mut line = serde_json::to_string(record).map_err(|_| save_err())?;
    line.push('\n');

    let (mut number, mut target) = active_response_segment(form_path).unwrap_or((0, base.clone()));
    let active_len = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "This form's answers file isn't safe to write to.",
            ));
        }
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err(save_err()),
    };
    if active_len > 0 && active_len.saturating_add(line.len() as u64) > RESPONSES_SEGMENT_BYTES {
        if number >= MAX_RESPONSES_SEGMENTS {
            return Err(answers_full());
        }
        // Never write past what a reader will read: the total read cap is the
        // form's storage budget too, so an accepted answer is one the owner can
        // still see. Only rotation pays for this sum.
        let used: u64 = response_segment_paths(form_path)
            .iter()
            .filter_map(|(_, path)| std::fs::symlink_metadata(path).ok())
            .filter(|meta| meta.is_file())
            .map(|meta| meta.len())
            .sum();
        if used.saturating_add(line.len() as u64) > MAX_RESPONSES_TOTAL_BYTES {
            return Err(answers_full());
        }
        number += 1;
        target = response_segment_path(&base, number).ok_or_else(save_err)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "This form's answers file isn't safe to write to.",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(save_err()),
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&target)
        .map_err(|e| {
            crate::files::note_write_failure(
                &state.db.lock().unwrap_or_else(|p| p.into_inner()),
                drive_id,
                &e.to_string(),
            );
            save_err()
        })?;
    file.write_all(line.as_bytes()).map_err(|_| save_err())?;
    state.touch_io_activity();
    Ok(())
}

/// Answers read from every segment, plus whether anything was skipped.
struct AnswersRead {
    records: Vec<Value>,
    /// A segment couldn't be read in full — too large, a symlink, unreadable,
    /// or past the total read cap. Owner-facing readers say so instead of
    /// implying the form has fewer answers.
    incomplete: bool,
}

impl AnswersRead {
    fn notice(&self) -> Option<String> {
        self.incomplete.then(|| {
            "Some older answers couldn't be opened, so this list may not show everything."
                .to_string()
        })
    }
}

/// Collected answers, latest version of each live response, never the edit
/// hashes. `count_only` answers the file list's badge without shipping every
/// answer to the browser.
fn responses_response(
    form_path: &FsPath,
    count_only: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let read = read_response_records_guarded(form_path)?;
    let notice = read.notice();
    let mut body = if count_only {
        json!({ "count": latest_by_id(&read.records).len() })
    } else {
        json!({ "responses": latest_in_order(&read.records) })
    };
    // The key appears only when something was skipped, so a normal read keeps
    // the shape every existing client (and the recorded contract) expects.
    if let Some(notice) = notice {
        body["notice"] = Value::String(notice);
    }
    let mut res = Json(body).into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    Ok(res)
}

/// Read every answers segment for an authorized viewer, oldest first. Unlike
/// the respond-path reader (which treats every anomaly as a skipped segment),
/// this one must report real problems with the *original* file: a planted
/// symlink, a non-file sibling, or an I/O error surface as errors — only a
/// genuinely missing file means "no answers yet". A numbered segment that
/// can't be read is skipped and marks the read incomplete so the owner's view
/// can say some answers are missing.
fn read_response_records_guarded(
    form_path: &FsPath,
) -> Result<AnswersRead, (StatusCode, Json<Value>)> {
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
    read_response_segments(form_path, true)
}

/// Read all answers segments (empty when nobody has answered yet).
/// Respond-path readers stay lenient — an unreadable segment is skipped rather
/// than failing the request — but a symlink is never followed: a planted link
/// could turn the append into a write to an attacker-chosen file.
fn read_response_records(form_path: &FsPath) -> AnswersRead {
    match read_response_segments(form_path, false) {
        Ok(read) => read,
        Err(_) => AnswersRead {
            records: Vec::new(),
            incomplete: true,
        },
    }
}

fn read_response_segments(
    form_path: &FsPath,
    strict: bool,
) -> Result<AnswersRead, (StatusCode, Json<Value>)> {
    let mut read = AnswersRead {
        records: Vec::new(),
        incomplete: false,
    };
    let mut total: u64 = 0;
    for (n, path) in response_segment_paths(form_path) {
        let original = n == 0;
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) if strict && original => return Err(answers_io_err()),
            Err(_) => {
                read.incomplete = true;
                continue;
            }
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            if strict && original {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "This form's answers file isn't safe to open.",
                ));
            }
            read.incomplete = true;
            continue;
        }
        if meta.len() > MAX_RESPONSES_SEGMENT_BYTES {
            read.incomplete = true;
            continue;
        }
        if total.saturating_add(meta.len()) > MAX_RESPONSES_TOTAL_BYTES {
            read.incomplete = true;
            break;
        }
        match read_segment(&path) {
            Ok(text) if text.len() as u64 <= MAX_RESPONSES_SEGMENT_BYTES => {
                total = total.saturating_add(text.len() as u64);
                read.records.extend(parse_response_records(&text));
            }
            Ok(_) => read.incomplete = true,
            Err(_) if strict && original => return Err(answers_io_err()),
            Err(_) => read.incomplete = true,
        }
    }
    Ok(read)
}

/// One capped segment read. O_NOFOLLOW closes the symlink_metadata→open race;
/// callers still check the returned length against the segment cap.
fn read_segment(path: &FsPath) -> std::io::Result<String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let mut text = String::new();
    file.take(MAX_RESPONSES_SEGMENT_BYTES + 1)
        .read_to_string(&mut text)?;
    Ok(text)
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

/// A deleted response is a tombstone line: `{"id": …, "deleted": true}`.
fn is_tombstone(rec: &Value) -> bool {
    rec.get("deleted").and_then(|d| d.as_bool()) == Some(true)
}

/// Latest live record per response id — edits append a new line with the
/// same id, so the last line for an id wins; a tombstone removes the id.
fn latest_by_id(records: &[Value]) -> Map<String, Value> {
    let mut latest = Map::new();
    for rec in records {
        if let Some(id) = rec.get("id").and_then(|id| id.as_str()) {
            if is_tombstone(rec) {
                latest.remove(id);
            } else {
                latest.insert(id.to_string(), rec.clone());
            }
        }
    }
    latest
}

/// Live responses in first-sent order, each carrying the time it was first
/// sent (`sent_at`) next to the time of its latest change (`at`).
fn latest_in_order(records: &[Value]) -> Vec<Value> {
    let latest = latest_by_id(records);
    let mut order: Vec<&str> = Vec::new();
    let mut first_at: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for rec in records {
        let Some(id) = rec.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        if !latest.contains_key(id) || first_at.contains_key(id) {
            continue;
        }
        order.push(id);
        first_at.insert(id, rec.get("at").and_then(|a| a.as_i64()).unwrap_or(0));
    }
    order
        .into_iter()
        .filter_map(|id| {
            let mut rec = latest.get(id)?.clone();
            if let Some(obj) = rec.as_object_mut() {
                obj.remove("edit");
                obj.insert(
                    "sent_at".into(),
                    json!(first_at.get(id).copied().unwrap_or(0)),
                );
            }
            Some(rec)
        })
        .collect()
}

/// Find the response a respondent may edit: an explicit `response_id` must
/// exist AND carry this edit secret; without an id, any record stamped with
/// the secret identifies its response (edit-link flow).
fn find_editable(
    latest: &Map<String, Value>,
    response_id: Option<&str>,
    edit_hash: &str,
) -> Result<Option<String>, (StatusCode, Json<Value>)> {
    let matches = |rec: &Value| rec.get("edit").and_then(|e| e.as_str()) == Some(edit_hash);
    if let Some(id) = response_id {
        // One refusal for wrong id and wrong secret — a different status or
        // message per case would make this a response-id existence oracle.
        return match latest.get(id) {
            Some(rec) if matches(rec) => Ok(Some(id.to_string())),
            _ => Err(json_error(
                StatusCode::FORBIDDEN,
                "This edit link doesn't match a saved answer on this form.",
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

/// `POST /s/{token}/respond` — append one answer record to the sibling
/// `.<name>.lunaform.responses`. Re-submits with a matching edit secret keep the
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
    // Cap check, secret match, and append are one step under the lock.
    let (response_id, edit_token, is_new) = {
        let _guard = RESPONSES_WRITE.lock().unwrap_or_else(|p| p.into_inner());
        // Edits need the existing records: match the secret before
        // validating — a wrong secret is refused before it can probe answer
        // shapes.
        let read = read_response_records(&form_path);
        // Counting live answers for `maxResponses` is only trustworthy when
        // every segment was read; refuse new answers rather than let a
        // truncated read open the cap.
        if read.incomplete && form_max_responses(&doc).is_some() {
            return Err(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Luna couldn't read all of this form's answers. Try again in a moment.",
            ));
        }
        let latest = latest_by_id(&read.records);
        let editing_id = match presented_hash.as_deref() {
            Some(hash) => find_editable(&latest, body.response_id.as_deref(), hash)?,
            // A target id without its secret is an edit attempt too — refuse
            // it with the same message as a mismatched secret.
            None if body
                .response_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()) =>
            {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "This edit link doesn't match a saved answer on this form.",
                ));
            }
            None => None,
        };
        let is_new = editing_id.is_none();
        if is_new && form_max_responses(&doc).is_some_and(|max| latest.len() >= max as usize) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "This form has all the answers it can take.",
            ));
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
            .and_then(|id| latest.get(id))
            .map(|rec| record_attachments(&doc, rec))
            .unwrap_or_default();
        let can_attach =
            |name: &str| previous_files.contains(name) || regular_file(&pending.join(name));
        validate_answers(&doc, &answers, Some(&can_attach))?;
        let new_files = attachments_in(&doc, &answers);
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
        let record = json!({
            "v": 1,
            "id": response_id,
            "edit": edit_hash,
            "at": crate::db::now_unix(),
            "answers": Value::Object(answers),
        });
        if let Err(e) = append_record(state, &link.drive_id, &form_path, &record) {
            release(&claimed);
            return Err(e);
        }
        // An edit that swapped or removed a file drops the old one.
        let dropped: Vec<String> = previous_files.difference(&new_files).cloned().collect();
        remove_attachments(&doc, &form.files, dropped.iter());
        (response_id, edit_token, is_new)
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
    let form_path = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this form right now. Try again.",
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
    let latest = latest_by_id(&read_response_records(&form_path).records);
    let Some((id, record)) = latest
        .iter()
        .find(|(_, rec)| rec.get("edit").and_then(|e| e.as_str()) == Some(edit_hash.as_str()))
    else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find answers for that edit link.",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "id": id,
        "answers": record.get("answers").cloned().unwrap_or(Value::Object(Map::new())),
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

/// Everything respondents may attach to one form, together. Past this the
/// form stops taking files until the owner clears some out.
const MAX_UPLOADS_DIR_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

/// Everything on one form — sent attachments, pictures, and unsent uploads —
/// stays under [`MAX_UPLOADS_DIR_BYTES`].
fn check_form_room(form: &FormLoc, incoming: u64) -> Result<(), (StatusCode, Json<Value>)> {
    let used = dir_file_bytes(&form.files) + dir_file_bytes(&form.files.join(PENDING_DIR));
    if used.saturating_add(incoming) > MAX_UPLOADS_DIR_BYTES {
        return Err(json_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "This form has no room for more files. Ask the person who shared it to clear some out.",
        ));
    }
    Ok(())
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
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("{disposition}; filename=\"{name}\""),
        )
        .header(header::CACHE_CONTROL, "private, no-store")
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
