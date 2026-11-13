//! Probe a disk's filesystems and pick what Luna can mount.
//!
//! The rapidinstall ISO is an isohybrid: the whole stick mounts as `iso9660`,
//! which the kernel will not write to. After install, people plug that same
//! Lexar/etc. stick back in as storage. Luna must notice and explain that it
//! can't use it as it is. Luna does not erase or format drives.

use std::path::Path;
use std::process::{Command, Stdio};

/// One whole disk or partition as `blkid` (or a test double) reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsInfo {
    pub name: String,
    pub fs_type: String,
    pub label: String,
    pub size_bytes: u64,
}

/// Where Luna should mount, and whether the drive needs setting up first
/// (installer media, which Luna can't write to).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountChoice {
    pub name: String,
    pub fs_type: String,
    pub needs_setup: bool,
}

pub trait FsProbe: Send + Sync {
    fn probe_disk(&self, disk: &str) -> Vec<FsInfo>;
}

#[derive(Clone, Default)]
pub struct CommandFsProbe;

impl FsProbe for CommandFsProbe {
    fn probe_disk(&self, disk: &str) -> Vec<FsInfo> {
        probe_disk_sysfs(Path::new("/sys/block"), disk, blkid_export)
    }
}

/// Test double: canned `blkid` results.
#[derive(Default)]
pub struct MockFsProbe {
    pub disks: std::sync::Mutex<std::collections::HashMap<String, Vec<FsInfo>>>,
}

impl FsProbe for MockFsProbe {
    fn probe_disk(&self, disk: &str) -> Vec<FsInfo> {
        self.disks
            .lock()
            .unwrap()
            .get(disk)
            .cloned()
            .unwrap_or_default()
    }
}

pub fn is_intrinsically_read_only(fs: &str) -> bool {
    matches!(
        fs.to_ascii_lowercase().as_str(),
        "iso9660" | "udf" | "squashfs" | "erofs" | "cramfs"
    )
}

pub fn is_writable_type(fs: &str) -> bool {
    matches!(
        fs.to_ascii_lowercase().as_str(),
        "vfat"
            | "fat"
            | "fat32"
            | "msdos"
            | "exfat"
            | "ext2"
            | "ext3"
            | "ext4"
            | "xfs"
            | "btrfs"
            | "ntfs"
            | "ntfs3"
            | "fuseblk"
    )
}

pub fn is_esp_like(info: &FsInfo) -> bool {
    let label = info.label.to_ascii_uppercase();
    if matches!(
        label.as_str(),
        "EFI" | "ESP" | "BOOT" | "LUNAUEFI" | "LUNAESP"
    ) {
        return true;
    }
    let fs = info.fs_type.to_ascii_lowercase();
    let fat = matches!(fs.as_str(), "vfat" | "fat" | "fat32" | "msdos");
    fat && info.size_bytes > 0 && info.size_bytes < 64 * 1024 * 1024
}

/// blkid's type for a LUKS (encrypted) partition. Luna can't open these, but it
/// must recognise them: otherwise an encrypted drive would be described as
/// blank or damaged. Deliberately excluded from [`is_writable_type`].
pub const LUKS_TYPE: &str = "crypto_luks";

pub fn is_luks_type(fs: &str) -> bool {
    fs.eq_ignore_ascii_case(LUKS_TYPE)
}

