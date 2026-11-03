//! Unlocking, locking and mounting an encrypted drive.
//!
//! The password is never stored. It arrives in a request, is handed to
//! `cryptsetup` on stdin, and is dropped. What makes the drive readable
//! afterwards is the volume key inside the kernel's dm-crypt mapping, which is
//! not ours to hold and is wiped by `luksClose` or power loss.
//!
//! Order matters on the way out: flush, unmount, then close the container. A
//! `luksClose` while the filesystem is still mounted leaves the kernel writing
//! into a device that no longer has a key.

use std::path::Path;

use crate::db;
use crate::drives::luks::{Luks, mapper_path};
use crate::drives::mount::Mounter;

/// Why an unlock did not happen. Each variant is a different thing to tell the
/// person, so they stay apart rather than collapsing into one string.
#[derive(Debug, thiserror::Error)]
pub enum UnlockError {
    #[error("That password didn't work.")]
    WrongPassword,
    #[error("Luna doesn't know this drive.")]
    UnknownDrive,
    #[error("This drive isn't encrypted.")]
    NotEncrypted,
    #[error("This drive is unplugged. Plug it in and try again.")]
    NotPresent,
    #[error("This drive is being encrypted. It will be available when that finishes.")]
    Converting,
    #[error("{0}")]
    Other(String),
}

