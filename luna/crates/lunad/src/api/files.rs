use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Extension, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::api::response::{json_error, json_error_code};
use crate::files::{self, FileEntry, FilesError};

// A destination folder path never needs to come close to this.
const MAX_PATH_FIELD_BYTES: usize = 4 * 1024;

/// Reads a multipart text field with a hard cap so an oversized field cannot
/// exhaust memory before validation. A mid-stream read error, truncation, or
/// invalid UTF-8 fails the whole field rather than accepting a partial destination.
async fn read_bounded_text(
    field: &mut axum::extract::multipart::Field<'_>,
    max: usize,
) -> Result<String, (StatusCode, Json<Value>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(128);
    while let Some(chunk) = field.chunk().await.map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't read the upload destination.",
        )
    })? {
        if buf.len() + chunk.len() > max {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That upload destination is too long.",
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That upload destination is not valid text.",
        )
    })
}

#[derive(Deserialize)]
struct ListQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
struct ContentQuery {
    path: Option<String>,
    download: Option<String>,
}

#[derive(Deserialize)]
struct UploadQuery {
    path: Option<String>,
    overwrite: Option<String>,
    /// Diagram saves name the last live edit in the file, same as EuroOffice
    /// `?coverage=` on an Editor.bin PUT. Absent for every other upload.
    coverage: Option<String>,
}

#[derive(Deserialize)]
struct MkdirBody {
    /// Relative path of the new folder (parent must already exist).
    path: String,
    /// Make the folder private to the person creating it.
    #[serde(default)]
    private: bool,
}

#[derive(Deserialize)]
struct CreateBody {
    /// Relative path of the new empty file (parent must already exist).
    path: String,
    /// Rejected: files are never private items — only folders are. A file
    /// inside a private folder is protected by the folder's boundary.
    #[serde(default)]
    private: bool,
}

#[derive(Deserialize)]
struct PrivacyBody {
    /// The folder whose boundary changes.
    path: String,
    /// `true` makes it private to the caller; `false` uses parent access.
    private: bool,
}

#[derive(Deserialize)]
struct RenameBody {
    path: String,
    new_name: String,
}

#[derive(Deserialize)]
struct RestoreBody {
    path: String,
    dest: String,
    #[serde(default)]
    confirm_broaden: bool,
}

#[derive(Deserialize)]
struct PurgeBody {
    path: String,
}

pub fn router() -> Router<AppState> {
    // Multipart is streamed to disk, but the body limit still bounds DoS.
    // Sized from MemAvailable; floor matches the web client's 32 MiB switchover.
    let multipart_max = crate::budget::limits().multipart_upload_bytes;
    Router::new()
        .route("/api/v1/drives/{id}/files", get(list).delete(delete_entry))
        .route("/api/v1/drives/{id}/files/stat", get(stat_entry))
        .route("/api/v1/drives/{id}/files/resolve", get(resolve_entry))
        .route("/api/v1/drives/{id}/files/mkdir", post(mkdir_entry))
        .route("/api/v1/drives/{id}/files/privacy", post(set_privacy))
        .route("/api/v1/drives/{id}/files/create", post(create_entry))
        .route("/api/v1/drives/{id}/files/rename", post(rename_entry))
        .route("/api/v1/drives/{id}/files/restore", post(restore_entry))
        .route("/api/v1/drives/{id}/files/purge", post(purge_entry))
        .route(
            "/api/v1/me/recents",
            get(get_recents).post(record_recent).delete(delete_recent),
        )
        .route("/api/v1/drives/{id}/trash", get(list_trash))
        .route("/api/v1/drives/{id}/files/content", get(content))
        .route(
            "/api/v1/drives/{id}/files/upload",
            post(upload).layer(DefaultBodyLimit::max(multipart_max)),
        )
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    let rel = rel.trim().trim_matches('/').to_string();
    if rel == files::TRASH_API_ALIAS || rel.starts_with(&format!("{}/", files::TRASH_API_ALIAS)) {
        return list_trash_view(&state, &user, &id, &rel);
    }
    check_inspect(&state, &user, &id, &rel)?;
    // Guest file-link parity: listing a file the member may read yields a
    // one-entry listing, so a deep link to a granted file (`?path=<file>`)
    // resolves instead of failing with "not a folder".
    if !rel.is_empty()
        && let Some(entry) = file_list_entry(&state, &user, &id, &rel)?
    {
        return Ok(Json(vec![entry]));
    }
    Ok(Json(visible_entries(&state, &user, &id, &rel)?))
}

/// `list?path=<file>` on a file: a one-entry listing like the public share
/// page returns for file links. `None` when `rel` is a directory (or does
/// not exist — the error propagates as the usual 404). The file itself still
/// needs real read rights: an upload-only member's exact grant row resolves
/// folders as a landing, but a file listing is disclosure.
fn file_list_entry(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    id: &str,
    rel: &str,
) -> Result<Option<FileEntry>, (StatusCode, Json<Value>)> {
    // Read-your-writes: an upload still in RAM may not be on the drive yet.
    if let Some(dirty) = state.ram_cache.get_dirty(id, rel) {
        check_access(state, user, id, rel, crate::access::CAP_VIEW)?;
        return Ok(Some(FileEntry {
            hidden: dirty.name.starts_with('.'),
            name: dirty.name,
            kind: "file".into(),
            size: dirty.bytes.len() as u64,
            modified: dirty.modified,
            saving: true,
            save_failed: false,
            original_name: None,
            original_path: None,
            link_target: None,
            caps: stamped_caps(state, user, id, rel),
            private: false,
            in_private: false,
        }));
    }
    let stat = with_db(state, |conn| files::stat(conn, id, rel)).map_err(map_files_err)?;
    if stat.kind == "dir" {
        return Ok(None);
    }
    check_access(state, user, id, rel, crate::access::CAP_VIEW)?;
    Ok(Some(FileEntry {
        hidden: stat.hidden,
        name: stat.name,
        kind: stat.kind,
        size: stat.size,
        modified: stat.modified,
        saving: false,
        save_failed: false,
        original_name: None,
        original_path: None,
        link_target: stat.link_target,
        caps: stamped_caps(state, user, id, rel),
        private: stat.private,
        in_private: stat.in_private,
    }))
}

/// The user's own capability string on a path — stamped onto entries and
/// stats so the UI renders affordances off the server's answer, never its
/// own permission math.
fn stamped_caps(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    rel: &str,
) -> String {
    with_db(state, |conn| {
        Ok(crate::access::caps_to_str(crate::auth::caps_on_path(
            user, conn, drive_id, rel,
        )))
    })
    .unwrap_or_default()
}

/// `GET files?path=.luna-trash…` — trash browses like a regular folder.
/// The root needs a write grant somewhere on the drive (same as the trash
/// endpoint); deeper paths need edit rights on the item's original
/// location. Entries are annotated with `original_name`/`original_path`
/// and, for non-admins, filtered to origins they could have edited.
fn list_trash_view(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    id: &str,
    rel: &str,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<Value>)> {
    if rel == files::TRASH_API_ALIAS {
        check_trash_list(state, user, id)?;
    } else {
        check_trash_item(state, user, id, rel)?;
    }
    let mut entries =
        with_db(state, |conn| files::list_trash_dir(conn, id, rel)).map_err(map_files_err)?;

    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let root = files::drive_root(&conn, id)
        .map(|d| std::path::PathBuf::from(d.mount_point))
        .unwrap_or_default();
    let meta = files::trash_meta_map(&root);
    let top_level = rel == files::TRASH_API_ALIAS;
    // Path under the trash root this listing represents ("" at the root).
    let under_root = rel
        .strip_prefix(&format!("{}/", files::TRASH_API_ALIAS))
        .unwrap_or("");

    entries.retain_mut(|entry| {
        // The child's trash-root-relative path: `{entry}` at the top,
        // `{entry}/sub/...` deeper. trash_meta is keyed on `{entry}`; the
        // rest inherits the entry's original path.
        let child = if under_root.is_empty() {
            entry.name.clone()
        } else {
            format!("{under_root}/{}", entry.name)
        };
        let (entry_name, rest) = match child.split_once('/') {
            Some((e, r)) => (e, Some(r)),
            None => (child.as_str(), None),
        };
        let entry_meta = meta.get(entry_name);
        let original = entry_meta.map(|m| match rest {
            Some(rest) => format!("{}/{rest}", m.original_path),
            None => m.original_path.clone(),
        });
        // Everyone filters by origin caps. Only entries with no origin
        // metadata at all stay admin-visible (their provenance is
        // unknowable anyway).
        // A private item in the trash answers to its own owner at its trash
        // path, never to the Admin role or to where it used to sit. That
        // holds for private rows repathed into trash AND for ordinary
        // children whose trash_meta recorded the private folder they were
        // deleted from.
        let protected = entry.private || entry_meta.is_some_and(|m| !m.private_owner.is_empty());
        let trash_path = format!("{}/{child}", files::TRASH_API_ALIAS);
        let visible = if protected {
            crate::auth::has_cap(user, &conn, id, &trash_path, crate::access::CAP_EDIT)
        } else {
            match original.as_deref() {
                Some(o) => crate::auth::has_cap(user, &conn, id, o, crate::access::CAP_EDIT),
                None => user.role == "admin",
            }
        };
        if !visible {
            return false;
        }
        // Trash inherits the origin's access row, so the caller's caps on
        // a trashed entry are their caps on where it came from — the same
        // rule `caps_on_path` applies to `.luna-trash` paths.
        entry.caps = crate::access::caps_to_str(if protected {
            crate::auth::caps_on_path(user, &conn, id, &trash_path)
        } else {
            match original.as_deref() {
                Some(o) => crate::auth::caps_on_path(user, &conn, id, o),
                None => crate::access::CAP_MANAGE,
            }
        });
        entry.original_path = original;
        if top_level {
            // The on-disk name carries a `{nonce}-` prefix; the original
            // path's basename is the true pre-trash name, with the
            // nonce-strip as fallback when metadata is gone.
            entry.original_name = Some(match entry.original_path.as_deref() {
                Some(orig) => orig.rsplit('/').next().unwrap_or(orig).to_string(),
                None => files::original_name_from_trash(&entry.name),
            });
        }
        true
    });
    Ok(Json(entries))
}

/// One folder's entries filtered to what `user` may browse — the same rows
/// the `list` endpoint returns.
fn visible_entries(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    id: &str,
    rel: &str,
) -> Result<Vec<FileEntry>, (StatusCode, Json<Value>)> {
    let mut entries = with_db(state, |conn| {
        files::list_dir_with_cache(conn, id, rel, Some(&state.ram_cache))
    })
    .map_err(map_files_err)?;
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let parent = crate::access::normalize_subject_path(rel);
        // Admins see everything except other people's private items.
        if user.role != "admin" || entries.iter().any(|e| e.private) {
            entries.retain(|entry| {
                if user.role == "admin" && !entry.private {
                    return true;
                }
                let child = if parent.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{parent}/{}", entry.name)
                };
                // Strict inspection, not the WebDAV ancestor walk: an entry that
                // is only an ancestor of a deeper grant stays hidden, so the
                // chain down to a deep grant never appears in listings.
                crate::auth::can_inspect_path(user, &conn, id, &child)
            });
        }
        // Stamp every visible entry with the caller's own capabilities —
        // the UI renders affordances off this, never off its own math.
        let rows = crate::db::list_access_members_for_user(&conn, &user.id).unwrap_or_default();
        for entry in &mut entries {
            let child = if parent.is_empty() {
                entry.name.clone()
            } else {
                format!("{parent}/{}", entry.name)
            };
            entry.caps = crate::access::caps_to_str(crate::auth::caps_on_path_rows(
                user, &conn, id, &child, &rows,
            ));
        }
    }
    Ok(entries)
}

