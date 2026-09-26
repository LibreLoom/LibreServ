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
}

#[derive(Deserialize)]
struct CreateBody {
    /// Relative path of the new empty file (parent must already exist).
    path: String,
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
        .route("/api/v1/drives/{id}/files/mkdir", post(mkdir_entry))
        .route("/api/v1/drives/{id}/files/create", post(create_entry))
        .route("/api/v1/drives/{id}/files/rename", post(rename_entry))
        .route("/api/v1/drives/{id}/files/restore", post(restore_entry))
        .route("/api/v1/drives/{id}/files/purge", post(purge_entry))
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
            original_name: None,
            original_path: None,
            link_target: None,
            caps: stamped_caps(state, user, id, rel),
            home: false,
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
        original_name: None,
        original_path: None,
        link_target: stat.link_target,
        caps: stamped_caps(state, user, id, rel),
        home: false,
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
        let original = meta.get(entry_name).map(|orig| match rest {
            Some(rest) => format!("{orig}/{rest}"),
            None => orig.clone(),
        });
        // Everyone filters by origin caps — including admins. A member-home
        // origin answers "0 caps" for admins, keeping deleted member files
        // private in trash too. Only entries with no origin metadata at all
        // stay admin-visible (their provenance is unknowable anyway).
        let visible = match original.as_deref() {
            Some(o) => crate::auth::has_cap(user, &conn, id, o, crate::access::CAP_EDIT),
            None => user.role == "admin",
        };
        if !visible {
            return false;
        }
        // Trash inherits the origin's access row, so the caller's caps on
        // a trashed entry are their caps on where it came from — the same
        // rule `caps_on_path` applies to `.luna-trash` paths.
        entry.caps = crate::access::caps_to_str(match original.as_deref() {
            Some(o) => crate::auth::caps_on_path(user, &conn, id, o),
            None => crate::access::CAP_MANAGE,
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
        if user.role != "admin" {
            entries.retain(|entry| {
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
            // The member's own home dir is Luna-hidden (`.luna-<uuid>-members`
            // never appears in directory reads), so inject it at the drive
            // root — otherwise their only writable folder would be
            // unreachable. `name` carries the full rel path so the row
            // navigates straight to the home without exposing the container.
            if rel.is_empty()
                && crate::member_home::home_on_drive(&conn, &user.id, id)
                && let Ok(drive) = files::drive_root(&conn, id)
                && let Some(home_rel) = crate::member_home::home_rel(&conn, id, &user.username)
            {
                let disk = std::path::PathBuf::from(&drive.mount_point).join(&home_rel);
                if let Ok(meta) = std::fs::symlink_metadata(&disk)
                    && meta.is_dir()
                {
                    entries.push(FileEntry {
                        hidden: true,
                        name: home_rel,
                        kind: "dir".into(),
                        size: 0,
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        saving: false,
                        original_name: None,
                        original_path: None,
                        link_target: None,
                        caps: crate::access::caps_to_str(crate::access::CAP_MANAGE),
                        home: true,
                    });
                }
            }
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
    // copies) is not a user file — never stat it. Member homes are the
    // exception: hidden from parents but addressable by their owner.
    if !in_trash
        && (files::is_blocked_user_path(&rel) || crate::backup::protect::is_protected_store(&rel))
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
    // totals would disclose them, even to admins (member-home trash stays
    // invisible). A specific entry's aggregates are fine: everything under
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
            if user.role == "admin" || rel != files::TRASH_API_ALIAS {
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
    .map_err(map_files_err)?;
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
    } else if crate::member_home::is_home_root(&rel) {
        "home".to_string()
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
                // ORIGIN the caller could still edit, and an entry with a
                // member-home origin never ships to an admin either. Entries
                // with no recorded origin stay admin-only, like the listing.
                files::write_folder_zip_including_trash(&conn, &id, &rel, &mut file, |child| {
                    let origin = files::trash_original_path(&conn, &id, child).ok().flatten();
                    if is_admin {
                        !origin
                            .as_deref()
                            .is_some_and(crate::member_home::is_member_home_path)
                    } else {
                        origin.is_some_and(|o| {
                            !o.is_empty()
                                && crate::auth::has_cap(
                                    &user,
                                    &conn,
                                    &id,
                                    &o,
                                    crate::access::CAP_EDIT,
                                )
                        })
                    }
                })
            } else {
                files::write_folder_zip(&conn, &id, &rel, &mut file, |child| {
                    is_admin || crate::auth::can_inspect_path(&user, &conn, &id, child)
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
        path.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("download"))
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

fn invalidate_parent_listing(state: &AppState, drive_id: &str, rel: &str) {
    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    state.ram_cache.invalidate_listing(drive_id, parent);
    state.ram_cache.invalidate_listing_tree(drive_id, rel);
}

async fn delete_entry(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let rel = query.path.unwrap_or_default();
    let rel = rel.trim().trim_matches('/').to_string();
    if crate::member_home::is_home_root(&rel) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Your home folder holds everything you save here — it can't be deleted.",
        ));
    }
    check_access(&state, &user, &id, &rel, crate::access::CAP_EDIT)?;
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
    check_access(&state, &user, &id, &rel, crate::access::CAP_UPLOAD)?;
    with_db(&state, |conn| files::mkdir(conn, &id, &rel)).map_err(|e| match e {
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
    check_access(&state, &user, &id, &rel, crate::access::CAP_UPLOAD)?;
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
    if crate::member_home::is_home_root(body.path.trim().trim_matches('/')) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Your home folder keeps its name — it can't be renamed.",
        ));
    }
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
        Ok::<_, FilesError>(root.join(&new_rel).is_dir())
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
    // Same origin-caps rule for everyone: member-home origins stay private
    // from admins; entries with no recorded origin stay admin-only.
    let visible: Vec<_> = entries
        .into_iter()
        .filter(|entry| {
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
        // Empty trash. Members purge only the entries they can see (their
        // own origins); admins purge the whole bin — including member-home
        // origins they cannot see — because "empty the trash" is an explicit
        // destructive choice over everything the drive holds. Otherwise
        // deleted-member homes would linger invisibly forever.
        if user.role == "admin" {
            let entries =
                with_db(&state, |conn| files::list_trash(conn, &id)).map_err(map_files_err)?;
            for entry in entries {
                let rel = format!("{}/{}", files::TRASH_API_ALIAS, entry.name);
                with_db(&state, |conn| files::purge_trash(conn, &id, &rel))
                    .map_err(map_files_err)?;
            }
        } else {
            let Json(entries) = list_trash_view(&state, &user, &id, &body.path)?;
            for entry in entries {
                let rel = format!("{}/{}", files::TRASH_API_ALIAS, entry.name);
                with_db(&state, |conn| files::purge_trash(conn, &id, &rel))
                    .map_err(map_files_err)?;
            }
        }
        return Ok(Json(json!({ "ok": true })));
    }
    check_trash_item(&state, &user, &id, &body.path)?;
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
                if files::is_blocked_create_path(&name) {
                    return Err(json_error(
                        StatusCode::BAD_REQUEST,
                        "That file name can't be used. Try renaming it.",
                    ));
                }
                let dir = with_db(&state, |conn| files::dest_dir_create(conn, &id, &dest_rel))
                    .map_err(map_files_err)?;
                let dest = dir.join(&name);
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
                            .accept_dirty(&id, &rel, &name, bytes.clone())
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
                            let flush_overwrite = may_overwrite;
                            let flush_user = user.id.clone();
                            let flush_coverage = query.coverage.clone();
                            let rt = tokio::runtime::Handle::current();
                            tokio::task::spawn_blocking(move || {
                                let mount = {
                                    let Ok(conn) = flush_state.db.lock() else {
                                        flush_state.ram_cache.remove_dirty(&flush_id, &flush_rel);
                                        return;
                                    };
                                    match crate::files::drive_root(&conn, &flush_id) {
                                        Ok(d) => std::path::PathBuf::from(d.mount_point),
                                        Err(_) => {
                                            flush_state
                                                .ram_cache
                                                .remove_dirty(&flush_id, &flush_rel);
                                            return;
                                        }
                                    }
                                };
                                if let Err(e) = flush_state.ram_cache.flush_dirty_to_disk(
                                    &flush_id,
                                    &flush_rel,
                                    &mount,
                                    flush_overwrite,
                                ) {
                                    if let Ok(conn) = flush_state.db.lock() {
                                        files::note_write_failure(&conn, &flush_id, &e.to_string());
                                    }
                                    flush_state.ram_cache.remove_dirty(&flush_id, &flush_rel);
                                    return;
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
                                original_name: None,
                                original_path: None,
                                link_target: None,
                                caps: String::new(),
                                home: false,
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
                    original_name: None,
                    original_path: None,
                    link_target: None,
                    caps: stamped_caps(&state, &user, &id, &rel),
                    home: false,
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
    let original = files::trash_original_path(&conn, drive_id, trash_rel).map_err(map_files_err)?;
    // Admins reach everything except member-home origins — the same privacy
    // boundary the caps engine enforces everywhere else.
    if user.role == "admin"
        && !original
            .as_deref()
            .is_some_and(crate::member_home::is_member_home_path)
    {
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
        FilesError::UnknownDrive => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.",
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
        FilesError::Path(luna_core::path::PathError::NotFound(_)) => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find that file or folder.",
        ),
        FilesError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => json_error(
            StatusCode::NOT_FOUND,
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
            "Luna couldn't read this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.",
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
            // Sam's home lives on another drive — on `photos` he holds only
            // a view grant, so the trash listing must refuse him. (A member
            // whose home *is* on this drive may list, filtered to what they
            // could edit.)
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(&conn, "other", "Other", "as_is", "ext4", "sdb", "").unwrap();
            crate::db::set_user_home_drive(&conn, &sam_id, "other").unwrap();
        }
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
        assert_eq!(entries.as_array().unwrap().len(), 0);

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
        assert_eq!(entries.as_array().unwrap().len(), 0);
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

    #[tokio::test]
    async fn admin_trash_zip_keeps_member_home_origins_out() {
        // The admin zip used to include every trash entry wholesale. It must
        // hold the same origin-ACL line as the listing: entries trashed out
        // of a member home stay private even to admins, while the admin's
        // own deletions still download.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        std::fs::write(mount.path().join(format!("{home}/diary.txt")), b"dear").unwrap();

        delete_path(&app, &sam_cookie, &sam_csrf, &format!("{home}/diary.txt")).await;
        delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;

        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/drives/photos/files/content?path=.luna-trash&download=1",
                "",
                Some(&admin_cookie),
                Some(&admin_csrf),
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
            "admin's own trashed file is in the zip: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.contains("diary")),
            "member-home trash never reaches an admin zip: {names:?}"
        );
    }

    // ---------------------------------------------------------------------
    // Member homes
    // ---------------------------------------------------------------------

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

    /// The expected home path for `username` on a mounted drive — derived
    /// from the drive's marker prefix, same as the production helper.
    fn expected_home_rel(mount: &std::path::Path, username: &str) -> String {
        let prefix = crate::drives::drive_db::prefix_for(mount).unwrap();
        format!(
            "{}/{username}",
            crate::member_home::members_dir_name(&prefix)
        )
    }

    /// Create the member's home by hitting `/me` — the lazy materialization
    /// a real member gets on their first visit.
    async fn materialize_home(app: &axum::Router, cookie: &str, csrf: &str) -> String {
        let (status, me) = get_json(app, cookie, csrf, "/api/v1/auth/me").await;
        assert_eq!(status, 200);
        let home = me["home"]["path"].as_str().unwrap().to_string();
        assert_eq!(me["home"]["drive_id"], "photos");
        assert_eq!(me["home"]["ready"], true);
        home
    }

    #[tokio::test]
    async fn member_home_injected_for_owner_hidden_from_admin() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        assert_eq!(home, expected_home_rel(mount.path(), "sam"));
        assert!(mount.path().join(&home).is_dir());

        // The member's root listing carries their home — hidden flag, manage
        // caps, reachable like any other folder.
        let res = get_files(&app, &sam_cookie, &sam_csrf, "").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let entry = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == home)
            .expect("member sees their home at the drive root");
        assert_eq!(entry["caps"], "full+share");
        assert_eq!(entry["kind"], "dir");

        // The admin's root listing shows no member-home names at all.
        let res = get_files(&app, &admin_cookie, &admin_csrf, "").await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            !entries
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"].as_str().is_some_and(|n| n.starts_with(".luna-"))),
            "admin never sees .luna-* entries"
        );

        // Owner browses in; admin gets the same 403 as any ungranted path.
        let res = get_files(&app, &sam_cookie, &sam_csrf, &home).await;
        assert_eq!(res.status(), 200);
        let res = get_files(&app, &admin_cookie, &admin_csrf, &home).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let (status, _) = get_json(
            &app,
            &admin_cookie,
            &admin_csrf,
            &format!(
                "/api/v1/drives/photos/files/stat?path={}",
                urlencoding(&home)
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Another member gets the same wall.
        let res = get_files(
            &app,
            &sam_cookie,
            &sam_csrf,
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f",
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn member_home_root_cannot_be_mutated_but_children_can() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        assert_eq!(home, expected_home_rel(mount.path(), "sam"));

        // The root refuses rename, delete, and job moves — even for its owner.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &format!(r#"{{"path":"{home}","new_name":"elsewhere"}}"#),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!(
                "/api/v1/drives/photos/files?path={}",
                urlencoding(&home)
            ))
            .header("cookie", &sam_cookie)
            .header("x-csrf-token", &sam_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/jobs",
                &format!(
                    r#"{{"kind":"move","from_drive":"photos","from_path":"{home}","to_drive":"photos","to_path":""}}"#
                ),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);

        // Inside the home, normal file work proceeds: mkdir, rename, delete.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/mkdir",
                &format!(r#"{{"path":"{home}/docs"}}"#),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/drives/photos/files/rename",
                &format!(r#"{{"path":"{home}/docs","new_name":"papers"}}"#),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        assert!(mount.path().join(format!("{home}/papers")).is_dir());
    }

    #[tokio::test]
    async fn member_home_trash_stays_private() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        std::fs::write(mount.path().join(format!("{home}/diary.txt")), b"dear").unwrap();

        delete_path(&app, &sam_cookie, &sam_csrf, &format!("{home}/diary.txt")).await;

        // Sam's trash shows his file; the admin's trash does not.
        let (status, trash) =
            get_json(&app, &sam_cookie, &sam_csrf, "/api/v1/drives/photos/trash").await;
        assert_eq!(status, 200);
        assert_eq!(trash.as_array().unwrap().len(), 1);
        assert_eq!(trash[0]["original_path"], format!("{home}/diary.txt"));

        let (status, trash) = get_json(
            &app,
            &admin_cookie,
            &admin_csrf,
            "/api/v1/drives/photos/trash",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(trash.as_array().unwrap().len(), 0);
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
    async fn drive_wide_link_cannot_walk_into_member_home() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        assert_eq!(home, expected_home_rel(mount.path(), "sam"));
        std::fs::write(mount.path().join(format!("{home}/secret.txt")), b"shh").unwrap();

        // A view link on the whole drive.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/links",
                r#"{"kind":"path","drive_id":"photos","path":"","caps":"view"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let token = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();

        for probe in [home.clone(), format!("{home}/secret.txt")] {
            let res = call(
                &app,
                json_req(
                    Method::GET,
                    &format!("/s/{token}/list?path={}", urlencoding(&probe)),
                    "",
                    None,
                    None,
                ),
            )
            .await;
            assert_eq!(
                res.status(),
                StatusCode::NOT_FOUND,
                "guest link must not reach {probe}"
            );
        }

        // But a link minted on the home itself works — the owner chooses to
        // publish their own space.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/links",
                &format!(r#"{{"kind":"path","drive_id":"photos","path":"{home}","caps":"view"}}"#),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let token = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let res = call(
            &app,
            json_req(Method::GET, &format!("/s/{token}/list"), "", None, None),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let entries = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["entries"]
            .as_array()
            .unwrap()
            .clone();
        assert!(entries.iter().any(|e| e["name"] == "secret.txt"));
    }

    #[tokio::test]
    async fn member_home_drive_switch_moves_files_safely() {
        let mount = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            let prefix = luna_core::marker::pick_prefix(vault.path()).unwrap();
            crate::drives::drive_db::create(
                vault.path(),
                &luna_core::marker::Marker::new("vault", "Vault"),
                &prefix,
            )
            .unwrap();
            crate::db::upsert_drive(
                &conn,
                "vault",
                "Vault",
                "as_is",
                "ext4",
                "sdb",
                vault.path().to_str().unwrap(),
            )
            .unwrap();
        }
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        std::fs::write(mount.path().join(format!("{home}/keepsake.txt")), b"keep").unwrap();

        // Members reject the admin-only endpoint.
        let res = call(
            &app,
            json_req(
                Method::GET,
                "/api/v1/users/member-home",
                "",
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // Switch: jobs enqueue and the recorded drive only flips when the
        // move finishes.
        let res = call(
            &app,
            json_req(
                Method::PUT,
                "/api/v1/users/member-home",
                r#"{"drive_id":"vault"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let job_ids: Vec<String> =
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| j.as_str().unwrap().to_string())
                .collect();
        assert_eq!(job_ids.len(), 1);

        // Wait for the internal move job (tiny tempdir → fast).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let (status, job) = get_json(
                &app,
                &admin_cookie,
                &admin_csrf,
                &format!("/api/v1/jobs/{}", job_ids[0]),
            )
            .await;
            assert_eq!(status, 200);
            match job["state"].as_str().unwrap() {
                "done" => break,
                "error" | "cancelled" => panic!("home migration job failed: {job}"),
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "home migration job timed out"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }

        // Files arrived on vault under the new drive's members container;
        // the old home is gone from photos (parked in its trash); the
        // member record points at vault.
        let vault_home = expected_home_rel(vault.path(), "sam");
        assert!(
            vault
                .path()
                .join(format!("{vault_home}/keepsake.txt"))
                .exists()
        );
        assert!(!mount.path().join(&home).exists());
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            let row = crate::db::get_user(&conn, &sam_id).unwrap().unwrap();
            assert_eq!(row.home_drive_id, "vault");
        }
        let (status, mh) = get_json(
            &app,
            &admin_cookie,
            &admin_csrf,
            "/api/v1/users/member-home",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(mh["drive_id"], "vault");
        assert_eq!(mh["configured"], true);
    }

    #[tokio::test]
    async fn deleted_member_home_parks_in_trash_privately() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        std::fs::write(mount.path().join(format!("{home}/letters.txt")), b"x").unwrap();

        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/users/{sam_id}"))
            .header("cookie", &admin_cookie)
            .header("x-csrf-token", &admin_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200);

        // The home left the drive root and sits in its trash — hidden from
        // the admin's trash listing because its origin is member-private.
        assert!(!mount.path().join(&home).exists());
        let trashed: Vec<_> = std::fs::read_dir(
            crate::drives::drive_db::prefix_for(mount.path())
                .map(|p| mount.path().join(format!("{p}-trash")))
                .unwrap(),
        )
        .unwrap()
        .flatten()
        .collect();
        assert_eq!(trashed.len(), 1, "home dir lands in the drive's trash");

        let (status, trash) = get_json(
            &app,
            &admin_cookie,
            &admin_csrf,
            "/api/v1/drives/photos/trash",
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(trash.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn member_home_link_is_invisible_to_admins() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;
        std::fs::create_dir_all(mount.path().join(format!("{home}/docs"))).unwrap();

        // Sam mints a link inside his own home — that's his right.
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/access/links",
                &format!(
                    r#"{{"kind":"path","drive_id":"photos","path":"{home}/docs","caps":"view"}}"#
                ),
                Some(&sam_cookie),
                Some(&sam_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let link: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let link_id = link["id"].as_str().unwrap().to_string();
        let token = link["token"].as_str().unwrap().to_string();

        // The admin's sharing inventory carries no member-home subject at
        // all — no roster, no interior path, and above all no raw
        // `/s/<token>` URL, which would be a working credential into the
        // private home.
        let (status, mine) =
            get_json(&app, &admin_cookie, &admin_csrf, "/api/v1/access/mine").await;
        assert_eq!(status, 200);
        let sharing = mine["sharing"].as_array().unwrap();
        assert!(
            !sharing.iter().any(|s| {
                s["path"]
                    .as_str()
                    .is_some_and(crate::member_home::is_member_home_path)
            }),
            "admin's mine must not surface member-home subjects: {sharing:?}"
        );

        // Update and delete answer like any foreign link — the member's
        // link is not the admin's to retune or kill.
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                &format!("/api/v1/access/links/{link_id}"),
                r#"{"expires_in_days":1}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/access/links/{link_id}"))
            .header("cookie", &admin_cookie)
            .header("x-csrf-token", &admin_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // The link itself still works for guests — only the admin lost the
        // ability to touch it.
        let res = call(
            &app,
            json_req(Method::GET, &format!("/s/{token}/list"), "", None, None),
        )
        .await;
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn foreign_members_container_belongs_to_nobody() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        materialize_home(&app, &sam_cookie, &sam_csrf).await;

        // A members container stamped with a DIFFERENT uuid — a tree
        // carried in from another Luna's drive, or planted in this drive's
        // image. It bears sam's name but is not sam's home: ownership
        // requires the container to match THIS drive's marker.
        let foreign = ".luna-11111111-2222-3333-4444-555555555555-members/sam";
        std::fs::create_dir_all(mount.path().join(format!("{foreign}/docs"))).unwrap();
        std::fs::write(mount.path().join(format!("{foreign}/docs/loot.txt")), b"x").unwrap();
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            let user = crate::db::get_user(&conn, &sam_id).unwrap().unwrap();
            let current = crate::auth::CurrentUser {
                id: user.id,
                username: user.username,
                role: user.role,
            };
            assert_eq!(
                crate::auth::caps_on_path(&current, &conn, "photos", foreign),
                0
            );
            assert_eq!(crate::member_home::owner_of(&conn, "photos", foreign), None);
        }

        // Sealed through the HTTP surface too — the planted tree gives sam
        // the same wall as any ungranted path.
        let res = get_files(&app, &sam_cookie, &sam_csrf, foreign).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = get_files(&app, &sam_cookie, &sam_csrf, &format!("{foreign}/docs")).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    /// Rename + delete proceed while the home drive is unplugged — the fs
    /// work queues as pending ops that run in the mount reconcile, so the
    /// old folder can never be inherited by a future same-name member.
    #[tokio::test]
    async fn unmounted_home_drive_defers_rename_and_delete() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        let (admin_cookie, admin_csrf) = admin_login(&app).await;
        let home = materialize_home(&app, &sam_cookie, &sam_csrf).await;

        // Yank the mount: the drive row stays adopted but unreadable —
        // the same state an unplugged drive leaves behind.
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(&conn, "photos", "Photos", "as_is", "ext4", "sda", "").unwrap();
        }

        // Rename proceeds — the folder rename queues behind the mount.
        let res = call(
            &app,
            json_req(
                Method::PATCH,
                &format!("/api/v1/users/{sam_id}"),
                r#"{"username":"sam2"}"#,
                Some(&admin_cookie),
                Some(&admin_csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            let row = crate::db::get_user(&conn, &sam_id).unwrap().unwrap();
            assert_eq!(row.username, "sam2");
            let ops = crate::db::list_pending_home_ops(&conn).unwrap();
            assert_eq!(ops.len(), 1);
            assert_eq!(ops[0].kind, "rename");
            assert_eq!(ops[0].username, "sam");
            assert_eq!(ops[0].dst_username, "sam2");
        }

        // Deleting the member proceeds too — the trash-out queues.
        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/users/{sam_id}"))
            .header("cookie", &admin_cookie)
            .header("x-csrf-token", &admin_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200);
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            assert!(crate::db::get_user(&conn, &sam_id).unwrap().is_none());
            let ops = crate::db::list_pending_home_ops(&conn).unwrap();
            assert_eq!(ops.len(), 2);
            assert_eq!(ops[1].kind, "trash");
            assert_eq!(ops[1].username, "sam2");
        }

        // Remount: reconcile applies the queued chain — rename first, then
        // the delete's trash parks the renamed folder.
        {
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
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
            crate::member_home::reconcile_pending(&conn).unwrap();
            assert!(crate::db::list_pending_home_ops(&conn).unwrap().is_empty());
        }
        assert!(!mount.path().join(&home).exists());
        let prefix = crate::drives::drive_db::prefix_for(mount.path()).unwrap();
        let trash = mount.path().join(format!("{prefix}-trash"));
        let parked: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(parked.len(), 1, "the home parked as one trash entry");
        assert!(parked[0].file_name().to_string_lossy().contains("sam2"));
    }

    #[tokio::test]
    async fn symlinked_member_home_does_not_redirect() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, _sam_id) = admin_and_sam(&app).await;
        let home = expected_home_rel(mount.path(), "sam");

        // A symlink squatting on sam's home — planted outside Luna (the
        // API can't mint it). It must never become a window onto `family`.
        std::fs::create_dir_all(mount.path().join(crate::member_home::members_dir_name(
            &crate::drives::drive_db::prefix_for(mount.path()).unwrap(),
        )))
        .unwrap();
        std::os::unix::fs::symlink(mount.path().join("family"), mount.path().join(&home)).unwrap();

        // /me resolves the home as unready — a symlink is not a home.
        let (status, me) = get_json(&app, &sam_cookie, &sam_csrf, "/api/v1/auth/me").await;
        assert_eq!(status, 200);
        assert_eq!(me["home"]["ready"], false);

        // Listing through it fails instead of following into `family`.
        let res = get_files(&app, &sam_cookie, &sam_csrf, &home).await;
        assert!(
            res.status().is_client_error(),
            "expected refusal, got {}",
            res.status()
        );
        let res = get_files(&app, &sam_cookie, &sam_csrf, &format!("{home}/a.txt")).await;
        assert!(
            res.status().is_client_error(),
            "expected refusal, got {}",
            res.status()
        );
    }

    #[tokio::test]
    async fn summary_space_follows_view_grants() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
        {
            // Sam's home lives on another drive so `photos` stats come only
            // from his grants — a home on this drive is itself a
            // view-bearing root.
            let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
            crate::db::upsert_drive(&conn, "other", "Other", "as_is", "ext4", "sdb", "").unwrap();
            crate::db::set_user_home_drive(&conn, &sam_id, "other").unwrap();
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
}
