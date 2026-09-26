use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::api::response::json_error;

#[derive(Serialize)]
struct DriveJson {
    id: String,
    label: String,
    state: String,
    fs_type: String,
    device: String,
    mount_point: String,
    /// Member home folders live on this drive — either the admin's choice
    /// or the first-drive default (`member_home_auto`).
    member_home: bool,
    /// The home-drive assignment came from the first-adopted-drive default,
    /// not an explicit admin pick — the UI shows the "automatic" pill slot.
    member_home_auto: bool,
    /// The requesting user can write somewhere on this drive (their home or
    /// a grant) — drag-and-drop targets only offer writable roots.
    writable: bool,
    /// The requesting user's capabilities on the drive root, server-stamped.
    caps: String,
}

#[derive(Serialize)]
struct DetectedDriveJson {
    name: String,
    model: String,
    size_bytes: u64,
    removable: bool,
    usb: bool,
    mount_point: Option<String>,
    fs_type: Option<String>,
}

#[derive(Serialize)]
struct InspectEntryJson {
    name: String,
    /// `"folder"` or `"file"`.
    kind: String,
}

#[derive(Serialize)]
struct InspectionJson {
    device: String,
    model: String,
    fs_type: Option<String>,
    mount_point: String,
    mounted_by_luna: bool,
    has_marker: bool,
    folders: u64,
    files: u64,
    unreadable: u64,
    /// Non-hidden top-level names (folders first), for the Add-drive preview.
    entries: Vec<InspectEntryJson>,
    needs_erase: bool,
    readable: bool,
    writable: bool,
}

/// Home-dashboard snapshot for one adopted drive. Space is `statvfs`;
/// folder/file counts and shortcuts are top-level only (no tree walk).
#[derive(Serialize)]
struct DriveSummaryJson {
    id: String,
    mounted: bool,
    total_bytes: Option<u64>,
    free_bytes: Option<u64>,
    used_bytes: Option<u64>,
    folders: Option<u64>,
    files: Option<u64>,
    /// Top-level folder names (or grant paths) for quick links into the drive.
    shortcuts: Vec<String>,
}

#[derive(Deserialize)]
struct AdoptBody {
    label: String,
    #[serde(default)]
    erase: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drives", get(list))
        .route("/api/v1/drives/detected", get(detected))
        .route("/api/v1/drives/{name}/inspect", post(inspect))
        .route("/api/v1/drives/{name}/adopt", post(adopt))
        .route("/api/v1/drives/{name}/dismiss", post(dismiss))
        .route("/api/v1/drives/{id}/eject", post(eject))
        .route("/api/v1/drives/{id}/remove", post(remove))
        .route("/api/v1/drives/{id}/health", get(drive_health))
        .route("/api/v1/drives/{id}/summary", get(drive_summary))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<DriveJson>>, (StatusCode, Json<serde_json::Value>)> {
    let rows = with_db(&state.db, crate::db::list_drives).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't list your drives. Try again.",
        )
    })?;
    let admin = user.role == "admin";
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna is updating its file list. Wait a moment and try again.",
        )
    })?;
    // Which drive hosts the member homes is admin knowledge — a member who
    // could spot it in this list learns where every other person's private
    // files live. Members learn their own home drive from /me anyway.
    let home_drive = if admin {
        crate::db::member_home_drive(&conn).ok().flatten()
    } else {
        None
    };
    let home_configured = admin
        && crate::db::member_home_drive_configured(&conn)
            .ok()
            .flatten()
            .is_some();
    Ok(Json(
        rows.into_iter()
            .filter(|d| admin || crate::auth::has_drive_access(&user, &conn, &d.id))
            .map(|d| {
                let id = d.id.clone();
                let mut json: DriveJson = d.into();
                json.member_home = admin && home_drive.as_deref() == Some(id.as_str());
                json.member_home_auto = json.member_home && !home_configured;
                json.writable = admin || crate::auth::has_write_on_drive(&user, &conn, &id);
                json.caps =
                    crate::access::caps_to_str(crate::auth::caps_on_path(&user, &conn, &id, ""));
                // Device node and OS mount path are server plumbing.
                if !admin {
                    json.mount_point = String::new();
                    json.device = String::new();
                }
                json
            })
            .collect(),
    ))
}

