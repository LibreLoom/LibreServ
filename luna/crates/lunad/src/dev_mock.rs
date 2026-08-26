//! Dev-only mock portable SSD for UI and API review without hardware.
//!
//! When enabled, lunad reports a ~64 GB USB stick named `sdmock` with realistic
//! fixture content under the dev data dir. The volume is a plain directory
//! (not a loop device) so Cloud Agent VMs work without root block-device setup.

use std::path::{Path, PathBuf};

use crate::detect::DetectedDrive;

/// Kernel block name — matches the frontend review fixture.
pub const DEVICE_NAME: &str = "sdmock";

/// Display model shown in the Drives UI.
pub const MODEL: &str = "64GB PSSD";

/// Decimal 64 GB, matching sizeLabel in the web UI.
pub const SIZE_BYTES: u64 = 64_000_000_000;

/// Relative to `LUNA_DATA_DIR` (typically `luna/dev/mock-pssd-vol`).
pub const VOLUME_DIR_NAME: &str = "mock-pssd-vol";

/// Whether the mock PSSD should appear in drive detection.
pub fn enabled() -> bool {
    match std::env::var("LUNA_MOCK_PSSD").ok().as_deref() {
        Some("0") | Some("false") | Some("no") | Some("off") => false,
        Some("1") | Some("true") | Some("yes") | Some("on") => true,
        _ => dev_data_dir(),
    }
}

/// True when `LUNA_DATA_DIR` points at the Makefile dev tree (`…/luna/dev`).
fn dev_data_dir() -> bool {
    std::env::var("LUNA_DATA_DIR")
        .ok()
        .map(|p| {
            Path::new(&p)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == "dev")
        })
        .unwrap_or(false)
}

/// Writable mock volume root. Created by `dev/setup-mock-pssd.sh`.
pub fn volume_path() -> PathBuf {
    if let Ok(p) = std::env::var("LUNA_MOCK_PSSD_PATH") {
        return PathBuf::from(p);
    }
    std::env::var("LUNA_DATA_DIR")
        .map(|d| PathBuf::from(d).join(VOLUME_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(VOLUME_DIR_NAME))
}

/// Build the mock drive when the volume exists and mock mode is on.
pub fn detected_drive() -> Option<DetectedDrive> {
    detected_drive_at(&volume_path(), enabled())
}

fn detected_drive_at(root: &Path, on: bool) -> Option<DetectedDrive> {
    if !on {
        return None;
    }
    if !root.is_dir() {
        return None;
    }
    Some(DetectedDrive {
        name: DEVICE_NAME.into(),
        model: MODEL.into(),
        size_bytes: SIZE_BYTES,
        removable: true,
        usb: true,
        mount_point: Some(root.to_string_lossy().into_owned()),
        fs_type: Some("exfat".into()),
        mount_readonly: false,
    })
}

/// Scan sysfs-backed drives and append the dev mock when active.
pub fn scan_all(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    let mut drives = crate::detect::scan(sys_block, proc_mounts);
    if let Some(mock) = detected_drive() {
        drives.retain(|d| d.name != mock.name);
        drives.push(mock);
        drives.sort_by(|a, b| a.name.cmp(&b.name));
    }
    drives
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn mock_drive_uses_fixture_volume() {
        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("mock-pssd-vol");
        fs::create_dir_all(vol.join("DCIM")).unwrap();
        fs::write(vol.join("readme.txt"), b"fixture").unwrap();

        let mock = detected_drive_at(&vol, true).expect("mock volume should be detected");
        assert_eq!(mock.name, DEVICE_NAME);
        assert_eq!(mock.model, MODEL);
        assert_eq!(mock.size_bytes, SIZE_BYTES);
        assert!(mock.usb);
        assert_eq!(mock.fs_type.as_deref(), Some("exfat"));
        assert!(mock.mount_point.as_ref().unwrap().contains("mock-pssd-vol"));
    }

    #[test]
    fn mock_disabled_when_volume_missing() {
        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("missing");
        assert!(detected_drive_at(&vol, true).is_none());
        assert!(detected_drive_at(&vol, false).is_none());
    }

    #[test]
    fn scan_all_injects_mock_over_real_sysfs() {
        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("mock-pssd-vol");
        fs::create_dir_all(&vol).unwrap();
        let sys = dir.path().join("sys/block");
        fs::create_dir_all(sys.join("sda/device")).unwrap();
        fs::write(sys.join("sda/size"), "1000\n").unwrap();
        fs::write(sys.join("sda/removable"), "1\n").unwrap();

        let mut drives = crate::detect::scan(&sys, "proc /proc proc rw 0 0\n");
        if let Some(mock) = detected_drive_at(&vol, true) {
            drives.retain(|d| d.name != mock.name);
            drives.push(mock);
        }
        assert!(drives.iter().any(|d| d.name == DEVICE_NAME));
        assert!(drives.iter().any(|d| d.name == "sda"));
    }

    #[test]
    fn adopt_mock_fixture_as_is() {
        use crate::drives::DriveManager;
        use crate::mount::CommandMounter;
        use std::sync::Arc;

        let root = tempfile::tempdir().unwrap();
        let vol = root.path().join("mock-pssd-vol");
        fs::create_dir_all(vol.join("DCIM")).unwrap();
        fs::write(vol.join("hello.txt"), b"hi").unwrap();

        let device = detected_drive_at(&vol, true).unwrap();
        let mgr = DriveManager::new(Arc::new(CommandMounter), root.path());
        let conn = crate::db::open(&root.path().join("luna.db")).unwrap();
        let row = mgr.adopt(&conn, &device, "Portable SSD", false);
        if let Err(e) = &row {
            panic!("adopt failed: {e:#}");
        }
        let row = row.unwrap();
        assert_eq!(row.label, "Portable SSD");
        assert_eq!(row.device, DEVICE_NAME);
        assert!(Path::new(&row.mount_point).join(".luna").exists());
    }
}
