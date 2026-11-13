//! A read-only look at a physical disk, and the server's **empty verdict**.
//!
//! Nothing in here writes to the disk. It answers two questions before an
//! erase: *which drive is this* (serial or WWN, size, partition layout, the
//! kernel's plug-in sequence number) and *what would be lost* (recognisable
//! top-level names, counts, bytes used).
//!
//! The verdict decides whether the person must wait 30 seconds before the
//! erase button works. The client never claims a drive is empty; this does.
//! A drive is **verified empty** only when one of these is certain:
//!
//! - nothing identifiable is on it at all (no partition table, no filesystem
//!   or container signature anywhere, including the backup table at its end); or
//! - it has a partition table and every partition mounts read-only and holds
//!   only entries the filesystem or an operating system creates on its own.
//!
//! Everything else is "not empty" and waits: an unreadable or unknown
//! filesystem, a locked LUKS container, installer media, anything uncertain,
//! and any trash folder that still has something in it.

use std::path::{Path, PathBuf};

use luna_core::marker;
use serde::Serialize;

use super::tools::DiskTools;
use crate::drives::DriveManager;
use crate::drives::detect::{self, DetectedDrive};
use crate::drives::fsprobe::{FsProbe, is_intrinsically_read_only, is_luks_type, is_writable_type};

/// Names shown in the preview. More than this and the count says so.
const PREVIEW_ENTRIES: usize = 30;

/// A trash folder is walked at most this far; a bigger one is not "empty".
const TRASH_WALK_LIMIT: usize = 2000;
const TRASH_DEPTH_LIMIT: usize = 8;

/// One partition as the kernel and `blkid` report it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartitionLayout {
    pub name: String,
    /// First sector, so two layouts that differ only in position differ.
    pub start_sectors: u64,
    pub size_bytes: u64,
    pub fs_type: String,
    pub label: String,
}

/// Which physical disk this is. A preview is bound to all of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskIdentity {
    /// Kernel name, e.g. `sdb`.
    pub name: String,
    pub model: String,
    pub size_bytes: u64,
    pub serial: Option<String>,
    pub wwn: Option<String>,
    /// The kernel's plug-in sequence number. Changes every time the stick is
    /// plugged in, so it tells a re-plugged (or swapped) stick from the one
    /// that was previewed. Cheap sticks often have no serial, or share one.
    pub diskseq: Option<u64>,
    /// A filesystem that sits on the whole disk, with no partition table.
    pub whole_fs_type: String,
    #[serde(skip)]
    pub layout: Vec<PartitionLayout>,
    /// A dev folder standing in for a drive.
    pub mock: bool,
}

impl DiskIdentity {
    /// The physical device is the same one: not swapped, not re-plugged.
    /// Ignores the layout, which changes as the erase writes.
    pub fn same_attachment(&self, other: &DiskIdentity) -> bool {
        self.name == other.name
            && self.model == other.model
            && self.size_bytes == other.size_bytes
            && self.serial == other.serial
            && self.wwn == other.wwn
            && self.diskseq == other.diskseq
            && self.mock == other.mock
    }

