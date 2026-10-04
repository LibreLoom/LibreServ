//! Mount/unmount behind a small trait.
//!
//! Luna owns every mount it creates. Pre-existing OS mounts of USB sticks may
//! be remounted read-write on adopt (the live OS disk is never a candidate).
//! Tests inject a mock; production shells out to `mount` and `umount` with no
//! shell interpretation.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

pub trait Mounter: Send + Sync {
    /// Mount `device` at `target`. Implementations create `target`.
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()>;
    /// Unmount `target` if mounted. Already-unmounted paths are success (idempotent).
    fn unmount(&self, target: &Path) -> anyhow::Result<()>;
    /// True when `target` is currently a live mount.
    fn is_mounted(&self, target: &Path) -> bool {
        path_is_mount_point(target)
    }
    /// Remount an already-mounted path read-only or read-write.
    fn remount(&self, target: &Path, read_only: bool) -> anyhow::Result<()> {
        let _ = (target, read_only);
        Ok(())
    }
    /// Mount with a known filesystem type (`vfat`, `exfat`, `ntfs`, …).
    fn mount_typed(
        &self,
        device: &str,
        target: &Path,
        read_only: bool,
        fs_type: Option<&str>,
    ) -> anyhow::Result<()> {
        let _ = fs_type;
        self.mount(device, target, read_only)
    }
}

/// True when `/proc/mounts` lists `target` as a mount point.
pub fn path_is_mount_point(target: &Path) -> bool {
    let Ok(canon) = std::fs::canonicalize(target) else {
        return false;
    };
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return false;
    };
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let _device = fields.next();
        let Some(point) = fields.next() else {
            continue;
        };
        let point = point.replace("\\040", " ");
        if Path::new(&point) == canon.as_path() {
            return true;
        }
    }
    false
}

fn already_unmounted_stderr(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("not mounted")
        || lower.contains("no mount point")
        || lower.contains("not found")
        || lower.contains("no such file")
}

#[derive(Clone, Default)]
pub struct CommandMounter;

impl Mounter for CommandMounter {
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
        self.mount_typed(device, target, read_only, None)
    }

    fn unmount(&self, target: &Path) -> anyhow::Result<()> {
        // Idempotent: nothing to do when the path is already gone / not mounted.
        if !self.is_mounted(target) {
            return Ok(());
        }
        let out = Command::new("umount").arg(target).output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if already_unmounted_stderr(&stderr) {
                return Ok(());
            }
            return Err(anyhow::anyhow!("unmount failed: {}", stderr.trim()));
        }
        Ok(())
    }

    fn remount(&self, target: &Path, read_only: bool) -> anyhow::Result<()> {
        let out = Command::new("mount")
            .args(remount_args(target, read_only))
            .output()?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "remount {} failed: {}",
                target.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    fn mount_typed(
        &self,
        device: &str,
        target: &Path,
        read_only: bool,
        fs_type: Option<&str>,
    ) -> anyhow::Result<()> {
        std::fs::create_dir_all(target)?;
        let out = Command::new("mount")
            .args(mount_args(device, target, read_only, fs_type))
            .output()?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "mount {device} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }
}

/// Arguments for `mount`, one per element, never shell-interpreted.
fn mount_args(device: &str, target: &Path, read_only: bool, fs_type: Option<&str>) -> Vec<String> {
    let mode = if read_only { "ro" } else { "rw" };
    let fs = fs_type.unwrap_or("").trim().to_ascii_lowercase();
    let mut args = Vec::new();
    if !fs.is_empty() && fs != "fuseblk" {
        let mount_fs = match fs.as_str() {
            "fat" | "fat32" | "msdos" => "vfat",
            // The kernel's ntfs3 driver reads and writes; there's no ntfs-3g.
            "ntfs" => "ntfs3",
            other => other,
        };
        args.push("-t".to_string());
        args.push(mount_fs.to_string());
    }
    args.push("-o".to_string());
    if matches!(fs.as_str(), "vfat" | "fat" | "fat32" | "msdos") {
        args.push(format!("{mode},utf8,umask=000"));
    } else {
        args.push(mode.to_string());
    }
    args.push(device.to_string());
    args.push(target.to_string_lossy().into_owned());
    args
}

fn remount_args(target: &Path, read_only: bool) -> Vec<String> {
    let mode = if read_only {
        "remount,ro"
    } else {
        "remount,rw"
    };
    vec![
        "-o".to_string(),
        mode.to_string(),
        target.to_string_lossy().into_owned(),
    ]
}

/// Mounter that records calls and materializes mount points as directories.
/// Used by unit tests; never touches a real kernel mount table.
///
/// Unmount shadows directory contents (like a real umount hiding the
/// filesystem), and the next mount to the same path restores them.
#[derive(Debug, Default)]
pub struct MockMounter {
    pub mounts: std::sync::Mutex<Vec<(String, PathBuf, bool)>>,
    pub unmounts: std::sync::Mutex<Vec<PathBuf>>,
    pub remounts: std::sync::Mutex<Vec<(PathBuf, bool)>>,
    pub fail_mount: std::sync::Mutex<bool>,
    /// Paths currently considered mounted (updated by mount/unmount).
    active: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    shadows: std::sync::Mutex<std::collections::HashMap<PathBuf, PathBuf>>,
}

impl MockMounter {
    pub fn mount_count(&self) -> usize {
        self.mounts.lock().unwrap().len()
    }
}

fn shadow_path_for(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".shadow");
    target.parent().unwrap_or_else(|| Path::new(".")).join(name)
}

