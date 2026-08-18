//! Physical drive detection from sysfs and /proc/mounts.
//!
//! This is read-only by design: it identifies attached block devices and
//! which filesystems (if any) are currently mounted. Adoption and mounting
//! happen later and only after an explicit user action.
//!
//! Paths are injectable so every branch is unit-tested against a fake sysfs.

use std::collections::HashMap;
use std::path::Path;

/// A block device as reported by sysfs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedDrive {
    /// Kernel name, e.g. `sda`, `nvme0n1`.
    pub name: String,
    /// Vendor/model text if available.
    pub model: String,
    /// Total size in bytes.
    pub size_bytes: u64,
    /// sysfs `removable` flag (USB storage is removable).
    pub removable: bool,
    /// True when the device node lives under a `usb` branch of the sysfs tree.
    pub usb: bool,
    /// Current mount point, if mounted.
    pub mount_point: Option<String>,
    /// Current filesystem type, if mounted.
    pub fs_type: Option<String>,
}

impl DetectedDrive {
    pub fn is_storage_candidate(&self) -> bool {
        let n = self.name.as_str();
        (n.starts_with("sd") || n.starts_with("hd") || n.starts_with("vd") || n.starts_with("nvme"))
            && !n
                .chars()
                .last()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            && !self.name.contains("loop")
    }
}

