//! The Backups folder on a drive: browse, versions, download, restore (plan §4).
//!
//! Every route finds the backup's store under the drive's mount and checks who
//! may see it first. Paths from the user are validated before they touch the
//! disk. A restore never overwrites: a clashing name gets a
//! "(restored <day>)" suffix.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::access::{self, CAP_EDIT};
use crate::api::gallery::stream_zip_response;
use crate::api::response::json_error;
use crate::auth::{self, CurrentUser};
use crate::backup::drive_backup;
use crate::backup::drive_store::{self, Manifest, Store};
use crate::backup::status::BackupState;
use crate::db::{self, DriveRow, ProtectionRow};
use crate::drives::layout::Layout;
use crate::files::{self, FilesError};
use crate::gallery;
use crate::private;

type ApiError = (StatusCode, Json<Value>);

const ONE_DAY: i64 = 86_400;
const MAX_RESTORE_NAMES: i64 = 999;
/// Suffix of a backup folder that is being removed (see `retire_store`).
const TRASH_MARK: &str = ".deleting-";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drives/{drive_id}/backups", get(list_backups))
        .route(
            "/api/v1/drives/{drive_id}/backups/{id}/list",
            get(list_folder),
        )
        .route(
            "/api/v1/drives/{drive_id}/backups/{id}/versions",
            get(versions),
        )
        .route(
            "/api/v1/drives/{drive_id}/backups/{id}/download",
            get(download),
        )
        .route(
            "/api/v1/drives/{drive_id}/backups/{id}/restore",
            post(restore),
        )
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct DownloadQuery {
    #[serde(default)]
    path: String,
    at: Option<String>,
}

#[derive(Deserialize)]
struct RestoreBody {
    path: String,
    at: Option<Value>,
}

fn fail(status: StatusCode, message: impl Into<String>) -> ApiError {
    json_error(status, message)
}

fn lock_db(state: &AppState) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, ApiError> {
    state.db.lock().map_err(|_| {
        fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna is busy right now. Try again.",
        )
    })
}

fn db_error(_: anyhow::Error) -> ApiError {
    fail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't read its records. Try again.",
    )
}

fn io_error(_: io::Error) -> ApiError {
    fail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't read that backup. Try again.",
    )
}

fn not_found_backup() -> ApiError {
    fail(
        StatusCode::NOT_FOUND,
        "Luna couldn't find that backup on this drive.",
    )
}

fn invalid_path() -> ApiError {
    fail(
        StatusCode::BAD_REQUEST,
        "That path is not valid. Choose it from the list instead.",
    )
}

fn invalid_version() -> ApiError {
    fail(
        StatusCode::BAD_REQUEST,
        "That version is not valid. Choose one from the list.",
    )
}

/// A path inside a backup, relative, with no `..` and no leading slash.
/// Empty means the top of the backup.
fn clean_rel(raw: &str) -> Result<String, ApiError> {
    if raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') {
        return Err(invalid_path());
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(invalid_path()),
            other => parts.push(other),
        }
    }
    Ok(parts.join("/"))
}

fn join_rel(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    }
}

fn file_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// A version number: digits only, so it can name a folder under `versions/`.
fn parse_at(raw: Option<&str>) -> Result<Option<i64>, ApiError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid_version());
    }
    raw.parse::<i64>().map(Some).map_err(|_| invalid_version())
}

/// Metadata for a real file or folder. Links are treated as absent.
fn plain_meta(path: &Path) -> Option<fs::Metadata> {
    let md = fs::symlink_metadata(path).ok()?;
    (!md.file_type().is_symlink()).then_some(md)
}

/// `path` resolved through links, when it sits inside `base`.
fn inside(base: &Path, path: &Path) -> Option<PathBuf> {
    let base = base.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    real.starts_with(&base).then_some(real)
}

fn mtime_of(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn can_see(
    conn: &rusqlite::Connection,
    user: &CurrentUser,
    manifest: &Manifest,
) -> Result<bool, ApiError> {
    let row: Option<ProtectionRow> =
        db::get_protection(conn, &manifest.protection_id).map_err(db_error)?;
    Ok(match row {
        Some(row) => drive_backup::visible_to(&row, user),
        None => manifest.access.allows(&user.id, user.role == "admin"),
    })
}

/// The mounted drive's backup folder, or a plain reason it is not connected.
fn store_home(conn: &rusqlite::Connection, drive_id: &str) -> Result<(PathBuf, Layout), ApiError> {
    let drive: DriveRow = files::drive_root(conn, drive_id).map_err(|err| match err {
        FilesError::UnknownDrive => fail(
            StatusCode::CONFLICT,
            "Connect that drive to see its backups.",
        ),
        _ => fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read that drive. Try again.",
        ),
    })?;
    let root = PathBuf::from(&drive.mount_point);
    let layout = Layout::detect(&root).ok_or_else(|| {
        fail(
            StatusCode::CONFLICT,
            "Connect that drive to see its backups.",
        )
    })?;
    Ok((root, layout))
}

/// A backup the user may see, or the same "not found" as a missing one.
fn find_visible(
    conn: &rusqlite::Connection,
    user: &CurrentUser,
    drive_id: &str,
    id: &str,
) -> Result<(Store, Manifest), ApiError> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(not_found_backup());
    }
    let (root, layout) = store_home(conn, drive_id)?;
    let store = Store::existing(&root, &layout, id).ok_or_else(not_found_backup)?;
    if is_deleted(conn, id)? {
        retire_store(store.root());
        return Err(not_found_backup());
    }
    let manifest = store
        .read_manifest()
        .map_err(io_error)?
        .ok_or_else(not_found_backup)?;
    if !can_see(conn, user, &manifest)? {
        return Err(not_found_backup());
    }
    Ok((store, manifest))
}

fn state_label(state: BackupState) -> &'static str {
    match state {
        BackupState::Ok => "ok",
        BackupState::Failing => "failing",
        BackupState::Stale => "stale",
    }
}

