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
    /// The kernel's disk sequence number (`/sys/block/<name>/diskseq`). It changes
    /// every time the device is plugged in, so it tells a re-plugged stick apart
    /// from the one that was there before. `None` when unknown (and for mocks).
    pub diskseq: Option<u64>,
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
    let live_root = root_block_device();
    scan_with_live_root(sys_block, proc_mounts, live_root.as_deref())
}

/// `scan`, with the device backing `/` supplied instead of looked up here:
/// tests scan a made-up sysfs, and the machine running them boots from
/// whatever disk it happens to boot from.
pub fn scan_with_live_root(
    sys_block: &Path,
    proc_mounts: &str,
    live_root: Option<&str>,
) -> Vec<DetectedDrive> {
    let mounts = parse_mounts(proc_mounts);
    // The device that carries the running OS (the `/` mount and its parent
    // disk) must never be offered up for adoption — adopting it would let Luna
    // write a `.luna` marker at the system root and then recursively walk,
    // hash, protect and thumbnail the whole OS. Same for anything mounted at `/`.
    let system_devices = system_devices(proc_mounts, live_root);
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
        let diskseq: Option<u64> = read_trimmed(&dir.join("diskseq")).and_then(|s| s.parse().ok());

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
            diskseq,
        });
    }
    drives.sort_by(|a, b| a.name.cmp(&b.name));
    drives
}

/// Scan sysfs-backed drives and append spawned dev-mock drives when active.
///
/// This is the production scan entry point. Release builds list real hardware
/// only. Debug builds (or `LUNA_MOCK_DRIVES=only`) list only the directory mock
/// drives, so nothing real can be listed or adopted; `LUNA_MOCK_DRIVES=1` lists
/// real hardware plus the mocks.
pub fn scan_with_dev_mocks(sys_block: &Path, proc_mounts: &str) -> Vec<DetectedDrive> {
    use crate::dev_mock::{Mode, mode, scan_mock_drives};
    match mode() {
        Mode::Off => scan(sys_block, proc_mounts),
        Mode::On => merge_mock_drives(scan(sys_block, proc_mounts), scan_mock_drives()),
        Mode::Only => merge_mock_drives(Vec::new(), scan_mock_drives()),
    }
}

/// Adds `mocks` to `drives`; a mock replaces a real drive of the same name.
fn merge_mock_drives(
    mut drives: Vec<DetectedDrive>,
    mocks: Vec<DetectedDrive>,
) -> Vec<DetectedDrive> {
    for mock in mocks {
        drives.retain(|d| d.name != mock.name);
        drives.push(mock);
    }
    drives.sort_by(|a, b| a.name.cmp(&b.name));
    drives
}

/// Names of the block devices backing the running OS root (`/`) — the exact
/// device and its parent disk (so `sda1` → `sda` is covered).
///
/// A root mounted by label or PARTLABEL (`root=PARTLABEL=LUNA_A`, what the
/// Luna OS image ships) has no name for the kernel to report there: it reads
/// `/dev/root`. `live_root`, resolved by `root_block_device`, fills that gap.
fn system_devices(proc_mounts: &str, live_root: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |dev: &str, out: &mut Vec<String>| {
        if dev.is_empty() || out.iter().any(|d| d == dev) {
            return;
        }
        out.push(dev.to_string());
        if let Some(parent) = parent_device(dev).filter(|p| p != dev)
            && !out.iter().any(|d| d == &parent)
        {
            out.push(parent);
        }
    };
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
        push(&dev, &mut out);
    }
    if let Some(dev) = live_root {
        push(dev, &mut out);
    }
    out
}

/// The block device that backs `/` right now, named the way sysfs names it
/// (`sda3`, `nvme0n1p2`, or a whole disk such as `sdb`).
///
/// `/proc/mounts` names the root device only when the kernel cmdline used
/// `root=/dev/...`; for a root found by PARTLABEL it says `/dev/root` and no
/// part of the OS can tell which disk it is running from. The kernel still
/// knows the device number behind `/`, and sysfs turns that back into a name.
pub fn root_block_device() -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let dev = std::fs::metadata("/").ok()?.dev();
    block_name_for(dev, Path::new("/sys/dev/block"))
}

