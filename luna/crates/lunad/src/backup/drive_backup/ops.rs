//! Lifecycle of a backup: deleting it, following moves and access changes,
//! rebuilding its row from the copies on a drive, and what people see.

use std::path::{Path, PathBuf};

use anyhow::Context;
use rusqlite::Connection;

use crate::backup::access_list::{self, AccessList};
use crate::backup::drive_store::{self, Store};
use crate::backup::status::{self, BackupState, Record};
use crate::db::{self, DriveRow, NewProtection, ProtectionRow};
use crate::drives::layout::Layout;

/// Meta key that remembers a backup deleted while its drive was unplugged.
fn deleted_key(id: &str) -> String {
    format!("deleted_backup:{id}")
}

/// The drive's mount point and layout, when the drive is really there.
fn connected(drive: &DriveRow) -> Option<(PathBuf, Layout)> {
    if drive.mount_point.is_empty() || drive.state == "missing" || drive.state == "ejected" {
        return None;
    }
    let root = PathBuf::from(&drive.mount_point);
    let layout = Layout::detect(&root)?;
    Some((root, layout))
}

/// Like [`connected`], looking the drive up by id first.
fn connected_target(conn: &Connection, drive_id: &str) -> Option<(PathBuf, Layout)> {
    let drive = db::get_drive(conn, drive_id).ok()??;
    connected(&drive)
}

pub(super) fn stop_reason(conn: &Connection, row: &ProtectionRow) -> Option<&'static str> {
    if row.private_owner.is_empty() {
        // A shared folder must not drift into a private item.
        let norm = crate::access::normalize_subject_path(&row.source_path);
        match access_list::private_source(conn, &row.source_drive, &norm) {
            access_list::PrivateSource::Shared => {}
            access_list::PrivateSource::OwnItem { .. } => {
                return Some("This folder is now a private item.");
            }
            access_list::PrivateSource::Inside => {
                return Some("This folder is now inside a private item.");
            }
        }
    } else if let Some(reason) = access_list::private_stop_reason(conn, row) {
        return Some(reason);
    }
    if row.source_drive == row.target_drive {
        Some("This folder is now on the backup drive itself.")
    } else {
        None
    }
}

/// Stops a backup whose source now sits somewhere a backup must not go.
fn check_stop(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    if row.state != "active" {
        return Ok(());
    }
    if let Some(reason) = stop_reason(conn, row) {
        db::set_protection_state(conn, &row.id, "stopped", reason)?;
    }
    Ok(())
}

/// Marks a store that is being removed. Its name starts with the backup's
/// id, so it is never mistaken for a backup: the manifest's id no longer
/// matches the folder name.
const TRASH_MARK: &str = ".deleting-";

/// Deletes a backup. Its copies on the backup drive are removed when the
/// drive is connected; otherwise they are removed the next time it is.
/// Refused while the backup is copying.
pub fn delete(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    // Held for the whole delete, so a run cannot start while the row goes.
    let Some(_slot) = crate::backup::drive_backup::try_hold(&row.id) else {
        anyhow::bail!("This backup is copying right now. Try again in a minute.");
    };
    db::delete_protection(conn, &row.id)?;
    // Recorded first, so a store left behind (drive absent, or removal
    // failing halfway) is cleaned up by `rebuild_from_manifests` later
    // instead of coming back as a backup.
    db::set_meta(conn, &deleted_key(&row.id), &db::now_unix().to_string())?;
    if let Some((root, layout)) = connected_target(conn, &row.target_drive)
        && let Some(store) = Store::existing(&root, &layout, &row.id)
    {
        retire_store(store.root())?;
    }
    Ok(())
}

/// Moves a store out of the backups folder under a new name, so it stops
/// being a backup at once, then removes it on a background thread. The
/// rename is quick, so this can run while the database lock is held.
fn retire_store(root: &Path) -> anyhow::Result<()> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let trash = root.with_file_name(format!("{name}{TRASH_MARK}{stamp}"));
    std::fs::rename(root, &trash)
        .context("Could not delete the backup's files on the backup drive.")?;
    std::thread::spawn(move || {
        if let Err(err) = std::fs::remove_dir_all(&trash) {
            tracing::warn!(error = %err, "could not finish deleting a backup's files");
        }
    });
    Ok(())
}

