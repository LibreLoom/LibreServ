//! Mount/unmount behind a small trait.
//!
//! Luna owns every mount it creates. Pre-existing OS mounts of USB sticks may
//! be remounted read-write on adopt (the live OS disk is never a candidate).
//! Tests inject a mock; production shells out to `mount` and `umount` with no
//! shell interpretation.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

/// How long `umount` gets before Luna gives up on it.
///
/// A drive that has stopped answering can hold an unmount open indefinitely,
/// and every wipe starts with an unmount — so without this bound a failing
/// stick would leave the drive stuck mid-format with nothing to report.
const UNMOUNT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// How long `mount` gets. Mounting a local filesystem is immediate; anything
/// slower is a sick drive or a filesystem that needs checking.
const MOUNT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// An unmount that failed only because something still has files open on
/// the drive. Waiting and trying again can work; other failures won't.
#[derive(Debug)]
pub struct MountBusy;

impl std::fmt::Display for MountBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("mount is busy")
    }
}

impl std::error::Error for MountBusy {}

/// A mount tool that ran out of time: the drive stopped answering.
///
/// Deliberately not [`MountBusy`]. Busy means "something has files open", and
/// callers retry it and tell the person to close them — neither of which is
/// true here, and retrying a dead drive is just a longer wait for the same
/// failure.
#[derive(Debug)]
pub struct DriveUnresponsive;

impl std::fmt::Display for DriveUnresponsive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("drive stopped responding")
    }
}

impl std::error::Error for DriveUnresponsive {}

/// True when `err` is (or wraps) [`DriveUnresponsive`].
pub fn is_unresponsive(err: &anyhow::Error) -> bool {
    err.downcast_ref::<DriveUnresponsive>().is_some()
}

/// True when `err` is (or wraps) [`MountBusy`].
pub fn is_busy(err: &anyhow::Error) -> bool {
    err.downcast_ref::<MountBusy>().is_some()
}

pub trait Mounter: Send + Sync {
    /// Mount `device` at `target`. Implementations create `target`.
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()>;
    /// Unmount `target` if mounted. Already-unmounted paths are success (idempotent).
    fn unmount(&self, target: &Path) -> anyhow::Result<()>;
    /// Let go of a mount whose drive was pulled out without ejecting. The
    /// device is gone, so a normal unmount can fail or hang on open files;
    /// this detaches the mount point now and cleans up when nothing uses it.
    fn detach_stale(&self, target: &Path) -> anyhow::Result<()> {
        self.unmount(target)
    }
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
        let out = run_bounded(Command::new("umount").arg(target), UNMOUNT_TIMEOUT)
            .map_err(|e| timeout_or(e, || anyhow::Error::new(DriveUnresponsive)))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if already_unmounted_stderr(&stderr) {
                return Ok(());
            }
            if stderr.to_ascii_lowercase().contains("busy") {
                return Err(anyhow::Error::new(MountBusy));
            }
            return Err(anyhow::anyhow!("unmount failed: {}", stderr.trim()));
        }
        Ok(())
    }

    fn detach_stale(&self, target: &Path) -> anyhow::Result<()> {
        if !self.is_mounted(target) {
            return Ok(());
        }
        let out = run_bounded(
            Command::new("umount").arg("-l").arg(target),
            UNMOUNT_TIMEOUT,
        )
        .map_err(|e| timeout_or(e, unresponsive))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if already_unmounted_stderr(&stderr) {
                return Ok(());
            }
            return Err(anyhow::anyhow!("detach failed: {}", stderr.trim()));
        }
        Ok(())
    }

    fn remount(&self, target: &Path, read_only: bool) -> anyhow::Result<()> {
        let out = run_bounded(
            Command::new("mount").args(remount_args(target, read_only)),
            MOUNT_TIMEOUT,
        )
        .map_err(|e| timeout_or(e, unresponsive))?;
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
        let out = run_bounded(
            Command::new("mount").args(mount_args(device, target, read_only, fs_type)),
            MOUNT_TIMEOUT,
        )
        .map_err(|e| timeout_or(e, unresponsive))?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "mount {device} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }
}

/// Run a mount tool with a deadline, capturing both streams.
///
/// `Command::output` waits forever, which is the one thing a mount call must
/// not do: a drive that has stopped answering would hold the caller open with
/// no way to report it. Callers decide what a timeout means — see
/// [`unresponsive`].
fn run_bounded(
    cmd: &mut Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::sandbox::output_limited(cmd, timeout)
}

/// What a tool that ran out of time means: the drive stopped answering.
fn unresponsive() -> anyhow::Error {
    anyhow::Error::new(DriveUnresponsive)
}

/// Map a timeout to the caller's meaning for it, and any other I/O error to
/// itself.
fn timeout_or(err: std::io::Error, on_timeout: impl FnOnce() -> anyhow::Error) -> anyhow::Error {
    if err.kind() == std::io::ErrorKind::TimedOut {
        on_timeout()
    } else {
        anyhow::Error::new(err)
    }
}

