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
pub const MOCK_DRIVES_DIR_NAME: &str = "mock-drives";

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

/// Whether the mock PSSD and mock drives should appear in drive detection.
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

/// Path to dynamic mock drives directory.
pub fn mock_drives_path() -> PathBuf {
    if let Ok(p) = std::env::var("LUNA_MOCK_DRIVES_PATH") {
        return PathBuf::from(p);
    }
    std::env::var("LUNA_DATA_DIR")
        .map(|d| PathBuf::from(d).join(MOCK_DRIVES_DIR_NAME))
        .unwrap_or_else(|_| PathBuf::from(MOCK_DRIVES_DIR_NAME))
}

/// Build the legacy mock PSSD drive when the volume exists and mock mode is on.
pub fn detected_drive() -> Option<DetectedDrive> {
    detected_drive_at(&volume_path(), enabled())
}

fn detected_drive_at(root: &Path, on: bool) -> Option<DetectedDrive> {
    if !on {
        return None;
    }
    if !root.is_dir() || root.join(".unplugged").exists() {
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
        let size_bytes = config.size_bytes.unwrap_or(SIZE_BYTES);
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

/// Scan sysfs-backed drives and append dev mocks when active.
pub fn scan_all(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    let mut drives = crate::detect::scan(sys_block, proc_mounts);
    if enabled() {
        if let Some(mock) = detected_drive() {
            drives.retain(|d| d.name != mock.name);
            drives.push(mock);
        }
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
        assert_eq!(photos.size_bytes, SIZE_BYTES);
        assert_eq!(photos.fs_type.as_deref(), Some("exfat"));

        let docs = drives.iter().find(|d| d.name == "sdmock_workdocs").unwrap();
        assert_eq!(docs.model, "Work Documents SSD");
        assert_eq!(docs.size_bytes, 256_000_000_000);
        assert_eq!(docs.fs_type.as_deref(), Some("ext4"));

        // Unplugged drive must not be in the list
        assert!(drives.iter().all(|d| !d.name.contains("unplugged")));
    }
}