    /// The same device with the same partitions on it.
    pub fn same_disk(&self, other: &DiskIdentity) -> bool {
        self.same_attachment(other)
            && self.whole_fs_type == other.whole_fs_type
            && self.layout == other.layout
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PartitionState {
    /// Mounted read-only and holds only entries an OS makes on its own.
    Empty,
    HasFiles,
    /// Luna could not read it: a filesystem it knows but could not open.
    Unreadable,
    /// An encrypted container. Nothing inside can be listed.
    Locked,
    /// No filesystem, or one Luna can't read (LVM, RAID member, …).
    UnknownFilesystem,
    /// iso9660 and friends: installer media.
    InstallerMedia,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewEntry {
    pub name: String,
    /// `"folder"` or `"file"`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartitionPreview {
    pub name: String,
    pub size_bytes: u64,
    pub fs_type: String,
    pub label: String,
    pub state: PartitionState,
    /// Bytes in use, when the filesystem could be read.
    pub used_bytes: Option<u64>,
    /// Top-level folders and files that an OS did not make itself.
    pub folders: u64,
    pub files: u64,
    /// Top-level entries Luna could not read.
    pub unreadable: u64,
    /// Recognisable top-level names, folders first.
    pub entries: Vec<PreviewEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub identity: DiskIdentity,
    pub partitions: Vec<PartitionPreview>,
    /// Nothing identifiable on the disk at all.
    pub blank: bool,
    /// Signature types found on the whole disk (`gpt`, `exfat`, …).
    pub signatures: Vec<String>,
    /// The verdict: no wait needed.
    pub empty: bool,
}

impl Preview {
    /// Bytes in use, summed over what could be read.
    pub fn used_bytes(&self) -> Option<u64> {
        let sizes: Vec<u64> = self
            .partitions
            .iter()
            .filter_map(|p| p.used_bytes)
            .collect();
        if sizes.is_empty() {
            None
        } else {
            Some(sizes.iter().sum())
        }
    }
}

/// What the inspection reads: the kernel's view, and the mount table.
pub struct Env<'a> {
    pub manager: &'a DriveManager,
    pub tools: &'a dyn DiskTools,
    pub sys_block: &'a Path,
    /// `/proc/mounts` as text (a parameter so tests can fake it).
    pub proc_mounts: &'a str,
}

// ---------------------------------------------------------------------------
// Identity

fn read_trimmed(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let t = raw.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// A USB stick's serial lives on the USB device far above the block device;
/// an NVMe drive's sits one level up. Walk up the real path looking for one.
fn read_serial(sys_block: &Path, disk: &str) -> Option<String> {
    let dir = sys_block.join(disk);
    if let Some(s) = read_trimmed(&dir.join("device/serial")) {
        return Some(s);
    }
    let real = std::fs::canonicalize(dir.join("device")).ok()?;
    real.ancestors()
        .skip(1)
        .take(6)
        .find_map(|a| read_trimmed(&a.join("serial")))
}

fn read_wwn(sys_block: &Path, disk: &str) -> Option<String> {
    let dir = sys_block.join(disk);
    read_trimmed(&dir.join("wwid")).or_else(|| read_trimmed(&dir.join("device/wwid")))
}

/// The partitions the kernel lists for `disk`, with their sizes and positions.
fn read_layout(
    sys_block: &Path,
    disk: &str,
    probed: &[crate::drives::fsprobe::FsInfo],
) -> Vec<PartitionLayout> {
    let Ok(entries) = std::fs::read_dir(sys_block.join(disk)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != disk && detect::is_partition_of(disk, n))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let dir = sys_block.join(disk).join(&name);
            let number = |file: &str| {
                read_trimmed(&dir.join(file))
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0)
            };
            let info = probed.iter().find(|p| p.name == name);
            PartitionLayout {
                start_sectors: number("start"),
                size_bytes: number("size").saturating_mul(512),
                fs_type: info.map(|i| i.fs_type.clone()).unwrap_or_default(),
                label: info.map(|i| i.label.clone()).unwrap_or_default(),
                name,
            }
        })
        .collect()
}

/// A probe that finds nothing. Reading who a disk is without asking `blkid`
/// about every partition: the physical identity does not depend on it.
pub struct NoProbe;

impl FsProbe for NoProbe {
    fn probe_disk(&self, _disk: &str) -> Vec<crate::drives::fsprobe::FsInfo> {
        Vec::new()
    }
}

/// Read who this disk is. `mock` marks a dev folder standing in for a drive:
/// it has no sysfs entry and no partitions.
pub fn read_identity(
    sys_block: &Path,
    det: &DetectedDrive,
    probe: &dyn FsProbe,
    mock: bool,
) -> DiskIdentity {
    if mock {
        return DiskIdentity {
            name: det.name.clone(),
            model: det.model.clone(),
            size_bytes: det.size_bytes,
            serial: None,
            wwn: None,
            diskseq: None,
            whole_fs_type: String::new(),
            layout: Vec::new(),
            mock: true,
        };
    }
    let probed = probe.probe_disk(&det.name);
    let layout = read_layout(sys_block, &det.name, &probed);
    let whole_fs_type = probed
        .iter()
        .find(|p| p.name == det.name)
        .map(|p| p.fs_type.clone())
        .unwrap_or_default();
    DiskIdentity {
        name: det.name.clone(),
        model: det.model.clone(),
        size_bytes: det.size_bytes,
        serial: read_serial(sys_block, &det.name),
        wwn: read_wwn(sys_block, &det.name),
        diskseq: det.diskseq,
        whole_fs_type,
        layout,
        mock: false,
    }
}

// ---------------------------------------------------------------------------
// Contents

/// What the top of one mounted filesystem holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RootScan {
    pub folders: u64,
    pub files: u64,
    pub unreadable: u64,
    pub entries: Vec<PreviewEntry>,
    /// The folder could not be listed at all.
    pub listing_failed: bool,
}

impl RootScan {
    /// Nothing but what an OS made on its own, and every entry was readable.
    pub fn os_only(&self) -> bool {
        !self.listing_failed && self.unreadable == 0 && self.folders == 0 && self.files == 0
    }
}