/// Can `user` change (rename/move/delete) `path` on this drive?
fn can_write(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
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
        crate::access::CAP_EDIT,
    ))
}

#[derive(serde::Serialize)]
struct Resolved {
    drive_id: String,
    path: String,
    kind: String,
}

/// Where a moved or renamed file went. Only asked for paths that no longer
/// exist; follows the forwarding trail (see `files::forwarding`) and
/// answers with the first place something really is. Every miss — no
/// trail, trail ends in trash, or the new location isn't one this user may
/// see — is the same 404, so this never reveals paths the caller can't
/// already open.
async fn resolve_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Resolved>, (StatusCode, Json<Value>)> {
    let not_found = || {
        json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find where this file went. It may have been deleted.",
        )
    };
    let rel = query.path.unwrap_or_default();
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // The old path is still here: nothing to forward.
    if files::stat(&conn, &id, &rel).is_ok() {
        return Err(not_found());
    }
    let hit = files::forwarding::resolve(&conn, &id, &rel, |drive, path| {
        files::stat(&conn, drive, path).is_ok()
    })
    .map_err(|_| not_found())?;
    let Some((drive_id, path)) = hit else {
        return Err(not_found());
    };
    if files::is_internal_temp(&path)
        || !crate::auth::can_inspect_path(&user, &conn, &drive_id, &path)
    {
        return Err(not_found());
    }
    let kind = files::stat(&conn, &drive_id, &path)
        .map(|s| s.kind)
        .map_err(|_| not_found())?;
    Ok(Json(Resolved {
        drive_id,
        path,
        kind,
    }))
}

#[derive(Deserialize)]
struct RecordRecentBody {
    kind: Option<String>,
    #[serde(rename = "driveId", alias = "drive_id")]
    drive_id: String,
    path: Option<String>,
}

#[derive(Deserialize)]
struct DeleteRecentQuery {
    #[serde(rename = "driveId", alias = "drive_id")]
    drive_id: Option<String>,
    path: Option<String>,
}

async fn get_recents(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<files::recents::RecentItem>>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;

    let drives = crate::db::list_drives(&conn).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read drive status.",
        )
    })?;
    let known_drives: std::collections::HashSet<String> =
        drives.iter().map(|d| d.id.clone()).collect();
    let ready_drives: std::collections::HashSet<String> = drives
        .into_iter()
        .filter(|d| (d.state == "as_is" || d.state == "readonly") && !d.mount_point.is_empty())
        .map(|d| d.id)
        .collect();

    let mut stmt = conn
        .prepare(
            "SELECT drive_id, path, kind, accessed_at
             FROM user_recents
             WHERE user_id = ?1
             ORDER BY accessed_at DESC",
        )
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read your recents.",
            )
        })?;

    let rows: Vec<(String, String, String, i64)> = stmt
        .query_map(rusqlite::params![user.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read your recents.",
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read your recents.",
            )
        })?;

    let mut items = Vec::new();
    let mut to_delete = Vec::new();
    let mut to_update = Vec::new();

    // Every row (already capped at RECENTS_LIMIT_PER_USER) is checked so stale
    // ones get pruned, but at most 10 items are returned.
    for (drive_id, path, kind, at) in rows {
        if !known_drives.contains(&drive_id) {
            to_delete.push((drive_id, path));
            continue;
        }
        // A drive that is only temporarily not ready keeps its rows.
        if !ready_drives.contains(&drive_id) {
            continue;
        }

        if path.is_empty() {
            if crate::auth::has_drive_access(&user, &conn, &drive_id) && items.len() < 10 {
                items.push(files::recents::RecentItem {
                    kind: "drive".into(),
                    drive_id,
                    path,
                    at,
                });
            }
            continue;
        }

        if files::stat(&conn, &drive_id, &path).is_ok() {
            if items.len() < 10 && crate::auth::can_inspect_path(&user, &conn, &drive_id, &path) {
                items.push(files::recents::RecentItem {
                    kind,
                    drive_id,
                    path,
                    at,
                });
            }
            continue;
        }

        let hit = files::forwarding::resolve(&conn, &drive_id, &path, |d, p| {
            files::stat(&conn, d, p).is_ok()
        });

        match hit {
            Ok(Some((new_drive, new_path)))
                if ready_drives.contains(&new_drive)
                    && crate::auth::can_inspect_path(&user, &conn, &new_drive, &new_path) =>
            {
                to_update.push((
                    drive_id,
                    path,
                    new_drive.clone(),
                    new_path.clone(),
                    kind.clone(),
                    at,
                ));
                if items.len() < 10 {
                    items.push(files::recents::RecentItem {
                        kind,
                        drive_id: new_drive,
                        path: new_path,
                        at,
                    });
                }
            }
            _ => {
                to_delete.push((drive_id, path));
            }
        }
    }

    for (old_d, old_p, new_d, new_p, new_kind, at) in to_update {
        let _ = conn.execute(
            "DELETE FROM user_recents WHERE user_id = ?1 AND drive_id = ?2 AND path = ?3",
            rusqlite::params![user.id, old_d, old_p],
        );
        let _ = conn.execute(
            "INSERT INTO user_recents (user_id, drive_id, path, kind, accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, drive_id, path) DO UPDATE SET
                accessed_at = max(user_recents.accessed_at, excluded.accessed_at)",
            rusqlite::params![user.id, new_d, new_p, new_kind, at],
        );
    }
    for (d, p) in to_delete {
        let _ = conn.execute(
            "DELETE FROM user_recents WHERE user_id = ?1 AND drive_id = ?2 AND path = ?3",
            rusqlite::params![user.id, d, p],
        );
    }

    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert((item.kind.clone(), item.drive_id.clone(), item.path.clone())));
    items.truncate(10);

    Ok(Json(items))
}

async fn record_recent(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<RecordRecentBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let path = body.path.unwrap_or_default();
    let path = path.trim().trim_matches('/').to_string();
    if path.is_empty() {
        if !matches!(crate::db::get_drive(&conn, &body.drive_id), Ok(Some(_))) {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "Luna can't find that drive.",
            ));
        }
        if !crate::auth::has_drive_access(&user, &conn, &body.drive_id) {
            return Err(json_error(StatusCode::FORBIDDEN, "Luna can't open that."));
        }
    } else if !crate::auth::can_inspect_path(&user, &conn, &body.drive_id, &path) {
        return Err(json_error(StatusCode::FORBIDDEN, "Luna can't open that."));
    }
    let kind = body
        .kind
        .as_deref()
        .unwrap_or(if path.is_empty() { "drive" } else { "file" });
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    files::recents::record(&conn, &user.id, &body.drive_id, &path, kind, now_ms).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save that recent item.",
        )
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn delete_recent(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<DeleteRecentQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if let (Some(drive_id), Some(path)) = (query.drive_id, query.path) {
        files::recents::remove(&conn, &user.id, &drive_id, &path).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't remove that recent item.",
            )
        })?;
    } else {
        files::recents::clear_user(&conn, &user.id).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't clear recents.",
            )
        })?;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn stat_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<files::FileStat>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    let rel = rel.trim().trim_matches('/').to_string();
    let in_trash =
        rel == files::TRASH_API_ALIAS || rel.starts_with(&format!("{}/", files::TRASH_API_ALIAS));

    // Luna's own bookkeeping (index db, gallery, trash root, protected
    // copies) is not a user file — never stat it.
    if !in_trash
        && (files::is_internal_temp(&rel) || crate::backup::protect::is_protected_store(&rel))
    {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ));
    }

    // Authorize before the drive is touched: an ungranted path answers the
    // same 403 whether it exists or not — stat must not be an existence
    // oracle. A granted path that is missing still gets its honest 404.
    if in_trash {
        if rel == files::TRASH_API_ALIAS {
            check_trash_list(&state, &user, &id)?;
        } else {
            check_trash_item(&state, &user, &id, &rel)?;
        }
    } else {
        check_inspect(&state, &user, &id, &rel)?;
    }

    // An upload still in RAM may not exist on the drive yet — answer from the
    // dirty overlay first, same as content serving does.
    if let Some(dirty) = state.ram_cache.get_dirty(&id, &rel) {
        let writable = can_write(&state, &user, &id, &rel)?;
        return Ok(Json(files::FileStat {
            hidden: dirty.name.starts_with('.'),
            name: dirty.name,
            kind: "file".into(),
            size: dirty.bytes.len() as u64,
            modified: dirty.modified,
            created: None,
            link_target: None,
            children: None,
            saving: true,
            writable,
            trashed_from: None,
            original_name: None,
            totals: None,
            caps: stamped_caps(&state, &user, &id, &rel),
            private: false,
            in_private: false,
        }));
    }

    // Authorized above; resolution now only reports whether it exists.
    let mut stat = with_db(&state, |conn| files::stat(conn, &id, &rel)).map_err(map_files_err)?;

    // A browsed folder counts only the children this user can see — the
    // unfiltered filesystem count would leak restricted siblings.
    if !in_trash && stat.kind == "dir" {
        let entries = visible_entries(&state, &user, &id, &rel)?;
        let mut counts = files::ChildCounts {
            dirs: 0,
            files: 0,
            other: 0,
        };
        for entry in &entries {
            match entry.kind.as_str() {
                "dir" => counts.dirs += 1,
                "file" => counts.files += 1,
                _ => counts.other += 1,
            }
        }
        stat.children = Some(counts);
    }

    // One lock for the request-context fields — trash origin, writable, and
    // the per-directory read lens the totals walk uses.
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if in_trash {
        let original = files::trash_original_path(&conn, &id, &rel).map_err(map_files_err)?;
        stat.trashed_from = original.filter(|p| !p.is_empty());
        // Restoring needs write access where the item originally lived.
        stat.writable = match &stat.trashed_from {
            Some(orig) => crate::auth::has_cap(&user, &conn, &id, orig, crate::access::CAP_EDIT),
            None => user.role == "admin",
        };
        // Top-level trash entries show their pre-trash name, not the
        // on-disk `{nonce}-` form.
        if rel
            .strip_prefix(&format!("{}/", files::TRASH_API_ALIAS))
            .is_some_and(|rest| !rest.contains('/'))
        {
            stat.original_name = Some(match stat.trashed_from.as_deref() {
                Some(orig) => orig.rsplit('/').next().unwrap_or(orig).to_string(),
                None => files::original_name_from_trash(&stat.name),
            });
        }
        // `stat.name` is the display name everywhere trash browses like a
        // folder: the alias root reads "Trash", a top-level entry its
        // pre-trash name, nested paths their real leaf name.
        stat.name = match rel.strip_prefix(&format!("{}/", files::TRASH_API_ALIAS)) {
            None => String::from("Trash"),
            Some(rest) if rest.contains('/') => rest.rsplit('/').next().unwrap_or(rest).to_string(),
            Some(rest) => stat
                .original_name
                .clone()
                .unwrap_or_else(|| files::original_name_from_trash(rest)),
        };
    } else {
        stat.writable = crate::auth::has_cap(&user, &conn, &id, &rel, crate::access::CAP_EDIT);
    }
    stat.caps = crate::access::caps_to_str(crate::auth::caps_on_path(&user, &conn, &id, &rel));

    // The trash root mixes every user's deleted items — raw child counts and
    // totals would disclose them, even to admins. A specific entry's aggregates are fine: everything under
    // it shares one origin.
    if in_trash && rel == files::TRASH_API_ALIAS {
        stat.children = None;
    }

    // Recursive totals for folders. The index answers instantly when every
    // subdir is still mtime-fresh; a bounded filesystem walk covers the rest
    // (trash is never indexed, so it always walks). Either way only the
    // directories this user may read count toward the total.
    if stat.kind == "dir" {
        let mut include = |p: &str| {
            in_trash || crate::auth::has_cap(&user, &conn, &id, p, crate::access::CAP_VIEW)
        };
        stat.totals = if in_trash {
            if rel != files::TRASH_API_ALIAS {
                files::folder_totals(&conn, &id, &rel, &mut include)
                    .ok()
                    .flatten()
            } else {
                None
            }
        } else {
            files::drive_root(&conn, &id)
                .ok()
                .and_then(|drive| {
                    files::open_drive_db(&drive).ok().and_then(|index_conn| {
                        crate::files::index::folder_totals_indexed(
                            &index_conn,
                            std::path::Path::new(&drive.mount_point),
                            &id,
                            &rel,
                            &mut include,
                        )
                    })
                })
                .or_else(|| {
                    files::folder_totals(&conn, &id, &rel, &mut include)
                        .ok()
                        .flatten()
                })
        };
    }
    Ok(Json(stat))
}

