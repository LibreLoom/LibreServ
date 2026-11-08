//! Registration and lifecycle boundaries shared by durable format operations.
//! These blocking helpers run while the worker owns the drive mutation lock
//! and its closing guard. They never decide which disk may be erased.

use std::path::Path;

use anyhow::{Context, bail};
use luna_core::marker::{self, Marker};
use rusqlite::{Connection, params};

use super::format::{Filesystem, device_path};
use super::{DriveManager, drive_db};
use crate::{AppState, db};

fn registered_mount_live(state: &AppState, drive: &db::DriveRow) -> bool {
    if drive.mount_point.is_empty() {
        return false;
    }
    state
        .drive_manager
        .mounter()
        .is_mounted(Path::new(&drive.mount_point))
        || crate::dev_mock::scan_mock_drives().iter().any(|mock| {
            mock.name == drive.device
                && mock.mount_point.as_deref() == Some(drive.mount_point.as_str())
        })
}

/// Holds backup exclusions and the RAM-cache closing state through formatting.
pub struct QuiescedDrive {
    state: AppState,
    id: String,
    _backups: Vec<crate::backup::drive_backup::RunSlot>,
    _cloud: Vec<crate::backup::cloud::run::RunSlot>,
}

impl Drop for QuiescedDrive {
    fn drop(&mut self) {
        self.state.ram_cache.end_close(&self.id);
    }
}

/// Refuse active work, flush pending saves, then stop indexing. New file work
/// must already be blocked by the durable operation's `converting` flag.
pub fn quiesce_for_format(state: &AppState, id: &str) -> anyhow::Result<QuiescedDrive> {
    if state.collab.drive_is_active(id) || state.office_docs.drive_is_active(id) {
        bail!("Close documents open from this drive, then try formatting again.");
    }
    let (drive, protections) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive settings are busy."))?;
        let drive = db::get_drive(&conn, id)?.context("Luna doesn't know this drive.")?;
        if !drive.mount_point.is_empty()
            && state
                .drive_manager
                .is_system_mount(Path::new(&drive.mount_point))
        {
            bail!("Luna can't format a drive mounted as part of its operating system.");
        }
        let working: i64 = conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE state IN ('running', 'queued') \
             AND (from_drive = ?1 OR to_drive = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if working != 0 {
            bail!(
                "Wait for copies and moves using this drive to finish, then try formatting again."
            );
        }
        let protections = db::list_protections(&conn)?
            .into_iter()
            .filter(|row| row.source_drive == id || row.target_drive == id)
            .collect::<Vec<_>>();
        (drive, protections)
    };
    let mut backups = Vec::new();
    let mut cloud = Vec::new();
    for protection in protections {
        backups.push(
            crate::backup::drive_backup::try_hold(&state.db, &protection.id).context(
                "Wait for backups using this drive to finish, then try formatting again.",
            )?,
        );
        cloud.push(
            crate::backup::cloud::run::RunSlot::take(&state.db, &protection.id).context(
                "Wait for cloud backups using this drive to finish, then try formatting again.",
            )?,
        );
    }
    state.ram_cache.begin_close(id);
    let guard = QuiescedDrive {
        state: state.clone(),
        id: id.to_string(),
        _backups: backups,
        _cloud: cloud,
    };
    if !state.ram_cache.dirty_rels_for_drive(id).is_empty() && !registered_mount_live(state, &drive)
    {
        bail!(
            "Luna still has unsaved files for this drive. Reconnect it and let those saves finish before formatting."
        );
    }
    if !drive.mount_point.is_empty() {
        state
            .ram_cache
            .flush_drive_dirty(id, Path::new(&drive.mount_point))?;
        crate::private::forget(Path::new(&drive.mount_point));
    }
    state.search_index.unwatch_mount(id);
    state.gallery.unwatch_mount(id);
    if !drive.mount_point.is_empty() {
        let target = Path::new(&drive.mount_point);
        if state.drive_manager.mounter().is_mounted(target) {
            state
                .drive_manager
                .mounter()
                .unmount(target)
                .map_err(|error| {
                    if super::mount::is_busy(&error) {
                        anyhow::anyhow!(
                            "Close files open from this drive, then try formatting again."
                        )
                    } else {
                        anyhow::anyhow!(
                            "Luna couldn't unmount this drive. Nothing has been erased."
                        )
                    }
                })?;
        }
    }
    Ok(guard)
}