/// `sda3` for the device number of the filesystem mounted at `dev`'s major:
/// minor, read out of sysfs. Split out so tests can point it at a fake tree.
fn block_name_for(dev: u64, sys_dev_block: &Path) -> Option<String> {
    let major = libc::major(dev as libc::dev_t);
    let minor = libc::minor(dev as libc::dev_t);
    let link = std::fs::read_link(sys_dev_block.join(format!("{major}:{minor}"))).ok()?;
    link.file_name().map(|n| n.to_string_lossy().into_owned())
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
pub(crate) fn parent_device(name: &str) -> Option<String> {
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

    fn mock(name: &str) -> DetectedDrive {
        DetectedDrive {
            name: name.into(),
            model: "Mock".into(),
            size_bytes: 1,
            removable: true,
            usb: true,
            mount_point: Some("/tmp/mock".into()),
            fs_type: Some("exfat".into()),
            mount_readonly: false,
            diskseq: None,
        }
    }

    #[test]
    fn mock_drives_join_real_ones_and_replace_a_real_drive_of_the_same_name() {
        let real = vec![mock("sda"), mock("sdb")];
        let merged = merge_mock_drives(real, vec![mock("sdb"), mock("sdmock_a")]);
        let names: Vec<_> = merged.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["sda", "sdb", "sdmock_a"]);
    }

    #[test]
    fn mocks_alone_list_only_the_mocks() {
        let merged = merge_mock_drives(Vec::new(), vec![mock("sdmock_b"), mock("sdmock_a")]);
        let names: Vec<_> = merged.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["sdmock_a", "sdmock_b"]);
    }

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
        let sata = root
            .path()
            .join("sys/devices/pci0000:00/0000:00:1f.2/ata1/host0/target0:0:0/0:0:0:0");
        fs::create_dir_all(&sata).unwrap();
        fs::create_dir_all(sys.join("sdc")).unwrap();
        std::os::unix::fs::symlink(&sata, sys.join("sdc/device")).unwrap();
        fs::write(sys.join("sdc/size"), "1000\n").unwrap();
        fs::write(sys.join("sdc/removable"), "0\n").unwrap();
        let drives = scan_with_live_root(&sys, "", None);
        assert!(drives.iter().find(|d| d.name == "sdb").unwrap().usb);
        assert!(!drives.iter().find(|d| d.name == "sdc").unwrap().usb);
    }

    #[test]
    fn scans_fake_sysfs() {
        let root = tempfile::tempdir().unwrap();
        let sys = fake_sysfs(root.path());
        let drives = scan_with_live_root(
            &sys,
            "/dev/sda1 /mnt/photos ext4 rw 0 0\nproc /proc proc rw 0 0\n",
            None,
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
            diskseq: None,
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

        let drives = scan_with_live_root(&sys, mounts, None);
        assert!(
            drives.iter().all(|d| d.name != "nvme0n1"),
            "the OS boot disk must not be offered for adoption"
        );
        assert!(
            drives.iter().any(|d| d.name == "sda"),
            "an unrelated USB drive must still be offered"
        );
    }

    #[test]
    fn system_root_found_by_partlabel_is_never_adoptable() {
        let root = tempfile::tempdir().unwrap();
        let sys = fake_sysfs(root.path());
        fs::create_dir_all(sys.join("sda/device")).unwrap();
        fs::write(sys.join("sda/size"), "999999\n").unwrap();
        fs::write(sys.join("sda/removable"), "0\n").unwrap();
        fs::create_dir_all(sys.join("sdb/device")).unwrap();
        fs::write(sys.join("sdb/size"), "524288\n").unwrap();
        fs::write(sys.join("sdb/removable"), "1\n").unwrap();
        // `root=PARTLABEL=LUNA_A` leaves no device name in the mounts table.
        let mounts = "/dev/root / ext4 ro 0 0\n/dev/sda5 /var/lib/luna ext4 rw 0 0\n";

        let drives = scan_with_live_root(&sys, mounts, Some("sda3"));
        assert!(
            drives.iter().all(|d| d.name != "sda"),
            "the disk carrying / must not be offered, whatever the mounts table says"
        );
        assert!(drives.iter().any(|d| d.name == "sdb"));
    }

    #[test]
    fn block_name_comes_from_the_device_number() {
        let root = tempfile::tempdir().unwrap();
        let dev_block = root.path().join("dev/block");
        fs::create_dir_all(dev_block.join("block")).unwrap();
        let target = dev_block.join("block/sda/sda3");
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, dev_block.join("8:3")).unwrap();

        let dev = libc::makedev(8, 3) as u64;
        assert_eq!(block_name_for(dev, &dev_block).as_deref(), Some("sda3"));
        assert_eq!(
            block_name_for(libc::makedev(8, 99) as u64, &dev_block),
            None
        );
    }
}