async fn detected(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<DetectedDriveJson>>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    let drives = crate::dev_mock::scan_all(std::path::Path::new("/sys/block"), &mounts);
    // Idempotent reconciliation on every poll: gone -> missing, returned -> as_is,
    // ejected stays ejected while still plugged in. Remounted Ready drives re-arm
    // the gallery watcher (eject→replug / kernel remount).
    let (known_devices, remounted, ready_moves) = with_db(&state.db, |conn| {
        let remounted = state.drive_manager.reconcile(conn, &drives)?;
        // Queued member-home work (account rename/delete/repin while a
        // drive was unplugged) applies here, inside the same lock that
        // marked the drive mounted — nothing can resolve a home path in
        // the gap. Cross-drive moves need the job manager, so they come
        // out and enqueue below.
        let ready_moves = crate::member_home::reconcile_pending(conn).unwrap_or_default();
        let rows = crate::db::list_drives(conn)?;
        // Drop gallery watches for drives that are no longer Ready.
        for row in &rows {
            if row.state != "as_is" && row.state != "readonly" {
                // Best-effort flush if the mount path is still reachable (e.g.
                // ejected-but-plugged). Unplugged drives skip flush.
                if !row.mount_point.is_empty() {
                    let mount = std::path::Path::new(&row.mount_point);
                    if mount.is_dir() {
                        let _ = state.ram_cache.flush_drive_dirty(&row.id, mount);
                    }
                }
                state.gallery.unwatch_mount(&row.id);
                state.ram_cache.drop_drive(&row.id);
            }
        }
        Ok((
            rows.into_iter()
                .filter(|d| d.state == "as_is" || d.state == "readonly")
                .map(|d| d.device)
                .collect::<std::collections::HashSet<_>>(),
            remounted,
            ready_moves,
        ))
    })
    .unwrap_or_default();
    for (id, mount) in remounted {
        state.gallery.watch_mount(&id, mount);
    }
    for mv in ready_moves {
        if state
            .job_manager
            .enqueue(
                "move",
                &mv.src_drive,
                &mv.src_rel,
                &mv.dst_drive,
                &mv.dst_members,
                &mv.user_id,
            )
            .await
            .is_ok()
        {
            let _ = with_db(&state.db, |conn| {
                crate::db::delete_pending_home_op(conn, &mv.op_id)
            });
        }
    }
    Ok(Json(
        drives
            .into_iter()
            .filter(|d| {
                d.is_storage_candidate()
                    && (d.removable || d.usb || d.mount_point.is_some())
                    && !known_devices.contains(&d.name)
            })
            .map(|d| DetectedDriveJson {
                name: d.name,
                model: d.model,
                size_bytes: d.size_bytes,
                removable: d.removable,
                usb: d.usb,
                mount_point: d.mount_point,
                fs_type: d.fs_type,
            })
            .collect(),
    ))
}

async fn inspect(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(name): Path<String>,
) -> Result<Json<InspectionJson>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let device = find_device(&name).ok_or_else(|| {
        json_error(
            StatusCode::NOT_FOUND,
            "Luna can't see a drive with that name.",
        )
    })?;
    let inspection = state.drive_manager.inspect(&device).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't look at this drive safely. Make sure it's plugged in and try again.",
        )
    })?;
    Ok(Json(InspectionJson {
        device: inspection.device,
        model: inspection.model,
        fs_type: inspection.fs_type,
        mount_point: inspection.mount_point.to_string_lossy().into_owned(),
        mounted_by_luna: inspection.mounted_by_luna,
        has_marker: inspection.has_marker,
        folders: inspection.summary.folders,
        files: inspection.summary.files,
        unreadable: inspection.summary.unreadable,
        entries: inspection
            .summary
            .entries
            .into_iter()
            .map(|e| InspectEntryJson {
                name: e.name,
                kind: e.kind,
            })
            .collect(),
        needs_erase: inspection.needs_erase,
        readable: inspection.readable,
        writable: inspection.writable,
    }))
}