async fn content(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ContentQuery>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    let rel = rel.trim().trim_matches('/').to_string();
    let in_trash = files::is_trash_api(&rel);
    // Trash is read-only, not unreadable: items open and download, gated by
    // edit rights on the path they were deleted from. The root uses the
    // same "could edit something here" bar as the listing.
    if rel == files::TRASH_API_ALIAS {
        check_trash_list(&state, &user, &id)?;
    } else if in_trash {
        check_trash_item(&state, &user, &id, &rel)?;
    } else {
        check_access(&state, &user, &id, &rel, crate::access::CAP_VIEW)?;
    }
    let (_path, meta) = with_db(&state, |conn| {
        if in_trash {
            files::resolve_any_including_trash(conn, &id, &rel)
        } else {
            files::resolve_any(conn, &id, &rel)
        }
    })
    .map_err(|err| match err {
        FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error_code(
            StatusCode::NOT_FOUND,
            "not_found",
            "This file doesn't exist anymore.",
        ),
        FilesError::Io(ref e) if e.kind() == std::io::ErrorKind::NotFound => json_error_code(
            StatusCode::NOT_FOUND,
            "not_found",
            "This file doesn't exist anymore.",
        ),
        other => map_files_err(other),
    })?;
    if meta.is_dir() {
        if query.download.as_deref() != Some("1") {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That's a folder. Use Download to save it as a zip file.",
            ));
        }
        return serve_folder_zip(state, user, id, rel, in_trash).await;
    }
    if !meta.is_file() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only download files and folders.",
        ));
    }
    serve_file_content(state, id, rel, query.download.as_deref(), headers, in_trash).await
}

async fn serve_folder_zip(
    state: AppState,
    user: crate::auth::CurrentUser,
    id: String,
    rel: String,
    in_trash: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let archive_base = if in_trash {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if rel == files::TRASH_API_ALIAS {
            "trash".to_string()
        } else {
            files::trash_api_leaf(&conn, &id, &rel)
                .ok()
                .flatten()
                .unwrap_or_else(|| files::zip_archive_basename(&rel))
        }
    } else {
        files::zip_archive_basename(&rel)
    };
    let zip_name = format!("{archive_base}.zip");
    let is_admin = user.role == "admin";
    let tmp = tempfile::NamedTempFile::new().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare that folder download. Try again.",
        )
    })?;
    let tmp_path = tmp.path().to_path_buf();

    let build_result = tokio::task::spawn_blocking({
        let state = state.clone();
        let id = id.clone();
        let rel = rel.clone();
        let user = user.clone();
        let tmp_path = tmp_path.clone();
        move || {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&tmp_path)
                .map_err(files::FilesError::Io)?;
            let conn = state
                .db
                .lock()
                .map_err(|_| files::FilesError::UnknownDrive)?;
            if in_trash {
                // Mirror list_trash_view + check_trash_item: a zip of the
                // trash root — or of one entry — only ships children whose
                // ORIGIN the caller could still edit. Entries with no
                // recorded origin stay admin-only, like the listing.
                files::write_folder_zip_including_trash(&conn, &id, &rel, &mut file, |child| {
                    // A private item (or anything inside one) answers at its
                    // current trash path, never to where it used to sit.
                    if crate::auth::inside_private(&conn, &id, child) {
                        return crate::auth::has_cap(
                            &user,
                            &conn,
                            &id,
                            child,
                            crate::access::CAP_EDIT,
                        );
                    }
                    let origin = files::trash_original_path(&conn, &id, child).ok().flatten();
                    match origin {
                        Some(o) => {
                            !o.is_empty()
                                && crate::auth::has_cap(
                                    &user,
                                    &conn,
                                    &id,
                                    &o,
                                    crate::access::CAP_EDIT,
                                )
                        }
                        None => is_admin,
                    }
                })
            } else {
                files::write_folder_zip(&conn, &id, &rel, &mut file, |child| {
                    crate::auth::can_inspect_path(&user, &conn, &id, child)
                })
            }
        }
    })
    .await
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare that folder download. Try again.",
        )
    })?;

    match build_result {
        Ok(_) => {}
        Err(files::FilesError::Io(ref io))
            if io.kind() == std::io::ErrorKind::InvalidInput
                && io.to_string().contains("folder too large") =>
        {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder has too many files to download as one zip. Download smaller folders instead.",
            ));
        }
        Err(other) => return Err(map_files_err(other)),
    }

    let async_file = tokio::fs::File::open(&tmp_path).await.map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't prepare that folder download. Try again.",
        )
    })?;
    let len = async_file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let stream = ReaderStream::new(async_file);
    // Keep the temp file alive until the response body finishes streaming.
    let body = Body::from_stream(ZipBody { stream, _keep: tmp });

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                files::content_disposition_filename(&zip_name)
            ),
        )
        .body(body)
        .unwrap())
}

struct ZipBody {
    stream: ReaderStream<tokio::fs::File>,
    _keep: tempfile::NamedTempFile,
}

impl futures_util::Stream for ZipBody {
    type Item = Result<bytes::Bytes, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.stream).poll_next(cx)
    }
}

async fn serve_file_content(
    state: AppState,
    id: String,
    rel: String,
    download: Option<&str>,
    headers: HeaderMap,
    in_trash: bool,
) -> Result<Response, (StatusCode, Json<Value>)> {
    // Read-your-writes: prefer in-flight dirty bytes over USB.
    if let Some(dirty) = state.ram_cache.get_dirty(&id, &rel) {
        let total = dirty.bytes.len() as u64;
        let modified = dirty.modified as u64;
        let etag = format!("\"{total:x}-{modified:x}\"");
        if let Some(if_none_match) = headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            && if_none_match.split(',').any(|c| c.trim() == etag)
        {
            return Ok(Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .body(Body::empty())
                .unwrap());
        }
        let name = dirty.name.clone();
        let mime = mime_guess::from_path(&name).first_or_octet_stream();
        let disposition = if download == Some("1") || !files::inline_safe(mime.as_ref()) {
            "attachment"
        } else {
            "inline"
        };
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CONTENT_LENGTH, total.to_string())
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ETAG, etag)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(
                header::CONTENT_DISPOSITION,
                format!(
                    "{disposition}; filename=\"{}\"",
                    files::content_disposition_filename(&name)
                ),
            )
            .body(Body::from(dirty.bytes.to_vec()))
            .unwrap());
    }

    let (path, meta) = with_db(&state, |conn| {
        if in_trash {
            files::file_path_including_trash(conn, &id, &rel)
        } else {
            files::file_path(conn, &id, &rel)
        }
    })
    .map_err(map_files_err)?;
    // open_verified works on real on-disk paths — the `.luna-trash` API
    // alias does not exist on the drive.
    let real_rel = if in_trash {
        with_db(&state, |conn| files::real_rel_path(conn, &id, &rel)).map_err(map_files_err)?
    } else {
        rel.clone()
    };
    let total = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{total:x}-{modified:x}\"");

    if let Some(if_none_match) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        && if_none_match.split(',').any(|c| c.trim() == etag)
    {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .body(Body::empty())
            .unwrap());
    }

    let mut file = {
        let drive =
            with_db(&state, |conn| crate::files::drive_root(conn, &id)).map_err(map_files_err)?;
        let root = std::path::PathBuf::from(&drive.mount_point);
        // Open the file against a re-verified descriptor so a mid-request
        // symlink swap on the drive cannot read outside the jail.
        let (file, _) = luna_core::path::open_verified(&root, &real_rel).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't open this file. Try again.",
            )
        })?;
        tokio::fs::File::from_std(file)
    };

    let (status, stream_len, content_range) =
        match headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
            Some(spec) => match parse_range(spec, total) {
                Some((start, end)) => (
                    StatusCode::PARTIAL_CONTENT,
                    end - start + 1,
                    Some(format!("bytes {start}-{end}/{total}")),
                ),
                None => {
                    return Err(json_error(
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        "Luna couldn't understand that download range.",
                    ));
                }
            },
            None => (StatusCode::OK, total, None),
        };

    if status == StatusCode::PARTIAL_CONTENT {
        let start = content_range
            .as_deref()
            .and_then(parse_range_start)
            .unwrap_or(0);
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't read this file. Try again.",
                )
            })?;
    }

    let stream = ReaderStream::new(file.take(stream_len));
    let name = if in_trash {
        // The meta leaf is authoritative — a rename in trash retitles the
        // origin while the on-disk name keeps its `{nonce}-` prefix.
        with_db(&state, |conn| files::trash_api_leaf(conn, &id, &rel))
            .map_err(map_files_err)?
            .unwrap_or_else(|| String::from("download"))
    } else {
        files::leaf_of(&path).unwrap_or_else(|| String::from("download"))
    };
    if files::is_internal_temp(&name) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ));
    }
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let disposition = if download == Some("1") || !files::inline_safe(mime.as_ref()) {
        "attachment"
    } else {
        "inline"
    };

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_LENGTH, stream_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "{disposition}; filename=\"{}\"",
                files::content_disposition_filename(&name)
            ),
        );
    if let Some(range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, range);
    }
    Ok(builder.body(Body::from_stream(stream)).unwrap())
}

/// Drop every cached view of a write's directory: the RAM listing plus the
/// indexed snapshot. The index's dir-mtime check cannot see writes that land
/// inside the filesystem's timestamp granularity (one second is common, two
/// on FAT32), so the row must be forgotten outright — not left to look fresh.
pub(crate) fn invalidate_parent_listing(state: &AppState, drive_id: &str, rel: &str) {
    // `.luna-trash` is an API alias — listings key on the real
    // `{prefix}-trash` path, so resolve before evicting or nothing clears.
    let real = state
        .db
        .lock()
        .ok()
        .and_then(|conn| files::real_rel_path(&conn, drive_id, rel).ok())
        .unwrap_or_else(|| rel.to_string());
    let parent = real.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    state.ram_cache.invalidate_listing(drive_id, parent);
    state.ram_cache.invalidate_listing_tree(drive_id, &real);
    if let Ok(conn) = state.db.lock() {
        files::note_write(&conn, drive_id, &real);
    }
}

async fn delete_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    let rel = rel.trim().trim_matches('/').to_string();
    check_access(&state, &user, &id, &rel, crate::access::CAP_EDIT)?;
    check_no_foreign_private(&state, &user, &id, &rel)?;
    let trash_path =
        with_db(&state, |conn| files::delete_to_trash(conn, &id, &rel)).map_err(map_files_err)?;
    state.gallery.remove(&id, &rel);
    // Eagerly drop album refs so shared albums update without waiting on the indexer.
    if let Ok(conn) = state.db.lock()
        && let Ok(drives) = crate::db::list_drives(&conn)
    {
        let mounts: Vec<(String, std::path::PathBuf)> = drives
            .into_iter()
            .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
            .map(|d| (d.id, std::path::PathBuf::from(d.mount_point)))
            .collect();
        crate::gallery::purge_album_item_refs_on_mounts(&mounts, &id, &rel);
    }
    invalidate_parent_listing(&state, &id, &rel);
    state.ram_cache.invalidate_thumb(&id, &rel);
    state.ram_cache.remove_dirty(&id, &rel);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "trash_path": trash_path })))
}