impl Mounter for MockMounter {
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
        if *self.fail_mount.lock().unwrap() {
            return Err(anyhow::anyhow!("mock mount failure"));
        }
        std::fs::create_dir_all(target)?;
        // Restore shadowed contents from a previous unmount of this path.
        if let Some(shadow) = self.shadows.lock().unwrap().remove(target)
            && shadow.is_dir()
        {
            for entry in std::fs::read_dir(&shadow)? {
                let entry = entry?;
                let dest = target.join(entry.file_name());
                std::fs::rename(entry.path(), dest)?;
            }
            let _ = std::fs::remove_dir_all(&shadow);
        }
        self.mounts
            .lock()
            .unwrap()
            .push((device.to_string(), target.to_path_buf(), read_only));
        self.active.lock().unwrap().insert(target.to_path_buf());
        Ok(())
    }

    fn is_mounted(&self, target: &Path) -> bool {
        self.active.lock().unwrap().contains(target)
    }

    fn unmount(&self, target: &Path) -> anyhow::Result<()> {
        // Match production: already-unmounted is success.
        if !self.is_mounted(target) {
            return Ok(());
        }
        self.unmounts.lock().unwrap().push(target.to_path_buf());
        self.active.lock().unwrap().remove(target);
        if target.is_dir() {
            let shadow = shadow_path_for(target);
            let _ = std::fs::remove_dir_all(&shadow);
            std::fs::create_dir_all(&shadow)?;
            for entry in std::fs::read_dir(target)? {
                let entry = entry?;
                std::fs::rename(entry.path(), shadow.join(entry.file_name()))?;
            }
            self.shadows
                .lock()
                .unwrap()
                .insert(target.to_path_buf(), shadow);
        }
        Ok(())
    }

    fn remount(&self, target: &Path, read_only: bool) -> anyhow::Result<()> {
        self.remounts
            .lock()
            .unwrap()
            .push((target.to_path_buf(), read_only));
        Ok(())
    }
}