pub fn scan(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    let mounts = parse_mounts(proc_mounts);
    // The device that carries the running OS (the `/` mount and its parent
    // disk) must never be offered up for adoption — adopting it would let Luna
    // write a `.luna` marker at the system root and then recursively walk,
    // hash, protect and thumbnail the whole OS. Same for anything mounted at `/`.
    let system_devices = system_devices(proc_mounts);
    let mut drives = Vec::new();
    let Ok(entries) = std::fs::read_dir(sys_block) else {
        return drives;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_block_name(&name) {
            continue;
        }
        let dir = entry.path();
        let removable = read_trimmed(&dir.join("removable")).as_deref() == Some("1");
        let size_sectors: u64 = read_trimmed(&dir.join("size"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let size_bytes = size_sectors.saturating_mul(512);
        let model = read_model(&dir);
        let usb = device_path_is_usb(&dir);
        let (mount_point, fs_type) = mounts.get(&name).cloned().unwrap_or((None, None));

        // Never surface the live OS disk (or anything mounted at the system
        // root) as an adoptable drive.
        if system_devices.contains(&name) || mount_point.as_deref() == Some("/") {
            continue;
        }

        drives.push(DetectedDrive {
            name,
            model,
            size_bytes,
            removable,
            usb,
            mount_point,
            fs_type,
        });
    }
    drives.sort_by(|a, b| a.name.cmp(&b.name));
    drives
}

/// Names of the block devices backing the running OS root (`/`) — the exact
/// device and its parent disk (so `sda1` → `sda` is covered).
fn system_devices(proc_mounts: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in proc_mounts.lines() {
        let mut fields = line.split_whitespace();
        let Some(device) = fields.next() else {
            continue;
        };
        let Some(point) = fields.next() else { continue };
        if point != "/" {
            continue;
        }
        let dev = Path::new(device)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| device.to_string());
        if !out.contains(&dev) {
            out.push(dev.clone());
        }
        if let Some(parent) = parent_device(&dev).filter(|p| p != &dev)
            && !out.contains(&parent)
        {
            out.push(parent);
        }
    }
    out
}

fn is_block_name(name: &str) -> bool {
    name.starts_with("sd")
        || name.starts_with("hd")
        || name.starts_with("vd")
        || name.starts_with("nvme")
}

fn read_trimmed(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_model(dir: &Path) -> String {
    let model = read_trimmed(&dir.join("device/model"));
    let vendor = read_trimmed(&dir.join("device/vendor"));
    match (vendor, model) {
        (Some(v), Some(m)) => format!("{v} {m}").trim().to_string(),
        (None, Some(m)) => m,
        (Some(v), None) => v,
        (None, None) => String::new(),
    }
}

fn device_path_is_usb(dir: &Path) -> bool {
    let Ok(target) = std::fs::canonicalize(dir.join("device")) else {
        return false;
    };
    target.components().any(|c| c.as_os_str() == "usb")
}

/// Strip partition suffixes to the parent disk name: `sda1` -> `sda`,
/// `nvme0n1p2` -> `nvme0n1`, `mmcblk0p1` -> `mmcblk0`.
fn parent_device(name: &str) -> Option<String> {
    let mut end = name.len();
    while end > 0 && name.as_bytes()[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == name.len() {
        return None;
    }
    let mut core = &name[..end];
    if let Some(stripped) = core.strip_suffix('p') {
        core = stripped;
    }
    if core.is_empty() {
        None
    } else {
        Some(core.to_string())
    }
}

/// Parse `/proc/mounts` into `device -> (mount_point, fs_type)`.
pub fn parse_mounts(proc_mounts: &str) -> HashMap<String, (Option<String>, Option<String>)> {
    let mut map = HashMap::new();
    for line in proc_mounts.lines() {
        let mut fields = line.split_whitespace();
        let Some(device) = fields.next() else {
            continue;
        };
        let Some(point) = fields.next() else { continue };
        let Some(fs) = fields.next() else { continue };
        let dev = Path::new(device)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| device.to_string());
        map.insert(dev.clone(), (Some(point.to_string()), Some(fs.to_string())));
        // A mount on `sda1` is a mount on drive `sda` for drive-level reporting.
        if let Some(parent) = parent_device(&dev).filter(|parent| *parent != dev) {
            map.entry(parent)
                .or_insert_with(|| (Some(point.to_string()), Some(fs.to_string())));
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fake_sysfs(root: &Path) -> PathBuf {
        let sys = root.join("sys/block");
        fs::create_dir_all(sys.join("sda/device")).unwrap();
        fs::create_dir_all(sys.join("sdb/device")).unwrap();
        fs::write(sys.join("sda/size"), "1953525168\n").unwrap();
        fs::write(sys.join("sda/removable"), "1\n").unwrap();
        fs::write(sys.join("sda/device/model"), "Backup Plus\n").unwrap();
        fs::write(sys.join("sda/device/vendor"), "Seagate\n").unwrap();
        fs::write(sys.join("sdb/size"), "123456\n").unwrap();
        fs::write(sys.join("sdb/removable"), "0\n").unwrap();
        sys
    }

    #[test]
    fn scans_fake_sysfs() {
        let root = tempfile::tempdir().unwrap();
        let sys = fake_sysfs(root.path());
        let drives = scan(
            &sys,
            "/dev/sda1 /mnt/photos ext4 rw 0 0\nproc /proc proc rw 0 0\n",
        );
        assert_eq!(drives.len(), 2);
        let sda = drives.iter().find(|d| d.name == "sda").unwrap();
        assert_eq!(sda.size_bytes, 1953525168 * 512);
        assert!(sda.removable);
        assert_eq!(sda.model, "Seagate Backup Plus");
        assert_eq!(sda.mount_point.as_deref(), Some("/mnt/photos"));
        assert_eq!(sda.fs_type.as_deref(), Some("ext4"));
    }

    #[test]
    fn device_is_storage_candidate_not_partition() {
        let mut d = DetectedDrive {
            name: "sda".into(),
            model: String::new(),
            size_bytes: 0,
            removable: true,
            usb: false,
            mount_point: None,
            fs_type: None,
        };
        assert!(d.is_storage_candidate());
        d.name = "sda1".into();
        assert!(!d.is_storage_candidate());
        d.name = "loop0".into();
        assert!(!d.is_storage_candidate());
    }

    #[test]
    fn parse_mounts_maps_whole_devices() {
        let map = parse_mounts("/dev/sdb1 /mnt/one ext4 rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\n");
        let (point, fs) = map.get("sdb1").unwrap();
        assert_eq!(point.as_deref(), Some("/mnt/one"));
        assert_eq!(fs.as_deref(), Some("ext4"));
    }

    #[test]
    fn system_root_device_is_never_adoptable() {
        let root = tempfile::tempdir().unwrap();
        let sys = fake_sysfs(root.path());
        // Add a fake NVMe boot disk mounted at /.
        fs::create_dir_all(sys.join("nvme0n1/device")).unwrap();
        fs::write(sys.join("nvme0n1/size"), "999999\n").unwrap();
        fs::write(sys.join("nvme0n1/removable"), "0\n").unwrap();
        let mounts = "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/sda1 /mnt/photos ext4 rw 0 0\nproc /proc proc rw 0 0\n";

        let drives = scan(&sys, mounts);
        assert!(
            drives.iter().all(|d| d.name != "nvme0n1"),
            "the OS boot disk must not be offered for adoption"
        );
        assert!(
            drives.iter().any(|d| d.name == "sda"),
            "an unrelated USB drive must still be offered"
        );
    }
}