/// The folder a path sits in ("" for the drive root).
fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

async fn mkdir_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = body.path.trim().trim_matches('/').to_string();
    if rel.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a name for the new folder.",
        ));
    }
    // Authorized on the folder it goes in, so a name taken by someone's
    // private item answers the same conflict for everyone.
    check_access(
        &state,
        &user,
        &id,
        parent_of(&rel),
        crate::access::CAP_UPLOAD,
    )?;
    with_db(&state, |conn| {
        files::mkdir_as(conn, &id, &rel, body.private.then_some(user.id.as_str()))
    })
    .map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A folder with this name is already here. Choose another name.",
        ),
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find the parent folder. Open it and try again.",
        ),
        other => map_files_err(other),
    })?;
    invalidate_parent_listing(&state, &id, &rel);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "path": rel })))
}

/// Make an ordinary folder private to the caller, or open a private folder
/// to its parent's access. Making private takes full access ("full +
/// share") on the folder — the caller becomes its owner. Opening it takes
/// being its owner (or an Admin when the owner is a stranger this Luna
/// doesn't know, the same people who could adopt it instead). Private
/// folders nested inside are untouched either way.
async fn set_privacy(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PrivacyBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = body.path.trim().trim_matches('/').to_string();
    if rel.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a folder first.",
        ));
    }
    if files::is_trash_api(&rel) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Restore it from Trash first.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let root = crate::db::get_drive(&conn, &id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| std::path::PathBuf::from(d.mount_point))
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna can't find that drive."))?;
    if !crate::auth::has_cap(&user, &conn, &id, &rel, crate::access::CAP_VIEW) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that folder.",
        ));
    }
    if crate::db::get_drive(&conn, &id)
        .ok()
        .flatten()
        .is_none_or(|d| d.state != "as_is")
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This drive isn't writable right now.",
        ));
    }
    if body.private {
        if !crate::auth::has_cap(&user, &conn, &id, &rel, crate::access::CAP_MANAGE) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only someone who manages this folder can make it private.",
            ));
        }
        if crate::private::item_at(&root, &rel).is_some() {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder is already private.",
            ));
        }
        crate::private::privatize(&root, &rel, &user.id).map_err(|e| {
            let msg = e.to_string();
            if msg == "already private" {
                json_error(StatusCode::BAD_REQUEST, "That folder is already private.")
            } else if msg == "only folders can be private" {
                json_error(StatusCode::BAD_REQUEST, "Only folders can be private.")
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't make that folder private. Try again.",
                )
            }
        })?;
    } else {
        let Some(item) = crate::private::item_at(&root, &rel) else {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "That folder already uses its parent's access.",
            ));
        };
        let can_open = item.owner == user.id
            || (user.role == "admin" && !crate::private::owner_known(&conn, &item.owner));
        if !can_open {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Only the folder's owner can open it to parent access.",
            ));
        }
        crate::private::unprivatize(&root, &rel).map_err(|e| {
            if e.to_string() == "a folder already has that name" {
                json_error(
                    StatusCode::CONFLICT,
                    "A folder with this name is already here.",
                )
            } else {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't open that folder. Try again.",
                )
            }
        })?;
    }
    // The listing cache holds a private flag per entry — the folder's own
    // row changed, and children's "in a private folder" state may have too.
    if let Ok(real) = files::real_rel_path(&conn, &id, &rel) {
        state.ram_cache.invalidate_listing(&id, &real);
        state.ram_cache.invalidate_listing_tree(&id, &real);
    }
    drop(conn);
    invalidate_parent_listing(&state, &id, &rel);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "path": rel })))
}

async fn create_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = body.path.trim().trim_matches('/').to_string();
    if rel.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a name for the new file.",
        ));
    }
    if body.private {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Only folders can be private. Put this file in a private folder instead.",
        ));
    }
    check_access(
        &state,
        &user,
        &id,
        parent_of(&rel),
        crate::access::CAP_UPLOAD,
    )?;
    with_db(&state, |conn| files::create(conn, &id, &rel)).map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Choose another name.",
        ),
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find the parent folder. Open it and try again.",
        ),
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::InvalidInput => {
            json_error(StatusCode::BAD_REQUEST, "Choose a name for the new file.")
        }
        other => map_files_err(other),
    })?;
    invalidate_parent_listing(&state, &id, &rel);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true, "path": rel })))
}

async fn rename_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(&state, &user, &id, &body.path, crate::access::CAP_EDIT)?;
    let parent = body.path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let new_rel = crate::gallery::gallery_indexer::join_rel(parent, &body.new_name);
    with_db(&state, |conn| {
        files::rename(conn, &id, &body.path, &body.new_name)
    })
    .map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already here. Choose another name.",
        ),
        other => map_files_err(other),
    })?;
    // Folder renames move many gallery rows; a catch-up rescan is the safe path.
    let renamed_dir = with_db(&state, |conn| {
        let drive = crate::files::drive_root(conn, &id)?;
        let root = std::path::PathBuf::from(&drive.mount_point);
        Ok::<_, FilesError>(files::resolve_child(&root, &new_rel).is_ok_and(|p| p.is_dir()))
    })
    .unwrap_or(false);
    if renamed_dir {
        state.gallery.rescan(&id);
    } else {
        state.gallery.rename(&id, &body.path, &new_rel);
    }
    invalidate_parent_listing(&state, &id, &body.path);
    invalidate_parent_listing(&state, &id, &new_rel);
    state.ram_cache.invalidate_thumb(&id, &body.path);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true })))
}

async fn list_trash(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    check_trash_list(&state, &user, &id)?;
    let entries = with_db(&state, |conn| files::list_trash(conn, &id)).map_err(map_files_err)?;
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // Same origin-caps rule for everyone; entries with no recorded origin
    // stay admin-only.
    let visible: Vec<_> = entries
        .into_iter()
        .filter(|entry| {
            if entry.private {
                return crate::auth::has_cap(
                    &user,
                    &conn,
                    &id,
                    &format!("{}/{}", files::TRASH_API_ALIAS, entry.name),
                    crate::access::CAP_EDIT,
                );
            }
            if entry.original_path.is_empty() {
                return user.role == "admin";
            }
            crate::auth::has_cap(
                &user,
                &conn,
                &id,
                &entry.original_path,
                crate::access::CAP_EDIT,
            )
        })
        .collect();
    Ok(Json(
        visible
            .into_iter()
            .map(|e| {
                json!({
                    "name": e.name,
                    "kind": e.kind,
                    "size": e.size,
                    "modified": e.modified,
                    "path": format!(".luna-trash/{}", e.name),
                    "original_name": files::original_name_from_trash(&e.name),
                    "original_path": e.original_path,
                })
            })
            .collect(),
    ))
}

async fn restore_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<RestoreBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_trash_item(&state, &user, &id, &body.path)?;
    check_access(&state, &user, &id, &body.dest, crate::access::CAP_UPLOAD)?;
    if !body.confirm_broaden {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let parent = body.dest.rsplit_once('/').map_or("", |(p, _)| p);
        if crate::api::jobs::broadens_access(&conn, &id, &body.path, &id, parent) {
            return Err(crate::api::response::json_error_code(
                StatusCode::CONFLICT,
                "broadens_access",
                "Restoring here lets everyone with access to this folder open it.",
            ));
        }
    }
    with_db(&state, |conn| {
        files::restore_from_trash(conn, &id, &body.path, &body.dest)
    })
    .map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::AlreadyExists => json_error(
            StatusCode::CONFLICT,
            "A file with this name is already there. Choose another name.",
        ),
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::InvalidInput => json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only put files back from the trash on this drive.",
        ),
        other => map_files_err(other),
    })?;
    state.gallery.upsert(&id, &body.dest);
    invalidate_parent_listing(&state, &id, &body.dest);
    state.touch_io_activity();
    Ok(Json(json!({ "ok": true })))
}

