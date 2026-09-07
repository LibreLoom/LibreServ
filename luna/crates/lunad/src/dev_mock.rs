//! Dev-only mock drives for UI and API review without hardware.
//!
//! When enabled, lunad reports dynamically spawned mock drives under
//! `{LUNA_DATA_DIR}/mock-drives/` (see `make mock-drive`). Each folder is a
//! plain directory (not a loop device) so Cloud Agent VMs work without root
//! block-device setup.
//!
//! The legacy single-volume `mock-pssd-vol` / `sdmock` / "64GB PSSD" path is no
//! longer injected into detection. Optional `make mock-pssd` fixtures remain
//! for photo/EXIF unit tests only.

use std::path::{Path, PathBuf};

use crate::detect::DetectedDrive;

/// Default reported size when a mock drive omits `size_bytes` in `.drive.json`.
pub const DEFAULT_SIZE_BYTES: u64 = 64_000_000_000;

/// Relative to `LUNA_DATA_DIR` (typically `luna/dev/mock-drives`).
pub const MOCK_DRIVES_DIR_NAME: &str = "mock-drives";

/// Legacy volume dir name — kept for optional fixtures / env override cleanup.
pub const VOLUME_DIR_NAME: &str = "mock-pssd-vol";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, Default)]
pub struct MockDriveConfig {
    pub name: Option<String>,
    pub model: Option<String>,
    pub size_bytes: Option<u64>,
    pub fs_type: Option<String>,
    pub removable: Option<bool>,
    pub usb: Option<bool>,
    pub mount_readonly: Option<bool>,
}

/// Whether mock drives should appear in drive detection.
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

