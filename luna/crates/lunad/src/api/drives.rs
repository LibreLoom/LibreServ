use std::sync::Mutex;

use axum::{Json, Router, extract::State, routing::get};
use rusqlite::Connection;
use serde::Serialize;

use crate::AppState;

#[derive(Serialize)]
struct DriveJson {
    id: String,
    label: String,
    state: String,
    fs_type: String,
    device: String,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/drives", get(list))
        .route("/api/v1/drives/detected", get(detected))
        .with_state(state)
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

async fn detected() -> Json<Vec<DetectedDriveJson>> {
    let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
    let drives = crate::detect::scan(std::path::Path::new("/sys/block"), &mounts);
    Json(
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
    )
}

async fn list(State(state): State<AppState>) -> Json<Vec<DriveJson>> {
    let rows = with_db(&state.db, crate::db::list_drives).unwrap_or_default();
    Json(
        rows.into_iter()
            .map(|d| DriveJson {
                id: d.id,
                label: d.label,
                state: d.state,
                fs_type: d.fs_type,
                device: d.device,
            })
            .collect(),
    )
}

fn with_db<T>(
    db: &Mutex<Connection>,
    f: impl FnOnce(&Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    f(&conn)
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
}