/// Re-arm only a verified usable mount. A destructive failure keeps the drive
/// gated; a pre-write failure may restore its previous usable mount.
pub fn finish_format(state: &AppState, id: &str, success: bool) -> anyhow::Result<()> {
    let (drive, pre_write_failure) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive settings are busy."))?;
        let pre_write_failure: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE rowid = \
             (SELECT MAX(rowid) FROM drive_format_operations WHERE drive_id = ?1) \
             AND destructive_started = 0)",
            [id],
            |row| row.get(0),
        )?;
        (db::get_drive(&conn, id)?, pre_write_failure)
    };
    if success
        && !drive.as_ref().is_some_and(|drive| {
            !drive.locked
                && matches!(drive.state.as_str(), "as_is" | "readonly")
                && registered_mount_live(state, drive)
        })
    {
        bail!("The filesystem was created, but Luna couldn't verify that this drive is ready.");
    }
    // In particular, a failed flush must leave its pending saves recoverable.
    if success {
        state.ram_cache.drop_drive(id);
    }
    if let Some(ref drive) = drive
        && !success
        && !registered_mount_live(state, drive)
    {
        state.drive_manager.luks().close(id)?;
        let conn = state
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive settings are busy."))?;
        db::set_drive_mount_point(&conn, id, "")?;
        if drive.encrypted {
            db::set_drive_locked(&conn, id, true)?;
        }
        return Ok(());
    }
    if let Some(drive) = drive
        && !drive.locked
        && (!drive.converting || success || pre_write_failure)
        && !drive.mount_point.is_empty()
        && matches!(drive.state.as_str(), "as_is" | "readonly")
        && registered_mount_live(state, &drive)
    {
        let root = Path::new(&drive.mount_point);
        let markers = marker::read_markers(root)?;
        if !markers.iter().any(|(_, found)| found.id == id) {
            bail!("Luna couldn't verify this drive after formatting.");
        }
        state.search_index.watch_mount(id, root.to_path_buf());
        state.gallery.watch_mount(id, root.to_path_buf());
    }
    Ok(())
}