/// Path to the legacy optional PSSD fixture volume (not auto-injected).
pub fn volume_path() -> PathBuf {
    if let Ok(p) = std::env::var("LUNA_MOCK_PSSD_PATH") {
        return PathBuf::from(p);
    }
    std::env::var("LUNA_DATA_DIR")
        .map(|d| PathBuf::from(d).join(VOLUME_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(VOLUME_DIR_NAME))
}

/// Path to dynamic mock drives directory.
pub fn mock_drives_path() -> PathBuf {
    if let Ok(p) = std::env::var("LUNA_MOCK_DRIVES_PATH") {
        return PathBuf::from(p);
    }
    std::env::var("LUNA_DATA_DIR")
        .map(|d| PathBuf::from(d).join(MOCK_DRIVES_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(MOCK_DRIVES_DIR_NAME))
}

/// Build a [`DetectedDrive`] from a directory when mock mode is on.
///
/// Used by unit tests and as the shared "directory-as-drive" helper. Detection
/// no longer auto-injects the legacy `mock-pssd-vol` — only `scan_mock_drives`.
pub fn detected_drive_at(root: &Path, on: bool, name: &str, model: &str) -> Option<DetectedDrive> {
    if !on {
        return None;
    }
    if !root.is_dir() || root.join(".unplugged").exists() {
        return None;
    }
    Some(DetectedDrive {
        name: name.into(),
        model: model.into(),
        size_bytes: DEFAULT_SIZE_BYTES,
        removable: true,
        usb: true,
        mount_point: Some(root.to_string_lossy().into_owned()),
        fs_type: Some("exfat".into()),
        mount_readonly: false,
    })
}

/// Scan dynamically spawned mock drives under the mock drives directory.
pub fn scan_mock_drives_at(parent: &Path, on: bool) -> Vec<DetectedDrive> {
    if !on || !parent.is_dir() {
        return Vec::new();
    }
    let mut results = Vec::new();
    let Ok(entries) = std::fs::read_dir(parent) else {
        return results;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || path.join(".unplugged").exists() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name.starts_with('.') {
            continue;
        }
        let config: MockDriveConfig = if path.join(".drive.json").exists() {
            std::fs::read_to_string(path.join(".drive.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            MockDriveConfig::default()
        };

        let name = config.name.unwrap_or_else(|| {
            if folder_name.starts_with("sdmock") {
                folder_name.clone()
            } else {
                format!("sdmock_{folder_name}")
            }
        });
        let model = config
            .model
            .unwrap_or_else(|| format!("Mock Drive ({folder_name})"));
        let size_bytes = config.size_bytes.unwrap_or(DEFAULT_SIZE_BYTES);
        let fs_type = config.fs_type.or_else(|| Some("exfat".into()));
        let removable = config.removable.unwrap_or(true);
        let usb = config.usb.unwrap_or(true);
        let mount_readonly = config
            .mount_readonly
            .unwrap_or_else(|| path.join(".readonly").exists());

        results.push(DetectedDrive {
            name,
            model,
            size_bytes,
            removable,
            usb,
            mount_point: Some(path.to_string_lossy().into_owned()),
            fs_type,
            mount_readonly,
        });
    }
    results.sort_by(|a, b| a.name.cmp(&b.name));
    results
}

pub fn scan_mock_drives() -> Vec<DetectedDrive> {
    scan_mock_drives_at(&mock_drives_path(), enabled())
}

/// Scan sysfs-backed drives and append spawned mock drives when active.
pub fn scan_all(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    let mut drives = crate::detect::scan(sys_block, proc_mounts);
    if enabled() {
        for mock in scan_mock_drives() {
            drives.retain(|d| d.name != mock.name);
            drives.push(mock);
        }
        drives.sort_by(|a, b| a.name.cmp(&b.name));
    }
    drives
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn directory_as_drive_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("fixture-vol");
        fs::create_dir_all(vol.join("DCIM")).unwrap();
        fs::write(vol.join("readme.txt"), b"fixture").unwrap();

        let mock = detected_drive_at(&vol, true, "sdmock_fixture", "Fixture Drive")
            .expect("directory should be detected");
        assert_eq!(mock.name, "sdmock_fixture");
        assert_eq!(mock.model, "Fixture Drive");
        assert_eq!(mock.size_bytes, DEFAULT_SIZE_BYTES);
        assert!(mock.usb);
        assert_eq!(mock.fs_type.as_deref(), Some("exfat"));
        assert!(mock.mount_point.as_ref().unwrap().contains("fixture-vol"));
    }

    #[test]
    fn directory_as_drive_disabled_when_missing_or_off() {
        let dir = tempfile::tempdir().unwrap();
        let vol = dir.path().join("missing");
        assert!(detected_drive_at(&vol, true, "sdmock_x", "X").is_none());
        assert!(detected_drive_at(&vol, false, "sdmock_x", "X").is_none());
    }

    #[test]
    fn scan_all_injects_mock_drives_over_real_sysfs() {
        let dir = tempfile::tempdir().unwrap();
        let mock_root = dir.path().join("mock-drives");
        let photos = mock_root.join("photos");
        fs::create_dir_all(&photos).unwrap();
        fs::write(
            photos.join(".drive.json"),
            serde_json::to_string(&MockDriveConfig {
                name: Some("sdmock_photos".into()),
                model: Some("Mock Photos Drive".into()),
                size_bytes: Some(128_000_000_000),
                fs_type: Some("exfat".into()),
                removable: Some(true),
                usb: Some(true),
                mount_readonly: Some(false),
            })
            .unwrap(),
        )
        .unwrap();

        let sys = dir.path().join("sys/block");
        fs::create_dir_all(sys.join("sda/device")).unwrap();
        fs::write(sys.join("sda/size"), "1000\n").unwrap();
        fs::write(sys.join("sda/removable"), "1\n").unwrap();

        let mut drives = crate::detect::scan(&sys, "proc /proc proc rw 0 0\n");
        for mock in scan_mock_drives_at(&mock_root, true) {
            drives.retain(|d| d.name != mock.name);
            drives.push(mock);
        }
        assert!(drives.iter().any(|d| d.name == "sdmock_photos"));
        assert!(drives.iter().any(|d| d.name == "sda"));
        assert!(
            !drives
                .iter()
                .any(|d| d.name == "sdmock" && d.model == "64GB PSSD")
        );
    }

    #[test]
    fn adopt_directory_fixture_as_is() {
        use crate::drives::DriveManager;
        use crate::mount::CommandMounter;
        use std::sync::Arc;

        let root = tempfile::tempdir().unwrap();
        let vol = root.path().join("mock-drives/photos");
        fs::create_dir_all(vol.join("DCIM")).unwrap();
        fs::write(vol.join("hello.txt"), b"hi").unwrap();

        let device = detected_drive_at(&vol, true, "sdmock_photos", "Mock Photos Drive").unwrap();
        let mgr = DriveManager::new(Arc::new(CommandMounter), root.path());
        let conn = crate::db::open(&root.path().join("luna.db")).unwrap();
        let row = mgr.adopt(&conn, &device, "Portable SSD", false);
        if let Err(e) = &row {
            panic!("adopt failed: {e:#}");
        }
        let row = row.unwrap();
        assert_eq!(row.label, "Portable SSD");
        assert_eq!(row.device, "sdmock_photos");
        assert!(Path::new(&row.mount_point).join(".luna").exists());
    }

    #[test]
    fn scan_mock_drives_detects_multiple_and_respects_unplugged() {
        let dir = tempfile::tempdir().unwrap();
        let mock_root = dir.path().join("mock-drives");
        let d1 = mock_root.join("photos");
        let d2 = mock_root.join("docs");
        let d3 = mock_root.join("unplugged_drive");
        fs::create_dir_all(&d1).unwrap();
        fs::create_dir_all(&d2).unwrap();
        fs::create_dir_all(&d3).unwrap();
        fs::write(d3.join(".unplugged"), "").unwrap();

        fs::write(
            d2.join(".drive.json"),
            serde_json::to_string(&MockDriveConfig {
                name: Some("sdmock_workdocs".into()),
                model: Some("Work Documents SSD".into()),
                size_bytes: Some(256_000_000_000),
                fs_type: Some("ext4".into()),
                removable: Some(true),
                usb: Some(true),
                mount_readonly: Some(false),
            })
            .unwrap(),
        )
        .unwrap();

        let drives = scan_mock_drives_at(&mock_root, true);
        assert_eq!(drives.len(), 2);

        let photos = drives.iter().find(|d| d.name == "sdmock_photos").unwrap();
        assert_eq!(photos.model, "Mock Drive (photos)");
        assert_eq!(photos.size_bytes, DEFAULT_SIZE_BYTES);
        assert_eq!(photos.fs_type.as_deref(), Some("exfat"));

        let docs = drives.iter().find(|d| d.name == "sdmock_workdocs").unwrap();
        assert_eq!(docs.model, "Work Documents SSD");
        assert_eq!(docs.size_bytes, 256_000_000_000);
        assert_eq!(docs.fs_type.as_deref(), Some("ext4"));

        // Unplugged drive must not be in the list
        assert!(drives.iter().all(|d| !d.name.contains("unplugged")));
    }
}
