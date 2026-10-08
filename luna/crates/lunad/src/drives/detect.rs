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
    /// True when `/proc/mounts` lists the mount as `ro` (exact option token).
    pub mount_readonly: bool,
}

impl DetectedDrive {
    pub fn is_storage_candidate(&self) -> bool {
        let n = self.name.as_str();
        if n.starts_with("sdmock") {
            return true;
        }
        if n.contains("loop") {
            return false;
        }
        if n.starts_with("nvme") || n.starts_with("mmcblk") {
            // eMMC boot/rpmb regions are never adoptable storage.
            if n.contains("boot") || n.contains("rpmb") {
                return false;
            }
            // Whole devices end in a digit (nvme0n1, mmcblk0); partitions
            // add a `p` before the number (nvme0n1p2, mmcblk0p1).
            let core = n.trim_end_matches(|c: char| c.is_ascii_digit());
            return !(core.len() < n.len() && core.ends_with('p'));
        }
        // sd/hd/vd partitions are the disk name plus digits (sda1).
        (n.starts_with("sd") || n.starts_with("hd") || n.starts_with("vd"))
            && !n
                .chars()
                .last()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
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
        let mounted = mounts.get(&name).and_then(|m| m.first());
        let mount_point = mounted.map(|m| m.mount_point.clone());
        let fs_type = mounted.map(|m| m.fs_type.clone());
        let mount_readonly = mounted.map(|m| m.read_only).unwrap_or(false);

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
            mount_readonly,
        });
    }
    drives.sort_by(|a, b| a.name.cmp(&b.name));
    drives
}

/// Scan sysfs-backed drives and append spawned dev-mock drives when active.
///
/// This is the production scan entry point: real hardware plus, in debug
/// builds or with `LUNA_MOCK_DRIVES=1`, directory mock drives for UI review.
pub fn scan_with_dev_mocks(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    let mut drives = scan(sys_block, proc_mounts);
    if crate::dev_mock::enabled() {
        for mock in crate::dev_mock::scan_mock_drives() {
            drives.retain(|d| d.name != mock.name);
            drives.push(mock);
        }
        drives.sort_by(|a, b| a.name.cmp(&b.name));
    }
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
        || name.starts_with("mmcblk")
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
    // The kernel names each USB bus `usb1`, `usb2`, ... in the device path
    // (`.../0000:00:14.0/usb2/2-1/2-1:1.0/host6/...`), never plain `usb`.
    target
        .components()
        .any(|c| is_usb_bus_component(c.as_os_str()))
}

/// `usb1`, `usb2`, ... — one path component per USB bus in a sysfs device path.
pub(crate) fn is_usb_bus_component(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .and_then(|s| s.strip_prefix("usb"))
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
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

/// A filesystem currently mounted, as `/proc/mounts` reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountedFs {
    pub mount_point: String,
    pub fs_type: String,
    pub read_only: bool,
}

/// Parse `/proc/mounts` into `device -> all of its mounts`. A disk can
/// show several partitions mounted at once; callers must see every one,
/// not just the first the kernel happened to list.
pub fn parse_mounts(proc_mounts: &str) -> HashMap<String, Vec<MountedFs>> {
    let mut map: HashMap<String, Vec<MountedFs>> = HashMap::new();
    for line in proc_mounts.lines() {
        let mut fields = line.split_whitespace();
        let Some(device) = fields.next() else {
            continue;
        };
        let Some(point) = fields.next() else { continue };
        let Some(fs) = fields.next() else { continue };
        let opts = fields.next().unwrap_or("");
        let read_only = opts.split(',').any(|t| t == "ro");
        let info = MountedFs {
            mount_point: point.to_string(),
            fs_type: fs.to_string(),
            read_only,
        };
        let dev = Path::new(device)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| device.to_string());
        map.entry(dev.clone()).or_default().push(info.clone());
        // A mount on `sda1` is a mount on drive `sda` for drive-level reporting.
        if let Some(parent) = parent_device(&dev).filter(|parent| *parent != dev) {
            let parent_list = map.entry(parent).or_default();
            if !parent_list
                .iter()
                .any(|m| m.mount_point == info.mount_point)
            {
                parent_list.push(info);
            }
        }
    }
    map
}