impl UnlockError {
    /// The message the API returns, already plain-language.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

fn classify(err: &anyhow::Error) -> UnlockError {
    let said = err.to_string();
    if said.contains("That password didn't work.") {
        return UnlockError::WrongPassword;
    }
    UnlockError::Other(said)
}

/// The mount point an unlocked drive uses. Same shape as any other adopted
/// drive, so nothing downstream needs to know it is encrypted.
pub fn mount_point_for(data_dir: &Path, drive_id: &str) -> std::path::PathBuf {
    data_dir.join("mounts/drives").join(drive_id)
}

/// Mount the drive's open container as ext4. The container must already be
/// open; this only does the filesystem half.
pub fn mount_container(
    mounter: &dyn Mounter,
    data_dir: &Path,
    drive_id: &str,
) -> anyhow::Result<String> {
    let target = mount_point_for(data_dir, drive_id);
    let source = mapper_path(drive_id);
    mounter
        .mount_typed(&source.to_string_lossy(), &target, false, Some("ext4"))
        .map_err(|e| anyhow::anyhow!("Luna couldn't open this drive. {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Close a drive's container, unmounting first.
///
/// Best-effort on the unmount: if the filesystem will not unmount, the
/// container stays open rather than being closed underneath it, because that
/// would leave the kernel writing into an unkeyed device.
pub fn lock_drive(
    mounter: &dyn Mounter,
    luks: &dyn Luks,
    drive_id: &str,
    mount_point: &str,
) -> anyhow::Result<()> {
    if !mount_point.is_empty() {
        let target = Path::new(mount_point);
        if target.is_dir() && mounter.is_mounted(target) {
            mounter.unmount(target).map_err(|e| {
                if crate::drives::mount::is_busy(&e) {
                    anyhow::anyhow!("Close any files open from this drive, then try again.")
                } else {
                    anyhow::anyhow!("Luna couldn't close this drive. Try again.")
                }
            })?;
        }
        let _ = std::fs::remove_dir(target);
    }
    luks.close(drive_id)
}

/// Open a drive's container and mount it. Returns the mount point.
///
/// The caller is responsible for having checked access and the rate limit; this
/// is the mechanical half.
pub fn unlock_drive(
    mounter: &dyn Mounter,
    luks: &dyn Luks,
    data_dir: &Path,
    drive_id: &str,
    device: &str,
    password: &str,
) -> Result<String, UnlockError> {
    if device.is_empty() {
        return Err(UnlockError::NotPresent);
    }
    if !Path::new(&format!("/dev/{device}")).exists() && !device.starts_with('/') {
        return Err(UnlockError::NotPresent);
    }
    luks.open(device, drive_id, password)
        .map_err(|e| classify(&e))?;
    match mount_container(mounter, data_dir, drive_id) {
        Ok(mount_point) => Ok(mount_point),
        Err(e) => {
            // Do not leave a container open with nothing mounting it: the key
            // would sit in the kernel for a drive the person cannot use.
            let _ = luks.close(drive_id);
            Err(UnlockError::Other(e.to_string()))
        }
    }
}

/// The database half of an unlock: record that the drive is open and where.
pub fn record_unlocked(
    conn: &rusqlite::Connection,
    drive_id: &str,
    mount_point: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE drives SET locked = 0, mount_point = ?2, fs_type = 'ext4', \
         state = CASE WHEN state IN ('missing','ejected') THEN 'as_is' ELSE state END, \
         updated_at = ?3 WHERE id = ?1",
        rusqlite::params![drive_id, mount_point, db::now_unix()],
    )?;
    Ok(())
}

/// The database half of a lock.
pub fn record_locked(conn: &rusqlite::Connection, drive_id: &str) -> anyhow::Result<()> {
    db::set_drive_locked(conn, drive_id, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::luks::MockLuks;
    use crate::drives::mount::MockMounter;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn unlocking_opens_the_container_and_mounts_it() {
        let dir = dir();
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        let mount = unlock_drive(&mounter, &luks, dir.path(), "d1", "/dev/sdb1", "pw").unwrap();
        assert!(luks.is_open("d1"));
        assert_eq!(mount, mount_point_for(dir.path(), "d1").to_string_lossy());
        // Mounted read-write, typed ext4, from the mapper — not the raw device.
        let mounts = mounter.mounts.lock().unwrap();
        assert_eq!(mounts.len(), 1);
        assert!(!mounts[0].2, "an unlocked drive must be mounted writable");
        assert!(mounts[0].0.contains("luna-vault-d1"));
    }

    #[test]
    fn a_wrong_password_reports_itself_plainly() {
        let dir = dir();
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        *luks.open_error.lock().unwrap() = Some("That password didn't work.".into());
        let err = unlock_drive(&mounter, &luks, dir.path(), "d1", "/dev/sdb1", "bad").unwrap_err();
        assert!(matches!(err, UnlockError::WrongPassword));
        assert_eq!(err.message(), "That password didn't work.");
        // Nothing was mounted, and no container was left open.
        assert_eq!(mounter.mount_count(), 0);
        assert!(!luks.is_open("d1"));
    }

    #[test]
    fn a_failed_mount_closes_the_container_again() {
        let dir = dir();
        let mounter = MockMounter::default();
        *mounter.fail_mount.lock().unwrap() = true;
        let luks = MockLuks::with_luks("/dev/sdb1");
        let err = unlock_drive(&mounter, &luks, dir.path(), "d1", "/dev/sdb1", "pw").unwrap_err();
        assert!(matches!(err, UnlockError::Other(_)));
        // The key must not stay in the kernel for a drive nobody can use.
        assert!(!luks.is_open("d1"));
        assert_eq!(luks.closed.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_unplugged_drive_is_refused_before_any_crypto() {
        let dir = dir();
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        let err = unlock_drive(&mounter, &luks, dir.path(), "d1", "", "pw").unwrap_err();
        assert!(matches!(err, UnlockError::NotPresent));
        assert_eq!(luks.open_count(), 0);
    }

    #[test]
    fn locking_unmounts_before_closing_the_container() {
        let dir = dir();
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        let mount = unlock_drive(&mounter, &luks, dir.path(), "d1", "/dev/sdb1", "pw").unwrap();
        lock_drive(&mounter, &luks, "d1", &mount).unwrap();
        assert!(!luks.is_open("d1"));
        assert_eq!(mounter.unmounts.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_busy_unmount_keeps_the_container_open() {
        let dir = dir();
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        let mount = unlock_drive(&mounter, &luks, dir.path(), "d1", "/dev/sdb1", "pw").unwrap();
        // Something still has a file open on the drive.
        *mounter.busy_unmounts.lock().unwrap() = 1;
        let err = lock_drive(&mounter, &luks, "d1", &mount).unwrap_err();
        assert!(err.to_string().contains("Close any files open"));
        // Closing the container under a live mount would leave the kernel
        // writing into an unkeyed device.
        assert!(luks.is_open("d1"));
    }

    #[test]
    fn locking_an_already_closed_drive_is_fine() {
        let mounter = MockMounter::default();
        let luks = MockLuks::with_luks("/dev/sdb1");
        lock_drive(&mounter, &luks, "d1", "").unwrap();
    }

    #[test]
    fn record_unlocked_clears_the_lock_and_sets_the_mount() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "crypto_LUKS", "sdb1", "").unwrap();
        crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
        crate::db::set_drive_locked(&conn, "d1", true).unwrap();
        record_unlocked(&conn, "d1", "/mnt/d1").unwrap();
        let row = crate::db::get_drive(&conn, "d1").unwrap().unwrap();
        assert!(!row.locked);
        assert!(row.encrypted);
        assert_eq!(row.mount_point, "/mnt/d1");
        assert_eq!(row.fs_type, "ext4");
    }

    #[test]
    fn record_locked_clears_the_mount_point() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb1", "/mnt/d1").unwrap();
        crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
        record_locked(&conn, "d1").unwrap();
        let row = crate::db::get_drive(&conn, "d1").unwrap().unwrap();
        assert!(row.locked);
        assert!(row.mount_point.is_empty());
        // A locked drive must not look readable.
        assert!(!row.is_readable());
    }
}