async fn adopt(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(name): Path<String>,
    Json(body): Json<AdoptBody>,
) -> Result<Json<DriveJson>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let label = body.label.trim().to_string();
    if label.is_empty() || label.len() > 80 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Give this drive a name between 1 and 80 characters.",
        ));
    }
    let device = find_device(&name).ok_or_else(|| {
        json_error(
            StatusCode::NOT_FOUND,
            "Luna can't see a drive with that name.",
        )
    })?;
    let row = with_db(&state.db, |conn| {
        state.drive_manager.adopt(conn, &device, &label, body.erase)
    })
    .map_err(|e| {
        json_error(
            StatusCode::BAD_REQUEST,
            format!("Luna couldn't add this drive. {}", plain_adopt_error(&e)),
        )
    })?;
    if !row.mount_point.is_empty() {
        state
            .gallery
            .watch_mount(&row.id, PathBuf::from(&row.mount_point));
    }
    Ok(Json(row.into()))
}

async fn dismiss(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    state.drive_manager.dismiss_foreign(&name).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't let go of this drive. Unplug it, wait a few seconds, and plug it back in.",
        )
    })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn eject(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    // Finish in-flight RAM saves while the mount is still up — never drop dirty
    // bytes that already returned success with saving:true.
    flush_dirty_before_unmount(&state, &id)?;
    with_db(&state.db, |conn| state.drive_manager.eject(conn, &id))
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, plain_eject_error(&e)))?;
    crate::files::dav::drop_cached_handler(&state, &id);
    state.gallery.unwatch_mount(&id);
    state.ram_cache.drop_drive(&id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    flush_dirty_before_unmount(&state, &id)?;
    with_db(&state.db, |conn| state.drive_manager.remove(conn, &id))
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, plain_remove_error(&e)))?;
    crate::files::dav::drop_cached_handler(&state, &id);
    state.gallery.unwatch_mount(&id);
    state.ram_cache.drop_drive(&id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Persist any dirty RAM writes for this drive before eject/remove.
fn flush_dirty_before_unmount(
    state: &AppState,
    id: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if state.ram_cache.dirty_rels_for_drive(id).is_empty() {
        return Ok(());
    }
    let mount = with_db(&state.db, |conn| {
        crate::db::get_drive(conn, id)?
            .filter(|d| !d.mount_point.is_empty())
            .map(|d| PathBuf::from(d.mount_point))
            .ok_or_else(|| anyhow::anyhow!("drive is not mounted"))
    })
    .ok();
    let Some(mount) = mount else {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna still needs to finish saving files on this drive, but the drive is not ready. Plug it back in and try again.",
        ));
    };
    state.ram_cache.flush_drive_dirty(id, &mount).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish saving files on this drive. Wait a moment and try again.",
        )
    })
}

async fn drive_health(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<crate::drives::smart::DriveHealth>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let device = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna is updating its file list. Wait a moment and try again.",
            )
        })?;
        let drive = crate::db::get_drive(&conn, &id)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't update this drive. Try again.",
                )
            })?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
        drive.device
    };
    let health = tokio::task::spawn_blocking(move || crate::drives::smart::read(&device))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check this drive.",
            )
        })?;
    Ok(Json(health))
}