pub(crate) fn is_partition_of(disk: &str, name: &str) -> bool {
    if name == disk {
        return true;
    }
    parent_device(name).as_deref() == Some(disk)
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

    #[cfg(unix)]
    #[test]
    fn a_drive_behind_a_usb_bus_is_usb_even_when_it_says_it_is_not_removable() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys/block");
        // Real layout: the device link points through a `usbN` bus directory.
        let dev = root
            .path()
            .join("sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0");
        fs::create_dir_all(&dev).unwrap();
        fs::create_dir_all(sys.join("sdb")).unwrap();
        std::os::unix::fs::symlink(&dev, sys.join("sdb/device")).unwrap();
        fs::write(sys.join("sdb/size"), "524288\n").unwrap();
        fs::write(sys.join("sdb/removable"), "0\n").unwrap();
        // An internal SATA disk and a path that only has "usb" inside a name.
        let sata = root.path().join("sys/devices/pci0000:00/0000:00:1f.2/ata1/host0/target0:0:0/0:0:0:0");
        fs::create_dir_all(&sata).unwrap();
        fs::create_dir_all(sys.join("sdc")).unwrap();
        std::os::unix::fs::symlink(&sata, sys.join("sdc/device")).unwrap();
        fs::write(sys.join("sdc/size"), "1000\n").unwrap();
        fs::write(sys.join("sdc/removable"), "0\n").unwrap();
        let drives = scan(&sys, "");
        assert!(drives.iter().find(|d| d.name == "sdb").unwrap().usb);
        assert!(!drives.iter().find(|d| d.name == "sdc").unwrap().usb);
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
            mount_readonly: false,
        };
        for whole in ["sda", "sdb", "vda", "nvme0n1", "nvme1n1", "mmcblk0"] {
            d.name = whole.into();
            assert!(d.is_storage_candidate(), "{whole}");
        }
        for part in [
            "sda1",
            "sdb12",
            "nvme0n1p1",
            "nvme1n1p15",
            "mmcblk0p1",
            "mmcblk0boot0",
            "mmcblk0rpmb",
            "loop0",
        ] {
            d.name = part.into();
            assert!(!d.is_storage_candidate(), "{part}");
        }
    }

    #[test]
    fn parse_mounts_maps_whole_devices() {
        let map = parse_mounts("/dev/sdb1 /mnt/one ext4 rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\n");
        let info = &map.get("sdb1").unwrap()[0];
        assert_eq!(info.mount_point, "/mnt/one");
        assert_eq!(info.fs_type, "ext4");
        assert!(!info.read_only);
    }

    #[test]
    fn parse_mounts_tracks_every_partition_of_a_disk() {
        let map = parse_mounts(
            "/dev/sdb1 /mnt/one ext4 rw 0 0\n/dev/sdb2 /mnt/two vfat ro 0 0\n/dev/sdc1 /x ext4 rw 0 0\n",
        );
        let points: Vec<&str> = map
            .get("sdb")
            .unwrap()
            .iter()
            .map(|m| m.mount_point.as_str())
            .collect();
        assert_eq!(points, ["/mnt/one", "/mnt/two"]);
        assert_eq!(map.get("sdc").unwrap().len(), 1);
    }

    #[test]
    fn parse_mounts_treats_ro_token_not_remount_ro_substring() {
        let map = parse_mounts(
            "/dev/sdb1 /mnt/iso iso9660 ro,relatime 0 0\n/dev/sdc1 /mnt/data ext4 rw,errors=remount-ro 0 0\n",
        );
        assert!(map.get("sdb1").unwrap()[0].read_only);
        assert!(!map.get("sdc1").unwrap()[0].read_only);
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
