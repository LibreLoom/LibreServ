//! Unlocking and locking an encrypted drive, and the startup rule.
//!
//! The password is never stored. It arrives in a request, goes to `cryptsetup`
//! on stdin, and is dropped. What keeps the drive readable afterwards is the
//! volume key inside the kernel's dm-crypt mapping, which is not ours to hold
//! and is wiped by `luksClose` or power loss.
//!
//! Order matters on the way out: stop using the drive, flush, unmount, then
//! close the container. A `luksClose` while the filesystem is still mounted
//! leaves the kernel writing into a device that no longer has a key.
//!
//! **Startup never mounts an encrypted drive.** After a boot every one is
//! locked. After a daemon-only restart a mapper may still be open and mounted;
//! [`startup`] checks mapper, mount and marker before deciding.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use rusqlite::Connection;

use crate::drives::DriveManager;
use crate::drives::crypt::luks::mapper_path;
use crate::drives::format::run::{self, FormatError, Pacing, Purpose};
use crate::drives::format::tools::ToolError;
use crate::drives::fsprobe::is_luks_type;
use crate::{AppState, db};

/// Why an unlock did not happen. Each variant is a different thing to tell the
/// person, so they stay apart rather than collapsing into one string.
#[derive(Debug, thiserror::Error)]
pub enum UnlockError {
    #[error("That password didn't work.")]
    WrongPassword,
    #[error("This drive is unplugged. Plug it in and try again.")]
    NotPresent,
    /// The password opened a container, but it is not the drive Luna meant.
    /// Deliberately not a wrong password: it must not count as a wrong try.
    #[error("This isn't the drive Luna expected. Plug in the right drive and try again.")]
    WrongDrive,
    #[error("{0}")]
    Other(String),
}

impl From<ToolError> for UnlockError {
    fn from(e: ToolError) -> Self {
        match e {
            ToolError::WrongPassword => UnlockError::WrongPassword,
            other => UnlockError::Other(other.to_string()),
        }
    }
}

/// Why a lock did not happen.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Something has files open from the drive: waiting and trying again can work.
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    Other(String),
}

// ---------------------------------------------------------------------------
// The "being locked" gate

static LOCKING_DRIVES: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Marks a drive as being locked until dropped. `files::drive_root` answers
/// such a drive with "locked" straight away: between the unmount and the
/// database update its mount folder is an empty folder on the system disk,
/// and nothing may read or write there.
pub struct LockingDriveGuard(String);

impl LockingDriveGuard {
    pub fn new(id: &str) -> Self {
        LOCKING_DRIVES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
        LockingDriveGuard(id.to_string())
    }
}

