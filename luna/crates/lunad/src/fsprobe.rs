//! Probe a disk's filesystems and (optionally) turn installer media into
//! a writable data USB.
//!
//! The rapidinstall ISO is an isohybrid: the whole stick mounts as `iso9660`,
//! which the kernel will not write to. After install, people plug that same
//! Lexar/etc. stick back in as storage. Luna must notice, explain, and — only
//! after an explicit erase — wipe the ISO layout and put a real filesystem on it.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

/// One whole disk or partition as `blkid` (or a test double) reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsInfo {
    pub name: String,
    pub fs_type: String,
    pub label: String,
    pub size_bytes: u64,
}

/// Where Luna should mount, and whether the stick is installer media.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountChoice {
    pub name: String,
    pub fs_type: String,
    pub needs_erase: bool,
}

pub trait FsProbe: Send + Sync {
    fn probe_disk(&self, disk: &str) -> Vec<FsInfo>;
    fn format_data_usb(&self, disk: &str, volume_label: &str) -> anyhow::Result<()>;
}

#[derive(Clone, Default)]
pub struct CommandFsProbe;

impl FsProbe for CommandFsProbe {
    fn probe_disk(&self, disk: &str) -> Vec<FsInfo> {
        probe_disk_sysfs(Path::new("/sys/block"), disk, blkid_export)
    }

    fn format_data_usb(&self, disk: &str, volume_label: &str) -> anyhow::Result<()> {
        format_data_usb_cmd(disk, volume_label)
    }
}

pub fn shared_command_probe() -> Arc<CommandFsProbe> {
    Arc::new(CommandFsProbe)
}

/// Test double: canned `blkid` results and recorded format calls.
#[derive(Default)]
pub struct MockFsProbe {
    pub disks: std::sync::Mutex<std::collections::HashMap<String, Vec<FsInfo>>>,
    pub formats: std::sync::Mutex<Vec<String>>,
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

    fn format_data_usb(&self, disk: &str, _volume_label: &str) -> anyhow::Result<()> {
        self.formats.lock().unwrap().push(disk.to_string());
        Ok(())
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
            needs_erase: false,
        };
    }
    if let Some(whole) = parts.iter().find(|p| p.name == disk) {
        if is_writable_type(&whole.fs_type) {
            return MountChoice {
                name: disk.to_string(),
                fs_type: whole.fs_type.clone(),
                needs_erase: false,
            };
        }
        if is_intrinsically_read_only(&whole.fs_type) {
            return MountChoice {
                name: disk.to_string(),
                fs_type: whole.fs_type.clone(),
                needs_erase: true,
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
            needs_erase: true,
        };
    }
    MountChoice {
        name: disk.to_string(),
        fs_type: parts
            .iter()
            .find(|p| p.name == disk)
            .map(|p| p.fs_type.clone())
            .unwrap_or_default(),
        needs_erase: false,
    }
}

pub fn first_partition_name(disk: &str) -> String {
    if disk.starts_with("nvme") || disk.starts_with("mmcblk") {
        format!("{disk}p1")
    } else {
        format!("{disk}1")
    }
}

pub fn sanitize_volume_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = cleaned.trim();
    let out = if trimmed.is_empty() { "LUNA" } else { trimmed };
    out.chars().take(11).collect()
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
        if fs_type.is_empty() && name != disk {
            continue;
        }
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

fn blkid_export(dev: &str) -> Option<(String, String)> {
    let out = Command::new("blkid")
        .args(["-o", "export", dev])
        .output()
        .ok()?;
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

fn format_data_usb_cmd(disk: &str, volume_label: &str) -> anyhow::Result<()> {
    let dev = format!("/dev/{disk}");
    if !Path::new(&dev).exists() {
        anyhow::bail!("Luna can't see that USB stick. Plug it in and try again.");
    }
    let wipe = Command::new("wipefs").args(["-af", &dev]).output();
    match wipe {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            anyhow::bail!(
                "Luna couldn't clear the old installer layout. {}",
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
        Err(_) => anyhow::bail!(
            "Luna couldn't prepare this USB. The box is missing a disk tool (wipefs)."
        ),
    }

    let mut sfdisk = Command::new("sfdisk")
        .arg(&dev)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            anyhow::anyhow!(
                "Luna couldn't prepare this USB. The box is missing a disk tool (sfdisk)."
            )
        })?;
    {
        let mut stdin = sfdisk
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Luna couldn't prepare this USB."))?;
        stdin.write_all(b"label: dos\n,+,7\n")?;
    }
    let sfdisk_out = sfdisk.wait_with_output()?;
    if !sfdisk_out.status.success() {
        anyhow::bail!(
            "Luna couldn't set up this USB. {}",
            String::from_utf8_lossy(&sfdisk_out.stderr).trim()
        );
    }

    let part = first_partition_name(disk);
    let part_dev = format!("/dev/{part}");
    for _ in 0..30 {
        if Path::new(&part_dev).exists() {
            break;
        }
        let _ = Command::new("blockdev").args(["--rereadpt", &dev]).status();
        let _ = Command::new("partprobe").arg(&dev).status();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !Path::new(&part_dev).exists() {
        anyhow::bail!(
            "Luna prepared the USB but the new partition did not appear. Unplug it, plug it back in, and try again."
        );
    }

    let label = sanitize_volume_label(volume_label);
    let mkfs = Command::new("mkfs.exfat")
        .args(["-n", &label, &part_dev])
        .output();
    match mkfs {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let fat = Command::new("mkfs.vfat")
                .args(["-F", "32", "-n", &label, &part_dev])
                .output();
            match fat {
                Ok(f) if f.status.success() => Ok(()),
                _ => anyhow::bail!(
                    "Luna couldn't set up this USB for files. {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ),
            }
        }
        Err(_) => {
            let fat = Command::new("mkfs.vfat")
                .args(["-F", "32", "-n", &label, &part_dev])
                .output()
                .map_err(|_| {
                    anyhow::anyhow!(
                        "Luna couldn't set up this USB for files. The box is missing a format tool."
                    )
                })?;
            if fat.status.success() {
                Ok(())
            } else {
                anyhow::bail!("Luna couldn't set up this USB for files.")
            }
        }
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
        assert!(choice.needs_erase);
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
        assert!(!choice.needs_erase);
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
    fn volume_label_fits_fat() {
        assert_eq!(
            sanitize_volume_label("Lexar USB Flash Drive"),
            "Lexar USB F"
        );
        assert_eq!(sanitize_volume_label("!!!"), "LUNA");
    }

    #[test]
    fn first_partition_nvme_uses_p() {
        assert_eq!(first_partition_name("nvme0n1"), "nvme0n1p1");
        assert_eq!(first_partition_name("sdb"), "sdb1");
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
        assert!(!choice.needs_erase);
    }
}