async fn purge_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PurgeBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if body.path == files::TRASH_API_ALIAS {
        // Empty trash. Everyone purges only the entries they can see (their
        // own origins); admins see every entry.
        let Json(entries) = list_trash_view(&state, &user, &id, &body.path)?;
        for entry in entries {
            let rel = format!("{}/{}", files::TRASH_API_ALIAS, entry.name);
            // Someone else's private item inside stays; only its owner can
            // remove it for good.
            if check_no_foreign_private(&state, &user, &id, &rel).is_err() {
                continue;
            }
            with_db(&state, |conn| files::purge_trash(conn, &id, &rel)).map_err(map_files_err)?;
        }
        return Ok(Json(json!({ "ok": true })));
    }
    check_trash_item(&state, &user, &id, &body.path)?;
    check_no_foreign_private(&state, &user, &id, &body.path)?;
    with_db(&state, |conn| files::purge_trash(conn, &id, &body.path)).map_err(|e| match e {
        FilesError::Io(ref io) if io.kind() == std::io::ErrorKind::InvalidInput => json_error(
            StatusCode::BAD_REQUEST,
            "Luna only permanently removes files that are already in the trash.",
        ),
        other => map_files_err(other),
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn upload(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<FileEntry>, (StatusCode, Json<Value>)> {
    let query_path = query.path.unwrap_or_default();
    let mut dest_rel = query_path.clone();
    check_access(&state, &user, &id, &dest_rel, crate::access::CAP_UPLOAD)?;
    let overwrite = query.overwrite.as_deref() == Some("1");

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "Luna couldn't read this upload."))?
    {
        match field.name() {
            Some("path") => {
                dest_rel = read_bounded_text(&mut field, MAX_PATH_FIELD_BYTES).await?;
                if !query_path.is_empty() && dest_rel != query_path {
                    return Err(json_error(
                        StatusCode::FORBIDDEN,
                        "You don't have permission to change this folder.",
                    ));
                }
                check_access(&state, &user, &id, &dest_rel, crate::access::CAP_UPLOAD)?;
            }
            Some("file") => {
                check_access(&state, &user, &id, &dest_rel, crate::access::CAP_UPLOAD)?;
                let original = field.file_name().unwrap_or("file").to_string();
                let name = files::safe_name(&original).map_err(|_| {
                    json_error(
                        StatusCode::BAD_REQUEST,
                        "That file name can't be used. Try renaming it.",
                    )
                })?;
                // Same bar as `files::create`: `.part`-style and Luna-namespace
                // leaves mint files no listing can ever show.
                if files::is_internal_temp(&name) {
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "That file name can't be used. Try renaming it.",
                    ));
                }
                let dir = with_db(&state, |conn| files::dest_dir_create(conn, &id, &dest_rel))
                    .map_err(map_files_err)?;
                let dest = files::entry_path(&dir, &name);
                // Only a destination that existed — and passed the EDIT
                // check — at this decision point may be replaced. Anything
                // that lands between here and install_temp is covered by the
                // atomic no-overwrite install below, not by the caller's
                // `overwrite` flag.
                let mut may_overwrite = false;
                if dest.exists() {
                    if !overwrite {
                        return Err(json_error(
                            StatusCode::CONFLICT,
                            "A file with this name is already here. Rename it or choose another.",
                        ));
                    }
                    // Overwriting is an edit, not an upload: a drop-only
                    // member cannot replace a file that is already there.
                    let file_rel = crate::gallery::gallery_indexer::join_rel(&dest_rel, &name);
                    if !can_write(&state, &user, &id, &file_rel)? {
                        return Err(json_error(
                            StatusCode::FORBIDDEN,
                            "You don't have permission to change this file.",
                        ));
                    }
                    may_overwrite = true;
                }

                let rel = crate::gallery::gallery_indexer::join_rel(&dest_rel, &name);
                let max_dirty =
                    crate::budget::cache_budget_from(crate::budget::meminfo().available_bytes)
                        .dirty_max_file_bytes;
                let temp = with_db(&state, |conn| files::temp_path(conn, &id, &dir))
                    .map_err(map_files_err)?;

                match buffer_field_up_to(&mut field, max_dirty, &temp).await {
                    Ok(Some(bytes)) => {
                        if state
                            .ram_cache
                            .accept_dirty(&id, &rel, &name, bytes.clone(), may_overwrite)
                            .is_ok()
                        {
                            let size = bytes.len() as u64;
                            let modified = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0);
                            invalidate_parent_listing(&state, &id, &rel);
                            let flush_state = state.clone();
                            let flush_id = id.clone();
                            let flush_rel = rel.clone();
                            let flush_user = user.id.clone();
                            let flush_coverage = query.coverage.clone();
                            let rt = tokio::runtime::Handle::current();
                            tokio::task::spawn_blocking(move || {
                                let mount = {
                                    let Ok(conn) = flush_state.db.lock() else {
                                        flush_state.ram_cache.mark_failed(&flush_id, &flush_rel);
                                        return;
                                    };
                                    match crate::files::drive_root(&conn, &flush_id) {
                                        Ok(d) => std::path::PathBuf::from(d.mount_point),
                                        Err(_) => {
                                            flush_state
                                                .ram_cache
                                                .mark_failed(&flush_id, &flush_rel);
                                            return;
                                        }
                                    }
                                };
                                match flush_state
                                    .ram_cache
                                    .flush_dirty_to_disk(&flush_id, &flush_rel, &mount)
                                {
                                    Ok(true) => {}
                                    // Eject or memory pressure landed it
                                    // first; a delete or failure left
                                    // nothing on the drive to announce.
                                    Ok(false) => {
                                        if flush_state.ram_cache.save_failed(&flush_id, &flush_rel)
                                            || !mount
                                                .join(&*files::real_rel(&mount, &flush_rel))
                                                .is_file()
                                        {
                                            return;
                                        }
                                    }
                                    Err(e) => {
                                        if let Ok(conn) = flush_state.db.lock() {
                                            files::note_write_failure(
                                                &conn,
                                                &flush_id,
                                                &e.to_string(),
                                            );
                                        }
                                        flush_state.ram_cache.mark_failed(&flush_id, &flush_rel);
                                        return;
                                    }
                                }
                                flush_state.gallery.upsert(&flush_id, &flush_rel);
                                flush_state.touch_io_activity();
                                // The save is durable NOW — only here may
                                // the collab room compact its op backlog to
                                // the uploader's claimed coverage. Firing
                                // this at accept_dirty time would drop ops
                                // the disk never received.
                                rt.spawn(async move {
                                    crate::api::collab::note_diagram_saved(
                                        &flush_state,
                                        &flush_id,
                                        &flush_rel,
                                        &flush_user,
                                        flush_coverage.as_deref(),
                                    )
                                    .await;
                                });
                            });
                            state.touch_io_activity();
                            return Ok(Json(FileEntry {
                                name,
                                kind: "file".into(),
                                size,
                                modified,
                                hidden: false,
                                saving: true,
                                save_failed: false,
                                original_name: None,
                                original_path: None,
                                link_target: None,
                                caps: String::new(),
                                private: false,
                                in_private: false,
                            }));
                        }
                        // Dirty accept refused — durable write of the buffered bytes.
                        if let Err(e) = tokio::fs::write(&temp, &bytes).await {
                            let _ = tokio::fs::remove_file(&temp).await;
                            if let Ok(conn) = state.db.lock() {
                                files::note_write_failure(&conn, &id, &e.to_string());
                            }
                            return Err(json_error(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!(
                                    "Luna couldn't save this file. {}",
                                    plain_upload_error(&anyhow::Error::from(e))
                                ),
                            ));
                        }
                        if let Ok(f) = std::fs::File::open(&temp) {
                            let _ = f.sync_all();
                        }
                    }
                    Ok(None) => {
                        // Already fully spilled to `temp` by buffer_field_up_to.
                    }
                    Err(e) => {
                        let _ = tokio::fs::remove_file(&temp).await;
                        if let Ok(conn) = state.db.lock() {
                            files::note_write_failure(&conn, &id, &e.to_string());
                        }
                        return Err(json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Luna couldn't save this file. {}", plain_upload_error(&e)),
                        ));
                    }
                }

                if let Err(e) = files::install_temp(&temp, &dest, may_overwrite) {
                    let _ = tokio::fs::remove_file(&temp).await;
                    if let Ok(conn) = state.db.lock() {
                        files::note_write_failure(&conn, &id, &e.to_string());
                    }
                    return Err(json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!(
                            "Luna couldn't finish saving this file. {}",
                            plain_upload_error(&anyhow::Error::from(e))
                        ),
                    ));
                }
                let meta = std::fs::symlink_metadata(&dest).map_err(|_| {
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "The file saved, but Luna couldn't confirm it.",
                    )
                })?;
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                state.gallery.upsert(&id, &rel);
                invalidate_parent_listing(&state, &id, &rel);
                state.touch_io_activity();
                crate::api::collab::note_diagram_saved(
                    &state,
                    &id,
                    &rel,
                    &user.id,
                    query.coverage.as_deref(),
                )
                .await;
                return Ok(Json(FileEntry {
                    name,
                    kind: "file".into(),
                    size: meta.len(),
                    modified,
                    hidden: false,
                    saving: false,
                    save_failed: false,
                    original_name: None,
                    original_path: None,
                    link_target: None,
                    caps: stamped_caps(&state, &user, &id, &rel),
                    private: false,
                    in_private: false,
                }));
            }
            _ => {}
        }
    }

    Err(json_error(
        StatusCode::BAD_REQUEST,
        "Choose a file to upload first.",
    ))
}

/// Buffer a multipart field up to `max` bytes.
///
/// - `Ok(Some(bytes))` — entire field fit in memory
/// - `Ok(None)` — exceeded `max`; `spill` holds all bytes read so far (including
///   the overflowing chunk). Caller must append the rest of the field to `spill`.
async fn buffer_field_up_to(
    field: &mut axum::extract::multipart::Field<'_>,
    max: u64,
    spill: &std::path::Path,
) -> anyhow::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.chunk().await? {
        if (buf.len() as u64).saturating_add(chunk.len() as u64) > max {
            let mut out = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(spill)
                .await?;
            out.write_all(&buf).await?;
            out.write_all(&chunk).await?;
            while let Some(more) = field.chunk().await? {
                out.write_all(&more).await?;
            }
            out.flush().await?;
            out.sync_all().await?;
            return Ok(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Some(buf))
}

/// Refuse to delete a folder that holds private items only their owners can
/// change — deleting it would destroy them.
fn check_no_foreign_private(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::holds_unreachable_private(user, &conn, drive_id, path) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "This folder holds private items that only their owners can delete.",
        ));
    }
    Ok(())
}

fn check_trash_list(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::has_write_on_drive(user, &conn, drive_id) {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view trash on this drive.",
        ))
    }
}

fn check_trash_item(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    trash_rel: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if !trash_rel.starts_with(".luna-trash/") || trash_rel == ".luna-trash" {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna only works with files that are already in the trash.",
        ));
    }
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    // A private item in the trash answers to its owner alone, Admin or not.
    if crate::auth::inside_private(&conn, drive_id, trash_rel) {
        return if crate::auth::has_cap(user, &conn, drive_id, trash_rel, crate::access::CAP_EDIT) {
            Ok(())
        } else {
            Err(json_error(
                StatusCode::NOT_FOUND,
                "Luna can't find that file or folder.",
            ))
        };
    }
    let original = files::trash_original_path(&conn, drive_id, trash_rel).map_err(map_files_err)?;
    // Admins reach everything.
    if user.role == "admin" {
        return Ok(());
    }
    let Some(original_path) = original.filter(|p| !p.is_empty()) else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ));
    };
    if crate::auth::has_cap(
        user,
        &conn,
        drive_id,
        &original_path,
        crate::access::CAP_EDIT,
    ) {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ))
    }
}

/// The HTTP surface's strict read gate: `path` must be inside a grant the
/// member can read, exactly the granted path (so an upload-only member's
/// landing resolves), or the drive root for a member holding any row on the
/// drive. Unlike WebDAV's [`can_browse_path`] walk, ancestors of a deep
/// grant stay closed — the chain to a deep file is not the member's to see.
fn check_inspect(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::can_inspect_path(user, &conn, drive_id, path) {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this folder.",
        ))
    }
}

fn check_access(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
    cap: crate::access::Caps,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::has_cap(user, &conn, drive_id, path, cap) {
        Ok(())
    } else if cap != crate::access::CAP_VIEW {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to change this folder.",
        ))
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this folder.",
        ))
    }
}

fn with_db<T>(
    state: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, FilesError>,
) -> Result<T, FilesError> {
    let conn = state.db.lock().map_err(|_| FilesError::UnknownDrive)?;
    f(&conn)
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => json_error_code(
            StatusCode::NOT_FOUND,
            "unknown_drive",
            "Luna doesn't know this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.",
        ),
        // The drive is adopted and mounted. Only its on-drive database is gone.
        FilesError::MissingDriveDb => json_error_code(
            StatusCode::INTERNAL_SERVER_ERROR,
            "missing_drive_db",
            files::MISSING_DRIVE_DB_MSG,
        ),
        FilesError::Path(
            luna_core::path::PathError::Absolute | luna_core::path::PathError::Escape,
        ) => json_error(StatusCode::BAD_REQUEST, "Luna can't open that path."),
        FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error_code(
            StatusCode::NOT_FOUND,
            "not_found",
            "Luna can't find that file or folder.",
        ),
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => json_error_code(
            StatusCode::NOT_FOUND,
            "not_found",
            "Luna can't find that file or folder.",
        ),
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
            json_error(StatusCode::BAD_REQUEST, "That path is not a folder.")
        }
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::InvalidInput => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't open that path.")
        }
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.",
        ),
    }
}

fn plain_upload_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    if text.contains("No space left") || text.contains("no space") {
        "This drive is full. Free up space or choose another drive.".into()
    } else if text.contains("Read-only") || text.contains("read-only") {
        "This drive is read-only, so Luna can't save to it.".into()
    } else if text.contains("Operation not permitted")
        || text.contains("os error 1")
        || text.contains("not supported")
    {
        "This drive wouldn't accept the file. If it's a USB stick, try ejecting it and plugging it back in, then save again.".into()
    } else {
        "Check that the drive is connected and try again.".into()
    }
}