/// Arguments for `mount`, one per element, never shell-interpreted.
/// Every lunad-created mount gets noexec/nosuid/nodev — adopted drives
/// only ever serve files through the daemon.
fn mount_args(device: &str, target: &Path, read_only: bool, fs_type: Option<&str>) -> Vec<String> {
    const HARDEN: &str = "noexec,nosuid,nodev";
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
        // vfat has no permission bits: map to the usual 644/755 so files
        // are daemon-owned, not world-everything.
        args.push(format!("{mode},utf8,fmask=0133,dmask=0022,{HARDEN}"));
    } else {
        args.push(format!("{mode},{HARDEN}"));
    }
    args.push(device.to_string());
    args.push(target.to_string_lossy().into_owned());
    args
}

fn remount_args(target: &Path, read_only: bool) -> Vec<String> {
    let mode = if read_only {
        "remount,ro,noexec,nosuid,nodev"
    } else {
        "remount,rw,noexec,nosuid,nodev"
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
    pub fail_unmount: std::sync::Mutex<bool>,
    /// Unmounts that fail as "busy" before one succeeds (counts down).
    pub busy_unmounts: std::sync::Mutex<u32>,
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
        if *self.fail_unmount.lock().unwrap() {
            return Err(anyhow::anyhow!("mock unmount failure"));
        }
        {
            let mut busy = self.busy_unmounts.lock().unwrap();
            if *busy > 0 {
                *busy -= 1;
                return Err(anyhow::Error::new(MountBusy));
            }
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
    fn a_mount_tool_that_never_returns_is_killed() {
        // The whole point of the bound: a drive that has stopped answering
        // must not hold the caller open. `sleep` stands in for a wedged
        // `umount`, and the deadline is short so the test is quick.
        let started = std::time::Instant::now();
        let out = run_bounded(
            Command::new("sleep").arg("30"),
            std::time::Duration::from_millis(200),
        );
        let err = out.expect_err("a tool that outlives its deadline must not succeed");
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the deadline was not enforced"
        );
    }

    #[test]
    fn a_timeout_is_not_reported_as_a_busy_drive() {
        // Busy means "close your files", and callers retry it. A timeout must
        // not be retried for half an hour or blamed on the person.
        let timed_out = std::io::Error::new(std::io::ErrorKind::TimedOut, "tool timed out");
        let as_busy = timeout_or(timed_out, || anyhow::Error::new(MountBusy));
        assert!(is_busy(&as_busy));

        let timed_out = std::io::Error::new(std::io::ErrorKind::TimedOut, "tool timed out");
        let as_unresponsive = timeout_or(timed_out, unresponsive);
        assert!(is_unresponsive(&as_unresponsive));
        assert!(!is_busy(&as_unresponsive));
    }

    #[test]
    fn an_ordinary_io_error_is_passed_through() {
        // A missing binary is not a dead drive, and must not be described as
        // one: the two need different fixes.
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let err = timeout_or(missing, unresponsive);
        assert!(!is_unresponsive(&err));
        assert!(!is_busy(&err));
        assert!(err.to_string().contains("no such file"));
    }

    #[test]
    fn an_unknown_filesystem_lets_mount_detect_it() {
        assert_eq!(
            args("/dev/sdb1", false, None),
            [
                "-o",
                "rw,noexec,nosuid,nodev",
                "/dev/sdb1",
                "/run/luna/mnt/d1"
            ]
        );
        assert_eq!(
            args("/dev/sdb1", true, Some("")),
            [
                "-o",
                "ro,noexec,nosuid,nodev",
                "/dev/sdb1",
                "/run/luna/mnt/d1"
            ]
        );
    }

    #[test]
    fn fuseblk_is_left_for_mount_to_resolve() {
        assert_eq!(
            args("/dev/sdb1", false, Some("fuseblk")),
            [
                "-o",
                "rw,noexec,nosuid,nodev",
                "/dev/sdb1",
                "/run/luna/mnt/d1"
            ]
        );
    }

    #[test]
    fn fat_variants_become_vfat_with_utf8_names_and_daemon_owned_permissions() {
        for fs in ["vfat", "fat", "FAT32", "msdos", " vfat "] {
            assert_eq!(
                args("/dev/sdb1", false, Some(fs)),
                [
                    "-t",
                    "vfat",
                    "-o",
                    "rw,utf8,fmask=0133,dmask=0022,noexec,nosuid,nodev",
                    "/dev/sdb1",
                    "/run/luna/mnt/d1"
                ],
                "{fs:?}"
            );
        }
        assert_eq!(
            args("/dev/sdb1", true, Some("vfat"))[3],
            "ro,utf8,fmask=0133,dmask=0022,noexec,nosuid,nodev"
        );
    }

    #[test]
    fn ntfs_uses_the_kernel_ntfs3_driver() {
        assert_eq!(
            args("/dev/sdb1", false, Some("NTFS")),
            [
                "-t",
                "ntfs3",
                "-o",
                "rw,noexec,nosuid,nodev",
                "/dev/sdb1",
                "/run/luna/mnt/d1"
            ]
        );
    }

    #[test]
    fn other_filesystems_pass_through_by_name() {
        assert_eq!(
            args("/dev/sdb1", true, Some("exfat")),
            [
                "-t",
                "exfat",
                "-o",
                "ro,noexec,nosuid,nodev",
                "/dev/sdb1",
                "/run/luna/mnt/d1"
            ]
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
            ["-o", "remount,ro,noexec,nosuid,nodev", "/m"]
        );
        assert_eq!(
            remount_args(Path::new("/m"), false),
            ["-o", "remount,rw,noexec,nosuid,nodev", "/m"]
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