/// Whether the backup was deleted (its tombstone is set, see ops.rs `delete`).
fn is_deleted(conn: &rusqlite::Connection, id: &str) -> Result<bool, ApiError> {
    Ok(db::get_meta(conn, &format!("deleted_backup:{id}"))
        .map_err(db_error)?
        .is_some())
}

/// Moves a deleted backup's folder out of the way at once, then removes it in the background.
fn retire_store(root: &Path) {
    let Some(name) = root.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let trash = root.with_file_name(format!("{name}{TRASH_MARK}{nanos}"));
    if fs::rename(root, &trash).is_ok() {
        std::thread::spawn(move || {
            let _ = fs::remove_dir_all(&trash);
        });
    }
}

fn store_size(store: &Store) -> u64 {
    let base = store.current_dir();
    store
        .current_files()
        .unwrap_or_default()
        .iter()
        .filter_map(|rel| plain_meta(&base.join(rel)))
        .filter(|md| md.is_file())
        .map(|md| md.len())
        .sum()
}

async fn list_backups(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    UrlPath(drive_id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    // Read what the list needs from the database, then drop the lock before
    // walking the backups' files for their sizes.
    let mut listed: Vec<(Store, Value)> = Vec::new();
    {
        let conn = lock_db(&state)?;
        let (root, layout) = store_home(&conn, &drive_id)?;
        let now = db::now_unix();
        for store in drive_store::list_stores(&root, &layout) {
            let Some(manifest) = store.read_manifest().ok().flatten() else {
                continue;
            };
            // A folder being removed keeps its old manifest under a `.deleting-` name.
            if store.root().file_name().and_then(|n| n.to_str())
                != Some(manifest.protection_id.as_str())
            {
                continue;
            }
            if is_deleted(&conn, &manifest.protection_id)? {
                retire_store(store.root());
                continue;
            }
            if !can_see(&conn, &user, &manifest)? {
                continue;
            }
            // `status` is the backup's lifecycle (active / stopped / source
            // gone), `state` its health, matching GET /api/v1/backups.
            let (status, state, stop_reason) =
                match db::get_protection(&conn, &manifest.protection_id).map_err(db_error)? {
                    Some(row) => (
                        row.state.clone(),
                        state_label(drive_backup::state(&row, now)),
                        row.stop_reason.clone(),
                    ),
                    None if manifest.last_ok_at > 0 && now - manifest.last_ok_at <= ONE_DAY => {
                        (db::PROTECTION_ACTIVE.to_string(), "ok", String::new())
                    }
                    None => (db::PROTECTION_ACTIVE.to_string(), "stale", String::new()),
                };
            let source_name = Path::new(&manifest.source_path)
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&manifest.source_drive_label)
                .to_string();
            let row = json!({
                "id": manifest.protection_id,
                "source_name": source_name,
                "source_drive_name": manifest.source_drive_label,
                "source_path": manifest.source_path,
                "last_ok_at": manifest.last_ok_at,
                "status": status,
                "stop_reason": stop_reason,
                "state": state,
            });
            listed.push((store, row));
        }
    }
    let out = tokio::task::spawn_blocking(move || {
        listed
            .into_iter()
            .map(|(store, mut row)| {
                row["size_bytes"] = json!(store_size(&store));
                row
            })
            .collect::<Vec<Value>>()
    })
    .await
    .map_err(|_| {
        fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't work out how much space these backups use. Try again.",
        )
    })?;
    Ok(Json(Value::Array(out)))
}

/// The newest copy of a deleted file, as (size, mtime) from its versions.
fn last_copy(store: &Store, key: &str) -> Option<(u64, i64)> {
    let mut times = store.version_times().ok()?;
    times.sort_unstable_by(|a, b| b.cmp(a));
    times.into_iter().find_map(|t| {
        let md = plain_meta(&store.versions_dir().join(t.to_string()).join(key))?;
        md.is_file().then(|| (md.len(), mtime_of(&md)))
    })
}

struct Row {
    deleted: bool,
    is_dir: bool,
    lower: String,
    value: Value,
}

async fn list_folder(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    UrlPath((drive_id, id)): UrlPath<(String, String)>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let rel = clean_rel(&q.path)?;
    let (store, manifest) = {
        let conn = lock_db(&state)?;
        find_visible(&conn, &user, &drive_id, &id)?
    };
    let base = store.current_dir();
    let dir = base.join(&rel);
    let is_folder = plain_meta(&dir).is_some_and(|m| m.is_dir());
    // A folder gone from the source has no current copy, but its deleted files still list.
    let deleted_folder = !is_folder && !rel.is_empty() && deleted_under_folder(&manifest, &rel);
    if (!is_folder && !deleted_folder) || (is_folder && inside(&base, &dir).is_none()) {
        return Err(fail(
            StatusCode::NOT_FOUND,
            "Luna couldn't find that folder in this backup.",
        ));
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut names = std::collections::HashSet::new();
    let listing: Vec<io::Result<fs::DirEntry>> = if is_folder {
        fs::read_dir(&dir).map_err(io_error)?.collect()
    } else {
        Vec::new()
    };
    for entry in listing {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(md) = plain_meta(&entry.path()) else {
            continue;
        };
        names.insert(name.clone());
        let is_dir = md.is_dir();
        rows.push(Row {
            deleted: false,
            is_dir,
            lower: name.to_lowercase(),
            value: json!({
                "name": name,
                "is_dir": is_dir,
                "size": if is_dir { 0 } else { md.len() },
                "mtime": mtime_of(&md),
                "deleted": false,
                "deleted_at": null,
            }),
        });
    }

    // Files deleted from the source that sat in this folder. The manifest
    // keeps their times on the backup's own clock (frozen while the source is
    // away, see Manifest::clock); shift them to wall time so "kept until"
    // (deleted_at + 30 days) reads true today.
    let now = db::now_unix();
    let shift = now - manifest.clock(now);
    let prefix = if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    };
    let mut deleted_dirs: BTreeMap<String, i64> = BTreeMap::new();
    for (key, at) in &manifest.deleted {
        let Some(rest) = key.strip_prefix(&prefix) else {
            continue;
        };
        let at = &(at + shift);
        match rest.split_once('/') {
            Some((folder, _)) => {
                if !names.contains(folder) {
                    let slot = deleted_dirs.entry(folder.to_string()).or_insert(*at);
                    *slot = (*slot).max(*at);
                }
            }
            None => {
                if names.contains(rest) {
                    continue;
                }
                let (size, mtime) = match last_copy(&store, key) {
                    Some((s, m)) => (json!(s), json!(m)),
                    None => (Value::Null, Value::Null),
                };
                rows.push(Row {
                    deleted: true,
                    is_dir: false,
                    lower: rest.to_lowercase(),
                    value: json!({
                        "name": rest,
                        "is_dir": false,
                        "size": size,
                        "mtime": mtime,
                        "deleted": true,
                        "deleted_at": at,
                    }),
                });
            }
        }
    }
    for (folder, at) in deleted_dirs {
        rows.push(Row {
            deleted: true,
            is_dir: true,
            lower: folder.to_lowercase(),
            value: json!({
                "name": folder,
                "is_dir": true,
                "size": 0,
                "mtime": null,
                "deleted": true,
                "deleted_at": at,
            }),
        });
    }

    rows.sort_by_key(|r| (r.deleted, !r.is_dir, r.lower.clone()));
    let entries: Vec<Value> = rows.into_iter().map(|r| r.value).collect();
    Ok(Json(Value::Array(entries)))
}