async fn drive_summary(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<DriveSummaryJson>, (StatusCode, Json<serde_json::Value>)> {
    let (mount_point, can_list_root, grant_shortcuts, can_see_space) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna is updating its file list. Wait a moment and try again.",
            )
        })?;
        let drive = crate::db::get_drive(&conn, &id)
            .map_err(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Luna couldn't update this drive. Try again.",
                )
            })?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
        if !crate::auth::has_drive_access(&user, &conn, &id) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this drive.",
            ));
        }
        let can_list_root = crate::auth::has_cap(&user, &conn, &id, "", crate::access::CAP_VIEW);
        let rows = crate::db::list_access_members_for_user(&conn, &user.id).unwrap_or_default();
        let grant_shortcuts = if can_list_root {
            Vec::new()
        } else {
            let mut shortcuts: Vec<String> = rows
                .iter()
                .filter(|r| {
                    r.subject_kind == crate::access::KIND_PATH
                        && r.drive_id == id
                        && !r.path.is_empty()
                        && r.caps & crate::access::CAP_VIEW != 0
                })
                .map(|r| r.path.clone())
                .take(6)
                .collect();
            // The member's home is grant-free — it never appears as an
            // access row, so offer it as the first quick link.
            if crate::member_home::home_on_drive(&conn, &user.id, &id)
                && let Some(home) = crate::member_home::home_rel(&conn, &id, &user.username)
            {
                shortcuts.insert(0, home);
                shortcuts.truncate(6);
            }
            shortcuts
        };
        // Space stats are a drive-level read: any view-bearing grant on this
        // drive — whole drive, a folder, a file, or the member's home —
        // earns the readout. Upload-only members get nothing (capacity is
        // drive metadata, not something their write access needs).
        let can_see_space = user.role == "admin"
            || can_list_root
            || crate::member_home::home_on_drive(&conn, &user.id, &id)
            || rows.iter().any(|r| {
                r.subject_kind == crate::access::KIND_PATH
                    && r.drive_id == id
                    && r.caps & crate::access::CAP_VIEW != 0
            });
        (
            drive.mount_point,
            can_list_root,
            grant_shortcuts,
            can_see_space,
        )
    };

    if mount_point.is_empty() {
        return Ok(Json(DriveSummaryJson {
            id,
            mounted: false,
            total_bytes: None,
            free_bytes: None,
            used_bytes: None,
            folders: None,
            files: None,
            shortcuts: grant_shortcuts,
        }));
    }

    let root = std::path::PathBuf::from(mount_point);
    let space = if can_see_space {
        crate::drives::summary::disk_space(&root)
    } else {
        None
    };
    let (folders, files, shortcuts) = if can_list_root {
        let (folders, files) = visible_top_level_counts(&root);
        let shortcuts = crate::drives::summary::top_level_shortcuts(&root);
        (Some(folders), Some(files), shortcuts)
    } else {
        (None, None, grant_shortcuts)
    };

    Ok(Json(DriveSummaryJson {
        id,
        mounted: true,
        total_bytes: space.as_ref().map(|s| s.total_bytes),
        free_bytes: space.as_ref().map(|s| s.free_bytes),
        used_bytes: space.as_ref().map(|s| s.used_bytes),
        folders,
        files,
        shortcuts,
    }))
}

/// Top-level folder/file counts for the dashboard, counting only names a
/// file listing would show. `.luna-<uuid>*` bookkeeping (marker, trash,
/// thumbs, member homes, upload temps) never appears in listings — counting
/// it here would hand members a hidden-item oracle they could diff against
/// what they can see.
fn visible_top_level_counts(root: &std::path::Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    let mut folders = 0u64;
    let mut files = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if crate::files::is_internal_temp(name) {
            continue;
        }
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => folders += 1,
            Ok(ft) if ft.is_file() || ft.is_symlink() => files += 1,
            _ => {}
        }
    }
    (folders, files)
}

fn find_device(name: &str) -> Option<crate::drives::detect::DetectedDrive> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    crate::dev_mock::scan_all(std::path::Path::new("/sys/block"), &mounts)
        .into_iter()
        .find(|d| d.name == name && d.is_storage_candidate())
}

fn require_admin(
    user: crate::auth::CurrentUser,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage drives.",
        ));
    }
    Ok(())
}

fn plain_adopt_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    let lower = text.to_ascii_lowercase();
    // needs_erase adopt path — unique phrasing so lock-switch copy does not match.
    if lower.contains("erase and add this drive")
        || lower.contains("moved any files you want to keep")
    {
        crate::drives::INSTALLER_USB_MESSAGE.into()
    } else if lower.contains("no space")
        || lower.contains("disk full")
        || lower.contains("file too large")
        || lower.contains("os error 28")
    {
        "This drive is full, so Luna couldn't put its sticker file on it. Free some space and try again.".into()
    } else if lower.contains("format it before")
        || lower.contains("read-only")
        || lower.contains("os error 30")
    {
        crate::drives::NEEDS_FORMAT_MESSAGE.into()
    } else if lower.contains("will not accept new files") || lower.contains("lock switch") {
        crate::drives::WRITE_REJECTED_MESSAGE.into()
    } else if lower.contains("could not mark") {
        "Luna couldn't put its sticker file on this drive. Unplug it, plug it back in, and try again.".into()
    } else if lower.contains("mount") {
        "Make sure the drive is plugged in and your computer isn't using it.".into()
    } else {
        text
    }
}