/// A format starts a new content generation. Keep explicit whole-drive member
/// access, revoke file/folder and album grants, revoke all public links, and
/// stop backup rules without deleting cloud snapshots or copies on other drives.
pub fn invalidate_formatted_contents(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM access_members WHERE drive_id = ?1 \
        AND NOT (subject_kind = 'path' AND path = '' AND album_id = '')",
        [id],
    )?;
    tx.execute("DELETE FROM access_links WHERE drive_id = ?1", [id])?;
    tx.execute(
        "UPDATE protections SET state = 'stopped', stop_reason = ?2, \
        last_error = ?2 WHERE source_drive = ?1 OR target_drive = ?1",
        params![
            id,
            "This drive was formatted. Set up this backup again before copying new files."
        ],
    )?;
    tx.execute(
        "UPDATE protections SET last_ok_at = 0, first_done = 0 \
        WHERE kind = 'drive' AND target_drive = ?1",
        [id],
    )?;
    for (table, sql) in [
        (
            "user_recents",
            "DELETE FROM user_recents WHERE drive_id = ?1",
        ),
        (
            "path_moves",
            "DELETE FROM path_moves WHERE drive_id = ?1 OR new_drive = ?1",
        ),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if exists {
            tx.execute(sql, [id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

impl DriveManager {
    /// Mount exactly the new partition (or its mapping), recreate the identity,
    /// and register only after verifying the mounted marker. No formatting here.
    #[allow(clippy::too_many_arguments)]
    pub fn register_formatted(
        &self,
        conn: &Connection,
        disk: &str,
        partition: &str,
        drive_id: Option<&str>,
        label: &str,
        filesystem: Filesystem,
        encrypted: bool,
        password: &str,
    ) -> anyhow::Result<db::DriveRow> {
        if encrypted && filesystem != Filesystem::Ext4 {
            bail!("Luna can't use that filesystem inside an encrypted drive.");
        }
        self.forget_marker_memo();
        let id = drive_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mock = crate::dev_mock::scan_mock_drives()
            .into_iter()
            .find(|drive| drive.name == disk);
        if mock.is_some() && encrypted {
            bail!("Directory mock drives do not support encryption.");
        }
        let target = if let Some(mock) = &mock {
            let root = std::fs::canonicalize(
                mock.mount_point
                    .as_deref()
                    .context("The mock drive is disconnected.")?,
            )?;
            let parent = std::fs::canonicalize(crate::dev_mock::mock_drives_path())?;
            if root.parent() != Some(parent.as_path()) {
                bail!("The mock drive is outside its storage folder.");
            }
            root
        } else {
            self.adopted_mount_point(&id)
        };
        if mock.is_none() && self.mounter.is_mounted(&target) {
            bail!("This drive is still mounted. Luna couldn't finish formatting it.");
        }
        std::fs::create_dir_all(&target)?;
        let source = if encrypted {
            self.luks.open(&device_path(partition), &id, password)?;
            super::luks::mapper_path(&id).to_string_lossy().into_owned()
        } else {
            device_path(partition)
        };
        let result = (|| -> anyhow::Result<db::DriveRow> {
            if mock.is_none() {
                self.mounter
                    .mount_typed(&source, &target, false, Some(filesystem.as_str()))?;
            }
            if mock.is_none() && !self.mounter.is_mounted(&target) {
                bail!("Luna couldn't verify that the formatted drive is mounted.");
            }
            let prefix = marker::pick_prefix(&target)?;
            let identity = Marker::new(&id, label);
            drop(drive_db::create(&target, &identity, &prefix)?);
            if !marker::read_markers(&target)?
                .iter()
                .any(|(_, found)| *found == identity)
            {
                bail!("Luna couldn't verify this drive's name and identity after formatting.");
            }
            // These recovery files belong to the new content generation too.
            if let Some(cloud) = crate::backup::cloud::identity::load(conn)? {
                crate::backup::cloud::identity::copy_to_drive_at(&target, &cloud, db::now_unix())?;
            }
            super::sync_filesystem(&target)?;
            let tx = conn.unchecked_transaction()?;
            db::upsert_drive(
                &tx,
                &id,
                label,
                "as_is",
                filesystem.as_str(),
                disk,
                &target.to_string_lossy(),
            )?;
            db::set_drive_encrypted(&tx, &id, encrypted)?;
            db::set_drive_locked(&tx, &id, false)?;
            db::set_drive_mount_point(&tx, &id, &target.to_string_lossy())?;
            // Registration is not the operation's success boundary. Keep new
            // content gated until its durable success is published atomically.
            db::set_drive_converting(&tx, &id, true)?;
            let row = db::get_drive(&tx, &id)?
                .context("Luna couldn't read this drive's new settings.")?;
            tx.commit()?;
            Ok(row)
        })();
        if result.is_err() && mock.is_none() {
            let unmounted = self.mounter.unmount(&target).is_ok();
            if encrypted && unmounted {
                let _ = self.luks.close(&id);
            }
            if unmounted {
                let _ = std::fs::remove_dir(&target);
            }
        }
        result
    }
}

/// A daemon restart is not a power cycle: a valid mounted mapper can survive.
/// Interrupted destructive operations stay gated until an explicit new review.
pub fn startup(conn: &Connection, manager: &DriveManager) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE drive_format_operations SET state = 'interrupted', error = ?1 \
        WHERE state IN ('queued', 'running')",
        ["Luna restarted before formatting finished. Review the drive before formatting again."],
    )?;
    for drive in db::list_drives(conn)? {
        let blocked: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE rowid = \
             (SELECT MAX(rowid) FROM drive_format_operations WHERE drive_id = ?1) \
             AND destructive_started = 1 AND state IN ('failed', 'interrupted'))",
            [&drive.id],
            |row| row.get(0),
        )?;
        db::set_drive_converting(conn, &drive.id, blocked)?;
        if blocked {
            continue;
        }
        if drive.encrypted {
            let target = manager.adopted_mount_point(&drive.id);
            let open = manager.luks.is_open(&drive.id);
            let mounted = manager.mounter.is_mounted(&target);
            let valid = open
                && mounted
                && marker::read_markers(&target)
                    .is_ok_and(|markers| markers.iter().any(|(_, found)| found.id == drive.id));
            if valid {
                db::set_drive_locked(conn, &drive.id, false)?;
                db::set_drive_mount_point(conn, &drive.id, &target.to_string_lossy())?;
            } else {
                if mounted {
                    // A mounted filesystem with an unverified identity is
                    // unavailable, never evidence that its key is gone.
                    db::set_drive_converting(conn, &drive.id, true)?;
                    continue;
                }
                if open {
                    manager.luks.close(&drive.id)?;
                }
                db::set_drive_locked(conn, &drive.id, true)?;
            }
        }
    }
    Ok(())
}