async fn versions(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    UrlPath((drive_id, id)): UrlPath<(String, String)>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let rel = clean_rel(&q.path)?;
    if rel.is_empty() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "Choose a file to see its versions.",
        ));
    }
    let (store, _) = {
        let conn = lock_db(&state)?;
        find_visible(&conn, &user, &drive_id, &id)?
    };
    let mut out: Vec<Value> = Vec::new();
    if let Some(md) = plain_meta(&store.current_dir().join(&rel)).filter(|m| m.is_file()) {
        out.push(json!({ "at": null, "size": md.len(), "mtime": mtime_of(&md) }));
    }
    let mut past = store.version_times().unwrap_or_default();
    past.sort_unstable_by(|a, b| b.cmp(a));
    for at in past {
        let path = store.versions_dir().join(at.to_string()).join(&rel);
        if let Some(md) = plain_meta(&path).filter(|m| m.is_file()) {
            out.push(json!({ "at": at, "size": md.len(), "mtime": mtime_of(&md) }));
        }
    }
    Ok(Json(Value::Array(out)))
}

async fn file_response(path: &Path, name: &str) -> Result<Response, ApiError> {
    let file = tokio::fs::File::open(path).await.map_err(|_| {
        fail(
            StatusCode::NOT_FOUND,
            "Luna couldn't open that file. Check the drive is still connected.",
        )
    })?;
    let len = file.metadata().await.ok().map(|m| m.len());
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime.essence_str())
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                files::content_disposition_filename(name)
            ),
        );
    if let Some(len) = len {
        builder = builder.header(header::CONTENT_LENGTH, len);
    }
    builder
        .body(Body::from_stream(ReaderStream::new(file)))
        .map_err(|_| {
            fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't send that file. Try again.",
            )
        })
}

/// Whether `rel` is a folder with deleted files under it.
fn deleted_under_folder(manifest: &Manifest, rel: &str) -> bool {
    let prefix = format!("{rel}/");
    manifest.deleted.keys().any(|key| key.starts_with(&prefix))
}

/// The newest copy of a deleted file, from the newest version that has it.
fn newest_copy_path(store: &Store, key: &str) -> Option<PathBuf> {
    let mut times = store.version_times().ok()?;
    times.sort_unstable_by(|a, b| b.cmp(a));
    times.into_iter().find_map(|t| {
        let path = store.versions_dir().join(t.to_string()).join(key);
        plain_meta(&path)
            .is_some_and(|m| m.is_file())
            .then_some(path)
    })
}

/// A deleted file or folder's newest copies, as (is folder, [(path inside it, copy)]).
/// A deleted file has one entry with an empty path inside.
fn deleted_copies(
    store: &Store,
    manifest: &Manifest,
    rel: &str,
) -> Option<(bool, Vec<(String, PathBuf)>)> {
    if manifest.deleted.contains_key(rel) {
        let copy = newest_copy_path(store, rel)?;
        return Some((false, vec![(String::new(), copy)]));
    }
    let prefix = format!("{rel}/");
    let entries: Vec<(String, PathBuf)> = manifest
        .deleted
        .keys()
        .filter_map(|key| {
            let inner = key.strip_prefix(&prefix)?;
            Some((inner.to_string(), newest_copy_path(store, key)?))
        })
        .collect();
    (!entries.is_empty()).then_some((true, entries))
}

/// Files under `rel` in the current copy, as (path inside the zip, file).
fn folder_entries(store: &Store, rel: &str) -> Result<Vec<(String, PathBuf)>, ApiError> {
    let base = store.current_dir();
    let prefix = if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    };
    let mut out = Vec::new();
    for file in store.current_files().map_err(io_error)? {
        let Some(inner) = file.strip_prefix(&prefix) else {
            continue;
        };
        let abs = base.join(&file);
        if plain_meta(&abs).is_some_and(|m| m.is_file()) {
            out.push((inner.to_string(), abs));
        }
    }
    Ok(out)
}

