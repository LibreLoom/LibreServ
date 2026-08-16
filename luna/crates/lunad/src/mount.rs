//! Mount/unmount behind a small trait.
//!
//! Luna owns every mount it creates and never remounts a filesystem the OS
//! already mounted. Tests inject a mock; production shells out to `mount` and
//! `umount` with no shell interpretation.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

pub trait Mounter: Send + Sync {
    /// Mount `device` at `target`. Implementations create `target`.
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()>;
    /// Unmount `target` if mounted.
    fn unmount(&self, target: &Path) -> anyhow::Result<()>;
}

#[derive(Clone, Default)]
pub struct CommandMounter;

impl Mounter for CommandMounter {
    fn mount(&self, device: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
        std::fs::create_dir_all(target)?;
        let mode = if read_only { "ro" } else { "rw" };
        let out = Command::new("mount")
            .arg("-o")
            .arg(mode)
            .arg(device)
            .arg(target)
            .output()?;
        if !out.status.success() {
            return Err(anyhow::anyhow!(
                "mount {device} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
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
}

/// Mounter that records calls and materializes mount points as directories.
/// Used by unit tests; never touches a real kernel mount table.
#[derive(Debug, Default)]
pub struct MockMounter {
    pub mounts: std::sync::Mutex<Vec<(String, PathBuf, bool)>>,
    pub unmounts: std::sync::Mutex<Vec<PathBuf>>,
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
}

pub fn shared_mock() -> Arc<MockMounter> {
    Arc::new(MockMounter::default())
}
