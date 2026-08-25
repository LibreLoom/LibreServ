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
    needs_erase: bool,
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
        .route("/api/v1/drives/{id}/health", get(drive_health))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Vec<DriveJson>>, (StatusCode, Json<serde_json::Value>)> {
    let rows = with_db(&state.db, crate::db::list_drives).map_err(|e| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not list drives. {e}"),
        )
    })?;
    let admin = user.role == "admin";
    Ok(Json(
        rows.into_iter()
            .map(|d| {
                let mut json: DriveJson = d.into();
                // The OS mount path is server plumbing; regular users don't
                // need it and it reveals the device's filesystem layout.
                if !admin {
                    json.mount_point = String::new();
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
    let drives = crate::detect::scan(std::path::Path::new("/sys/block"), &mounts);
    // Idempotent reconciliation on every poll: gone -> missing, returned -> as_is.
    let _ = with_db(&state.db, |conn| {
        state.drive_manager.reconcile(conn, &drives)
    });
    Ok(Json(
        drives
            .into_iter()
            .filter(|d| {
                d.is_storage_candidate() && (d.removable || d.usb || d.mount_point.is_some())
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
        needs_erase: inspection.needs_erase,
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
            "Luna couldn't let go of this drive. Try ejecting it from your computer instead.",
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
    with_db(&state.db, |conn| state.drive_manager.eject(conn, &id)).map_err(|e| {
        json_error(
            StatusCode::BAD_REQUEST,
            format!("Luna couldn't eject this drive safely. {e}"),
        )
    })?;
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
                "Luna's index is busy. Try again.",
            )
        })?;
        let drive = crate::db::get_drive(&conn, &id)
            .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")))?
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

fn find_device(name: &str) -> Option<crate::detect::DetectedDrive> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    crate::detect::scan(std::path::Path::new("/sys/block"), &mounts)
        .into_iter()
        .find(|d| d.name == name && d.is_storage_candidate())
}

fn require_admin(
    user: crate::auth::CurrentUser,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can manage drives.",
        ));
    }
    Ok(())
}

fn plain_adopt_error(err: &anyhow::Error) -> String {
    let text = err.to_string();
    let lower = text.to_ascii_lowercase();
    // The installer pitch is the only path that says the disk cannot be changed.
    // Do not key off the word "installer" — the lock-switch copy mentions it too.
    if lower.contains("cannot be changed") {
        crate::drives::INSTALLER_USB_MESSAGE.into()
    } else if lower.contains("no space")
        || lower.contains("disk full")
        || lower.contains("file too large")
        || lower.contains("os error 28")
    {
        "This drive is full, so Luna couldn't put its sticker file on it. Free some space and try again.".into()
    } else if lower.contains("read-only")
        || lower.contains("os error 30")
        || lower.contains("will not accept new files")
        || lower.contains("lock switch")
    {
        crate::drives::WRITE_REJECTED_MESSAGE.into()
    } else if lower.contains("could not mark") {
        "Luna couldn't put its sticker file on this drive. Unplug it, plug it back in, and try again.".into()
    } else if lower.contains("mount") {
        "Make sure the drive is plugged in and your computer isn't using it.".into()
    } else {
        text
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
    fn installer_error_is_plain_language() {
        let err = anyhow::anyhow!("{}", crate::drives::INSTALLER_USB_MESSAGE);
        let installer = super::plain_adopt_error(&err);
        assert!(installer.contains("Erase it to use it"));
        assert!(installer.contains("cannot be changed"));

        let raw = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: Read-only file system (os error 30)"
        );
        let plain = super::plain_adopt_error(&raw);
        assert_eq!(plain, crate::drives::WRITE_REJECTED_MESSAGE);
        assert!(!plain.contains("os error"));
        assert!(!plain.contains("cannot be changed"));
    }

    #[test]
    fn marker_full_and_generic_are_not_installer() {
        let full = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: No space left on device (os error 28)"
        );
        let full_plain = super::plain_adopt_error(&full);
        assert!(full_plain.contains("full"));
        assert!(!full_plain.to_ascii_lowercase().contains("installer"));

        let other = anyhow::anyhow!(
            "Luna could not mark this drive as its own. could not write the marker: Permission denied (os error 13)"
        );
        let other_plain = super::plain_adopt_error(&other);
        assert!(other_plain.contains("Unplug"));
        assert!(!other_plain.to_ascii_lowercase().contains("installer"));
        assert!(!other_plain.contains("os error"));
    }
}