async fn download(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    UrlPath((drive_id, id)): UrlPath<(String, String)>,
    Query(q): Query<DownloadQuery>,
) -> Result<Response, ApiError> {
    let rel = clean_rel(&q.path)?;
    let at = parse_at(q.at.as_deref())?;
    let (store, manifest) = {
        let conn = lock_db(&state)?;
        find_visible(&conn, &user, &drive_id, &id)?
    };
    let not_found = || {
        fail(
            StatusCode::NOT_FOUND,
            "Luna couldn't find that in this backup.",
        )
    };

    if let Some(at) = at {
        if rel.is_empty() {
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "Choose a file to download a version of.",
            ));
        }
        let base = store.versions_dir().join(at.to_string());
        let path = base.join(&rel);
        let ok = plain_meta(&path).is_some_and(|m| m.is_file()) && inside(&base, &path).is_some();
        if !ok {
            return Err(fail(
                StatusCode::NOT_FOUND,
                "Luna couldn't find that version of this file.",
            ));
        }
        return file_response(&path, file_name(&rel)).await;
    }

    let base = store.current_dir();
    let path = base.join(&rel);
    let Some(md) = plain_meta(&path) else {
        // Not in the current copy: a deleted file or folder, from its newest copy.
        return match deleted_copies(&store, &manifest, &rel) {
            Some((false, entries)) => match entries.first() {
                Some((_, copy)) => file_response(copy, file_name(&rel)).await,
                None => Err(not_found()),
            },
            Some((true, entries)) => zip_response(&rel, entries).await,
            None => Err(not_found()),
        };
    };
    if inside(&base, &path).is_none() {
        return Err(not_found());
    }
    if md.is_file() {
        return file_response(&path, file_name(&rel)).await;
    }

    // A folder downloads as one zip, with the folder's name on the top level.
    zip_response(&rel, folder_entries(&store, &rel)?).await
}

/// Streams `entries` (path inside the folder, file) as one zip named after `rel`.
async fn zip_response(rel: &str, entries: Vec<(String, PathBuf)>) -> Result<Response, ApiError> {
    let root = files::zip_archive_basename(rel);
    let entries: Vec<(String, PathBuf)> = entries
        .into_iter()
        .map(|(inner, abs)| (format!("{root}/{inner}"), abs))
        .collect();
    let zip_fail = "Luna couldn't prepare that download. Try again.";
    stream_zip_response(&format!("{root}.zip"), move |tmp: &Path| {
        let out =
            fs::File::create(tmp).map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, zip_fail))?;
        gallery::write_items_zip(&entries, out, files::ZIP_MAX_FILES)
            .map(|_| ())
            .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, zip_fail))
    })
    .await
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Short English date for a Unix time, in UTC, such as "16 Oct".
fn short_date(now: i64) -> String {
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = now.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{day} {}", MONTHS[(month - 1) as usize])
}

/// Splits `name` into (stem, extension with its dot). Folders keep the whole name.
fn split_ext(name: &str, is_dir: bool) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if !is_dir && i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// A name in `dir` that nothing occupies, not even a hidden private item.
/// Tries `name`, then `stem (restored <day>)ext`, then `... <day> 2`, and so on.
fn restore_name(dir: &Path, name: &str, is_dir: bool, now: i64) -> Option<String> {
    let free = |candidate: &str| {
        let path = dir.join(candidate);
        fs::symlink_metadata(&path).is_err() && !crate::private::sibling_clash(&path)
    };
    if free(name) {
        return Some(name.to_string());
    }
    let (stem, ext) = split_ext(name, is_dir);
    let day = short_date(now);
    (1..=MAX_RESTORE_NAMES)
        .map(|n| {
            if n == 1 {
                format!("{stem} (restored {day}){ext}")
            } else {
                format!("{stem} (restored {day} {n}){ext}")
            }
        })
        .find(|candidate| free(candidate))
}

/// Copies deleted copies back out: each lands at its path inside `dest`.
fn copy_entries(entries: &[(String, PathBuf)], dest: &Path) -> io::Result<()> {
    for (inner, copy) in entries {
        let to = if inner.is_empty() {
            dest.to_path_buf()
        } else {
            dest.join(inner)
        };
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_tree(copy, &to)?;
    }
    Ok(())
}

/// Copies a file or folder tree to `dest`, which must not exist. Links are skipped.
fn copy_tree(src: &Path, dest: &Path) -> io::Result<()> {
    let md = fs::symlink_metadata(src)?;
    if md.is_dir() {
        fs::create_dir(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let child = entry.path();
            if fs::symlink_metadata(&child)?.file_type().is_symlink() {
                continue;
            }
            copy_tree(&child, &dest.join(entry.file_name()))?;
        }
    } else if md.is_file() {
        let mut from = fs::File::open(src)?;
        let mut to = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)?;
        io::copy(&mut from, &mut to)?;
    }
    Ok(())
}

fn missing_folder(label: &str) -> ApiError {
    fail(
        StatusCode::CONFLICT,
        format!("The original folder is missing on {label}. Put it back, then try again."),
    )
}

/// Recreate a private item the owner's backup is restoring into, when the item
/// itself has gone missing: a new row under the same path, then its folder.
fn recreate_private_item(mount: &Path, item_path: &str, owner: &str) -> Result<(), ApiError> {
    let failed = || {
        fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't recreate the private item. Try again.",
        )
    };
    if plain_meta(&mount.join(item_path)).is_some() {
        return Err(fail(
            StatusCode::CONFLICT,
            "Something else now has this private item's name. Rename it, then try again.",
        ));
    }
    private::create(mount, item_path, owner).map_err(|_| failed())?;
    let disk = mount.join(private::disk_rel(mount, item_path));
    if let Err(err) = fs::create_dir(&disk) {
        let _ = private::remove(mount, item_path);
        return Err(if err.kind() == io::ErrorKind::AlreadyExists {
            fail(
                StatusCode::CONFLICT,
                "Something else now has this private item's name. Rename it, then try again.",
            )
        } else {
            failed()
        });
    }
    Ok(())
}