/// `true` when nothing under `path` is a file other than `desktop.ini`.
/// Folders (`files/`, `info/`, per-user folders) are structure, not content.
/// A symlink, an unreadable entry or a trash too big to walk is not empty.
fn trash_is_empty(path: &Path) -> bool {
    let mut seen = 0usize;
    let mut stack = vec![(path.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > TRASH_DEPTH_LIMIT {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else { return false };
            seen += 1;
            if seen > TRASH_WALK_LIMIT {
                return false;
            }
            let Ok(ft) = entry.file_type() else {
                return false;
            };
            if ft.is_dir() {
                stack.push((entry.path(), depth + 1));
            } else if !entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("desktop.ini")
            {
                return false;
            }
        }
    }
    true
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut e| e.next().is_none())
}

/// Is this top-level entry something a filesystem or an OS makes by itself,
/// that the erase can safely ignore?
///
/// `case_insensitive` is true for FAT, exFAT and NTFS, where Windows and
/// macOS do not care how a name is capitalised.
fn is_os_made(path: &Path, name: &str, is_dir: bool, case_insensitive: bool) -> bool {
    let is = |want: &str| {
        if case_insensitive {
            name.eq_ignore_ascii_case(want)
        } else {
            name == want
        }
    };
    // Luna's own sticker file. It is recreated by the flow.
    if !is_dir && marker::is_marker_name(name) {
        return true;
    }
    if !is_dir {
        return false;
    }
    // Luna's trash, as long as nothing is in it.
    if let Some(prefix) = marker::extract_prefix(name)
        && name == format!("{prefix}-trash")
    {
        return trash_is_empty(path);
    }
    if is("lost+found") {
        // Recovered files in here are somebody's data.
        return is_empty_dir(path);
    }
    if is("System Volume Information") || is(".fseventsd") || is(".Spotlight-V100") {
        return true;
    }
    let trash_name = is("$RECYCLE.BIN")
        || is(".Trashes")
        || if case_insensitive {
            name.to_ascii_lowercase().starts_with(".trash-")
        } else {
            name.starts_with(".Trash-")
        };
    if trash_name {
        return trash_is_empty(path);
    }
    false
}