/// Prefer a real data partition over the whole-disk ISO9660 view of an isohybrid USB.
pub fn pick_mount_source(disk: &str, parts: &[FsInfo]) -> MountChoice {
    let data: Vec<&FsInfo> = parts
        .iter()
        .filter(|p| is_writable_type(&p.fs_type) && !is_esp_like(p))
        .collect();
    if let Some(best) = data.iter().max_by_key(|p| p.size_bytes) {
        return MountChoice {
            name: best.name.clone(),
            fs_type: best.fs_type.clone(),
            needs_setup: false,
        };
    }
    // An encrypted drive: nothing Luna can mount, but not blank either. It is
    // the largest such partition that matters, matching the data-partition rule.
    if let Some(luks) = parts
        .iter()
        .filter(|p| is_luks_type(&p.fs_type) && !is_esp_like(p))
        .max_by_key(|p| p.size_bytes)
    {
        return MountChoice {
            name: luks.name.clone(),
            fs_type: luks.fs_type.clone(),
            needs_setup: false,
        };
    }
    if let Some(whole) = parts.iter().find(|p| p.name == disk) {
        if is_writable_type(&whole.fs_type) {
            return MountChoice {
                name: disk.to_string(),
                fs_type: whole.fs_type.clone(),
                needs_setup: false,
            };
        }
        if is_intrinsically_read_only(&whole.fs_type) {
            return MountChoice {
                name: disk.to_string(),
                fs_type: whole.fs_type.clone(),
                needs_setup: true,
            };
        }
    }
    if parts.iter().any(|p| is_intrinsically_read_only(&p.fs_type)) {
        return MountChoice {
            name: disk.to_string(),
            fs_type: parts
                .iter()
                .find(|p| is_intrinsically_read_only(&p.fs_type))
                .map(|p| p.fs_type.clone())
                .unwrap_or_default(),
            needs_setup: true,
        };
    }
    MountChoice {
        name: disk.to_string(),
        fs_type: parts
            .iter()
            .find(|p| p.name == disk)
            .map(|p| p.fs_type.clone())
            .unwrap_or_default(),
        needs_setup: false,
    }
}

pub(crate) fn probe_disk_sysfs(
    sys_block: &Path,
    disk: &str,
    blkid: impl Fn(&str) -> Option<(String, String)>,
) -> Vec<FsInfo> {
    let mut names = vec![disk.to_string()];
    names.extend(list_partition_names(sys_block, disk));
    let mut out = Vec::new();
    for name in names {
        let size_dir = if name == disk {
            sys_block.join(disk)
        } else {
            sys_block.join(disk).join(&name)
        };
        let size_bytes = read_size_bytes(&size_dir).unwrap_or(0);
        let (fs_type, label) = blkid(&format!("/dev/{name}")).unwrap_or_default();
        out.push(FsInfo {
            name,
            fs_type,
            label,
            size_bytes,
        });
    }
    out
}

fn list_partition_names(sys_block: &Path, disk: &str) -> Vec<String> {
    let dir = sys_block.join(disk);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| {
            n != disk && n.starts_with(disk) && n.chars().last().is_some_and(|c| c.is_ascii_digit())
        })
        .collect();
    names.sort();
    names
}

fn read_size_bytes(path: &Path) -> Option<u64> {
    let raw = std::fs::read_to_string(path.join("size")).ok()?;
    let sectors: u64 = raw.trim().parse().ok()?;
    Some(sectors.saturating_mul(512))
}

/// Enough of a device's start for blkid to find any common filesystem
/// (ext 1 KiB, iso9660 32 KiB, btrfs 64 KiB, UDF anchors at 128 KiB).
const PROBE_HEAD_BYTES: u64 = 2 * 1024 * 1024;

fn read_device_head(dev: &Path, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(dev)?.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Write `bytes` so the sandbox user can read them: the staging dir is
/// owned by `nobody` and closed to everyone else, so a readable file inside
/// it is reachable only by our own sandboxed children.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, bytes)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
}

