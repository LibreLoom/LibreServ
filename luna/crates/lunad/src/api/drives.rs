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
    let rows = with_db(&state.db, crate::db::list_drives).map_err(|e| {
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
    Ok(Json(
        rows.into_iter()
            .filter(|d| admin || crate::auth::has_drive_access(&user, &conn, &d.id))
            .map(|d| {
                let mut json: DriveJson = d.into();
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
    // ejected stays ejected while still plugged in.
    let known_devices = with_db(&state.db, |conn| {
        state.drive_manager.reconcile(conn, &drives)?;
        let rows = crate::db::list_drives(conn)?;
        Ok(rows
            .into_iter()
            .filter(|d| d.state == "as_is" || d.state == "readonly")
            .map(|d| d.device)
            .collect::<std::collections::HashSet<_>>())
    })
    .unwrap_or_default();
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
    with_db(&state.db, |conn| state.drive_manager.eject(conn, &id))
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, plain_eject_error(&e)))?;
    crate::dav::drop_cached_handler(&state, &id);
    state.gallery.unwatch_mount(&id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    with_db(&state.db, |conn| state.drive_manager.remove(conn, &id)).map_err(|e| {
        json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't remove this drive. Try again.",
        )
    })?;
    crate::dav::drop_cached_handler(&state, &id);
    state.gallery.unwatch_mount(&id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn drive_health(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<crate::smart::DriveHealth>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(user)?;
    let device = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna is updating its file list. Wait a moment and try again.",
            )
        })?;
        let drive = crate::db::get_drive(&conn, &id)
            .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "Luna couldn't update this drive. Try again."))?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
        drive.device
    };
    let health = tokio::task::spawn_blocking(move || crate::smart::read(&device))
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
    let (mount_point, can_list_root, grant_shortcuts) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna is updating its file list. Wait a moment and try again.",
            )
        })?;
        let drive = crate::db::get_drive(&conn, &id)
            .map_err(|_| json_error(StatusCode::INTERNAL_SERVER_ERROR, "Luna couldn't update this drive. Try again."))?
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this drive."))?;
        if !crate::auth::has_drive_access(&user, &conn, &id) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to view this drive.",
            ));
        }
        let can_list_root = crate::auth::can_access(&user, &conn, &id, "", false);
        let grant_shortcuts = if can_list_root {
            Vec::new()
        } else {
            crate::db::list_grants_for_user(&conn, &user.id)
                .unwrap_or_default()
                .into_iter()
                .filter(|g| g.drive_id == id && !g.path.is_empty())
                .map(|g| g.path)
                .take(6)
                .collect::<Vec<_>>()
        };
        (drive.mount_point, can_list_root, grant_shortcuts)
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
    let space = crate::summary::disk_space(&root);
    let (folders, files, shortcuts) = if can_list_root {
        let counts = crate::summary::top_level_counts(&root);
        let shortcuts = crate::summary::top_level_shortcuts(&root);
        (Some(counts.folders), Some(counts.files), shortcuts)
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

fn find_device(name: &str) -> Option<crate::detect::DetectedDrive> {
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
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db;

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
}