/// List the top of the filesystem mounted at `root`. Hidden names count: a
/// drive holding only `.git` is not empty. `ignore` names are skipped
/// entirely (a dev mock drive's own config files).
pub fn scan_root(root: &Path, case_insensitive: bool, ignore: &[&str]) -> RootScan {
    let mut scan = RootScan::default();
    let Ok(entries) = std::fs::read_dir(root) else {
        scan.listing_failed = true;
        return scan;
    };
    let mut named: Vec<PreviewEntry> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            scan.unreadable += 1;
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignore.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            scan.unreadable += 1;
            continue;
        };
        let is_dir = ft.is_dir();
        if is_os_made(&entry.path(), &name, is_dir, case_insensitive) {
            continue;
        }
        if is_dir {
            scan.folders += 1;
        } else {
            scan.files += 1;
        }
        named.push(PreviewEntry {
            name,
            kind: if is_dir { "folder" } else { "file" }.into(),
        });
    }
    named.sort_by(|a, b| {
        (a.kind != "folder")
            .cmp(&(b.kind != "folder"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    named.truncate(PREVIEW_ENTRIES);
    scan.entries = named;
    scan
}

fn case_insensitive_fs(fs: &str) -> bool {
    matches!(
        fs.to_ascii_lowercase().as_str(),
        "vfat" | "fat" | "fat32" | "msdos" | "exfat" | "ntfs" | "ntfs3" | "fuseblk"
    )
}

fn fs_opt(fs: &str) -> Option<&str> {
    (!fs.is_empty()).then_some(fs)
}

/// Read what is on one partition: through the mount that is already there,
/// or through a read-only one made just for the look and dropped again.
fn look_inside(env: &Env, name: &str, fs_type: &str) -> Option<(RootScan, Option<u64>)> {
    let ci = case_insensitive_fs(fs_type);
    let existing = detect::parse_mounts(env.proc_mounts)
        .get(name)
        .and_then(|m| m.first().map(|m| PathBuf::from(&m.mount_point)));
    if let Some(root) = existing {
        let used = crate::drives::summary::disk_space(&root).map(|s| s.used_bytes);
        return Some((scan_root(&root, ci, &[]), used));
    }
    let _look = env.manager.look_guard();
    let point = env.manager.format_look_point(name);
    env.manager
        .mounter()
        .mount_typed(&format!("/dev/{name}"), &point, true, fs_opt(fs_type))
        .ok()?;
    let scan = scan_root(&point, ci, &[]);
    let used = crate::drives::summary::disk_space(&point).map(|s| s.used_bytes);
    if env.manager.mounter().unmount(&point).is_err() {
        // Never leave a look-inside mount behind.
        let _ = env.manager.mounter().detach_stale(&point);
    }
    let _ = std::fs::remove_dir(&point);
    Some((scan, used))
}

/// Where an open LUKS container on partition `name` is mounted, if it is:
/// its device-mapper holder (`/sys/block/<disk>/<name>/holders/dm-N`) found in
/// `/proc/mounts` by `dm-N` or by its mapper name. Read-only use: never opens
/// or mounts anything.
fn open_container_mount(env: &Env, name: &str) -> Option<PathBuf> {
    let holders = match detect::parent_device(name).filter(|p| p != name) {
        Some(disk) => env.sys_block.join(disk).join(name).join("holders"),
        None => env.sys_block.join(name).join("holders"),
    };
    let mounts = detect::parse_mounts(env.proc_mounts);
    std::fs::read_dir(holders)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let dm = entry.file_name().to_string_lossy().into_owned();
            let mapper = read_trimmed(&env.sys_block.join(&dm).join("dm/name"));
            [Some(dm), mapper]
                .into_iter()
                .flatten()
                .find_map(|key| mounts.get(&key).and_then(|m| m.first()))
                .map(|m| PathBuf::from(&m.mount_point))
        })
}

fn preview_of(
    env: &Env,
    name: &str,
    size_bytes: u64,
    fs_type: &str,
    label: &str,
) -> PartitionPreview {
    let mut part = PartitionPreview {
        name: name.to_string(),
        size_bytes,
        fs_type: fs_type.to_string(),
        label: label.to_string(),
        state: PartitionState::UnknownFilesystem,
        used_bytes: None,
        folders: 0,
        files: 0,
        unreadable: 0,
        entries: Vec::new(),
    };
    if fs_type.is_empty() {
        return part;
    }
    if is_luks_type(fs_type) {
        // An unlocked container (Remove protection on a drive Luna has open)
        // is read through its live mount, so the person sees their files
        // before erasing them. A closed one can't be read: locked.
        let Some(root) = open_container_mount(env, name) else {
            part.state = PartitionState::Locked;
            return part;
        };
        let scan = scan_root(&root, false, &[]);
        part.used_bytes = crate::drives::summary::disk_space(&root).map(|s| s.used_bytes);
        part.folders = scan.folders;
        part.files = scan.files;
        part.unreadable = scan.unreadable;
        part.state = if scan.listing_failed {
            PartitionState::Unreadable
        } else if scan.os_only() {
            PartitionState::Empty
        } else {
            PartitionState::HasFiles
        };
        part.entries = scan.entries;
        return part;
    }
    let installer = is_intrinsically_read_only(fs_type);
    if !installer && !is_writable_type(fs_type) {
        // LVM, RAID, ZFS, BitLocker, swap, …: Luna can't say what is inside.
        return part;
    }
    let Some((scan, used)) = look_inside(env, name, fs_type) else {
        part.state = PartitionState::Unreadable;
        return part;
    };
    part.used_bytes = used;
    part.folders = scan.folders;
    part.files = scan.files;
    part.unreadable = scan.unreadable;
    part.state = if scan.listing_failed {
        PartitionState::Unreadable
    } else if installer {
        PartitionState::InstallerMedia
    } else if scan.os_only() {
        PartitionState::Empty
    } else {
        PartitionState::HasFiles
    };
    part.entries = scan.entries;
    part
}

/// Signatures a partition table alone leaves on the whole disk.
fn is_table_signature(sig: &str) -> bool {
    matches!(sig.to_ascii_lowercase().as_str(), "gpt" | "dos" | "pmbr")
}

/// The verdict. `signatures` is `None` when the disk could not be read for
/// them, which is never "empty".
pub fn empty_verdict(
    identity: &DiskIdentity,
    signatures: Option<&[String]>,
    partitions: &[PartitionPreview],
) -> bool {
    let Some(signatures) = signatures else {
        return false;
    };
    if identity.layout.is_empty() {
        if identity.whole_fs_type.is_empty() {
            // No table, no filesystem: blank, if wipefs agrees.
            return signatures.is_empty() && partitions.is_empty();
        }
        // A filesystem straight on the whole disk. Any other signature
        // (a table with no partitions, a second format) is unexplained.
        let explained = signatures
            .iter()
            .all(|s| s.eq_ignore_ascii_case(&identity.whole_fs_type));
        return explained && partitions.len() == 1 && partitions[0].state == PartitionState::Empty;
    }
    // A table: only table signatures may be on the whole disk, and every
    // partition must be provably empty. A hybrid (iso9660 on the whole disk
    // plus partitions) fails the first test.
    identity.whole_fs_type.is_empty()
        && signatures.iter().all(|s| is_table_signature(s))
        && partitions.len() == identity.layout.len()
        && partitions.iter().all(|p| p.state == PartitionState::Empty)
}

/// Look at `det` and decide. `mock` is true for a dev folder standing in for a drive.
pub fn inspect_disk(env: &Env, det: &DetectedDrive, mock: bool) -> Preview {
    let identity = read_identity(env.sys_block, det, env.manager.probe(), mock);
    if mock {
        return inspect_mock(det, identity);
    }
    let sigs = env
        .tools
        .list_signatures(&format!("/dev/{}", det.name))
        .ok();
    let mut partitions: Vec<PartitionPreview> = identity
        .layout
        .iter()
        .map(|p| preview_of(env, &p.name, p.size_bytes, &p.fs_type, &p.label))
        .collect();
    if identity.layout.is_empty() && !identity.whole_fs_type.is_empty() {
        partitions.push(preview_of(
            env,
            &identity.name,
            identity.size_bytes,
            &identity.whole_fs_type,
            "",
        ));
    }
    let empty = empty_verdict(&identity, sigs.as_deref(), &partitions);
    let blank = identity.layout.is_empty()
        && identity.whole_fs_type.is_empty()
        && sigs.as_ref().is_some_and(|s| s.is_empty());
    Preview {
        identity,
        partitions,
        blank,
        signatures: sigs.unwrap_or_default(),
        empty,
    }
}

/// A dev mock drive is a folder: its "disk" is whatever is in it. Its own
/// config files (`.drive.json`, `.unplugged`, `.readonly`) are not content.
fn inspect_mock(det: &DetectedDrive, identity: DiskIdentity) -> Preview {
    let root = det.mount_point.as_deref().map(Path::new);
    let scan = match root {
        Some(root) => scan_root(root, true, &[".drive.json", ".unplugged", ".readonly"]),
        None => RootScan {
            listing_failed: true,
            ..RootScan::default()
        },
    };
    let used = root
        .and_then(crate::drives::summary::disk_space)
        .map(|s| s.used_bytes);
    let state = if scan.listing_failed {
        PartitionState::Unreadable
    } else if scan.os_only() {
        PartitionState::Empty
    } else {
        PartitionState::HasFiles
    };
    let empty = state == PartitionState::Empty;
    let part = PartitionPreview {
        name: det.name.clone(),
        size_bytes: det.size_bytes,
        fs_type: det.fs_type.clone().unwrap_or_default(),
        label: String::new(),
        state,
        used_bytes: used,
        folders: scan.folders,
        files: scan.files,
        unreadable: scan.unreadable,
        entries: scan.entries,
    };
    Preview {
        identity,
        partitions: vec![part],
        blank: false,
        signatures: Vec::new(),
        empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::format::tools::MockTools;
    use crate::drives::fsprobe::{FsInfo, MockFsProbe};
    use std::fs;

    fn layout(name: &str, fs: &str) -> PartitionLayout {
        PartitionLayout {
            name: name.into(),
            start_sectors: 2048,
            size_bytes: 1 << 30,
            fs_type: fs.into(),
            label: String::new(),
        }
    }

    fn identity(layout: Vec<PartitionLayout>, whole: &str) -> DiskIdentity {
        DiskIdentity {
            name: "sdb".into(),
            model: "Stick".into(),
            size_bytes: 8 << 30,
            serial: Some("SER1".into()),
            wwn: None,
            diskseq: Some(7),
            whole_fs_type: whole.into(),
            layout,
            mock: false,
        }
    }

    fn part(name: &str, state: PartitionState) -> PartitionPreview {
        PartitionPreview {
            name: name.into(),
            size_bytes: 1 << 30,
            fs_type: "exfat".into(),
            label: String::new(),
            state,
            used_bytes: None,
            folders: 0,
            files: 0,
            unreadable: 0,
            entries: Vec::new(),
        }
    }

    fn sigs(list: &[&str]) -> Option<Vec<String>> {
        Some(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn a_disk_with_nothing_on_it_is_verified_empty() {
        let id = identity(vec![], "");
        assert!(empty_verdict(&id, sigs(&[]).as_deref(), &[]));
    }

    #[test]
    fn a_disk_that_could_not_be_read_for_signatures_is_never_empty() {
        let id = identity(vec![], "");
        assert!(!empty_verdict(&id, None, &[]));
    }

    #[test]
    fn a_table_with_no_partitions_is_not_blank() {
        let id = identity(vec![], "");
        assert!(!empty_verdict(&id, sigs(&["gpt"]).as_deref(), &[]));
    }

    #[test]
    fn a_table_whose_partitions_are_all_empty_is_empty() {
        let id = identity(vec![layout("sdb1", "exfat")], "");
        let parts = [part("sdb1", PartitionState::Empty)];
        assert!(empty_verdict(
            &id,
            sigs(&["gpt", "PMBR"]).as_deref(),
            &parts
        ));
    }

    #[test]
    fn one_partition_with_files_makes_the_disk_not_empty() {
        let id = identity(vec![layout("sdb1", "exfat"), layout("sdb2", "ext4")], "");
        let parts = [
            part("sdb1", PartitionState::Empty),
            part("sdb2", PartitionState::HasFiles),
        ];
        assert!(!empty_verdict(&id, sigs(&["gpt"]).as_deref(), &parts));
    }

    #[test]
    fn locked_unknown_unreadable_and_installer_partitions_all_wait() {
        let id = identity(vec![layout("sdb1", "x")], "");
        for state in [
            PartitionState::Locked,
            PartitionState::UnknownFilesystem,
            PartitionState::Unreadable,
            PartitionState::InstallerMedia,
        ] {
            let parts = [part("sdb1", state)];
            assert!(
                !empty_verdict(&id, sigs(&["gpt"]).as_deref(), &parts),
                "{state:?} must not count as empty"
            );
        }
    }

    #[test]
    fn an_isohybrid_stick_is_never_empty_even_with_an_empty_looking_partition() {
        let id = identity(vec![layout("sdb1", "vfat")], "iso9660");
        let parts = [part("sdb1", PartitionState::Empty)];
        assert!(!empty_verdict(
            &id,
            sigs(&["iso9660", "dos"]).as_deref(),
            &parts
        ));
    }

    #[test]
    fn a_foreign_signature_beside_the_table_waits() {
        // LVM or a RAID member on the whole disk is not "nothing".
        let id = identity(vec![layout("sdb1", "exfat")], "");
        let parts = [part("sdb1", PartitionState::Empty)];
        assert!(!empty_verdict(
            &id,
            sigs(&["gpt", "linux_raid_member"]).as_deref(),
            &parts
        ));
    }

    #[test]
    fn a_missing_partition_preview_is_not_empty() {
        let id = identity(vec![layout("sdb1", "exfat"), layout("sdb2", "exfat")], "");
        let parts = [part("sdb1", PartitionState::Empty)];
        assert!(!empty_verdict(&id, sigs(&["gpt"]).as_deref(), &parts));
    }

    #[test]
    fn an_empty_filesystem_straight_on_the_disk_is_empty() {
        let id = identity(vec![], "exfat");
        let parts = [part("sdb", PartitionState::Empty)];
        assert!(empty_verdict(&id, sigs(&["exfat"]).as_deref(), &parts));
        assert!(!empty_verdict(
            &id,
            sigs(&["exfat", "gpt"]).as_deref(),
            &parts
        ));
    }

    fn dir_with(names: &[&str], dirs: &[&str]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for n in names {
            fs::write(d.path().join(n), b"x").unwrap();
        }
        for n in dirs {
            fs::create_dir_all(d.path().join(n)).unwrap();
        }
        d
    }

    #[test]
    fn only_entries_an_os_makes_count_as_empty() {
        let d = dir_with(
            &[],
            &[
                "lost+found",
                "System Volume Information",
                "$RECYCLE.BIN",
                ".Trashes",
                ".Trash-1000/files",
                ".Trash-1000/info",
                ".fseventsd",
                ".Spotlight-V100",
            ],
        );
        fs::write(d.path().join("$RECYCLE.BIN/desktop.ini"), b"x").unwrap();
        fs::write(
            d.path().join("System Volume Information/WPSettings.dat"),
            b"x",
        )
        .unwrap();
        let scan = scan_root(d.path(), true, &[]);
        assert!(scan.os_only(), "{scan:?}");
    }

    #[test]
    fn luna_marker_and_an_empty_luna_trash_count_as_empty() {
        let id = "0b9a6f3e-5c1d-4a7e-9d2b-3f4a5b6c7d8e";
        let d = dir_with(
            &[&format!(".luna-{id}.sqlite3")],
            &[&format!(".luna-{id}-trash")],
        );
        assert!(scan_root(d.path(), true, &[]).os_only());
        // But files in Luna's trash are somebody's files.
        fs::write(d.path().join(format!(".luna-{id}-trash/old.txt")), b"x").unwrap();
        assert!(!scan_root(d.path(), true, &[]).os_only());
        // And other Luna-named folders (backups) are not on the list.
        let d2 = dir_with(&[], &[&format!(".luna-{id}-backups")]);
        assert!(!scan_root(d2.path(), true, &[]).os_only());
    }

    #[test]
    fn hidden_files_are_content() {
        let d = dir_with(&[".git"], &[]);
        let scan = scan_root(d.path(), true, &[]);
        assert!(!scan.os_only());
        assert_eq!(scan.files, 1);
        assert_eq!(scan.entries[0].name, ".git");
    }

    #[test]
    fn a_trash_with_a_file_in_it_is_not_empty() {
        let d = dir_with(&[], &[".Trash-1000/files"]);
        assert!(scan_root(d.path(), false, &[]).os_only());
        fs::write(d.path().join(".Trash-1000/files/photo.jpg"), b"x").unwrap();
        assert!(!scan_root(d.path(), false, &[]).os_only());
        let d2 = dir_with(&[], &["$RECYCLE.BIN/S-1-5-21"]);
        fs::write(d2.path().join("$RECYCLE.BIN/S-1-5-21/$R123.docx"), b"x").unwrap();
        assert!(!scan_root(d2.path(), true, &[]).os_only());
    }

    #[test]
    fn recovered_files_in_lost_and_found_are_content() {
        let d = dir_with(&[], &["lost+found"]);
        fs::write(d.path().join("lost+found/#12345"), b"x").unwrap();
        assert!(!scan_root(d.path(), false, &[]).os_only());
    }

    #[test]
    fn names_match_case_insensitively_only_on_windows_style_filesystems() {
        let d = dir_with(&[], &["system volume information"]);
        assert!(scan_root(d.path(), true, &[]).os_only());
        // On ext4 that is a folder somebody made.
        assert!(!scan_root(d.path(), false, &[]).os_only());
    }

    #[test]
    fn an_os_name_that_is_a_file_is_content() {
        let d = dir_with(&["lost+found", "System Volume Information"], &[]);
        assert_eq!(scan_root(d.path(), true, &[]).files, 2);
    }

    #[test]
    fn the_preview_lists_folders_first_with_real_names() {
        let d = dir_with(&["notes.txt", "Zebra.txt"], &["Photos", "Documents"]);
        let scan = scan_root(d.path(), true, &[]);
        let names: Vec<&str> = scan.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Documents", "Photos", "notes.txt", "Zebra.txt"]);
        assert_eq!((scan.folders, scan.files), (2, 2));
    }

    #[test]
    fn a_folder_that_cannot_be_listed_is_not_empty() {
        let scan = scan_root(Path::new("/luna/no/such/folder"), true, &[]);
        assert!(scan.listing_failed);
        assert!(!scan.os_only());
    }

    #[test]
    fn serial_is_found_on_a_usb_parent_and_layout_is_read_from_sysfs() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys/block");
        let usb = root.path().join("sys/devices/usb1/1-2");
        let scsi = usb.join("1-2:1.0/host6/target6:0:0/6:0:0:0");
        fs::create_dir_all(&scsi).unwrap();
        fs::write(usb.join("serial"), "AA11BB22\n").unwrap();
        fs::create_dir_all(sys.join("sdb/sdb1")).unwrap();
        std::os::unix::fs::symlink(&scsi, sys.join("sdb/device")).unwrap();
        fs::write(sys.join("sdb/wwid"), "naa.5000\n").unwrap();
        fs::write(sys.join("sdb/sdb1/start"), "2048\n").unwrap();
        fs::write(sys.join("sdb/sdb1/size"), "1000\n").unwrap();
        let probe = MockFsProbe::default();
        probe.disks.lock().unwrap().insert(
            "sdb".into(),
            vec![FsInfo {
                name: "sdb1".into(),
                fs_type: "exfat".into(),
                label: "PHOTOS".into(),
                size_bytes: 512_000,
            }],
        );
        let det = DetectedDrive {
            name: "sdb".into(),
            model: "Stick".into(),
            size_bytes: 1 << 30,
            removable: true,
            usb: true,
            mount_point: None,
            fs_type: None,
            mount_readonly: false,
            diskseq: Some(9),
        };
        let id = read_identity(&sys, &det, &probe, false);
        assert_eq!(id.serial.as_deref(), Some("AA11BB22"));
        assert_eq!(id.wwn.as_deref(), Some("naa.5000"));
        assert_eq!(id.diskseq, Some(9));
        assert_eq!(id.layout.len(), 1);
        assert_eq!(id.layout[0].start_sectors, 2048);
        assert_eq!(id.layout[0].size_bytes, 512_000);
        assert_eq!(id.layout[0].label, "PHOTOS");
    }

    #[test]
    fn identity_binds_attachment_and_layout_separately() {
        let a = identity(vec![layout("sdb1", "exfat")], "");
        let mut replugged = a.clone();
        replugged.diskseq = Some(8);
        assert!(!a.same_attachment(&replugged));
        let mut other_serial = a.clone();
        other_serial.serial = Some("OTHER".into());
        assert!(!a.same_attachment(&other_serial));
        // The erase rewrites the table: attachment survives, the disk does not.
        let wiped = identity(vec![], "");
        assert!(a.same_attachment(&wiped));
        assert!(!a.same_disk(&wiped));
        assert!(a.same_disk(&a.clone()));
        let mut moved = a.clone();
        moved.layout[0].start_sectors = 4096;
        assert!(!a.same_disk(&moved));
    }

    #[test]
    fn a_blank_disk_and_a_luks_disk_through_the_whole_inspection() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys/block");
        fs::create_dir_all(sys.join("sdb")).unwrap();
        let probe = std::sync::Arc::new(MockFsProbe::default());
        let manager = DriveManager::new_with_probe(
            crate::drives::mount::shared_mock(),
            root.path(),
            probe.clone(),
        );
        let tools = MockTools::default();
        let det = DetectedDrive {
            name: "sdb".into(),
            model: "Stick".into(),
            size_bytes: 1 << 30,
            removable: true,
            usb: true,
            mount_point: None,
            fs_type: None,
            mount_readonly: false,
            diskseq: Some(1),
        };
        let env = Env {
            manager: &manager,
            tools: &tools,
            sys_block: &sys,
            proc_mounts: "",
        };
        let blank = inspect_disk(&env, &det, false);
        assert!(blank.blank && blank.empty);

        // The same disk with an encrypted partition: locked, so it waits.
        fs::create_dir_all(sys.join("sdb/sdb1")).unwrap();
        fs::write(sys.join("sdb/sdb1/start"), "2048").unwrap();
        fs::write(sys.join("sdb/sdb1/size"), "2048").unwrap();
        probe.disks.lock().unwrap().insert(
            "sdb".into(),
            vec![FsInfo {
                name: "sdb1".into(),
                fs_type: "crypto_LUKS".into(),
                label: String::new(),
                size_bytes: 1 << 20,
            }],
        );
        tools
            .signatures
            .lock()
            .unwrap()
            .insert("/dev/sdb".into(), vec!["gpt".into()]);
        let locked = inspect_disk(&env, &det, false);
        assert!(!locked.empty);
        assert_eq!(locked.partitions[0].state, PartitionState::Locked);

        // Unlocked and mounted (Remove protection): its files are listed.
        let open = tempfile::tempdir().unwrap();
        fs::write(open.path().join("tax-2024.pdf"), b"x").unwrap();
        fs::create_dir_all(sys.join("sdb/sdb1/holders/dm-3")).unwrap();
        fs::create_dir_all(sys.join("dm-3/dm")).unwrap();
        fs::write(sys.join("dm-3/dm/name"), "luna-d1\n").unwrap();
        let mounts = format!(
            "/dev/mapper/luna-d1 {} ext4 rw 0 0\n",
            open.path().display()
        );
        let env = Env {
            proc_mounts: &mounts,
            ..env
        };
        let opened = inspect_disk(&env, &det, false);
        assert!(!opened.empty);
        assert_eq!(opened.partitions[0].state, PartitionState::HasFiles);
        assert_eq!(opened.partitions[0].entries[0].name, "tax-2024.pdf");
    }

    #[test]
    fn a_mock_drive_is_inspected_as_a_folder_and_ignores_its_config() {
        let d = dir_with(&[".drive.json"], &[]);
        let det = DetectedDrive {
            name: "sdmock_a".into(),
            model: "Mock".into(),
            size_bytes: 1 << 30,
            removable: true,
            usb: true,
            mount_point: Some(d.path().to_string_lossy().into_owned()),
            fs_type: Some("exfat".into()),
            mount_readonly: false,
            diskseq: None,
        };
        let root = tempfile::tempdir().unwrap();
        let manager = DriveManager::new(crate::drives::mount::shared_mock(), root.path());
        let tools = MockTools::default();
        let env = Env {
            manager: &manager,
            tools: &tools,
            sys_block: root.path(),
            proc_mounts: "",
        };
        assert!(inspect_disk(&env, &det, true).empty);
        fs::write(d.path().join("holiday.jpg"), b"x").unwrap();
        let looked = inspect_disk(&env, &det, true);
        assert!(!looked.empty);
        assert_eq!(looked.partitions[0].entries[0].name, "holiday.jpg");
    }
}