impl Drop for LockingDriveGuard {
    fn drop(&mut self) {
        LOCKING_DRIVES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub fn drive_is_locking(id: &str) -> bool {
    LOCKING_DRIVES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(id)
}

// ---------------------------------------------------------------------------
// Looking at the container

/// Resolve a physical drive (kernel name such as `sdb`) to its single LUKS
/// container partition. Never guesses: zero or several containers is an error.
pub fn luks_partition(manager: &DriveManager, disk: &str) -> anyhow::Result<String> {
    let disk = disk.strip_prefix("/dev/").unwrap_or(disk);
    let parts = manager.probe().probe_disk(disk);
    let mut containers = parts.iter().filter(|part| is_luks_type(&part.fs_type));
    let part = containers
        .next()
        .ok_or_else(|| anyhow::anyhow!("Luna couldn't find the encrypted part of this drive."))?;
    if containers.next().is_some() {
        anyhow::bail!("Luna found more than one encrypted part on this drive.");
    }
    Ok(format!("/dev/{}", part.name))
}

fn marker_is(root: &Path, id: &str) -> bool {
    luna_core::marker::read_marker(root)
        .ok()
        .flatten()
        .is_some_and(|marker| marker.id == id)
}

/// Where an unlocked drive is mounted: its row's mount point, else the
/// standard place. Same shape as any other adopted drive, so nothing
/// downstream knows it is encrypted.
fn mount_of(manager: &DriveManager, row: &db::DriveRow) -> PathBuf {
    if row.mount_point.is_empty() {
        manager.adopted_mount_point(&row.id)
    } else {
        PathBuf::from(&row.mount_point)
    }
}

/// Is this drive really open: mapper present, filesystem mounted, and the
/// marker inside carrying this drive's id? All three, or it is not unlocked.
pub fn is_open_and_mounted(manager: &DriveManager, row: &db::DriveRow) -> bool {
    if !manager.luks().is_open(&row.id) {
        return false;
    }
    let mount = mount_of(manager, row);
    manager.mounter().is_mounted(&mount) && marker_is(&mount, &row.id)
}

/// Best effort: unmount whatever is mounted for a drive that must be locked
/// and close its container. A mount of a drive that was pulled out is
/// detached rather than waited on.
pub fn close_for_lock(manager: &DriveManager, row: &db::DriveRow) {
    let mount = mount_of(manager, row);
    if manager.mounter().is_mounted(&mount) {
        if manager.mounter().unmount(&mount).is_err()
            && let Err(e) = manager.mounter().detach_stale(&mount)
        {
            tracing::warn!(drive = %row.id, error = %e, "could not let go of an encrypted drive's mount");
            // Closing the container under a live mount would leave the kernel
            // writing into an unkeyed device; leave it for the next pass.
            return;
        }
        let _ = std::fs::remove_dir(&mount);
    }
    if let Err(e) = manager.luks().close(&row.id) {
        tracing::warn!(drive = %row.id, error = %e, "could not close an encrypted drive");
    }
}

// ---------------------------------------------------------------------------
// Unlock

/// Open a drive's container and mount it. `disk` is the drive's kernel name.
/// Returns the mount point. The caller has checked access and the rate limit;
/// this is the mechanical half.
pub fn unlock_drive(
    manager: &DriveManager,
    id: &str,
    disk: &str,
    password: &str,
) -> Result<PathBuf, UnlockError> {
    if disk.is_empty() {
        return Err(UnlockError::NotPresent);
    }
    let partition = luks_partition(manager, disk).map_err(|e| UnlockError::Other(e.to_string()))?;
    let target = manager.adopted_mount_point(id);
    if manager.luks().is_open(id) {
        // Open but not a verified mount: left over from a crash. Start clean
        // rather than guess what is inside it.
        if manager.mounter().is_mounted(&target) {
            if marker_is(&target, id) {
                return Ok(target);
            }
            manager
                .mounter()
                .unmount(&target)
                .map_err(|_| UnlockError::Other("This drive is in use. Try again.".into()))?;
        }
        manager.luks().close(id)?;
    }
    manager.luks().open(&partition, id, password)?;
    let mounted = manager.mounter().mount_typed(
        &mapper_path(id).to_string_lossy(),
        &target,
        false,
        Some("ext4"),
    );
    if let Err(e) = mounted {
        tracing::warn!(drive = %id, error = %e, "could not mount an unlocked drive");
        // The key must not sit in the kernel for a drive nobody can use.
        let _ = manager.luks().close(id);
        return Err(UnlockError::Other(
            "Luna couldn't open this drive. Unplug it, plug it back in, and try again.".into(),
        ));
    }
    if !marker_is(&target, id) {
        if manager.mounter().unmount(&target).is_ok() {
            let _ = manager.luks().close(id);
            let _ = std::fs::remove_dir(&target);
        }
        return Err(UnlockError::WrongDrive);
    }
    Ok(target)
}

/// Read an encrypted Luna drive's identity without registering it. A
/// temporary read-only mount and mapper are always cleaned up first.
pub fn inspect_identity(
    manager: &DriveManager,
    partition: &str,
    password: &str,
) -> Result<luna_core::marker::Marker, UnlockError> {
    let temporary_id = format!("inspect-{}", uuid::Uuid::new_v4());
    let target = manager.foreign_mount_point(&temporary_id);
    manager.luks().open(partition, &temporary_id, password)?;
    let source = mapper_path(&temporary_id);
    let result = (|| -> anyhow::Result<luna_core::marker::Marker> {
        manager
            .mounter()
            .mount_typed(&source.to_string_lossy(), &target, true, Some("ext4"))?;
        if !manager.mounter().is_mounted(&target) {
            anyhow::bail!("not mounted");
        }
        let markers = luna_core::marker::read_markers(&target)?;
        if markers.len() != 1 {
            anyhow::bail!("not exactly one drive identity");
        }
        let marker = markers.into_iter().next().unwrap().1;
        if uuid::Uuid::parse_str(&marker.id).is_err() {
            anyhow::bail!("invalid drive identity");
        }
        Ok(marker)
    })();
    let cleanup =
        || UnlockError::Other("Luna couldn't close the drive after checking it. Try again.".into());
    if manager.mounter().is_mounted(&target) && manager.mounter().unmount(&target).is_err() {
        return Err(cleanup());
    }
    if manager.luks().close(&temporary_id).is_err() {
        return Err(cleanup());
    }
    let _ = std::fs::remove_dir(&target);
    result.map_err(|e| {
        tracing::warn!(error = %e, "could not read an encrypted drive's identity");
        UnlockError::Other(
            "This doesn't look like a drive set up by Luna, so Luna can't add it.".into(),
        )
    })
}

// ---------------------------------------------------------------------------
// Lock

/// Lock an unlocked drive: refuse open documents and running copies, hold the
/// backup run slots, flush the RAM cache, stop the indexers, unmount, close
/// the container, record it. Blocking; the caller holds the drive lock.
///
/// A refusal (busy, documents open) leaves the drive as it was. If the
/// container will not close after the unmount, the mount is put back.
pub fn lock_drive(state: &AppState, id: &str) -> Result<(), LockError> {
    let manager = &state.drive_manager;
    // Close the gate first: from here files code answers "locked" instead of
    // reading the empty folder an unmount leaves behind.
    let _gate = LockingDriveGuard::new(id);
    let pacing = Pacing {
        busy_retry: state.format.busy_retry,
        ..Pacing::default()
    };
    let (quiesced, drive) = run::quiesce(state, id, &pacing, Purpose::Lock).map_err(|e| {
        // A refusal leaves the drive as it was, so let the indexers watch it
        // again if it is still mounted (quiesce stopped them).
        if let Ok(Some(row)) = state
            .db
            .lock()
            .map(|conn| db::get_drive(&conn, id).ok().flatten())
            && manager.mount_is_live(&row.mount_point)
        {
            let root = PathBuf::from(&row.mount_point);
            state.search_index.watch_mount(id, root.clone());
            state.photos.watch_mount(id, root);
        }
        match e {
        FormatError::Busy => LockError::Busy(
            "Something is still using this drive. Close any files open from it, then try again."
                .into(),
        ),
        FormatError::Unresponsive => LockError::Other(
            "This drive stopped responding, so Luna couldn't lock it. Unplug it, plug it back in, and try again."
                .into(),
        ),
        other => LockError::Busy(other.to_string()),
        }
    })?;
    if let Err(e) = manager.luks().close(id) {
        tracing::warn!(drive = %id, error = %e, "could not close an encrypted drive");
        // Put the drive back as it was where possible, so nothing is left
        // open with nothing mounted.
        let target = manager.adopted_mount_point(id);
        let restored = !drive.mount_point.is_empty()
            && manager.luks().is_open(id)
            && manager
                .mounter()
                .mount_typed(
                    &mapper_path(id).to_string_lossy(),
                    Path::new(&drive.mount_point),
                    false,
                    Some("ext4"),
                )
                .is_ok();
        if restored {
            let root = PathBuf::from(&drive.mount_point);
            state.search_index.watch_mount(id, root.clone());
            state.photos.watch_mount(id, root);
        } else if let Ok(conn) = state.db.lock() {
            // Not mounted and not closed: record it as locked so nothing reads
            // the empty folder; the next reconcile closes the container.
            let _ = record_locked(&conn, id);
            let _ = std::fs::remove_dir(&target);
        }
        drop(quiesced);
        return Err(LockError::Other(
            "Luna couldn't lock this drive. Try again.".into(),
        ));
    }
    {
        let conn = state
            .db
            .lock()
            .map_err(|_| LockError::Other("Luna couldn't read its drive settings.".into()))?;
        record_locked(&conn, id).map_err(|_| {
            LockError::Other("Luna couldn't record that the drive is locked.".into())
        })?;
    }
    state.ram_cache.drop_drive(id);
    if !drive.mount_point.is_empty() {
        let _ = std::fs::remove_dir(&drive.mount_point);
    }
    drop(quiesced);
    Ok(())
}

// ---------------------------------------------------------------------------
// The database half

/// Record that the drive is open and where it is mounted.
pub fn record_unlocked(conn: &Connection, drive_id: &str, mount_point: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE drives SET locked = 0, mount_point = ?2, fs_type = 'ext4', \
         state = CASE WHEN state IN ('missing','ejected') THEN 'as_is' ELSE state END, \
         updated_at = ?3 WHERE id = ?1",
        rusqlite::params![drive_id, mount_point, db::now_unix()],
    )?;
    // An unlocked backup drive may hold backups Luna has no record of.
    if let Some(drive) = db::get_drive(conn, drive_id)? {
        crate::backup::drive_backup::rebuild_for_drive(conn, &drive);
    }
    Ok(())
}

/// Record that the drive is locked (and has no mount point).
pub fn record_locked(conn: &Connection, drive_id: &str) -> anyhow::Result<()> {
    db::set_drive_locked(conn, drive_id, true)
}

// ---------------------------------------------------------------------------
// Startup

/// Settle every encrypted drive before anything reads the registry. After a
/// boot nothing is open, so all are locked. After a daemon-only restart a
/// container may still be open and mounted; it stays unlocked only when the
/// mapper, the mount and the marker all agree. Anything else (a power cut
/// mid-unlock, a half-open container) is closed and recorded as locked.
pub fn startup(conn: &Connection, manager: &DriveManager) -> anyhow::Result<()> {
    for row in db::list_drives(conn)?.into_iter().filter(|d| d.encrypted) {
        if is_open_and_mounted(manager, &row) {
            if row.locked || row.mount_point.is_empty() {
                let mount = mount_of(manager, &row);
                record_unlocked(conn, &row.id, &mount.to_string_lossy())?;
            }
            continue;
        }
        close_for_lock(manager, &row);
        if !row.locked || !row.mount_point.is_empty() {
            record_locked(conn, &row.id)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::crypt::luks::{Luks, MockLuks};
    use crate::drives::fsprobe::{FsInfo, MockFsProbe};
    use crate::drives::mount::{MockMounter, Mounter};
    use std::sync::Arc;

    const ID: &str = "f64bcf9e-3819-4fa2-89fd-a9a3e559a395";

    struct Rig {
        dir: tempfile::TempDir,
        mounter: Arc<MockMounter>,
        luks: Arc<MockLuks>,
        manager: DriveManager,
    }

    /// A manager over one disk `sdb` with a single LUKS partition `sdb1`.
    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let mounter = Arc::new(MockMounter::default());
        let luks = Arc::new(MockLuks::default());
        let probe = MockFsProbe::default();
        probe.disks.lock().unwrap().insert(
            "sdb".into(),
            vec![FsInfo {
                name: "sdb1".into(),
                fs_type: "crypto_LUKS".into(),
                label: String::new(),
                size_bytes: 1 << 30,
            }],
        );
        let manager = DriveManager::new_with_probe(mounter.clone(), dir.path(), Arc::new(probe))
            .with_luks(luks.clone());
        Rig {
            dir,
            mounter,
            luks,
            manager,
        }
    }

    /// The marker the drive carries inside its container, as `unlock` will find
    /// it once the (mock) mount brings the folder back.
    fn put_marker(rig: &Rig, id: &str) {
        let root = rig.manager.adopted_mount_point(id);
        std::fs::create_dir_all(&root).unwrap();
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        luna_core::marker::write_marker(
            &root,
            &luna_core::marker::Marker::new(id, "Photos"),
            &prefix,
        )
        .unwrap();
    }

    fn row(rig: &Rig, locked: bool, mounted: bool) -> db::DriveRow {
        db::DriveRow {
            id: ID.into(),
            label: "Photos".into(),
            state: "as_is".into(),
            fs_type: "ext4".into(),
            device: "sdb".into(),
            mount_point: if mounted {
                rig.manager
                    .adopted_mount_point(ID)
                    .to_string_lossy()
                    .into_owned()
            } else {
                String::new()
            },
            encrypted: true,
            locked,
        }
    }

    fn register(conn: &Connection, row: &db::DriveRow) {
        db::upsert_drive(
            conn,
            &row.id,
            &row.label,
            &row.state,
            &row.fs_type,
            &row.device,
            &row.mount_point,
        )
        .unwrap();
        db::set_drive_encrypted(conn, &row.id, row.encrypted).unwrap();
        if row.locked {
            db::set_drive_locked(conn, &row.id, true).unwrap();
        }
    }

    #[test]
    fn unlocking_opens_the_container_and_mounts_the_mapper_read_write() {
        let rig = rig();
        put_marker(&rig, ID);
        let mount = unlock_drive(&rig.manager, ID, "sdb", "pw").unwrap();
        assert!(rig.luks.is_open(ID));
        assert_eq!(mount, rig.manager.adopted_mount_point(ID));
        let mounts = rig.mounter.mounts.lock().unwrap();
        assert_eq!(mounts.len(), 1);
        assert!(!mounts[0].2, "an unlocked drive must be mounted writable");
        assert!(
            mounts[0].0.contains("luna-vault-"),
            "mounted from the mapper"
        );
        assert_eq!(rig.luks.calls()[0], format!("open /dev/sdb1 {ID}"));
    }

    #[test]
    fn a_wrong_password_is_reported_plainly_and_leaves_nothing_open() {
        let rig = rig();
        put_marker(&rig, ID);
        *rig.luks.password.lock().unwrap() = Some("right".into());
        let err = unlock_drive(&rig.manager, ID, "sdb", "wrong").unwrap_err();
        assert!(matches!(err, UnlockError::WrongPassword));
        assert_eq!(err.to_string(), "That password didn't work.");
        assert_eq!(rig.mounter.mount_count(), 0);
        assert!(!rig.luks.is_open(ID));
    }

    #[test]
    fn a_different_drives_marker_is_never_published_and_is_not_a_wrong_password() {
        let rig = rig();
        put_marker(&rig, "someone-else");
        // The marker the unlock will find belongs to another drive.
        let other = rig.manager.adopted_mount_point("someone-else");
        let ours = rig.manager.adopted_mount_point(ID);
        std::fs::create_dir_all(&ours).unwrap();
        for entry in std::fs::read_dir(&other).unwrap().flatten() {
            std::fs::rename(entry.path(), ours.join(entry.file_name())).unwrap();
        }
        let err = unlock_drive(&rig.manager, ID, "sdb", "pw").unwrap_err();
        assert!(matches!(err, UnlockError::WrongDrive));
        assert!(!rig.luks.is_open(ID), "the key must not stay in the kernel");
        assert_eq!(rig.mounter.unmounts.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_failed_mount_closes_the_container_again() {
        let rig = rig();
        put_marker(&rig, ID);
        *rig.mounter.fail_mount.lock().unwrap() = true;
        let err = unlock_drive(&rig.manager, ID, "sdb", "pw").unwrap_err();
        assert!(matches!(err, UnlockError::Other(_)));
        assert!(!rig.luks.is_open(ID));
        assert_eq!(rig.luks.count("close"), 1);
    }

    #[test]
    fn an_unplugged_or_unprobeable_drive_is_refused_before_any_crypto() {
        let rig = rig();
        assert!(matches!(
            unlock_drive(&rig.manager, ID, "", "pw").unwrap_err(),
            UnlockError::NotPresent
        ));
        // No container on this disk at all.
        let err = unlock_drive(&rig.manager, ID, "sdc", "pw").unwrap_err();
        assert!(err.to_string().contains("couldn't find the encrypted part"));
        assert_eq!(rig.luks.count("open"), 0);
    }

    #[test]
    fn several_containers_on_one_disk_are_never_guessed_between() {
        let rig = rig();
        let probe = MockFsProbe::default();
        let part = |n: &str| FsInfo {
            name: n.into(),
            fs_type: "crypto_LUKS".into(),
            label: String::new(),
            size_bytes: 1,
        };
        probe
            .disks
            .lock()
            .unwrap()
            .insert("sdb".into(), vec![part("sdb1"), part("sdb2")]);
        let manager =
            DriveManager::new_with_probe(rig.mounter.clone(), rig.dir.path(), Arc::new(probe));
        assert!(luks_partition(&manager, "sdb").is_err());
    }

    #[test]
    fn a_stale_open_mapper_with_no_mount_is_closed_and_reopened_with_the_password() {
        let rig = rig();
        put_marker(&rig, ID);
        rig.luks.open.lock().unwrap().insert(ID.into());
        unlock_drive(&rig.manager, ID, "sdb", "pw").unwrap();
        assert_eq!(rig.luks.count("close"), 1);
        assert_eq!(rig.luks.count("open"), 1);
        assert!(rig.luks.is_open(ID));
    }

    #[test]
    fn existing_identity_is_read_without_leaving_a_mapper_open() {
        struct IdentityMounter(MockMounter);
        impl Mounter for IdentityMounter {
            fn mount(&self, source: &str, target: &Path, read_only: bool) -> anyhow::Result<()> {
                assert!(read_only);
                self.0.mount(source, target, read_only)?;
                let prefix = luna_core::marker::pick_prefix(target)?;
                luna_core::marker::write_marker(
                    target,
                    &luna_core::marker::Marker::new(ID, "Photos"),
                    &prefix,
                )?;
                Ok(())
            }
            fn is_mounted(&self, target: &Path) -> bool {
                self.0.is_mounted(target)
            }
            fn unmount(&self, target: &Path) -> anyhow::Result<()> {
                self.0.unmount(target)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let luks = Arc::new(MockLuks::default());
        let manager = DriveManager::new(
            Arc::new(IdentityMounter(MockMounter::default())),
            dir.path(),
        )
        .with_luks(luks.clone());
        let marker = inspect_identity(&manager, "/dev/sdb1", "pw").unwrap();
        assert_eq!(marker.label, "Photos");
        assert_eq!(marker.id, ID);
        assert_eq!(luks.count("open"), 1);
        assert_eq!(luks.count("close"), 1);
        assert!(luks.open.lock().unwrap().is_empty());
    }

    #[test]
    fn a_wrong_password_while_reading_an_identity_is_a_wrong_password() {
        let rig = rig();
        *rig.luks.password.lock().unwrap() = Some("right".into());
        assert!(matches!(
            inspect_identity(&rig.manager, "/dev/sdb1", "wrong").unwrap_err(),
            UnlockError::WrongPassword
        ));
        assert!(rig.luks.open.lock().unwrap().is_empty());
    }

    #[test]
    fn record_unlocked_clears_the_lock_and_sets_the_mount() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "").unwrap();
        db::set_drive_encrypted(&conn, "d1", true).unwrap();
        db::set_drive_locked(&conn, "d1", true).unwrap();
        record_unlocked(&conn, "d1", "/mnt/d1").unwrap();
        let row = db::get_drive(&conn, "d1").unwrap().unwrap();
        assert!(!row.locked && row.encrypted);
        assert_eq!(row.mount_point, "/mnt/d1");
    }

    #[test]
    fn record_locked_clears_the_mount_point() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "/mnt/d1").unwrap();
        db::set_drive_encrypted(&conn, "d1", true).unwrap();
        record_locked(&conn, "d1").unwrap();
        let row = db::get_drive(&conn, "d1").unwrap().unwrap();
        assert!(row.locked);
        assert!(row.mount_point.is_empty());
    }

    // --- startup ---------------------------------------------------------

    #[test]
    fn after_a_boot_every_encrypted_drive_is_locked_and_nothing_is_mounted() {
        let rig = rig();
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        // The row says unlocked, but nothing is open: the box just booted.
        register(&conn, &row(&rig, false, true));
        startup(&conn, &rig.manager).unwrap();
        let after = db::get_drive(&conn, ID).unwrap().unwrap();
        assert!(after.locked);
        assert!(after.mount_point.is_empty());
        assert_eq!(rig.mounter.mount_count(), 0, "startup never mounts");
        assert_eq!(rig.luks.count("open"), 0, "and never opens a container");
    }

    #[test]
    fn a_daemon_restart_keeps_a_drive_unlocked_only_when_mapper_mount_and_marker_agree() {
        let rig = rig();
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        put_marker(&rig, ID);
        let mounted = row(&rig, false, true);
        register(&conn, &mounted);
        rig.luks.open.lock().unwrap().insert(ID.into());
        rig.mounter
            .mount(
                "/dev/mapper/luna-vault-x",
                &rig.manager.adopted_mount_point(ID),
                false,
            )
            .unwrap();
        startup(&conn, &rig.manager).unwrap();
        let after = db::get_drive(&conn, ID).unwrap().unwrap();
        assert!(!after.locked, "still open and mounted: stays unlocked");
        assert_eq!(after.mount_point, mounted.mount_point);
        assert!(rig.luks.is_open(ID));
    }

    #[test]
    fn an_open_mapper_with_no_mount_is_closed_and_locked_not_left_half_open() {
        let rig = rig();
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        register(&conn, &row(&rig, false, true));
        rig.luks.open.lock().unwrap().insert(ID.into());
        startup(&conn, &rig.manager).unwrap();
        assert!(!rig.luks.is_open(ID), "no key left in the kernel");
        assert!(db::get_drive(&conn, ID).unwrap().unwrap().locked);
    }

    #[test]
    fn an_open_and_mounted_drive_with_the_wrong_marker_is_locked() {
        let rig = rig();
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        put_marker(&rig, "another-drive");
        let ours = rig.manager.adopted_mount_point(ID);
        std::fs::create_dir_all(&ours).unwrap();
        for entry in std::fs::read_dir(rig.manager.adopted_mount_point("another-drive"))
            .unwrap()
            .flatten()
        {
            std::fs::rename(entry.path(), ours.join(entry.file_name())).unwrap();
        }
        register(&conn, &row(&rig, false, true));
        rig.luks.open.lock().unwrap().insert(ID.into());
        rig.mounter.mount("x", &ours, false).unwrap();
        startup(&conn, &rig.manager).unwrap();
        assert!(db::get_drive(&conn, ID).unwrap().unwrap().locked);
        assert!(!rig.luks.is_open(ID));
    }

    #[test]
    fn plain_drives_are_never_touched_by_startup() {
        let rig = rig();
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        db::upsert_drive(&conn, "plain", "Stick", "as_is", "exfat", "sdc", "/mnt/p").unwrap();
        startup(&conn, &rig.manager).unwrap();
        let after = db::get_drive(&conn, "plain").unwrap().unwrap();
        assert!(!after.locked && !after.encrypted);
        assert_eq!(after.mount_point, "/mnt/p");
        assert!(rig.luks.calls().is_empty());
    }

    // --- lock ------------------------------------------------------------

    fn state_with_unlocked_drive(rig: &Rig) -> AppState {
        let conn = db::open(&rig.dir.path().join("luna.db")).unwrap();
        let manager = Arc::new(rig.manager.clone());
        // Built before the drive is registered: startup would lock it.
        let mut state = AppState::new(conn, manager, rig.dir.path());
        let mut service = crate::drives::format::FormatService::default();
        service.busy_retry = std::time::Duration::ZERO;
        state.format = Arc::new(service);
        put_marker(rig, ID);
        let mount = rig.manager.adopted_mount_point(ID);
        rig.mounter.mount("m", &mount, false).unwrap();
        rig.luks.open.lock().unwrap().insert(ID.into());
        register(&state.db.lock().unwrap(), &row(rig, false, true));
        state
    }

    #[test]
    fn locking_unmounts_before_closing_and_records_the_lock() {
        let rig = rig();
        let state = state_with_unlocked_drive(&rig);
        lock_drive(&state, ID).unwrap();
        let after = db::get_drive(&state.db.lock().unwrap(), ID)
            .unwrap()
            .unwrap();
        assert!(after.locked);
        assert!(after.mount_point.is_empty());
        assert!(!rig.luks.is_open(ID));
        assert_eq!(rig.mounter.unmounts.lock().unwrap().len(), 1);
        assert!(
            !drive_is_locking(ID),
            "the gate opens again when it is done"
        );
    }

    #[test]
    fn a_busy_unmount_refuses_the_lock_and_keeps_the_container_open() {
        let rig = rig();
        let state = state_with_unlocked_drive(&rig);
        // Something has a file open from the drive for longer than the retries.
        *rig.mounter.busy_unmounts.lock().unwrap() = 1000;
        let err = lock_drive(&state, ID).unwrap_err();
        assert!(matches!(err, LockError::Busy(_)), "{err:?}");
        // Closing under a live mount would leave the kernel writing into an
        // unkeyed device.
        assert!(rig.luks.is_open(ID));
        assert_eq!(rig.luks.count("close"), 0);
        let after = db::get_drive(&state.db.lock().unwrap(), ID)
            .unwrap()
            .unwrap();
        assert!(!after.locked);
    }

    #[test]
    fn a_failed_close_puts_the_mount_back() {
        let rig = rig();
        let state = state_with_unlocked_drive(&rig);
        *rig.luks.fail_at.lock().unwrap() = Some("close");
        // The mock close fails without closing, so the container is still open.
        let err = lock_drive(&state, ID).unwrap_err();
        assert!(matches!(err, LockError::Other(_)));
        assert!(rig.luks.is_open(ID));
        assert!(rig.mounter.is_mounted(&rig.manager.adopted_mount_point(ID)));
        assert!(
            !db::get_drive(&state.db.lock().unwrap(), ID)
                .unwrap()
                .unwrap()
                .locked
        );
    }

    #[test]
    fn a_running_copy_refuses_the_lock_in_words_that_name_locking() {
        let rig = rig();
        let state = state_with_unlocked_drive(&rig);
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO jobs (id, kind, state, from_drive, created_at, updated_at) \
                 VALUES ('j1', 'copy', 'running', ?1, 0, 0)",
                [ID],
            )
            .unwrap();
        let err = lock_drive(&state, ID).unwrap_err();
        assert!(err.to_string().contains("try locking it again"), "{err}");
        assert!(rig.luks.is_open(ID));
        assert!(
            !db::get_drive(&state.db.lock().unwrap(), ID)
                .unwrap()
                .unwrap()
                .locked
        );
    }
}
