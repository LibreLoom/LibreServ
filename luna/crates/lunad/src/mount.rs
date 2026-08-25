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
    /// Unmount `target` if mounted.
    fn unmount(&self, target: &Path) -> anyhow::Result<()>;
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

#[derive(Clone, Default)]
pub struct CommandMounter;

impl Mounter for CommandMounter {
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
        self.mount_typed(device, target, read_only, None)
    }

    fn unmount(&self, target: &Path) -> anyhow::Result<()> {
        let out = Command::new("umount").arg(target).output()?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "unmount {} failed: {}",
                target.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    fn remount(&self, target: &Path, read_only: bool) -> anyhow::Result<()> {
        let mode = if read_only {
            "remount,ro"
        } else {
            "remount,rw"
        };
        let out = Command::new("mount")
            .arg("-o")
            .arg(mode)
            .arg(target)
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
        let mode = if read_only { "ro" } else { "rw" };
        let fs = fs_type.unwrap_or("").trim().to_ascii_lowercase();

        if matches!(fs.as_str(), "ntfs" | "ntfs3" | "fuseblk")
            && try_ntfs3g(device, target, read_only)?
        {
            return Ok(());
        }

        let mut cmd = Command::new("mount");
        if !fs.is_empty() && fs != "fuseblk" {
            let mount_fs = match fs.as_str() {
                "fat" | "fat32" | "msdos" => "vfat",
                other => other,
            };
            cmd.arg("-t").arg(mount_fs);
        }
        if matches!(fs.as_str(), "vfat" | "fat" | "fat32" | "msdos") {
            cmd.arg("-o").arg(format!("{mode},utf8,umask=000"));
        } else {
            cmd.arg("-o").arg(mode);
        }
        let out = cmd.arg(device).arg(target).output()?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "mount {device} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }
}

fn try_ntfs3g(device: &str, target: &Path, read_only: bool) -> anyhow::Result<bool> {
    let mode = if read_only { "ro" } else { "rw" };
    let out = Command::new("ntfs-3g")
        .arg("-o")
        .arg(mode)
        .arg(device)
        .arg(target)
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Ok(false),
    }
}

/// Mounter that records calls and materializes mount points as directories.
/// Used by unit tests; never touches a real kernel mount table.
#[derive(Debug, Default)]
pub struct MockMounter {
    pub mounts: std::sync::Mutex<Vec<(String, PathBuf, bool)>>,
    pub unmounts: std::sync::Mutex<Vec<PathBuf>>,
    pub remounts: std::sync::Mutex<Vec<(PathBuf, bool)>>,
    pub fail_mount: std::sync::Mutex<bool>,
}

impl MockMounter {
    pub fn mount_count(&self) -> usize {
        self.mounts.lock().unwrap().len()
    }
}

impl Mounter for MockMounter {
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
        if *self.fail_mount.lock().unwrap() {
            return Err(anyhow::anyhow!("mock mount failure"));
        }
        std::fs::create_dir_all(target)?;
        self.mounts
            .lock()
            .unwrap()
            .push((device.to_string(), target.to_path_buf(), read_only));
        Ok(())
    }

    fn unmount(&self, target: &Path) -> anyhow::Result<()> {
        self.unmounts.lock().unwrap().push(target.to_path_buf());
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