/// User-facing eject errors — never dump raw mount paths or UUIDs.
fn plain_eject_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("doesn't know") {
        "Luna doesn't know this drive.".into()
    } else if lower.contains("close any files")
        || lower.contains("target is busy")
        || lower.contains("device is busy")
        || lower.contains("busy")
    {
        "Luna couldn't eject this drive safely. Close any files open from it, then try again."
            .into()
    } else {
        "Luna couldn't eject this drive safely. Unplug it, wait a moment, and plug it back in."
            .into()
    }
}

/// User-facing remove errors — DriveManager already returns plain copy for
/// real failures; strip raw OS paths if anything else leaks through.
fn plain_remove_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("doesn't know") {
        "Luna doesn't know this drive.".into()
    } else if lower.contains("sticker") {
        "Luna couldn't remove its sticker file from this drive. Try again.".into()
    } else if lower.contains("plug the drive") {
        "Plug the drive back in so Luna can remove its sticker file, then try again.".into()
    } else {
        "Luna couldn't remove this drive. Try again.".into()
    }
}

fn with_db<T>(
    db: &Arc<Mutex<Connection>>,
    f: impl FnOnce(&Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    f(&conn)
}

impl From<crate::db::DriveRow> for DriveJson {
    fn from(d: crate::db::DriveRow) -> Self {
        Self {
            id: d.id,
            label: d.label,
            state: d.state,
            fs_type: d.fs_type,
            device: d.device,
            mount_point: d.mount_point,
            member_home: false,
            member_home_auto: false,
            writable: false,
            caps: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db;

    #[test]
    fn summary_counts_skip_luna_internal_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("Photos")).unwrap();
        std::fs::create_dir(root.join("plain")).unwrap();
        // Luna bookkeeping must not move the needle: marker db, members
        // container, trash dir, in-flight upload temp.
        std::fs::create_dir(root.join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-members"))
            .unwrap();
        std::fs::create_dir(root.join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-trash")).unwrap();
        std::fs::write(
            root.join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f.sqlite3"),
            b"x",
        )
        .unwrap();
        std::fs::write(
            root.join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.ab12.part"),
            b"x",
        )
        .unwrap();
        // Ordinary dotfiles and non-uuid .luna-* names are user files and
        // still count.
        std::fs::write(root.join(".hidden.txt"), b"x").unwrap();
        std::fs::create_dir(root.join(".luna-notes")).unwrap();
        std::fs::write(root.join("readme.txt"), b"x").unwrap();

        let (folders, files) = super::visible_top_level_counts(root);
        assert_eq!(folders, 3, "Photos + plain + .luna-notes");
        assert_eq!(files, 2, "readme.txt + .hidden.txt");
    }

    /// Build a state + router pair with one adopted drive and a member who
    /// can see it (a grant), so the drives list reaches the flag code.
    fn app_with_drive_and_member() -> (tempfile::TempDir, crate::AppState, String, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        {
            let conn = state.db.lock().unwrap();
            db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdz", "/mnt/d1").unwrap();
            db::set_member_home_drive(&conn, "d1").unwrap();
        }
        let admin = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = state
            .auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        {
            let conn = state.db.lock().unwrap();
            db::insert_access_member(
                &conn,
                &db::AccessMemberRow {
                    id: "m1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "d1".into(),
                    path: String::new(),
                    album_id: String::new(),
                    user_id: member.id.clone(),
                    caps: crate::access::CAP_VIEW,
                    created_by: admin.id.clone(),
                },
            )
            .unwrap();
        }
        let admin_token = state.auth.issue(&admin).unwrap();
        let member_token = state.auth.issue(&member).unwrap();
        (dir, state, admin_token, member_token, member.id)
    }

    async fn get_drives(state: &crate::AppState, token: &str) -> Vec<serde_json::Value> {
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let response = tower::ServiceExt::oneshot(
            router,
            axum::http::Request::builder()
                .uri("/api/v1/drives")
                .header("Authorization", format!("Bearer {token}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn member_home_flags_are_admin_only() {
        let (_dir, state, admin_token, member_token, _member_id) = app_with_drive_and_member();
        let admin_view = get_drives(&state, &admin_token).await;
        let member_view = get_drives(&state, &member_token).await;
        assert_eq!(admin_view[0]["member_home"], true);
        assert_eq!(admin_view[0]["member_home_auto"], false);
        // The member still sees the drive (their grant) but must not learn
        // it hosts everyone's homes — the flag reads the same as any other.
        assert_eq!(member_view[0]["member_home"], false);
        assert_eq!(member_view[0]["member_home_auto"], false);
    }

    #[test]
    fn empty_database_lists_empty() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        assert!(db::list_drives(&conn).unwrap().is_empty());
    }

    #[test]
    fn needs_erase_error_is_plain_language() {
        let err = anyhow::anyhow!("{}", crate::drives::INSTALLER_USB_MESSAGE);
        let needs_erase = super::plain_adopt_error(&err);
        assert!(needs_erase.contains("Erase and add this drive"));
        assert!(!needs_erase.to_ascii_lowercase().contains("installer"));

        let raw = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: Read-only file system (os error 30)"
        );
        let plain = super::plain_adopt_error(&raw);
        assert_eq!(plain, crate::drives::NEEDS_FORMAT_MESSAGE);
        assert!(!plain.contains("os error"));
        assert!(!plain.contains("Erase and add this drive"));
    }

    #[test]
    fn marker_full_and_generic_are_not_needs_erase() {
        let full = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: No space left on device (os error 28)"
        );
        let full_plain = super::plain_adopt_error(&full);
        assert!(full_plain.contains("full"));
        assert!(!full_plain.to_ascii_lowercase().contains("installer"));
        assert!(!full_plain.contains("Erase and add this drive"));

        let other = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: Permission denied (os error 13)"
        );
        let other_plain = super::plain_adopt_error(&other);
        assert!(other_plain.contains("Unplug"));
        assert!(!other_plain.to_ascii_lowercase().contains("installer"));
        assert!(!other_plain.contains("os error"));
    }

    #[test]
    fn eject_errors_never_leak_paths_or_uuids() {
        let busy = anyhow::anyhow!("Close any files open from this drive, then try again.");
        let plain = super::plain_eject_error(&busy);
        assert!(plain.contains("Close any files"));
        assert!(!plain.contains("/var/lib"));

        let raw = anyhow::anyhow!(
            "unmount /var/lib/luna/mounts/drives/4b8d8abb-c7da-4d24-960a-7670030b96e5 failed: umount: no mount point specified."
        );
        let plain_raw = super::plain_eject_error(&raw);
        assert!(plain_raw.starts_with("Luna couldn't eject"));
        assert!(!plain_raw.contains("4b8d8abb"));
        assert!(!plain_raw.contains("/var/lib"));
        assert!(!plain_raw.contains("umount"));
    }

    #[test]
    fn remove_errors_stay_plain_language() {
        let unknown = anyhow::anyhow!("Luna doesn't know this drive.");
        assert_eq!(
            super::plain_remove_error(&unknown),
            "Luna doesn't know this drive."
        );

        let sticker =
            anyhow::anyhow!("Luna couldn't remove its sticker file from this drive. Try again.");
        let plain = super::plain_remove_error(&sticker);
        assert!(plain.contains("sticker file"));
        assert!(!plain.contains("os error"));

        let raw = anyhow::anyhow!(
            "remove_file /var/lib/luna/mounts/drives/aabbccdd/.luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f.sqlite3: Permission denied (os error 13)"
        );
        let plain_raw = super::plain_remove_error(&raw);
        assert_eq!(plain_raw, "Luna couldn't remove this drive. Try again.");
        assert!(!plain_raw.contains("/var/lib"));
        assert!(!plain_raw.contains("os error"));
    }
}