pub(crate) fn parse_range(spec: &str, total: u64) -> Option<(u64, u64)> {
    let rest = spec.strip_prefix("bytes=")?;
    if rest.contains(',') {
        return None;
    }
    let (start_s, end_s) = rest.split_once('-')?;
    if start_s.is_empty() {
        // suffix range: last N bytes
        let n: u64 = end_s.parse().ok()?;
        if n == 0 || total == 0 {
            return None;
        }
        let start = total.saturating_sub(n);
        return Some((start, total - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() {
        total.checked_sub(1)?
    } else {
        end_s.parse().ok()?
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

fn parse_range_start(content_range: &str) -> Option<u64> {
    let rest = content_range.strip_prefix("bytes ")?;
    let (start, _) = rest.split_once('-')?;
    start.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-10", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=999-1000", 1000), Some((999, 999)));
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("bytes=1000-", 1000), None);
    }

    #[test]
    fn disposition_header_cannot_split() {
        let name = files::content_disposition_filename("a\r\nContent-Type: text/html");
        assert!(!name.contains('\r'));
        assert!(!name.contains('\n'));
        assert!(!name.contains(':'));
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
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
        let prefix = luna_core::marker::pick_prefix(mount).unwrap();
        crate::drives::drive_db::create(
            mount,
            &luna_core::marker::Marker::new("photos", "Photos"),
            &prefix,
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

    async fn admin_and_sam(app: &axum::Router) -> (String, String, String) {
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
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
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
        (cookie_header(&sam_session, &sam_csrf), sam_csrf, sam_id)
    }

    #[tokio::test]
    async fn mkdir_creates_folder_and_respects_grants() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":"family/album"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        assert!(mount.path().join("family/album").is_dir());

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":"secret/nope"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(!mount.path().join("secret/nope").exists());
    }

    async fn body_json(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn private_items_are_the_owners_not_the_admins() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let res = call(
            &app,
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
        let post = |uri: &'static str, body: &'static str, cookie: &str, csrf: &str| {
            json_req(Method::POST, uri, body, Some(cookie), Some(csrf))
        };
        let get = |uri: &str, cookie: &str| {
            let mut r = HttpReq::builder()
                .method(Method::GET)
                .uri(uri)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap();
            r.extensions_mut().insert(ConnectInfo(CLIENT));
            r
        };

        // Sam makes a private folder and puts a file in it.
        let res = call(
            &app,
            post(
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":"family/Vault","private":true}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            post(
                "/api/v1/drives/photos/files/create",
                r#"{"path":"family/Vault/note.txt"}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        // On disk it is not a folder called Vault.
        assert!(!mount.path().join("family/Vault").exists());

        // The same name is taken, whether or not the person can see why.
        for (cookie, csrf) in [(&sam_cookie, &sam_csrf), (&admin_cookie, &admin_csrf)] {
            let res = call(
                &app,
                post(
                    "/api/v1/drives/photos/files/mkdir",
                    r#"{"path":"family/Vault"}"#,
                    cookie,
                    csrf,
                ),
            )
            .await;
            assert_eq!(res.status(), StatusCode::CONFLICT);
        }

        // Sam sees it, flagged; the Admin's listing has nothing.
        let sam_list = body_json(
            call(
                &app,
                get("/api/v1/drives/photos/files?path=family", &sam_cookie),
            )
            .await,
        )
        .await;
        assert_eq!(sam_list[0]["name"], "Vault");
        assert_eq!(sam_list[0]["private"], true);
        let admin_list = body_json(
            call(
                &app,
                get("/api/v1/drives/photos/files?path=family", &admin_cookie),
            )
            .await,
        )
        .await;
        assert!(admin_list.as_array().unwrap().is_empty(), "{admin_list}");
        let inside = call(
            &app,
            get("/api/v1/drives/photos/files?path=family/Vault", &sam_cookie),
        )
        .await;
        assert_eq!(inside.status(), 200);
        assert_eq!(body_json(inside).await[0]["name"], "note.txt");

        // The Admin can't open it, stat it, or read what is inside.
        for uri in [
            "/api/v1/drives/photos/files?path=family/Vault",
            "/api/v1/drives/photos/files/stat?path=family/Vault",
            "/api/v1/drives/photos/files/stat?path=family/Vault/note.txt",
        ] {
            let res = call(&app, get(uri, &admin_cookie)).await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{uri}");
        }
        let stat = body_json(
            call(
                &app,
                get(
                    "/api/v1/drives/photos/files/stat?path=family/Vault",
                    &sam_cookie,
                ),
            )
            .await,
        )
        .await;
        assert_eq!(stat["private"], true);

        // Deleting the folder around it would delete it.
        let mut del = HttpReq::builder()
            .method(Method::DELETE)
            .uri("/api/v1/drives/photos/files?path=family")
            .header("cookie", &admin_cookie)
            .header("x-csrf-token", &admin_csrf)
            .body(Body::empty())
            .unwrap();
        del.extensions_mut().insert(ConnectInfo(CLIENT));
        assert_eq!(call(&app, del).await.status(), StatusCode::FORBIDDEN);
        assert!(crate::private::item_at(mount.path(), "family/Vault").is_some());

        // Renaming keeps it private and under its new name.
        let res = call(
            &app,
            post(
                "/api/v1/drives/photos/files/rename",
                r#"{"path":"family/Vault","new_name":"Safe"}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let sam_list = body_json(
            call(
                &app,
                get("/api/v1/drives/photos/files?path=family", &sam_cookie),
            )
            .await,
        )
        .await;
        assert_eq!(sam_list[0]["name"], "Safe");
        assert_eq!(sam_list[0]["private"], true);

        // Its owner can open a private file by its real name.
        let res = call(
            &app,
            get(
                "/api/v1/drives/photos/files/content?path=family/Safe/note.txt",
                &sam_cookie,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // A zip of the trash never carries a private item to an Admin.
        let mut del = HttpReq::builder()
            .method(Method::DELETE)
            .uri("/api/v1/drives/photos/files?path=family/Safe")
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        del.extensions_mut().insert(ConnectInfo(CLIENT));
        assert_eq!(call(&app, del).await.status(), 200);
        let res = call(
            &app,
            get(
                "/api/v1/drives/photos/files/content?path=.luna-trash",
                &admin_cookie,
            ),
        )
        .await;
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("note.txt"));
    }

    /// An ordinary file deleted out of a private folder stays private in
    /// the trash — the row recording that must not depend on the boundary
    /// still being at its old path, or existing at all.
    #[tokio::test]
    async fn a_child_deleted_from_a_private_folder_stays_private_in_trash() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (admin_session, admin_csrf) = auth_cookies(&admin_login);
        let admin_cookie = cookie_header(&admin_session, &admin_csrf);
        let post = |uri: &'static str, body: &'static str, cookie: &str, csrf: &str| {
            json_req(Method::POST, uri, body, Some(cookie), Some(csrf))
        };
        let get = |uri: &str, cookie: &str| {
            let mut r = HttpReq::builder()
                .method(Method::GET)
                .uri(uri)
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap();
            r.extensions_mut().insert(ConnectInfo(CLIENT));
            r
        };
        let del = |path: &str, cookie: &str, csrf: &str| {
            let mut r = HttpReq::builder()
                .method(Method::DELETE)
                .uri(format!("/api/v1/drives/photos/files?path={path}"))
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::empty())
                .unwrap();
            r.extensions_mut().insert(ConnectInfo(CLIENT));
            r
        };
        let trash_names = |cookie: &str| {
            let app = app.clone();
            let cookie = cookie.to_string();
            async move {
                let v =
                    body_json(call(&app, get("/api/v1/drives/photos/trash", &cookie)).await).await;
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e["name"].as_str().unwrap().to_string())
                    .collect::<Vec<_>>()
            }
        };

        // Sam's private folder, ordinary file inside it, file to trash.
        assert_eq!(
            call(
                &app,
                post(
                    "/api/v1/drives/photos/files/mkdir",
                    r#"{"path":"family/Vault","private":true}"#,
                    &sam_cookie,
                    &sam_csrf,
                ),
            )
            .await
            .status(),
            200
        );
        assert_eq!(
            call(
                &app,
                post(
                    "/api/v1/drives/photos/files/create",
                    r#"{"path":"family/Vault/note.txt"}"#,
                    &sam_cookie,
                    &sam_csrf,
                ),
            )
            .await
            .status(),
            200
        );
        assert_eq!(
            call(&app, del("family/Vault/note.txt", &sam_cookie, &sam_csrf))
                .await
                .status(),
            200
        );

        // Sam sees it; the Admin's trash list and reads do not.
        assert_eq!(trash_names(&sam_cookie).await.len(), 1);
        assert!(trash_names(&admin_cookie).await.is_empty());
        let entry = trash_names(&sam_cookie).await[0].clone();
        let res = call(
            &app,
            get(
                &format!("/api/v1/drives/photos/files/content?path=.luna-trash/{entry}"),
                &admin_cookie,
            ),
        )
        .await;
        assert_ne!(res.status(), 200, "admin read of trashed private child");

        // The boundary moves — the deleted child still isn't the Admin's.
        assert_eq!(
            call(
                &app,
                post(
                    "/api/v1/drives/photos/files/rename",
                    r#"{"path":"family/Vault","new_name":"Moved"}"#,
                    &sam_cookie,
                    &sam_csrf,
                ),
            )
            .await
            .status(),
            200
        );
        assert!(trash_names(&admin_cookie).await.is_empty());

        // The boundary itself is trashed and purged — provenance still holds.
        assert_eq!(
            call(&app, del("family/Moved", &sam_cookie, &sam_csrf))
                .await
                .status(),
            200
        );
        let folder = trash_names(&sam_cookie)
            .await
            .into_iter()
            .find(|n| n.ends_with("Moved"))
            .unwrap();
        let purge_body = format!(r#"{{"path":".luna-trash/{folder}"}}"#);
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/purge",
                &purge_body,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        assert!(crate::private::under(mount.path(), "").is_empty());
        assert_eq!(trash_names(&sam_cookie).await, vec![entry.clone()]);
        assert!(trash_names(&admin_cookie).await.is_empty());
        let res = call(
            &app,
            get(
                &format!("/api/v1/drives/photos/files/content?path=.luna-trash/{entry}"),
                &admin_cookie,
            ),
        )
        .await;
        assert_ne!(
            res.status(),
            200,
            "admin read after the boundary was purged"
        );
    }

    #[tokio::test]
    async fn create_makes_file_and_respects_grants() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/create",
                r#"{"path":"family/note.txt"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        assert!(mount.path().join("family/note.txt").is_file());
        assert_eq!(
            std::fs::read(mount.path().join("family/note.txt")).unwrap(),
            b""
        );

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/create",
                r#"{"path":"secret/nope.txt"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(!mount.path().join("secret/nope.txt").exists());

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/create",
                r#"{"path":"family/note.txt"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn multipart_path_mismatch_is_forbidden() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        let boundary = "----luna";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nsecret\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=family")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(!mount.path().join("secret/x.txt").exists());
    }

    #[tokio::test]
    async fn oversized_multipart_path_field_is_refused() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        let boundary = "----luna";
        let big_path = "a".repeat(MAX_PATH_FIELD_BYTES + 1);
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{big_path}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=family")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(!mount.path().join("family/a/a/x.txt").exists());
    }

    #[tokio::test]
    async fn list_without_drive_database_names_the_missing_database() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("photo.jpg"), b"jpeg").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::upsert_drive(
            &conn,
            "photos",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            mount.path().to_str().unwrap(),
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
        let res = call(
            &app,
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
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/files")
            .header("cookie", cookie_header(&session, &csrf))
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["code"], "missing_drive_db");
        let message = value["error"].as_str().unwrap();
        assert!(
            message.contains("database for this drive is missing"),
            "{message}"
        );
        assert!(
            message.contains("On the Drives page, remove this drive, then add it again."),
            "{message}"
        );
        assert!(
            !message.to_ascii_lowercase().contains("unplug"),
            "{message}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn grant_symlink_list_is_forbidden() {
        use std::os::unix::fs::symlink;
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("secret/note.txt"), b"nope").unwrap();
        symlink(
            mount.path().join("secret"),
            mount.path().join("family/escape"),
        )
        .unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_VIEW,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/files?path=family/escape")
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    fn list_trash_names(mount: &std::path::Path) -> Vec<String> {
        let trash = crate::drives::layout::Layout::detect(mount)
            .unwrap()
            .trash_dir(mount);
        std::fs::read_dir(trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != ".meta")
            .collect()
    }

    #[tokio::test]
    async fn trash_list_filters_by_write_grant() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (admin_session, admin_csrf) = auth_cookies(&admin_login);
        let admin_cookie = cookie_header(&admin_session, &admin_csrf);

        for path in ["family/a.txt", "secret/b.txt"] {
            let mut http = HttpReq::builder()
                .method(Method::DELETE)
                .uri(format!("/api/v1/drives/photos/files?path={path}"))
                .header("cookie", &admin_cookie)
                .header("x-csrf-token", &admin_csrf)
                .body(Body::empty())
                .unwrap();
            http.extensions_mut().insert(ConnectInfo(CLIENT));
            let res = call(&app, http).await;
            assert_eq!(res.status(), 200, "delete {path}");
        }

        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/trash")
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let items = v.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["original_path"], "family/a.txt");

        let secret_item = list_trash_names(mount.path())
            .into_iter()
            .find(|name| name.contains("b.txt"))
            .unwrap();
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/purge",
                &format!(r#"{{"path":".luna-trash/{secret_item}"}}"#),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn trash_list_forbidden_without_write_grant() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_VIEW,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/trash")
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn folder_download_returns_zip() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("album")).unwrap();
        std::fs::write(mount.path().join("album/beach.jpg"), b"photo").unwrap();
        let (_dir, app) = test_app(mount.path());
        let res = call(
            &app,
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
        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&admin_login);
        let cookie = cookie_header(&session, &csrf);

        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/files/content?path=album&download=1")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/zip")
        );
        let disposition = res
            .headers()
            .get(axum::http::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(disposition.contains("album.zip"), "{disposition}");
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(body.as_ref().starts_with(b"PK"));
    }

    #[tokio::test]
    async fn folder_without_download_flag_is_rejected() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("album")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let res = call(
            &app,
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
        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&admin_login);
        let cookie = cookie_header(&session, &csrf);
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri("/api/v1/drives/photos/files/content?path=album")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn scoped_upload_to_multi_level_missing_dirs_is_allowed() {
        // Regression: a write grant used to be refused whenever more than one
        // destination level was missing — the access check only resolved the
        // request's immediate parent, so `family/a/b` 403'd for a folder grant
        // on `family` even though the create path would have made both.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        // Chunked-upload create (POST /api/v1/uploads).
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/uploads",
                r#"{"drive_id":"photos","path":"family/a/b","name":"n.txt","size":3}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // Multipart upload (POST /api/v1/drives/{id}/files/upload).
        let boundary = "----luna";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nfamily/x/y\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"m.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=family/x/y")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200);
        // Small uploads land in the RAM dirty cache and flush on a blocking
        // task — poll briefly for the durable file.
        let dest = mount.path().join("family/x/y/m.txt");
        for _ in 0..100 {
            if dest.is_file() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(dest.is_file());

        // Outside the grant still refuses, even for missing paths.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/uploads",
                r#"{"drive_id":"photos","path":"secret/a/b","name":"n.txt","size":3}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(!mount.path().join("secret/a").exists());
    }

    async fn admin_cookie(app: &axum::Router) -> (String, String) {
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
        admin_login(app).await
    }

    /// Login-only variant for tests that already registered "max"
    /// (`admin_and_sam` registers him on the way to sam's session).
    async fn admin_login(app: &axum::Router) -> (String, String) {
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
        let (session, csrf) = auth_cookies(&res);
        (cookie_header(&session, &csrf), csrf)
    }

    async fn delete_path(app: &axum::Router, cookie: &str, csrf: &str, path: &str) -> String {
        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/drives/photos/files?path={path}"))
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(app, http).await;
        assert_eq!(res.status(), 200, "delete {path}");
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        v["trash_path"].as_str().unwrap().to_string()
    }

    async fn get_files(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        path: &str,
    ) -> axum::response::Response {
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri(format!(
                "/api/v1/drives/photos/files?path={}",
                urlencoding(path)
            ))
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        call(app, http).await
    }

    fn urlencoding(path: &str) -> String {
        path.replace('%', "%25")
            .replace('/', "%2F")
            .replace(' ', "%20")
    }

    #[tokio::test]
    async fn trash_browses_like_a_folder() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs/sub")).unwrap();
        std::fs::write(mount.path().join("docs/report.txt"), b"hi").unwrap();
        std::fs::write(mount.path().join("docs/sub/deep.txt"), b"deep").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;

        let docs_trash = delete_path(&app, &cookie, &csrf, "docs").await;
        assert!(docs_trash.starts_with(".luna-trash/"));

        // The trash root lists like a folder, annotated with origins.
        let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entries = entries.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry["kind"], "dir");
        assert_eq!(entry["original_name"], "docs");
        assert_eq!(entry["original_path"], "docs");
        assert!(entry["name"].as_str().unwrap() != "docs");

        // Trashed folders open and keep their real names inside.
        let res = get_files(&app, &cookie, &csrf, &docs_trash).await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entries = entries.as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let sub = entries
            .iter()
            .find(|e| e["name"] == "sub")
            .expect("sub dir listed by its real name");
        assert_eq!(sub["original_path"], "docs/sub");

        // Nested listing works too.
        let res = get_files(&app, &cookie, &csrf, &format!("{docs_trash}/sub")).await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(entries.as_array().unwrap()[0]["name"], "deep.txt");

        // Stat and content serve trash items read-only.
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!(
                    "/api/v1/drives/photos/files/stat?path={}",
                    urlencoding(&format!("{docs_trash}/report.txt"))
                ),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let stat: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(stat["trashed_from"], "docs/report.txt");

        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!(
                    "/api/v1/drives/photos/files/content?path={}&download=1",
                    urlencoding(&format!("{docs_trash}/report.txt"))
                ),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let disposition = res
            .headers()
            .get(axum::http::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(disposition.contains("report.txt"), "{disposition}");
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"hi");

        // A trashed folder still downloads as a zip under its old name.
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!(
                    "/api/v1/drives/photos/files/content?path={}&download=1",
                    urlencoding(&docs_trash)
                ),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let disposition = res
            .headers()
            .get(axum::http::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(disposition.contains("docs.zip"), "{disposition}");

        // Writes into trash stay refused.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":".luna-trash/newdir"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_ne!(res.status(), 200);
    }

    #[tokio::test]
    async fn trash_folder_view_filters_by_origin_grant() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (admin_session, admin_csrf) = auth_cookies(&admin_login);
        let admin_cookie = cookie_header(&admin_session, &admin_csrf);
        delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
        let secret_trash = delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

        // Sam sees only the entry whose origin she could edit.
        let res = get_files(&app, &sam_cookie, &sam_csrf, ".luna-trash").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entries = entries.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["original_path"], "family/a.txt");

        // And she cannot open or read the other entry.
        let res = get_files(&app, &sam_cookie, &sam_csrf, &secret_trash).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!(
                    "/api/v1/drives/photos/files/content?path={}",
                    urlencoding(&secret_trash)
                ),
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn trash_root_lists_empty_when_never_used() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn trash_root_stats_empty_when_never_used() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/drives/photos/files/stat?path=.luna-trash",
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let stat: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(stat["name"], "Trash");
        assert_eq!(stat["kind"], "dir");
    }

    #[tokio::test]
    async fn purging_the_trash_root_empties_it() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("a.txt"), b"a").unwrap();
        std::fs::write(mount.path().join("b.txt"), b"b").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let trash_a = delete_path(&app, &cookie, &csrf, "a.txt").await;
        let trash_b = delete_path(&app, &cookie, &csrf, "b.txt").await;

        // Purging the trash root itself removes every entry.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/purge",
                r#"{"path":".luna-trash"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 0);
        for entry in [&trash_a, &trash_b] {
            let res = get_files(&app, &cookie, &csrf, entry).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{entry} is gone");
        }

        // Emptying an already-empty trash is a quiet no-op.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/purge",
                r#"{"path":".luna-trash"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn renaming_a_trash_entry_retitles_it() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/old.txt"), b"x").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let trash_rel = delete_path(&app, &cookie, &csrf, "docs/old.txt").await;

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &serde_json::json!({"path": trash_rel, "new_name": "new.txt"}).to_string(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // The listing shows the retitled name, never the nonce-prefixed
        // on-disk entry name.
        let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entries = entries.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["original_name"], "new.txt");
        assert_eq!(entries[0]["original_path"], "docs/new.txt");
        assert!(entries[0]["name"].as_str().unwrap().ends_with("-new.txt"));
    }

    async fn resolve_path(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        path: &str,
    ) -> axum::response::Response {
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri(format!(
                "/api/v1/drives/photos/files/resolve?path={}",
                urlencoding(path)
            ))
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        call(app, http).await
    }

    #[tokio::test]
    async fn old_links_follow_a_renamed_folder_until_it_is_trashed() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("Taxes/2024")).unwrap();
        std::fs::write(mount.path().join("Taxes/2024/w2.pdf"), b"x").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                r#"{"path":"Taxes","new_name":"Old taxes"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        let res = resolve_path(&app, &cookie, &csrf, "Taxes/2024/w2.pdf").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let hit: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(hit["drive_id"], "photos");
        assert_eq!(hit["path"], "Old taxes/2024/w2.pdf");
        assert_eq!(hit["kind"], "file");

        // A path that still exists is never forwarded.
        let res = resolve_path(&app, &cookie, &csrf, "Old taxes").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // Trash ends the trail.
        delete_path(&app, &cookie, &csrf, &urlencoding("Old taxes")).await;
        let res = resolve_path(&app, &cookie, &csrf, "Taxes/2024/w2.pdf").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn forwarding_never_reveals_a_folder_the_member_cannot_see() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/plan.txt"), b"x").unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "family", crate::access::CAP_VIEW);

        // The file moves somewhere Sam has no grant.
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::files::move_rel(&conn, "photos", "family/plan.txt", "secret/plan.txt").unwrap();

        let res = resolve_path(&app, &sam_cookie, &sam_csrf, "family/plan.txt").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // Once Sam can see the new location, her old link follows it.
        grant_path(&dir, &sam_id, "secret", crate::access::CAP_VIEW);
        let res = resolve_path(&app, &sam_cookie, &sam_csrf, "family/plan.txt").await;
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn moving_a_trash_item_out_uses_the_original_name() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("inbox")).unwrap();
        std::fs::write(mount.path().join("note.txt"), b"back").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let trash_rel = delete_path(&app, &cookie, &csrf, "note.txt").await;

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/jobs",
                &serde_json::json!({
                    "kind": "move",
                    "from_drive": "photos",
                    "from_path": trash_rel,
                    "to_drive": "photos",
                    "to_path": "inbox",
                })
                .to_string(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let job: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let job_id = job["id"].as_str().unwrap().to_string();

        for _ in 0..200 {
            let res = call(
                &app,
                json_req(
                    Method::GET,
                    &format!("/api/v1/jobs/{job_id}"),
                    "",
                    Some(&cookie),
                    Some(&csrf),
                ),
            )
            .await;
            let body = axum::body::to_bytes(res.into_body(), 1 << 20)
                .await
                .unwrap();
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if v["state"] == "done" {
                break;
            }
            assert_ne!(v["state"], "error", "{}", v["error"]);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let names: Vec<String> = std::fs::read_dir(mount.path().join("inbox"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        // The destination carries the original name — never the
        // `{nonce}-` storage prefix.
        assert_eq!(names, vec!["note.txt".to_string()]);

        let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn member_actions_follow_trash_origins() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let admin_login = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (admin_session, admin_csrf) = auth_cookies(&admin_login);
        let admin_cookie = cookie_header(&admin_session, &admin_csrf);
        let family_trash = delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
        let secret_trash = delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

        // Edit rights on the origin carry over: Sam can rename the entry
        // whose origin she could edit…
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &serde_json::json!({"path": family_trash, "new_name": "a2.txt"}).to_string(),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // …but not the one from a folder she has no grant on.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &serde_json::json!({"path": secret_trash, "new_name": "b2.txt"}).to_string(),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    /// Grant `user_id` a path-scoped member row on the test "photos" drive.
    fn grant_path(dir: &tempfile::TempDir, user_id: &str, path: &str, caps: crate::access::Caps) {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: uuid::Uuid::new_v4().to_string(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: path.into(),
                album_id: String::new(),
                user_id: user_id.into(),
                caps,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    async fn stat_path(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        path: &str,
    ) -> axum::response::Response {
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri(format!(
                "/api/v1/drives/photos/files/stat?path={}",
                urlencoding(path)
            ))
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        call(app, http).await
    }

    #[tokio::test]
    async fn member_inspect_never_walks_up_to_a_deep_grant() {
        // Sam may read docs/inner only. WebDAV walks the ancestors so she can
        // reach it — the HTTP files API must not: `docs` stays invisible to
        // stat and to listing, and nothing about siblings leaks.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs/inner")).unwrap();
        std::fs::write(mount.path().join("docs/inner/file.pdf"), b"x").unwrap();
        std::fs::write(mount.path().join("docs/sibling.txt"), b"s").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "docs/inner", crate::access::CAP_VIEW);

        for path in ["docs", "docs/sibling.txt", "nope/missing.txt"] {
            let res = stat_path(&app, &sam_cookie, &sam_csrf, path).await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "stat {path}");
            let res = get_files(&app, &sam_cookie, &sam_csrf, path).await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "list {path}");
        }

        // The drive root opens (a member row exists on this drive) but lists
        // nothing — `docs` is only an ancestor of her grant, so it hides.
        let res = get_files(&app, &sam_cookie, &sam_csrf, "").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(entries.as_array().unwrap().is_empty(), "{entries}");

        // The granted folder itself inspects and lists normally.
        let res = stat_path(&app, &sam_cookie, &sam_csrf, "docs/inner").await;
        assert_eq!(res.status(), 200);
        let res = get_files(&app, &sam_cookie, &sam_csrf, "docs/inner").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let names: Vec<_> = entries
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["file.pdf".to_string()]);
    }

    #[tokio::test]
    async fn member_file_grant_lists_one_entry() {
        // A grant on a file — same shape the public share page gives guests:
        // listing the file returns the file itself as a single row, while its
        // parent folder stays closed.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("pics")).unwrap();
        std::fs::write(mount.path().join("pics/a.jpg"), b"jpg").unwrap();
        std::fs::write(mount.path().join("pics/b.jpg"), b"jpg2").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "pics/a.jpg", crate::access::CAP_VIEW);

        let res = get_files(&app, &sam_cookie, &sam_csrf, "pics/a.jpg").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entries = entries.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "a.jpg");

        // The parent is not hers — listing it is forbidden, and stat on the
        // sibling (which exists) answers the same 403 as a missing path.
        let res = get_files(&app, &sam_cookie, &sam_csrf, "pics").await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = stat_path(&app, &sam_cookie, &sam_csrf, "pics/b.jpg").await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // The drive root opens (she has a row on this drive) but lists no
        // ancestor of her grant — the chain to `a.jpg` stays invisible.
        let res = get_files(&app, &sam_cookie, &sam_csrf, "").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(entries.as_array().unwrap().is_empty(), "{entries}");
    }

    #[tokio::test]
    async fn member_upload_only_grant_is_view_blind() {
        // A drop folder: Sam can save into `drop` but never see what's in it.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        std::fs::write(mount.path().join("drop/secret.txt"), b"s").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "drop", crate::access::CAP_UPLOAD);

        // The landing itself resolves (stat works so the UI can anchor on it),
        // but its listing is empty — the upload grant carries no read.
        let res = stat_path(&app, &sam_cookie, &sam_csrf, "drop").await;
        assert_eq!(res.status(), 200);
        let res = get_files(&app, &sam_cookie, &sam_csrf, "drop").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 0);

        // Children stay closed: stat and content both refuse.
        let res = stat_path(&app, &sam_cookie, &sam_csrf, "drop/secret.txt").await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/drives/photos/files/content?path=drop%2Fsecret.txt",
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn member_upload_overwrite_needs_edit() {
        // Upload-only members drop new files — replacing an existing one is
        // an edit, even when the client passes overwrite=1.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        std::fs::write(mount.path().join("drop/x.txt"), b"old").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "drop", crate::access::CAP_UPLOAD);

        let boundary = "----luna";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nnew\r\n--{boundary}--\r\n"
        );
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=drop&overwrite=1")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(body))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            std::fs::read(mount.path().join("drop/x.txt")).unwrap(),
            b"old"
        );

        // Same shape with the real grants: a full-access member may replace.
        // (Small uploads buffer through the RAM dirty overlay before the
        // background flush lands them — read back through the API.)
        grant_path(&dir, &sam_id, "docs", crate::access::CAP_ALL);
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/x.txt"), b"old").unwrap();
        let mut http = HttpReq::builder()
            .method(Method::POST)
            .uri("/api/v1/drives/photos/files/upload?path=docs&overwrite=1")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::from(format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nnew\r\n--{boundary}--\r\n"
            )))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/drives/photos/files/content?path=docs%2Fx.txt",
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(&body[..], b"new");
    }

    #[tokio::test]
    async fn member_trash_zip_skips_foreign_origins() {
        // The trash zip mirrors the filtered listing: entries whose origin
        // Sam cannot edit never enter the archive.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
        let (dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        grant_path(&dir, &sam_id, "family", crate::access::CAP_ALL);

        let res = call(
            &app,
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
        delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
        delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

        // Download the whole trash root as a zip.
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/drives/photos/files/content?path=.luna-trash&download=1",
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(body)).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n.contains("a.txt")),
            "own trashed file is in the zip: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("b.txt")),
            "foreign trashed file stays out: {names:?}"
        );
    }

    /// GET helper for endpoints outside `/files` — same cookies, same guard.
    async fn get_json(
        app: &axum::Router,
        cookie: &str,
        csrf: &str,
        uri: &str,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let mut http = HttpReq::builder()
            .method(Method::GET)
            .uri(uri)
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(app, http).await;
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn member_without_share_cap_cannot_redistribute() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;

        // Full content access on docs/ — but no share capability.
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g-docs".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "docs".into(),
                    album_id: String::new(),
                    user_id: sam_id.clone(),
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        // Adding people is manage-level: refused without CAP_SHARE.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/members",
                &format!(
                    r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{sam_id}","caps":"view"}}"#
                ),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST); // self-grant

        // Register a second member to share with.
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/users",
                r#"{"username":"kim","display_name":"Kim","password":"hunter22hunter1","role":"user"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let kim_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/members",
                &format!(
                    r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{kim_id}","caps":"view"}}"#
                ),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // A public link is manage-level too.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/links",
                r#"{"kind":"path","drive_id":"photos","path":"docs","caps":"view"}"#,
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // The roster is hidden from members without share rights — they see
        // that sharing exists (counts), never who or which links.
        let (status, subj) = get_json(
            &app,
            &sam_cookie,
            &sam_csrf,
            "/api/v1/access/subject?kind=path&drive_id=photos&path=docs",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(subj["my_caps"], "full");
        assert!(subj["members"].as_array().unwrap().is_empty());
        assert!(subj["links"].as_array().unwrap().is_empty());

        // With CAP_SHARE granted, both doors open.
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::update_access_member_caps(
                &conn,
                "g-docs",
                crate::access::CAP_ALL | crate::access::CAP_SHARE,
            )
            .unwrap();
        }
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/members",
                &format!(
                    r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{kim_id}","caps":"view"}}"#
                ),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn summary_space_follows_view_grants() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "family".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_UPLOAD,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }

        // Upload-only: the drive is reachable for drop-offs, but capacity —
        // drive metadata — is not.
        let (status, summary) = get_json(
            &app,
            &sam_cookie,
            &sam_csrf,
            "/api/v1/drives/photos/summary",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(summary["mounted"], true);
        assert!(summary["total_bytes"].is_null());
        assert!(summary["free_bytes"].is_null());
        assert!(summary["used_bytes"].is_null());

        // Any view-bearing grant on the drive earns the storage readout.
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::update_access_member_caps(
                &conn,
                "g1",
                crate::access::CAP_VIEW | crate::access::CAP_UPLOAD,
            )
            .unwrap();
        }
        let (status, summary) = get_json(
            &app,
            &sam_cookie,
            &sam_csrf,
            "/api/v1/drives/photos/summary",
        )
        .await;
        assert_eq!(status, 200);
        assert!(summary["total_bytes"].is_number());
        assert!(summary["free_bytes"].is_number());
    }

    #[tokio::test]
    async fn recents_reflect_renames_without_duplicates_and_prune_deletes() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;

        // 1. Create a file whiteboard.excalidraw on the photos drive
        let file_path = mount.path().join("whiteboard.excalidraw");
        std::fs::write(&file_path, b"drawing").unwrap();

        // 2. Record it in recents
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/me/recents",
                &serde_json::to_string(&serde_json::json!({
                    "driveId": "photos",
                    "path": "whiteboard.excalidraw",
                    "kind": "file"
                }))
                .unwrap(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // 3. GET /api/v1/me/recents returns whiteboard.excalidraw
        let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
        assert_eq!(status, 200);
        let list = recents.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["path"], "whiteboard.excalidraw");

        // 4. Rename whiteboard.excalidraw to 67.excalidraw via Luna API
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &serde_json::to_string(&serde_json::json!({
                    "path": "whiteboard.excalidraw",
                    "new_name": "67.excalidraw"
                }))
                .unwrap(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // 5. User accesses 67.excalidraw (simulating navigation)
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/me/recents",
                &serde_json::to_string(&serde_json::json!({
                    "driveId": "photos",
                    "path": "67.excalidraw",
                    "kind": "file"
                }))
                .unwrap(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // 6. GET /api/v1/me/recents: expects 67.excalidraw and NO duplicates
        let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
        assert_eq!(status, 200);
        let list = recents.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["path"], "67.excalidraw");

        // 7. Delete 67.excalidraw to trash
        let res = call(
            &app,
            json_req(
                Method::DELETE,
                "/api/v1/drives/photos/files?path=67.excalidraw",
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        // 8. GET /api/v1/me/recents: 67.excalidraw should NOT be shown
        let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
        assert_eq!(status, 200);
        let list = recents.as_array().unwrap();
        assert_eq!(list.len(), 0);

        // 9. Create another file and delete it on disk directly (out-of-band)
        let ghost_path = mount.path().join("ghost.txt");
        std::fs::write(&ghost_path, b"ghost").unwrap();
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/me/recents",
                &serde_json::to_string(&serde_json::json!({
                    "driveId": "photos",
                    "path": "ghost.txt",
                    "kind": "file"
                }))
                .unwrap(),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        // Delete directly on disk
        std::fs::remove_file(&ghost_path).unwrap();
        // GET /api/v1/me/recents detects it is missing and prunes it
        let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
        assert_eq!(status, 200);
        assert_eq!(recents.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn recents_check_drive_entries() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let post = |drive: &str| {
            json_req(
                Method::POST,
                "/api/v1/me/recents",
                &serde_json::to_string(&serde_json::json!({ "driveId": drive, "path": "" }))
                    .unwrap(),
                Some(&cookie),
                Some(&csrf),
            )
        };
        // A drive that doesn't exist is refused, not stored.
        let res = call(&app, post("no-such-drive")).await;
        assert_eq!(res.status(), 404);
        // A real drive is stored and listed as a drive.
        let res = call(&app, post("photos")).await;
        assert_eq!(res.status(), 200);
        let (_, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
        let list = recents.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["kind"], "drive");
    }
}