fn blkid_export(dev: &str) -> Option<(String, String)> {
    // blkid parses filesystem superblocks from whatever USB stick somebody
    // plugs in — it runs sandboxed as `nobody`, reading the device through an
    // inherited read-only fd so a parser exploit can't reach the rest of the
    // disk or the daemon's files.
    let mut io = crate::sandbox::SandboxIo::new().ok()?;
    // The sandboxed child runs as `nobody`, and reopening a block device
    // through an inherited /proc/self/fd/N re-checks the device's own
    // permissions (root:disk 0660), so it would see nothing. Root copies the
    // start of the device — where every filesystem keeps its superblock — into
    // the sandbox's staging dir, and blkid reads that plain file instead.
    let head = read_device_head(Path::new(dev), PROBE_HEAD_BYTES).ok()?;
    let staged = io.out_path("probe.img").ok()?;
    write_private(&staged, &head).ok()?;
    let blkid = crate::sandbox::which("blkid")?;
    let mut cmd = Command::new(blkid);
    cmd.args(["-o", "export"])
        .arg(&staged)
        .stderr(Stdio::null());
    let out = crate::sandbox::output(&mut cmd, &io, std::time::Duration::from_secs(15)).ok()?;
    if !out.status.success() {
        return None;
    }
    parse_blkid_export(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_blkid_export(text: &str) -> Option<(String, String)> {
    let mut fs_type = String::new();
    let mut label = String::new();
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("TYPE=") {
            fs_type = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("LABEL=") {
            label = v.trim().to_string();
        }
    }
    if fs_type.is_empty() && label.is_empty() {
        None
    } else {
        Some((fs_type, label))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn isohybrid_prefers_erase_when_only_iso_and_tiny_esp() {
        let parts = vec![
            FsInfo {
                name: "sdb".into(),
                fs_type: "iso9660".into(),
                label: "LUNAINST".into(),
                size_bytes: 8_000_000_000,
            },
            FsInfo {
                name: "sdb1".into(),
                fs_type: "vfat".into(),
                label: "LUNAUEFI".into(),
                size_bytes: 4 * 1024 * 1024,
            },
        ];
        let choice = pick_mount_source("sdb", &parts);
        assert!(choice.needs_setup);
        assert_eq!(choice.name, "sdb");
        assert_eq!(choice.fs_type, "iso9660");
    }

    #[test]
    fn partitioned_fat_is_preferred_over_whole_disk_iso() {
        let parts = vec![
            FsInfo {
                name: "sdb".into(),
                fs_type: "iso9660".into(),
                label: "LUNAINST".into(),
                size_bytes: 32_000_000_000,
            },
            FsInfo {
                name: "sdb1".into(),
                fs_type: "vfat".into(),
                label: "PHOTOS".into(),
                size_bytes: 31_000_000_000,
            },
        ];
        let choice = pick_mount_source("sdb", &parts);
        assert!(!choice.needs_setup);
        assert_eq!(choice.name, "sdb1");
        assert_eq!(choice.fs_type, "vfat");
    }

    #[test]
    fn parse_blkid_reads_type_and_label() {
        let text = "DEVNAME=/dev/sdb\nUUID=abc\nTYPE=iso9660\nLABEL=LUNAINST\n";
        assert_eq!(
            parse_blkid_export(text),
            Some(("iso9660".into(), "LUNAINST".into()))
        );
    }

    #[test]
    fn sysfs_lists_partitions() {
        let root = tempfile::tempdir().unwrap();
        let sys = root.path().join("sys/block");
        fs::create_dir_all(sys.join("sdb/sdb1")).unwrap();
        fs::write(sys.join("sdb/size"), "62500000\n").unwrap();
        fs::write(sys.join("sdb/sdb1/size"), "62400000\n").unwrap();
        let infos = probe_disk_sysfs(&sys, "sdb", |dev| {
            if dev.ends_with("sdb1") {
                Some(("vfat".into(), "PHOTOS".into()))
            } else {
                Some(("iso9660".into(), "LUNAINST".into()))
            }
        });
        assert!(
            infos
                .iter()
                .any(|i| i.name == "sdb1" && i.fs_type == "vfat")
        );
        let choice = pick_mount_source("sdb", &infos);
        assert_eq!(choice.name, "sdb1");
        assert!(!choice.needs_setup);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod head_tests {
    use super::*;

    #[test]
    fn device_head_is_capped_and_stageable() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("dev");
        std::fs::write(&big, vec![7u8; 4096]).unwrap();
        assert_eq!(read_device_head(&big, 1024).unwrap().len(), 1024);
        assert_eq!(read_device_head(&big, 1 << 20).unwrap().len(), 4096);
        let out = dir.path().join("probe.img");
        write_private(&out, b"x").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&out).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}