/// Removes folders left behind by a removal that was interrupted. Runs in
/// the background, and ignores what it cannot remove.
fn sweep_leftover_trash(dir: PathBuf) {
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().contains(TRASH_MARK) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// A folder moved or was renamed. Follows every backup of it (and of
/// anything inside it), then stops the ones that now sit somewhere they
/// must not. Never fails: errors are logged, because the move already
/// happened.
pub fn on_moved(
    conn: &Connection,
    from_drive: &str,
    old_path: &str,
    to_drive: &str,
    new_path: &str,
) {
    if let Err(err) = move_inner(conn, from_drive, old_path, to_drive, new_path) {
        tracing::warn!(error = %err, "could not update backups after a move");
    }
}

fn move_inner(
    conn: &Connection,
    from_drive: &str,
    old_path: &str,
    to_drive: &str,
    new_path: &str,
) -> anyhow::Result<()> {
    let old_norm = crate::access::normalize_subject_path(old_path);
    let moved_ids: Vec<String> = db::list_protections(conn)?
        .into_iter()
        .filter(|r| r.source_drive == from_drive)
        .filter(|r| {
            crate::access::path_contains(
                &old_norm,
                &crate::access::normalize_subject_path(&r.source_path),
            )
        })
        .map(|r| r.id)
        .collect();
    if moved_ids.is_empty() {
        return Ok(());
    }
    db::repath_protections_move(conn, from_drive, old_path, to_drive, new_path)?;
    for id in &moved_ids {
        let Some(row) = db::get_protection(conn, id)? else {
            continue;
        };
        // Keep the copy's own record of where its source is in step.
        if let Some((root, layout)) = connected_target(conn, &row.target_drive) {
            if let Some(store) = Store::existing(&root, &layout, &row.id) {
                if let Some(mut manifest) = store.read_manifest()? {
                    manifest.source_drive_id = row.source_drive.clone();
                    manifest.source_drive_label = db::get_drive(conn, &row.source_drive)?
                        .map(|d| d.label)
                        .unwrap_or_default();
                    manifest.source_path = row.source_path.clone();
                    store.write_manifest(&manifest)?;
                }
            }
        }
        check_stop(conn, &row)?;
    }
    Ok(())
}

/// Access to a folder changed. Re-saves the access list of every active
/// backup of that drive's folders, when it actually changed.
pub fn on_grants_changed(conn: &Connection, drive_id: &str) {
    let rows = match db::list_protections(conn) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(error = %err, "could not list backups after an access change");
            return;
        }
    };
    for row in rows
        .iter()
        .filter(|r| r.state == "active" && r.source_drive == drive_id)
    {
        if let Err(err) = refresh_access(conn, row) {
            tracing::warn!(error = %err, id = %row.id, "could not update a backup's access");
        }
    }
}

