use std::path::PathBuf;
use std::sync::Arc;

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
    /// The requesting user can write somewhere on this drive (a grant) —
    /// drag-and-drop targets only offer writable roots.
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
            "Luna couldn't reach your drives right now. Try again.",
        )
    })?;
    Ok(Json(
        rows.into_iter()
            .filter(|d| admin || crate::auth::has_drive_access(&user, &conn, &d.id))
            .map(|d| {
                let id = d.id.clone();
                let mut json: DriveJson = d.into();
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
    let (known_devices, remounted) = with_db(&state.db, |conn| {
        let remounted = state.drive_manager.reconcile(conn, &drives)?;
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
        ))
    })
    .unwrap_or_default();
    for (id, mount) in remounted {
        state.gallery.watch_mount(&id, mount);
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
    let (st, drive) = (state.clone(), id.clone());
    closed_drive(&state, &id, move || {
        with_db(&st.db, |conn| st.drive_manager.eject(conn, &drive))
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, plain_eject_error(&e)))
    })
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let (st, drive) = (state.clone(), id.clone());
    closed_drive(&state, &id, move || {
        with_db(&st.db, |conn| st.drive_manager.remove(conn, &drive))
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, plain_remove_error(&e)))
    })
    .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Run `unmount` (eject or remove) with the drive closed to RAM-buffered
/// saves: no new ones are accepted, and every one already accepted — including
/// one a background task is writing right now — lands before the unmount.
/// Uploads that were answered "saving" can never be dropped by the unmount.
async fn closed_drive(
    state: &AppState,
    id: &str,
    unmount: impl FnOnce() -> Result<(), (StatusCode, Json<serde_json::Value>)> + Send + 'static,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    state.ram_cache.begin_close(id);
    let (st, drive) = (state.clone(), id.to_string());
    let result = tokio::task::spawn_blocking(move || {
        flush_dirty_before_unmount(&st, &drive)?;
        unmount()?;
        crate::files::dav::drop_cached_handler(&st, &drive);
        st.gallery.unwatch_mount(&drive);
        st.ram_cache.drop_drive(&drive);
        Ok(())
    })
    .await
    .unwrap_or_else(|_| {
        Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't finish with this drive. Try again.",
        ))
    });
    state.ram_cache.end_close(id);
    result
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
                "Luna couldn't reach your drives right now. Try again.",
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
                "Luna couldn't reach your drives right now. Try again.",
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
            let shortcuts: Vec<String> = rows
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
            shortcuts
        };
        // Space stats are a drive-level read: any view-bearing grant on this
        // drive — whole drive, a folder, or a file — earns the readout. Upload-only members get nothing (capacity is
        // drive metadata, not something their write access needs).
        let can_see_space = user.role == "admin"
            || can_list_root
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
/// thumbs, upload temps) never appears in listings — counting
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
    // No /proc/mounts off Linux (e.g. macOS dev hosts) — mock drives still scan.
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
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
    } else if lower.contains("system disk") {
        "That's the drive Luna runs from. Luna won't use its own system drive for your files."
            .into()
    } else if lower.contains("will only erase a usb stick") {
        "Luna can only erase a USB stick, not the computer's own disk.".into()
    } else if lower.contains("give the drive a name") {
        "Give the drive a name first.".into()
    } else if lower.contains("added but could not be read back") {
        "Luna added this drive but couldn't read it back right away. Refresh and try again.".into()
    } else if lower.contains("mount") {
        "Make sure the drive is plugged in and your computer isn't using it.".into()
    } else {
        "Try again.".into()
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
        "Something is still using this drive, like a copy or a file that's open. Wait for it to finish, then try again."
            .into()
    } else if lower.contains("finish writing") {
        "Luna couldn't finish writing to this drive, so it isn't safe to unplug yet. Try again."
            .into()
    } else {
        "Luna couldn't eject this drive safely, so don't unplug it yet. Try again in a moment."
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
    } else if lower.contains("plug the drive") {
        "Plug the drive back in so Luna can remove its sticker file, then try again.".into()
    } else if lower.contains("sticker") {
        "Luna couldn't remove its sticker file from this drive. Try again.".into()
    } else {
        "Luna couldn't remove this drive. Try again.".into()
    }
}

fn with_db<T>(
    db: &Arc<crate::Db>,
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
        // Luna bookkeeping must not move the needle: marker db, trash dir,
        // in-flight upload temp.
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
    /// can see it (a grant), so the drives list reaches the per-user fields.
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
    async fn members_see_their_access_but_not_server_paths() {
        let (_dir, state, admin_token, member_token, _member_id) = app_with_drive_and_member();
        let admin_view = get_drives(&state, &admin_token).await;
        let member_view = get_drives(&state, &member_token).await;
        assert_eq!(admin_view[0]["mount_point"], "/mnt/d1");
        assert_eq!(admin_view[0]["caps"], "full+share");
        // The member sees the drive (their grant) with only their own
        // access — the OS mount path and device node stay server plumbing.
        assert_eq!(member_view[0]["mount_point"], "");
        assert_eq!(member_view[0]["device"], "");
        assert_eq!(member_view[0]["writable"], false);
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
        let unnamed = anyhow::anyhow!("Give the drive a name first.");
        assert_eq!(
            super::plain_adopt_error(&unnamed),
            "Give the drive a name first."
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
        assert!(plain.starts_with("Something is still using this drive"));
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