async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    UrlPath((drive_id, id)): UrlPath<(String, String)>,
    Json(body): Json<RestoreBody>,
) -> Result<Json<Value>, ApiError> {
    let rel = clean_rel(&body.path)?;
    if rel.is_empty() {
        return Err(fail(
            StatusCode::BAD_REQUEST,
            "Choose a file or folder to restore.",
        ));
    }
    let at_text = match body.at {
        None => None,
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(_) => return Err(invalid_version()),
    };
    let at = parse_at(at_text.as_deref())?;

    // Everything that needs the database happens here, then the lock is dropped
    // before the copy starts.
    let (src, copies, dest, final_name, parent_rel, slot) = {
        let conn = lock_db(&state)?;
        let (store, manifest) = find_visible(&conn, &user, &drive_id, &id)?;
        // Held until the copy below finishes, so no backup run can write into
        // the files being restored.
        let Some(slot) = drive_backup::try_hold(&id) else {
            return Err(fail(
                StatusCode::CONFLICT,
                "This backup is copying right now. Try again in a minute.",
            ));
        };

        let base = match at {
            Some(t) => store.versions_dir().join(t.to_string()),
            None => store.current_dir(),
        };
        let src = base.join(&rel);
        let not_found = || {
            fail(
                StatusCode::NOT_FOUND,
                "Luna couldn't find that in this backup.",
            )
        };
        let on_disk = match plain_meta(&src) {
            Some(md) if inside(&base, &src).is_some() && (at.is_none() || md.is_file()) => Some(md),
            Some(_) => return Err(not_found()),
            None => None,
        };
        // Not in the current copy: a deleted file or folder, from its newest copies.
        let (is_dir, copies) = match (&on_disk, at) {
            (Some(md), _) => (md.is_dir(), None),
            (None, None) => {
                let (is_dir, copies) =
                    deleted_copies(&store, &manifest, &rel).ok_or_else(not_found)?;
                (is_dir, Some(copies))
            }
            (None, Some(_)) => return Err(not_found()),
        };
        let name = file_name(&rel).to_string();

        // The protections row knows where the backup's files come from now (it
        // follows a moved source); the manifest is only the fallback.
        let row = db::get_protection(&conn, &id).map_err(db_error)?;
        let (source_id, source_path) = match &row {
            Some(row) => (row.source_drive.clone(), row.source_path.clone()),
            None => (
                manifest.source_drive_id.clone(),
                manifest.source_path.clone(),
            ),
        };
        let label = match db::get_drive(&conn, &source_id).ok().flatten() {
            Some(drive) if !drive.label.is_empty() => drive.label,
            _ if source_id == manifest.source_drive_id
                && !manifest.source_drive_label.is_empty() =>
            {
                manifest.source_drive_label.clone()
            }
            _ => "the original drive".to_string(),
        };
        let source = files::drive_root(&conn, &source_id)
            .ok()
            .filter(|d| Layout::detect(Path::new(&d.mount_point)).is_some())
            .ok_or_else(|| {
                fail(
                    StatusCode::CONFLICT,
                    format!("Connect {label} to restore to the original folder."),
                )
            })?;

        let source_sub = clean_rel(&access::normalize_subject_path(&source_path))?;
        let parent_rel = rel
            .rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default();
        let mount = PathBuf::from(&source.mount_point);
        // A private item's backup is restored only by its owner, into the
        // private item itself. Nobody else gets in, admins included.
        let owner = match &row {
            Some(row) => row.private_owner.clone(),
            None => manifest.private_owner.clone().unwrap_or_default(),
        };
        let dest_dir = if owner.is_empty() {
            let parent_sub = access::normalize_subject_path(&join_rel(&source_sub, &parent_rel));
            if !auth::has_cap(&user, &conn, &source_id, &parent_sub, CAP_EDIT) {
                return Err(fail(
                    StatusCode::FORBIDDEN,
                    "You need Write access to that folder to restore into it.",
                ));
            }
            let dest_dir = mount.join(&source_sub).join(&parent_rel);
            if !plain_meta(&dest_dir).is_some_and(|m| m.is_dir()) {
                return Err(missing_folder(&label));
            }
            dest_dir
        } else {
            if user.id() != owner {
                return Err(fail(
                    StatusCode::FORBIDDEN,
                    "Only the owner of this private item can restore it.",
                ));
            }
            if private::item_at(&mount, &source_sub).is_none() {
                // The item's folder is recreated only inside a folder that still
                // exists, the same rule as a plain restore.
                if let Some((parent, _)) = source_sub.rsplit_once('/') {
                    let parent_disk = mount.join(private::disk_rel(&mount, parent));
                    if !plain_meta(&parent_disk).is_some_and(|m| m.is_dir()) {
                        return Err(missing_folder(&label));
                    }
                }
                recreate_private_item(&mount, &source_sub, &owner)?;
            }
            let dest_dir = mount.join(private::disk_rel(
                &mount,
                &join_rel(&source_sub, &parent_rel),
            ));
            if !plain_meta(&dest_dir).is_some_and(|m| m.is_dir()) {
                return Err(missing_folder(&label));
            }
            dest_dir
        };
        // A link anywhere along the way (a drive that came from another computer can
        // carry them) must not lead the copy out of this drive.
        if inside(&mount, &dest_dir).is_none() {
            return Err(fail(
                StatusCode::CONFLICT,
                format!("The original folder on {label} isn't a regular folder, so Luna won't restore into it."),
            ));
        }
        let final_name =
            restore_name(&dest_dir, &name, is_dir, db::now_unix()).ok_or_else(|| {
                fail(
                    StatusCode::CONFLICT,
                    "Luna couldn't find a free name for that copy.",
                )
            })?;
        (
            src,
            copies,
            dest_dir.join(&final_name),
            final_name,
            parent_rel,
            slot,
        )
    };

    // The slot moves into the blocking task, so it is held until the copy
    // ends even if this request is dropped (client disconnects).
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        match copies {
            Some(entries) => copy_entries(&entries, &dest),
            None => copy_tree(&src, &dest),
        }
    })
        .await
        .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "Luna couldn't finish the restore. Try again."))?
        .map_err(|_| {
            fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish restoring that. Some files may be partly copied to the original folder.",
            )
        })?;
    Ok(Json(json!({
        "name": final_name,
        "path": join_rel(&parent_rel, &final_name),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use luna_core::marker::{Marker, pick_prefix};
    use tower::ServiceExt;

    use crate::backup::access_list::AccessList;
    use crate::backup::drive_store::MANIFEST_FORMAT;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;

    struct Fixture {
        _dir: tempfile::TempDir,
        router: Router,
        admin_token: String,
        member_token: String,
        member_id: String,
        src_root: PathBuf,
        tgt_root: PathBuf,
        state: AppState,
    }

    fn new_drive(dir: &Path, conn: &rusqlite::Connection, id: &str, label: &str) -> PathBuf {
        let root = dir.join(id);
        fs::create_dir_all(&root).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(&root, &Marker::new(id.to_string(), label), &prefix)
                .unwrap(),
        );
        db::upsert_drive(conn, id, label, "as_is", "ext4", id, root.to_str().unwrap()).unwrap();
        root
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let src_root = new_drive(dir.path(), &conn, "drive-src", "Photos");
        let tgt_root = new_drive(dir.path(), &conn, "drive-tgt", "Backup");
        fs::create_dir_all(src_root.join("Docs")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Fixture {
            _dir: dir,
            admin_token: auth.issue(&admin).unwrap(),
            member_token: auth.issue(&member).unwrap(),
            member_id: member.id.clone(),
            router,
            src_root,
            tgt_root,
            state,
        }
    }

    fn make_store(f: &Fixture, id: &str, source_drive: &str, access: AccessList) -> Store {
        let layout = Layout::detect(&f.tgt_root).unwrap();
        let store = Store::open(&f.tgt_root, &layout, id).unwrap();
        let manifest = Manifest {
            format: MANIFEST_FORMAT,
            protection_id: id.into(),
            luna_id: None,
            source_drive_id: source_drive.into(),
            source_drive_label: "Photos".into(),
            source_path: "Docs".into(),
            private_owner: None,
            created_by: "admin".into(),
            created_at: 1,
            access,
            last_ok_at: db::now_unix(),
            deleted: BTreeMap::new(),
            paused_secs: 0,
            paused_since: 0,
        };
        store.write_manifest(&manifest).unwrap();
        store
    }

    async fn send(
        f: &Fixture,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Vec<u8>) {
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let resp = f
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, bytes.to_vec())
    }

    async fn get_json(f: &Fixture, token: &str, uri: &str) -> (StatusCode, Value) {
        let (status, bytes) = send(f, "GET", uri, token, None).await;
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[test]
    fn short_date_is_english_day_and_month() {
        assert_eq!(short_date(1_792_152_000), "16 Oct");
        assert_eq!(short_date(0), "1 Jan");
    }

    #[test]
    fn clean_rel_rejects_escapes() {
        assert!(clean_rel("..").is_err());
        assert!(clean_rel("a/../b").is_err());
        assert!(clean_rel("/etc").is_err());
        assert_eq!(clean_rel("a//./b/").unwrap(), "a/b");
    }

    #[tokio::test]
    async fn list_shows_only_stores_the_user_can_see() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        make_store(&f, "p-list-shared", "drive-src", shared);
        make_store(
            &f,
            "p-admin",
            "drive-src",
            AccessList {
                users: vec![],
                admins: true,
            },
        );
        make_store(
            &f,
            "p-private",
            "drive-src",
            AccessList {
                users: vec![],
                admins: false,
            },
        );
        let ids = |v: &Value| {
            let mut ids: Vec<String> = v
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].as_str().unwrap().to_string())
                .collect();
            ids.sort();
            ids
        };
        let (status, member) =
            get_json(&f, &f.member_token, "/api/v1/drives/drive-tgt/backups").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ids(&member), vec!["p-list-shared"]);
        let (_, admin) = get_json(&f, &f.admin_token, "/api/v1/drives/drive-tgt/backups").await;
        assert_eq!(ids(&admin), vec!["p-admin", "p-list-shared"]);
    }

    #[tokio::test]
    async fn list_includes_stop_reason() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        make_store(&f, "p-reason", "drive-src", shared);
        let (status, body) = get_json(&f, &f.admin_token, "/api/v1/drives/drive-tgt/backups").await;
        assert_eq!(status, StatusCode::OK);
        let row = body
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "p-reason")
            .expect("backup listed");
        assert!(row["stop_reason"].is_string());
    }

    #[tokio::test]
    async fn browse_lists_current_files_and_deleted_ones() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-browse-shared", "drive-src", shared);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        fs::create_dir_all(store.current_dir().join("sub")).unwrap();
        let mut manifest = store.read_manifest().unwrap().unwrap();
        manifest.deleted.insert("gone.txt".into(), 500);
        store.write_manifest(&manifest).unwrap();

        let (status, body) = get_json(
            &f,
            &f.admin_token,
            "/api/v1/drives/drive-tgt/backups/p-browse-shared/list?path=",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let entries = body.as_array().unwrap();
        let find = |name: &str| entries.iter().find(|e| e["name"] == name).unwrap().clone();
        assert_eq!(find("a.txt")["deleted"], false);
        assert_eq!(find("a.txt")["size"], 5);
        assert_eq!(find("sub")["is_dir"], true);
        assert_eq!(find("gone.txt")["deleted"], true);
        assert_eq!(find("gone.txt")["deleted_at"], 500);
    }

    #[tokio::test]
    async fn versions_newest_first_and_download_a_version() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-versions-shared", "drive-src", shared);
        fs::write(store.current_dir().join("a.txt"), "v3").unwrap();
        for (at, body) in [(100, "v1"), (200, "v2")] {
            let dir = store.versions_dir().join(at.to_string());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("a.txt"), body).unwrap();
        }

        let (status, body) = get_json(
            &f,
            &f.member_token,
            "/api/v1/drives/drive-tgt/backups/p-versions-shared/versions?path=a.txt",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let ats: Vec<Value> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["at"].clone())
            .collect();
        assert_eq!(ats, vec![json!(null), json!(200), json!(100)]);

        let (status, bytes) = send(
            &f,
            "GET",
            "/api/v1/drives/drive-tgt/backups/p-versions-shared/download?path=a.txt&at=100",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"v1");
    }

    #[tokio::test]
    async fn bad_paths_are_rejected() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        make_store(&f, "p-bad-paths-shared", "drive-src", shared);
        for uri in [
            "/api/v1/drives/drive-tgt/backups/p-bad-paths-shared/list?path=..",
            "/api/v1/drives/drive-tgt/backups/p-bad-paths-shared/list?path=/etc",
            "/api/v1/drives/drive-tgt/backups/p-bad-paths-shared/download?path=..%2Fsecret",
            "/api/v1/drives/drive-tgt/backups/p-bad-paths-shared/download?path=a.txt&at=../1",
        ] {
            let (status, _) = send(&f, "GET", uri, &f.admin_token, None).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    fn make_private_store(f: &Fixture, id: &str, owner: &str, access: AccessList) -> Store {
        let store = make_store(f, id, "drive-src", access);
        let mut manifest = store.read_manifest().unwrap().unwrap();
        manifest.private_owner = Some(owner.into());
        store.write_manifest(&manifest).unwrap();
        store
    }

    #[tokio::test]
    async fn owner_restores_into_the_private_item() {
        let f = fixture();
        let access = AccessList {
            users: vec![f.member_id.clone()],
            admins: false,
        };
        let store = make_private_store(&f, "p-priv-owner-restores-into-the-private-item", &f.member_id, access);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        private::privatize(&f.src_root, "Docs", &f.member_id).unwrap();

        let (status, _) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-owner-restores-into-the-private-item/restore",
            &f.member_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let disk = f.src_root.join(private::disk_rel(&f.src_root, "Docs"));
        assert_eq!(fs::read_to_string(disk.join("a.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn a_shared_person_cannot_restore_a_private_item() {
        let f = fixture();
        let access = AccessList {
            users: vec![f.member_id.clone()],
            admins: false,
        };
        let store = make_private_store(&f, "p-priv-a-shared-person-cannot-restore-a-private", "someone-else", access);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        private::privatize(&f.src_root, "Docs", "someone-else").unwrap();

        let (status, bytes) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-a-shared-person-cannot-restore-a-private/restore",
            &f.member_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            "Only the owner of this private item can restore it."
        );
        let disk = f.src_root.join(private::disk_rel(&f.src_root, "Docs"));
        assert!(!disk.join("a.txt").exists());
    }

    #[tokio::test]
    async fn admin_cannot_restore_a_private_item() {
        let f = fixture();
        let access = AccessList {
            users: vec![],
            admins: true,
        };
        let store = make_private_store(&f, "p-priv-admin-cannot-restore-a-private-item", &f.member_id, access);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        private::privatize(&f.src_root, "Docs", &f.member_id).unwrap();

        let (status, _) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-admin-cannot-restore-a-private-item/restore",
            &f.admin_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let disk = f.src_root.join(private::disk_rel(&f.src_root, "Docs"));
        assert!(!disk.join("a.txt").exists());
    }

    #[tokio::test]
    async fn gone_private_item_is_recreated_as_private() {
        let f = fixture();
        let access = AccessList {
            users: vec![f.member_id.clone()],
            admins: false,
        };
        let store = make_private_store(&f, "p-priv-gone-private-item-is-recreated-as-privat", &f.member_id, access);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        fs::remove_dir_all(f.src_root.join("Docs")).unwrap();

        let (status, _) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-gone-private-item-is-recreated-as-privat/restore",
            &f.member_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let item = private::item_at(&f.src_root, "Docs").expect("item recreated");
        assert_eq!(item.owner, f.member_id);
        let disk = f.src_root.join(private::disk_rel(&f.src_root, "Docs"));
        assert_eq!(fs::read_to_string(disk.join("a.txt")).unwrap(), "hello");
        assert!(!f.src_root.join("Docs").exists());
    }

    #[tokio::test]
    async fn gone_private_item_under_a_missing_folder_is_409() {
        let f = fixture();
        let access = AccessList {
            users: vec![f.member_id.clone()],
            admins: false,
        };
        let store = make_private_store(&f, "p-priv-gone-private-item-under-a-missing-folder", &f.member_id, access);
        set_manifest(&store, |m| m.source_path = "Work/Docs".into());
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        // Neither the private item nor its parent folder "Work" exists.

        let (status, bytes) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-gone-private-item-under-a-missing-folder/restore",
            &f.member_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            "The original folder is missing on Photos. Put it back, then try again."
        );
        assert!(private::item_at(&f.src_root, "Work/Docs").is_none());
        assert!(!f.src_root.join("Work").exists());
    }

    #[tokio::test]
    async fn gone_private_item_is_recreated_under_its_parent_folder() {
        let f = fixture();
        let access = AccessList {
            users: vec![f.member_id.clone()],
            admins: false,
        };
        let store = make_private_store(&f, "p-priv-gone-private-item-is-recreated-under-its", &f.member_id, access);
        set_manifest(&store, |m| m.source_path = "Work/Docs".into());
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        fs::create_dir(f.src_root.join("Work")).unwrap();

        let (status, _) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-priv-gone-private-item-is-recreated-under-its/restore",
            &f.member_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let item = private::item_at(&f.src_root, "Work/Docs").expect("item recreated");
        assert_eq!(item.owner, f.member_id);
        let disk = f.src_root.join(private::disk_rel(&f.src_root, "Work/Docs"));
        assert_eq!(fs::read_to_string(disk.join("a.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn restore_picks_a_free_name_on_a_clash() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-restore-clash-shared", "drive-src", shared);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        fs::write(f.src_root.join("Docs/a.txt"), "live").unwrap();

        let day = short_date(db::now_unix());
        let uri = "/api/v1/drives/drive-tgt/backups/p-restore-clash-shared/restore";
        let (status, bytes) = send(
            &f,
            "POST",
            uri,
            &f.admin_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let expected = format!("a (restored {day}).txt");
        assert_eq!(body["name"], expected);
        assert_eq!(
            fs::read_to_string(f.src_root.join("Docs/a.txt")).unwrap(),
            "live"
        );
        assert_eq!(
            fs::read_to_string(f.src_root.join("Docs").join(&expected)).unwrap(),
            "hello"
        );

        let (status, bytes) = send(
            &f,
            "POST",
            uri,
            &f.admin_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["name"], format!("a (restored {day} 2).txt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_refuses_a_destination_behind_a_link() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-link", "drive-src", shared);
        fs::create_dir_all(store.current_dir().join("Sub/Deep")).unwrap();
        fs::write(store.current_dir().join("Sub/Deep/a.txt"), "hello").unwrap();
        // "Sub" on the live drive is a link that leads outside the drive.
        let outside = f._dir.path().join("outside");
        fs::create_dir_all(outside.join("Deep")).unwrap();
        std::os::unix::fs::symlink(&outside, f.src_root.join("Docs/Sub")).unwrap();

        let (status, _) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-link/restore",
            &f.admin_token,
            Some(json!({ "path": "Sub/Deep/a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(fs::read_dir(outside.join("Deep")).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn restore_is_409_when_the_source_drive_is_gone() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-gone-drive", "drive-missing", shared);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();

        let (status, bytes) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-gone-drive/restore",
            &f.admin_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            "Connect Photos to restore to the original folder."
        );
    }

    #[tokio::test]
    async fn restore_is_409_while_the_backup_is_copying() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-held", "drive-src", shared);
        fs::write(store.current_dir().join("a.txt"), "hello").unwrap();
        let _held = drive_backup::try_hold("p-held").expect("slot free");

        let (status, bytes) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-held/restore",
            &f.admin_token,
            Some(json!({ "path": "a.txt" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["error"],
            "This backup is copying right now. Try again in a minute."
        );
    }

    fn tombstone(f: &Fixture, id: &str) {
        let conn = lock_db(&f.state).expect("database lock");
        db::set_meta(&conn, &format!("deleted_backup:{id}"), "1").unwrap();
    }

    fn set_manifest(store: &Store, edit: impl FnOnce(&mut Manifest)) {
        let mut manifest = store.read_manifest().unwrap().unwrap();
        edit(&mut manifest);
        store.write_manifest(&manifest).unwrap();
    }

    #[tokio::test]
    async fn tombstoned_backup_is_hidden_and_removed() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-tombstoned", "drive-src", shared);
        let root = store.root().to_path_buf();
        tombstone(&f, "p-tombstoned");

        let (status, body) =
            get_json(&f, &f.member_token, "/api/v1/drives/drive-tgt/backups").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.as_array().unwrap().is_empty());
        assert!(!root.exists());

        let (status, _) = get_json(
            &f,
            &f.member_token,
            "/api/v1/drives/drive-tgt/backups/p-tombstoned/list?path=",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn deleted_folder_lists_and_downloads_its_newest_copies() {
        let f = fixture();
        let shared = AccessList {
            users: vec![f.member_id.clone()],
            admins: true,
        };
        let store = make_store(&f, "p-del", "drive-src", shared);
        set_manifest(&store, |m| {
            m.deleted.insert("Old/a.txt".into(), 150);
        });
        for (at, body) in [(100, "old"), (120, "older")] {
            let dir = store.versions_dir().join(at.to_string()).join("Old");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("a.txt"), body).unwrap();
        }

        let (status, body) = get_json(
            &f,
            &f.member_token,
            "/api/v1/drives/drive-tgt/backups/p-del/list?path=Old",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let names: Vec<(Value, Value)> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["name"].clone(), v["deleted"].clone()))
            .collect();
        assert_eq!(names, vec![(json!("a.txt"), json!(true))]);

        let (status, bytes) = send(
            &f,
            "GET",
            "/api/v1/drives/drive-tgt/backups/p-del/download?path=Old/a.txt",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"older");
    }

    #[tokio::test]
    async fn restore_of_deleted_file_uses_the_row_location() {
        let f = fixture();
        let store = make_store(
            &f,
            "p-restore",
            "drive-src",
            AccessList {
                users: vec![],
                admins: true,
            },
        );
        // The manifest says the files came from "Elsewhere"; the row says "Docs".
        set_manifest(&store, |m| {
            m.source_path = "Elsewhere".into();
            m.deleted.insert("Old/a.txt".into(), 150);
        });
        {
            let conn = lock_db(&f.state).expect("database lock");
            db::insert_protection(
                &conn,
                &db::NewProtection {
                    id: "p-restore",
                    kind: db::PROTECTION_DRIVE,
                    source_drive: "drive-src",
                    source_path: "Docs",
                    target_drive: "drive-tgt",
                    private_owner: "",
                    created_by: "admin",
                    created_at: 1,
                },
            )
            .unwrap();
            let admin_only = serde_json::to_string(&AccessList {
                users: vec![],
                admins: true,
            })
            .unwrap();
            db::set_protection_access(&conn, "p-restore", &admin_only).unwrap();
        }
        let dir = store.versions_dir().join("100").join("Old");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "old").unwrap();
        fs::create_dir_all(f.src_root.join("Docs").join("Old")).unwrap();

        let (status, bytes) = send(
            &f,
            "POST",
            "/api/v1/drives/drive-tgt/backups/p-restore/restore",
            &f.admin_token,
            Some(json!({ "path": "Old/a.txt" })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(
            fs::read_to_string(f.src_root.join("Docs").join("Old").join("a.txt")).unwrap(),
            "old"
        );
    }
}