fn refresh_access(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<()> {
    let access = crate::backup::access_list::for_row(conn, row)?;
    let json = serde_json::to_string(&access)?;
    if json == row.access_json {
        return Ok(());
    }
    db::set_protection_access(conn, &row.id, &json)?;
    if let Some((root, layout)) = connected_target(conn, &row.target_drive) {
        if let Some(store) = Store::existing(&root, &layout, &row.id) {
            if let Some(mut manifest) = store.read_manifest()? {
                manifest.access = access;
                store.write_manifest(&manifest)?;
            }
        }
    }
    Ok(())
}

/// Rebuilds missing backup rows from the copies on connected drives, so a
/// lost database does not lose the backups. Copies of backups deleted while
/// their drive was away are removed instead. Returns how many rows came back.
pub fn rebuild_from_manifests(conn: &Connection) -> usize {
    let drives = match db::list_drives(conn) {
        Ok(drives) => drives,
        Err(err) => {
            tracing::warn!(error = %err, "could not list drives to rebuild backups");
            return 0;
        }
    };
    let mut inserted = 0;
    for drive in &drives {
        let Some((root, layout)) = connected(drive) else {
            continue;
        };
        let backups = layout.backups_dir(&root);
        std::thread::spawn(move || sweep_leftover_trash(backups));
        for store in drive_store::list_stores(&root, &layout) {
            match rebuild_one(conn, drive, &store) {
                Ok(true) => inserted += 1,
                Ok(false) => {}
                Err(err) => tracing::warn!(error = %err, "could not rebuild a backup"),
            }
        }
    }
    inserted
}

/// Rebuilds one store's row. Returns true when a row was inserted.
fn rebuild_one(conn: &Connection, drive: &DriveRow, store: &Store) -> anyhow::Result<bool> {
    let Some(manifest) = store.read_manifest()? else {
        return Ok(false);
    };
    let id = manifest.protection_id.clone();
    let dir_name = store
        .root()
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if id.is_empty() || id != dir_name {
        return Ok(false);
    }
    if db::get_meta(conn, &deleted_key(&id))?.is_some() {
        retire_store(store.root())?;
        return Ok(false);
    }
    if db::get_protection(conn, &id)?.is_some() {
        return Ok(false);
    }
    let source_known = db::get_drive(conn, &manifest.source_drive_id)?.is_some();
    let private_owner = manifest.private_owner.clone().unwrap_or_default();
    db::insert_protection(
        conn,
        &NewProtection {
            id: &id,
            kind: db::PROTECTION_DRIVE,
            source_drive: &manifest.source_drive_id,
            source_path: &manifest.source_path,
            target_drive: &drive.id,
            private_owner: &private_owner,
            created_by: &manifest.created_by,
            created_at: manifest.created_at,
        },
    )?;
    let access_json = serde_json::to_string(&manifest.access)?;
    db::set_protection_access(conn, &id, &access_json)?;
    if manifest.last_ok_at > 0 {
        db::record_protection_ok(conn, &id, manifest.last_ok_at, &access_json)?;
    }
    // An unknown source drive stays `active`: the run waits for the drive.
    if source_known && let Some(row) = db::get_protection(conn, &id)? {
        check_stop(conn, &row)?;
    }
    Ok(true)
}

/// What a person sees for a backup now. Stopped and source-gone backups
/// are final, not failures, so they never show as Stale.
pub fn state(row: &ProtectionRow, now: i64) -> BackupState {
    let rec = Record {
        last_ok_at: row.last_ok_at,
        failing_since: row.failing_since,
        last_error: &row.last_error,
        hard: row.hard,
        since: row.created_at,
    };
    match status::state(rec, now) {
        BackupState::Stale if row.state == "stopped" || row.state == "source_gone" => {
            BackupState::Ok
        }
        other => other,
    }
}

/// Whether `user` may see this backup: the members the access list names,
/// and admins when it allows them.
pub fn visible_to(row: &ProtectionRow, user: &crate::auth::CurrentUser) -> bool {
    let access: AccessList = if row.access_json.trim().is_empty() {
        AccessList::default()
    } else {
        serde_json::from_str(&row.access_json).unwrap_or_default()
    };
    access.allows(&user.id, user.role == "admin")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::drive_store::{MANIFEST_FORMAT, Manifest};
    use luna_core::marker::{Marker, pick_prefix};
    use std::collections::BTreeMap;
    use std::path::Path;

    const NOW: i64 = 1_800_000_000;

    fn new_drive(dir: &Path, conn: &Connection) -> (String, PathBuf, Layout) {
        let id = uuid::Uuid::new_v4().to_string();
        let root = dir.join(&id);
        std::fs::create_dir_all(&root).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(&root, &Marker::new(id.clone(), "Test"), &prefix)
                .unwrap(),
        );
        db::upsert_drive(
            conn,
            &id,
            "Test",
            "as_is",
            "ext4",
            &id,
            root.to_str().unwrap(),
        )
        .unwrap();
        let layout = Layout::detect(&root).unwrap();
        (id, root, layout)
    }

    fn protect(conn: &Connection, src: &str, path: &str, target: &str) -> ProtectionRow {
        let id = uuid::Uuid::new_v4().to_string();
        db::insert_protection(
            conn,
            &NewProtection {
                id: &id,
                kind: db::PROTECTION_DRIVE,
                source_drive: src,
                source_path: &crate::access::normalize_subject_path(path),
                target_drive: target,
                private_owner: "",
                created_by: "u1",
                created_at: NOW - 100,
            },
        )
        .unwrap()
    }

    fn manifest(id: &str, src: &str, path: &str, last_ok_at: i64) -> Manifest {
        Manifest {
            format: MANIFEST_FORMAT,
            protection_id: id.into(),
            luna_id: None,
            source_drive_id: src.into(),
            source_drive_label: "Source".into(),
            source_path: path.into(),
            private_owner: None,
            created_by: "u1".into(),
            created_at: NOW - 100,
            access: AccessList {
                users: vec!["u2".into()],
                admins: true,
            },
            last_ok_at,
            deleted: BTreeMap::new(),
            paused_secs: 0,
            paused_since: 0,
        }
    }

    fn user(id: &str, role: &str) -> crate::auth::CurrentUser {
        crate::auth::CurrentUser {
            id: id.into(),
            username: id.into(),
            role: role.into(),
        }
    }

    #[test]
    fn stop_reason_on_own_target() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (drive, _, _) = new_drive(dir.path(), &conn);
        let (other, _, _) = new_drive(dir.path(), &conn);
        let same = protect(&conn, &drive, "/Photos", &drive);
        let fine = protect(&conn, &drive, "/Photos", &other);
        assert_eq!(
            stop_reason(&conn, &same),
            Some("This folder is now on the backup drive itself.")
        );
        assert_eq!(stop_reason(&conn, &fine), None);
    }

    #[test]
    fn on_moved_follows_rename_and_cross_drive_move() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let (other, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", &target);

        on_moved(&conn, &src, "/Photos", &src, "/Pictures");
        let renamed = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(renamed.source_drive, src);
        assert!(
            renamed.source_path.ends_with("Pictures"),
            "{}",
            renamed.source_path
        );
        assert_eq!(renamed.state, "active");

        on_moved(&conn, &src, "/Pictures", &other, "/Moved");
        let moved = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(moved.source_drive, other);
        assert_eq!(moved.state, "active");
    }

    #[test]
    fn on_moved_stops_backup_moved_onto_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Data", &target);
        on_moved(&conn, &src, "/Data", &target, "/Stuff");
        let after = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(after.state, "stopped");
        assert_eq!(
            after.stop_reason,
            "This folder is now on the backup drive itself."
        );
    }

    #[test]
    fn on_grants_changed_resaves_access() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", &target);
        db::set_protection_access(&conn, &row.id, "stale").unwrap();
        on_grants_changed(&conn, &src);
        let after = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_ne!(after.access_json, "stale");
        assert!(serde_json::from_str::<AccessList>(&after.access_json).is_ok());
    }

    #[test]
    fn delete_removes_store_when_target_connected() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, root, layout) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", &target);
        let store = Store::open(&root, &layout, &row.id).unwrap();
        let store_dir = store.root().to_path_buf();
        delete(&conn, &row).unwrap();
        assert!(!store_dir.exists());
        assert!(db::get_protection(&conn, &row.id).unwrap().is_none());
        assert!(
            db::get_meta(&conn, &deleted_key(&row.id))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn delete_records_tombstone_when_target_absent() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", "unplugged-drive");
        delete(&conn, &row).unwrap();
        assert!(db::get_protection(&conn, &row.id).unwrap().is_none());
        assert!(
            db::get_meta(&conn, &deleted_key(&row.id))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn delete_refused_while_backup_is_copying() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, root, layout) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", &target);
        let store = Store::open(&root, &layout, &row.id).unwrap();
        let _run = crate::backup::drive_backup::RunSlot::take(&row.id).unwrap();

        let err = delete(&conn, &row).unwrap_err();
        assert_eq!(
            err.to_string(),
            "This backup is copying right now. Try again in a minute."
        );
        assert!(store.root().exists());
        assert!(db::get_protection(&conn, &row.id).unwrap().is_some());
        assert!(
            db::get_meta(&conn, &deleted_key(&row.id))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rebuild_with_unknown_source_drive_stays_active() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (target, root, layout) = new_drive(dir.path(), &conn);
        let id = uuid::Uuid::new_v4().to_string();
        let store = Store::open(&root, &layout, &id).unwrap();
        store
            .write_manifest(&manifest(&id, "drive-not-here", "/Photos", NOW - 5))
            .unwrap();

        assert_eq!(rebuild_from_manifests(&conn), 1);
        let back = db::get_protection(&conn, &id).unwrap().unwrap();
        assert_eq!(back.target_drive, target);
        assert_eq!(back.state, "active");
    }

    #[test]
    fn rebuild_recreates_rows_and_skips_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, root, layout) = new_drive(dir.path(), &conn);

        let live = uuid::Uuid::new_v4().to_string();
        let store = Store::open(&root, &layout, &live).unwrap();
        store
            .write_manifest(&manifest(&live, &src, "/Photos", NOW - 5))
            .unwrap();

        let dead = uuid::Uuid::new_v4().to_string();
        let dead_store = Store::open(&root, &layout, &dead).unwrap();
        dead_store
            .write_manifest(&manifest(&dead, &src, "/Old", NOW - 5))
            .unwrap();
        db::set_meta(&conn, &deleted_key(&dead), &NOW.to_string()).unwrap();

        assert_eq!(rebuild_from_manifests(&conn), 1);
        let back = db::get_protection(&conn, &live).unwrap().unwrap();
        assert_eq!(back.target_drive, target);
        assert_eq!(back.source_path, "/Photos");
        assert_eq!(back.state, "active");
        assert!(db::get_protection(&conn, &dead).unwrap().is_none());
        assert!(!dead_store.root().exists());
        assert_eq!(rebuild_from_manifests(&conn), 0);
    }

    #[test]
    fn state_ok_failing_and_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);

        let row = protect(&conn, &src, "/Photos", &target);
        db::record_protection_ok(&conn, &row.id, NOW, "").unwrap();
        let ok = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(state(&ok, NOW), BackupState::Ok);

        db::record_protection_error(&conn, &row.id, "The drive is full.", true, NOW).unwrap();
        let failing = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(state(&failing, NOW), BackupState::Failing);

        let stopped = protect(&conn, &src, "/Old", &target);
        db::set_protection_state(&conn, &stopped.id, "stopped", "Stopped.").unwrap();
        let stopped = db::get_protection(&conn, &stopped.id).unwrap().unwrap();
        assert_eq!(state(&stopped, NOW + 10 * 86_400), BackupState::Ok);
    }

    #[test]
    fn visible_to_member_admin_and_stranger() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, _, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Photos", &target);
        let access = AccessList {
            users: vec!["member".into()],
            admins: true,
        };
        db::set_protection_access(&conn, &row.id, &serde_json::to_string(&access).unwrap())
            .unwrap();
        let row = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert!(visible_to(&row, &user("member", "user")));
        assert!(visible_to(&row, &user("boss", "admin")));
        assert!(!visible_to(&row, &user("stranger", "user")));
    }

    fn protect_private(
        conn: &Connection,
        src: &str,
        path: &str,
        target: &str,
        owner: &str,
    ) -> ProtectionRow {
        let id = uuid::Uuid::new_v4().to_string();
        db::insert_protection(
            conn,
            &NewProtection {
                id: &id,
                kind: db::PROTECTION_DRIVE,
                source_drive: src,
                source_path: &crate::access::normalize_subject_path(path),
                target_drive: target,
                private_owner: owner,
                created_by: "u1",
                created_at: NOW - 100,
            },
        )
        .unwrap()
    }

    #[test]
    fn stop_reason_when_private_item_changes_owner() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        crate::private::create(&root, "Docs", "u1").unwrap();
        let row = protect_private(&conn, &src, "Docs", &target, "u1");
        assert_eq!(stop_reason(&conn, &row), None);
        crate::private::remove(&root, "Docs").unwrap();
        crate::private::create(&root, "Docs", "u2").unwrap();
        assert_eq!(
            stop_reason(&conn, &row),
            Some("This folder now belongs to someone else.")
        );
    }

    #[test]
    fn stop_reason_when_shared_folder_becomes_private() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Docs", &target);
        assert_eq!(stop_reason(&conn, &row), None);
        crate::private::create(&root, "Docs", "u1").unwrap();
        assert_eq!(
            stop_reason(&conn, &row),
            Some("This folder is now a private item.")
        );
    }

    #[test]
    fn stop_reason_when_shared_folder_goes_inside_private_item() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        let row = protect(&conn, &src, "/Docs/Sub", &target);
        assert_eq!(stop_reason(&conn, &row), None);
        crate::private::create(&root, "Docs", "u1").unwrap();
        assert_eq!(
            stop_reason(&conn, &row),
            Some("This folder is now inside a private item.")
        );
    }

    #[test]
    fn stop_reason_none_for_private_item_still_owned_by_same_user() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        crate::private::create(&root, "Docs", "u1").unwrap();
        let row = protect_private(&conn, &src, "Docs", &target, "u1");
        assert_eq!(stop_reason(&conn, &row), None);
    }

    #[test]
    fn renaming_the_private_item_keeps_its_backup() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        crate::private::create(&root, "Docs", "u1").unwrap();
        let row = protect_private(&conn, &src, "Docs", &target, "u1");
        crate::private::repath(&root, "Docs", "Papers").unwrap();
        on_moved(&conn, &src, "Docs", &src, "Papers");
        let after = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(after.state, "active", "{}", after.stop_reason);
        assert!(after.source_path.ends_with("Papers"), "{}", after.source_path);
        assert_eq!(after.private_owner, "u1");
        assert_eq!(stop_reason(&conn, &after), None);
    }

    #[test]
    fn private_backup_stops_when_moved_inside_another_private_item() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (src, root, _) = new_drive(dir.path(), &conn);
        let (target, _, _) = new_drive(dir.path(), &conn);
        crate::private::create(&root, "Vault", "u1").unwrap();
        crate::private::create(&root, "Docs", "u1").unwrap();
        let row = protect_private(&conn, &src, "Docs", &target, "u1");
        on_moved(&conn, &src, "Docs", &src, "Vault/Docs");
        let after = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(after.state, "stopped");
        assert_eq!(
            after.stop_reason,
            "This private item is now inside another private item."
        );
    }
}