pub fn shared_mock() -> Arc<MockMounter> {
    Arc::new(MockMounter::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(device: &str, read_only: bool, fs: Option<&str>) -> Vec<String> {
        mount_args(device, Path::new("/run/luna/mnt/d1"), read_only, fs)
    }

    #[test]
    fn an_unknown_filesystem_lets_mount_detect_it() {
        assert_eq!(
            args("/dev/sdb1", false, None),
            ["-o", "rw", "/dev/sdb1", "/run/luna/mnt/d1"]
        );
        assert_eq!(
            args("/dev/sdb1", true, Some("")),
            ["-o", "ro", "/dev/sdb1", "/run/luna/mnt/d1"]
        );
    }

    #[test]
    fn fuseblk_is_left_for_mount_to_resolve() {
        assert_eq!(
            args("/dev/sdb1", false, Some("fuseblk")),
            ["-o", "rw", "/dev/sdb1", "/run/luna/mnt/d1"]
        );
    }

    #[test]
    fn fat_variants_become_vfat_with_utf8_names_and_open_permissions() {
        for fs in ["vfat", "fat", "FAT32", "msdos", " vfat "] {
            assert_eq!(
                args("/dev/sdb1", false, Some(fs)),
                [
                    "-t",
                    "vfat",
                    "-o",
                    "rw,utf8,umask=000",
                    "/dev/sdb1",
                    "/run/luna/mnt/d1"
                ],
                "{fs:?}"
            );
        }
        assert_eq!(
            args("/dev/sdb1", true, Some("vfat"))[3],
            "ro,utf8,umask=000"
        );
    }

    #[test]
    fn ntfs_uses_the_kernel_ntfs3_driver() {
        assert_eq!(
            args("/dev/sdb1", false, Some("NTFS")),
            ["-t", "ntfs3", "-o", "rw", "/dev/sdb1", "/run/luna/mnt/d1"]
        );
    }

    #[test]
    fn other_filesystems_pass_through_by_name() {
        assert_eq!(
            args("/dev/sdb1", true, Some("exfat")),
            ["-t", "exfat", "-o", "ro", "/dev/sdb1", "/run/luna/mnt/d1"]
        );
    }

    #[test]
    fn a_device_or_path_that_looks_like_a_flag_stays_one_argument() {
        let a = mount_args(
            "/dev/sd b1; rm -rf /",
            Path::new("/mnt/x y"),
            false,
            Some("ext4"),
        );
        assert_eq!(a[a.len() - 2], "/dev/sd b1; rm -rf /");
        assert_eq!(a[a.len() - 1], "/mnt/x y");
        assert_eq!(a.len(), 6);
    }

    #[test]
    fn remount_picks_the_mode() {
        assert_eq!(
            remount_args(Path::new("/m"), true),
            ["-o", "remount,ro", "/m"]
        );
        assert_eq!(
            remount_args(Path::new("/m"), false),
            ["-o", "remount,rw", "/m"]
        );
    }

    #[test]
    fn already_unmounted_messages_are_success() {
        for msg in [
            "umount: /mnt/x: not mounted.",
            "umount: /mnt/x: No mount point specified.",
            "umount: /mnt/x: not found",
            "umount: /mnt/x: No such file or directory",
            "UMOUNT: /MNT/X: NOT MOUNTED",
        ] {
            assert!(already_unmounted_stderr(msg), "{msg}");
        }
    }

    #[test]
    fn a_busy_or_denied_unmount_is_a_real_failure() {
        for msg in [
            "umount: /mnt/x: target is busy.",
            "umount: /mnt/x: must be superuser to unmount.",
            "",
        ] {
            assert!(!already_unmounted_stderr(msg), "{msg:?}");
        }
    }

    #[test]
    fn unmounting_a_path_that_is_not_a_mount_point_succeeds_without_running_umount() {
        let dir = tempfile::tempdir().unwrap();
        assert!(CommandMounter.unmount(dir.path()).is_ok());
        assert!(CommandMounter.unmount(&dir.path().join("gone")).is_ok());
    }

    #[test]
    fn the_mock_unmount_hides_files_and_the_next_mount_brings_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("m");
        let mock = MockMounter::default();
        mock.mount("/dev/x", &target, false).unwrap();
        std::fs::write(target.join("a.txt"), b"hi").unwrap();
        mock.unmount(&target).unwrap();
        assert!(!target.join("a.txt").exists());
        mock.mount("/dev/x", &target, false).unwrap();
        assert!(target.join("a.txt").exists());
        // Unmounting twice records only the unmount that did something.
        mock.unmount(&target).unwrap();
        mock.unmount(&target).unwrap();
        assert_eq!(mock.unmounts.lock().unwrap().len(), 2);
    }
}
