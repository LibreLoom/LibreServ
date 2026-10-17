//! Drive backups: one protected folder or drive copied onto another drive
//! (plan §2-§4). Storage lives in [`super::drive_store`], what gets copied in
//! [`super::scope`], who may see it in [`super::access_list`].

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use rusqlite::Connection;

use super::{access_list, albums_export, drive_store, scope, status};
use crate::db::{self, ProtectionRow};
use crate::drives::drive_db;
use crate::drives::layout::Layout;
use crate::files;

mod ops;
pub use ops::{delete, on_grants_changed, on_moved, rebuild_from_manifests, state, visible_to};

/// Fewer deletions than this never trip the mass-delete guard.
const MASS_DELETE_MIN: usize = 20;

/// What one run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOutcome {
    pub copied: u64,
    pub unchanged: u64,
    pub removed: u64,
    /// Files that couldn't go onto the target as they are (case clash on
    /// exFAT/FAT, too large for FAT), named in plain words.
    pub notes: Vec<String>,
    /// Why this run did not complete a good copy, in plain words. None when
    /// the copy finished.
    pub problem: Option<String>,
}

/// An outcome for a run that copied nothing, with the reason in plain words.
fn problem_outcome(message: &str) -> RunOutcome {
    RunOutcome {
        problem: Some(message.to_string()),
        ..RunOutcome::default()
    }
}

/// Why a create request was refused, in words a person can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

/// Start a drive backup of `source_path` on `source_drive` onto
/// `target_drive` for `user`. Permission rules (plan §2): Read on the source,
/// Write on the target drive, Admin for a whole drive; never a source inside
/// a private item (phase 4), never onto its own drive. One backup per object
/// per destination: an existing one is returned as is.
pub fn create(
    conn: &Connection,
    user: &crate::auth::CurrentUser,
    source_drive: &str,
    source_path: &str,
    target_drive: &str,
) -> Result<ProtectionRow, Refused> {
    use crate::access::{CAP_EDIT, CAP_VIEW};

    let refuse = |msg: String| Refused(msg);
    let db_refused = || Refused("Luna couldn't save this backup. Try again.".to_string());
    let norm = crate::access::normalize_subject_path(source_path);

    if norm.is_empty() && user.role != "admin" {
        return Err(refuse("Only an Admin can back up a whole drive.".into()));
    }
    if !crate::auth::has_cap(user, conn, source_drive, &norm, CAP_VIEW) {
        return Err(refuse(
            "You need Read access to this folder to back it up.".into(),
        ));
    }
    if !crate::auth::has_cap(user, conn, target_drive, "", CAP_EDIT) {
        return Err(refuse(
            "You need Write access to the backup drive to back up to it.".into(),
        ));
    }
    if source_drive == target_drive {
        return Err(refuse(
            "A backup has to go on a different drive from the folder it copies.".into(),
        ));
    }
    if crate::auth::inside_private(conn, source_drive, &norm) {
        return Err(refuse(
            "Private items are backed up from their own shield by their owner.".into(),
        ));
    }

    let source_label = drive_label(conn, source_drive);
    let folder = folder_name(&norm, &source_label);
    if files::drive_root(conn, source_drive).is_err() {
        return Err(refuse(format!(
            "Connect {source_label} first, then try again."
        )));
    }
    let meta = match files::resolve_any(conn, source_drive, &norm) {
        Ok((_, meta)) => meta,
        Err(_) => {
            return Err(refuse(format!(
                "Luna can't find \"{folder}\" on {source_label}."
            )));
        }
    };
    if !meta.is_dir() {
        return Err(refuse(
            "Only folders and whole drives can be backed up.".into(),
        ));
    }
    match connected(conn, target_drive) {
        Some(_) => {}
        None => {
            let target_label = drive_label(conn, target_drive);
            return Err(refuse(format!(
                "Connect {target_label} first, then try again."
            )));
        }
    }

    if let Some(existing) = db::find_protection(
        conn,
        db::PROTECTION_DRIVE,
        source_drive,
        &norm,
        target_drive,
    )
    .map_err(|_| db_refused())?
    {
        // The folder exists (checked above), so a backup that was waiting on
        // it runs again.
        if existing.state == db::PROTECTION_SOURCE_GONE {
            db::set_protection_state(conn, &existing.id, db::PROTECTION_ACTIVE, "")
                .map_err(|_| db_refused())?;
            return db::get_protection(conn, &existing.id)
                .ok()
                .flatten()
                .ok_or_else(db_refused);
        }
        return Ok(existing);
    }

    let access = access_list::for_source(conn, source_drive, &norm).map_err(|_| db_refused())?;
    let access_json = serde_json::to_string(&access).map_err(|_| db_refused())?;
    let id = uuid::Uuid::new_v4().to_string();
    db::insert_protection(
        conn,
        &db::NewProtection {
            id: &id,
            kind: db::PROTECTION_DRIVE,
            source_drive,
            source_path: &norm,
            target_drive,
            private_owner: "",
            created_by: &user.id,
            created_at: db::now_unix(),
        },
    )
    .map_err(|_| db_refused())?;
    db::set_protection_access(conn, &id, &access_json).map_err(|_| db_refused())?;
    db::get_protection(conn, &id)
        .ok()
        .flatten()
        .ok_or_else(db_refused)
}

/// Run one drive backup now. Records the result on the row (ok / error /
/// stopped / source gone) and returns what happened.
pub fn run(db: &crate::Db, id: &str, now: i64) -> anyhow::Result<RunOutcome> {
    run_inner(db, id, now, false)
}

/// Like [`run`], but applies deletions even when most of the source seems
/// gone (the person pressed "Run anyway" after the mass-delete guard).
pub fn run_allowing_mass_delete(db: &crate::Db, id: &str, now: i64) -> anyhow::Result<RunOutcome> {
    run_inner(db, id, now, true)
}

/// Run every active drive backup. True when any backup's state changed (so
/// the health cache must be refreshed).
pub fn run_all(db: &crate::Db, now: i64) -> bool {
    let rows = match with_conn(db, |c| db::list_protections(c)) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "could not list drive backups");
            return false;
        }
    };
    let mut changed = false;
    for row in rows
        .iter()
        .filter(|r| {
            r.kind == db::PROTECTION_DRIVE
                && matches!(r.state.as_str(), db::PROTECTION_ACTIVE | db::PROTECTION_SOURCE_GONE)
        })
    {
        let before = (row.state.clone(), backup_state(row, now));
        if let Err(e) = run(db, &row.id, now) {
            tracing::warn!(error = %e, id = %row.id, "drive backup run failed");
        }
        let after = match with_conn(db, |c| db::get_protection(c, &row.id)) {
            Ok(Some(after)) => after,
            _ => continue,
        };
        if after.state != before.0 || backup_state(&after, now) != before.1 {
            changed = true;
        }
    }
    changed
}

/// Backups being copied right now. Two runs of one backup at once (the
/// schedule and "Back up now") would both move files into `versions/`.
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Holds a backup's place in [`RUNNING`] until it is dropped. A run holds
/// one while it copies; a restore or delete holds one so no run starts
/// meanwhile.
pub struct RunSlot(String);

impl RunSlot {
    fn take(id: &str) -> Option<Self> {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        running.insert(id.to_string()).then(|| Self(id.to_string()))
    }
}

/// Holds the backup's slot, or returns `None` when a run or another holder
/// already has it. While the slot is held, [`run`] refuses and
/// [`is_running`] reports true.
pub fn try_hold(id: &str) -> Option<RunSlot> {
    RunSlot::take(id)
}

impl Drop for RunSlot {
    fn drop(&mut self) {
        RUNNING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

/// Is this backup being copied right now, or held by a restore or delete?
pub fn is_running(id: &str) -> bool {
    RUNNING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(id)
}

fn run_inner(
    db: &crate::Db,
    id: &str,
    now: i64,
    allow_mass_delete: bool,
) -> anyhow::Result<RunOutcome> {
    // Already running: that run records its own result.
    let Some(_slot) = RunSlot::take(id) else {
        return Ok(problem_outcome(
            "This backup is already running. Its status updates when it finishes.",
        ));
    };
    let Some(row) = with_conn(db, |c| db::get_protection(c, id))? else {
        return Ok(problem_outcome("This backup no longer exists."));
    };
    if row.kind != db::PROTECTION_DRIVE {
        return Ok(problem_outcome("This isn't a folder backup."));
    }
    // A stopped backup stays stopped until its folder is set up again. Only
    // a backup whose folder was gone may run again (step 4 revives it).
    if !matches!(
        row.state.as_str(),
        db::PROTECTION_ACTIVE | db::PROTECTION_SOURCE_GONE
    ) {
        let reason = if row.stop_reason.is_empty() {
            "This backup is stopped."
        } else {
            row.stop_reason.as_str()
        };
        return Ok(problem_outcome(reason));
    }

    // Step 2: the backup drive must be connected.
    let Some(target) = with_conn(db, |c| connected(c, &row.target_drive)) else {
        let name = with_conn(db, |c| drive_label(c, &row.target_drive));
        return fail(
            db,
            id,
            &format!("Waiting: {name} isn't connected."),
            false,
            now,
        );
    };

    // Step 3: the source drive must be connected. Its folder can't be read,
    // so the deleted-files clock freezes until it is back.
    let Some(source) = with_conn(db, |c| connected(c, &row.source_drive)) else {
        pause_clock(&target, id, now);
        let name = with_conn(db, |c| drive_label(c, &row.source_drive));
        return fail(
            db,
            id,
            &format!("Waiting: {name} isn't connected."),
            false,
            now,
        );
    };

    // Step 4: the folder itself must still be there.
    let folder = folder_name(&row.source_path, &source.label);
    let abs = match with_conn(db, |c| {
        files::resolve_any(c, &row.source_drive, &row.source_path)
    }) {
        Ok((abs, _)) => abs,
        Err(e) if is_not_found(&e) => return source_gone(db, &row, &target, now),
        Err(_) => {
            pause_clock(&target, id, now);
            return fail(
                db,
                id,
                &format!("Luna couldn't read {folder} on {}.", source.label),
                false,
                now,
            );
        }
    };
    // The folder is back (restored from the trash, say): a backup that was
    // waiting on it runs again.
    if row.state == db::PROTECTION_SOURCE_GONE {
        with_conn(db, |c| {
            db::set_protection_state(c, id, db::PROTECTION_ACTIVE, "")
        })?;
    }

    // Step 5: the folder moved somewhere a backup can't follow.
    if let Some(reason) = with_conn(db, |c| ops::stop_reason(c, &row)) {
        with_conn(db, |c| {
            db::set_protection_state(c, id, db::PROTECTION_STOPPED, reason)
        })?;
        return Ok(problem_outcome(reason));
    }

    // Step 6: read the folder. Walking it is the first step that can fail
    // because of the source, so a failure here also freezes the clock.
    let walked = match scope::walk(&abs) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return source_gone(db, &row, &target, now);
        }
        Err(_) => {
            pause_clock(&target, id, now);
            return fail(
                db,
                id,
                &format!("Luna couldn't read {folder} on {}.", source.label),
                false,
                now,
            );
        }
    };
    // The album list is read here, under the same lock as the access list.
    let (access, albums) = with_conn(db, |c| {
        let access = access_list::for_source(c, &row.source_drive, &row.source_path);
        (access, source_albums(c, &row, &source.root))
    });
    let access = access?;

    // Steps 6-9 touch the backup drive; the database lock is not held here.
    let target_name = target.label.clone();
    match sync_target(
        &target,
        &row,
        &source.label,
        walked,
        &access,
        allow_mass_delete,
        now,
    ) {
        Ok(None) => fail(
            db,
            id,
            &format!(
                "Most of {folder} seems to be gone, so Luna paused this backup to keep the copies. Check the drive, then run the backup again."
            ),
            true,
            now,
        ),
        Ok(Some(mut outcome)) => {
            // The files are safe at this point, so a problem with the album
            // list is only a note.
            if let Err(e) = albums.and_then(|list| save_albums(&target, &row.id, &list)) {
                tracing::warn!(error = %e, id, "drive backup could not save the album list");
                outcome.notes.push(format!(
                    "Luna couldn't update the album list in this backup on {target_name}. Your files are backed up."
                ));
            }
            #[cfg(test)]
            {
                let hook = BEFORE_RECORD.with(|h| h.borrow_mut().take());
                if let Some(hook) = hook {
                    hook(db);
                }
            }
            // A revoke or a move during the run has already changed the row
            // and, through the grant or move code, possibly the manifest. Read
            // the row again under the lock. When it no longer matches what this
            // run copied, keep its current values and fix the manifest.
            let Some((fresh, fresh_access)) = with_conn(db, |c| -> anyhow::Result<_> {
                let Some(fresh) = db::get_protection(c, id)? else {
                    return Ok(None);
                };
                let fresh_access =
                    access_list::for_source(c, &fresh.source_drive, &fresh.source_path)?;
                Ok(Some((fresh, fresh_access)))
            })?
            else {
                // The backup was removed during the run: nothing to record.
                return Ok(outcome);
            };
            if fresh.source_drive != row.source_drive
                || fresh.source_path != row.source_path
                || fresh_access != access
            {
                if let Err(e) = repair_manifest(&target, id, &fresh, &fresh_access) {
                    tracing::warn!(error = %e, id, "could not update the backup's manifest after a change");
                }
            }
            let access_json = serde_json::to_string(&fresh_access)?;
            with_conn(db, |c| -> anyhow::Result<()> {
                db::record_protection_ok(c, id, now, &access_json)?;
                db::set_protection_notes(c, id, &outcome.notes.join("\n"))
            })?;
            Ok(outcome)
        }
        Err(e) => {
            tracing::warn!(error = %e, id, "drive backup could not write to the backup drive");
            if is_disk_full(&e) {
                fail(
                    db,
                    id,
                    &format!(
                        "{target_name} is full. Free up space on it, then the backup continues."
                    ),
                    true,
                    now,
                )
            } else {
                fail(
                    db,
                    id,
                    &format!(
                        "Luna couldn't save the backup on {target_name}. Check that the drive is connected and has room, then try again."
                    ),
                    false,
                    now,
                )
            }
        }
    }
}

/// Copy `walked` into the backup store, delete what left the source, and
/// save the manifest. `Ok(None)` means the mass-delete guard held and nothing
/// was changed.
fn sync_target(
    target: &Target,
    row: &ProtectionRow,
    source_label: &str,
    walked: Vec<scope::Entry>,
    access: &access_list::AccessList,
    allow_mass_delete: bool,
    now: i64,
) -> io::Result<Option<RunOutcome>> {
    let store = drive_store::Store::open(&target.root, &target.layout, &row.id)?;
    let limits = target.limits;
    let (wanted, notes, kept) = plan_names(walked, limits, &target.label);

    let current = store.current_files()?;
    // Compared by name_key on both sides, so a case-only change on a target
    // that ignores capitals never reads as a deletion.
    let wanted_keys: HashSet<String> = wanted
        .iter()
        .map(|(rel, _)| name_key(rel, limits))
        .chain(kept.iter().map(|rel| name_key(rel, limits)))
        .collect();
    let current_keys: HashSet<String> = current.iter().map(|rel| name_key(rel, limits)).collect();
    let deletions: Vec<String> = current
        .iter()
        .filter(|rel| !wanted_keys.contains(&name_key(rel, limits)))
        .cloned()
        .collect();
    if !allow_mass_delete
        && deletions.len() >= MASS_DELETE_MIN
        && deletions.len() * 2 > current.len()
    {
        return Ok(None);
    }

    let mut manifest = match store.read_manifest()? {
        Some(manifest) => manifest,
        None => drive_store::Manifest {
            format: drive_store::MANIFEST_FORMAT,
            protection_id: row.id.clone(),
            luna_id: String::new(),
            source_drive_id: row.source_drive.clone(),
            source_drive_label: source_label.to_string(),
            source_path: row.source_path.clone(),
            private_owner: None,
            created_by: row.created_by.clone(),
            created_at: row.created_at,
            access: access.clone(),
            last_ok_at: 0,
            deleted: BTreeMap::new(),
            paused_secs: 0,
            paused_since: 0,
        },
    };
    // The source is readable again, so the deleted-files clock runs; stamp
    // this run's deletions on that clock.
    // If nobody could look at this backup for a long stretch (both drives
    // away, or Luna off), that time doesn't count toward deleted files aging
    // out. Runs happen every 30 minutes, so a 2-hour gap is a real one.
    const CLOCK_GAP_SECS: i64 = 2 * 60 * 60;
    if manifest.paused_since == 0
        && manifest.last_ok_at > 0
        && now - manifest.last_ok_at > CLOCK_GAP_SECS
    {
        manifest.paused_secs += now - manifest.last_ok_at;
    }
    manifest.resume(now);
    let stamp = manifest.clock(now);

    let mut outcome = RunOutcome {
        notes,
        ..RunOutcome::default()
    };
    // On a target that ignores capitals, a copy saved under another spelling
    // of the same name is the same file: move it aside as replaced (not as a
    // deletion) so the new spelling is the only copy left in `current/`.
    if limits.case_insensitive {
        for (rel, _) in &wanted {
            for old in current.iter().filter(|old| {
                old.as_str() != rel.as_str() && name_key(old, limits) == name_key(rel, limits)
            }) {
                retry_with_room(
                    &store,
                    &mut manifest,
                    now,
                    &mut outcome.notes,
                    &target.label,
                    |_| store.remove(old, now),
                )?;
            }
        }
    }
    for (rel, entry) in &wanted {
        // A file that vanished since the walk is skipped quietly; the next
        // run sees it gone.
        let meta = match fs::metadata(&entry.abs) {
            Ok(meta) => meta,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let put = match retry_with_room(
            &store,
            &mut manifest,
            now,
            &mut outcome.notes,
            &target.label,
            |_| store.put(rel, &entry.abs, &meta, now),
        ) {
            Ok(put) => put,
            Err(e) if e.kind() == ErrorKind::NotFound && !entry.abs.exists() => continue,
            Err(e) => return Err(e),
        };
        match put {
            drive_store::Put::Unchanged => outcome.unchanged += 1,
            drive_store::Put::Added | drive_store::Put::Updated => outcome.copied += 1,
        }
        // A file that came back is no longer deleted.
        manifest.deleted.remove(rel);
    }
    // A file too big for the target keeps its existing copy: it counts as
    // unchanged and is never a deletion.
    for rel in &kept {
        if current_keys.contains(&name_key(rel, limits)) {
            outcome.unchanged += 1;
        }
    }
    // The manifest lists every deletion before any file leaves `current/`.
    // If the run stops partway, the next run finishes the job and no file is
    // lost from the backup.
    // Thinning runs before the stamps go in: it would drop stamps for files
    // still in `current/`.
    store.thin(&mut manifest, now)?;
    for rel in &deletions {
        manifest.deleted.insert(rel.clone(), stamp);
    }
    manifest.source_drive_label = source_label.to_string();
    manifest.source_drive_id = row.source_drive.clone();
    manifest.source_path = row.source_path.clone();
    manifest.access = access.clone();
    manifest.last_ok_at = now;
    save_manifest(&store, &mut manifest, now, &mut outcome.notes, &target.label)?;

    for rel in &deletions {
        #[cfg(test)]
        {
            if FAIL_REMOVAL_OF.with(|f| f.borrow().as_deref() == Some(rel.as_str())) {
                return Err(io::Error::other("injected removal failure"));
            }
        }
        let removed = retry_with_room(
            &store,
            &mut manifest,
            now,
            &mut outcome.notes,
            &target.label,
            |_| store.remove(rel, now),
        )?;
        if removed {
            outcome.removed += 1;
        }
    }
    // Making room during a removal can thin the manifest, so save it again.
    if !deletions.is_empty() {
        save_manifest(&store, &mut manifest, now, &mut outcome.notes, &target.label)?;
    }
    Ok(Some(outcome))
}

fn is_disk_full(e: &io::Error) -> bool {
    e.kind() == ErrorKind::StorageFull || e.raw_os_error() == Some(28)
}

/// Run one disk write. When the target is full, thin out old versions to make
/// room and try once more. A note says when versions were removed. The error
/// comes back when nothing was freed.
fn retry_with_room<T>(
    store: &drive_store::Store,
    manifest: &mut drive_store::Manifest,
    now: i64,
    notes: &mut Vec<String>,
    target_label: &str,
    mut op: impl FnMut(&mut drive_store::Manifest) -> io::Result<T>,
) -> io::Result<T> {
    match op(manifest) {
        Err(e) if is_disk_full(&e) => {
            // If thinning fails, nothing was freed and the full-disk error stands.
            let freed = store.free_space_by_thinning(manifest, now).unwrap_or(0);
            if freed == 0 {
                return Err(e);
            }
            let note = format!("Removed older versions to make room on {target_label}.");
            if !notes.contains(&note) {
                notes.push(note);
            }
            op(manifest)
        }
        other => other,
    }
}

/// Save the manifest, making room once if the target is full.
fn save_manifest(
    store: &drive_store::Store,
    manifest: &mut drive_store::Manifest,
    now: i64,
    notes: &mut Vec<String>,
    target_label: &str,
) -> io::Result<()> {
    retry_with_room(store, manifest, now, notes, target_label, |m| {
        store.write_manifest(m)
    })
}

/// Bring the backup drive's manifest in line with the row's source and access.
/// Used when a revoke or a move changed them during a run.
fn repair_manifest(
    target: &Target,
    id: &str,
    row: &ProtectionRow,
    access: &access_list::AccessList,
) -> anyhow::Result<()> {
    let Some(store) = drive_store::Store::existing(&target.root, &target.layout, id) else {
        return Ok(());
    };
    let Some(mut manifest) = store.read_manifest()? else {
        return Ok(());
    };
    manifest.source_drive_id = row.source_drive.clone();
    manifest.source_path = row.source_path.clone();
    manifest.access = access.clone();
    store.write_manifest(&manifest)?;
    Ok(())
}

#[cfg(test)]
thread_local! {
    /// Test seam: runs once, after a run has copied and before it records its result.
    static BEFORE_RECORD: std::cell::RefCell<Option<Box<dyn FnOnce(&crate::Db)>>> =
        std::cell::RefCell::new(None);
    /// Test seam: removing this file fails.
    static FAIL_REMOVAL_OF: std::cell::RefCell<Option<String>> =
        std::cell::RefCell::new(None);
}

/// The source drive's albums that belong in a backup. The drive's own
/// database is attached for the read, since albums live there and not in
/// luna.db.
fn source_albums(
    conn: &Connection,
    row: &ProtectionRow,
    source_root: &Path,
) -> anyhow::Result<Vec<albums_export::AlbumExport>> {
    let Some(db_file) = drive_db::find_db_file(source_root) else {
        anyhow::bail!("the source drive has no Luna database");
    };
    conn.execute(
        "ATTACH DATABASE ?1 AS src_drive",
        [db_file.to_string_lossy().as_ref()],
    )?;
    let list = albums_export::export(conn, &row.source_drive, &row.source_path);
    // Detach even when the read failed, so the next run can attach again.
    let detached = conn.execute_batch("DETACH DATABASE src_drive");
    let list = list?;
    detached?;
    Ok(list)
}

/// Write the album list next to the backup's manifest. It goes to a temp file
/// first and is renamed into place, so a failed write never leaves half a list.
fn save_albums(
    target: &Target,
    protection_id: &str,
    list: &[albums_export::AlbumExport],
) -> anyhow::Result<()> {
    let store = drive_store::Store::existing(&target.root, &target.layout, protection_id)
        .ok_or_else(|| anyhow::anyhow!("the backup's folder is missing on the backup drive"))?;
    let body = serde_json::to_vec_pretty(list)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".albums")
        .rand_bytes(8)
        .tempfile_in(store.root())?;
    tmp.as_file_mut().write_all(&body)?;
    tmp.persist(store.root().join(albums_export::ALBUMS_FILE))
        .map_err(|e| e.error)?;
    Ok(())
}

/// The name each file gets on the target (plan §4), and a note for each one
/// that couldn't keep its own name. Files too big for the target's format are
/// not copied; their rel paths come back in the third list so the caller keeps
/// their existing copies. On a target that ignores capitals, the second of two
/// clashing names is saved as `<stem> (2).<ext>` in the same folder.
fn plan_names(
    mut walked: Vec<scope::Entry>,
    limits: drive_store::FsLimits,
    target_name: &str,
) -> (Vec<(String, scope::Entry)>, Vec<String>, Vec<String>) {
    walked.sort_by(|a, b| a.rel.cmp(&b.rel));
    let mut notes = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut kept = Vec::new();
    for entry in walked {
        if limits.max_file.is_some_and(|max| entry.size > max) {
            notes.push(format!(
                "{} is too big for {target_name}'s format (largest 4 GB).",
                entry.rel
            ));
            kept.push(entry.rel.clone());
            continue;
        }
        if taken.insert(name_key(&entry.rel, limits)) {
            out.push((entry.rel.clone(), entry));
        } else {
            let alt = free_alt_name(&entry.rel, limits, &mut taken);
            notes.push(format!(
                "{} has the same name as another file on {target_name} apart from capitals, so it was saved as {alt}.",
                entry.rel
            ));
            out.push((alt, entry));
        }
    }
    (out, notes, kept)
}

fn name_key(rel: &str, limits: drive_store::FsLimits) -> String {
    if limits.case_insensitive {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// `dir/stem (2).ext`, `dir/stem (3).ext`, … — the first free one.
fn free_alt_name(rel: &str, limits: drive_store::FsLimits, taken: &mut HashSet<String>) -> String {
    let (dir, name) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|e| e.to_str());
    let mut n = 2;
    loop {
        let candidate = match ext {
            Some(ext) => format!("{dir}{stem} ({n}).{ext}"),
            None => format!("{dir}{stem} ({n})"),
        };
        if taken.insert(name_key(&candidate, limits)) {
            return candidate;
        }
        n += 1;
    }
}

/// A backup's drive, when it is plugged in and carries its Luna marker.
struct Target {
    root: PathBuf,
    layout: Layout,
    label: String,
    limits: drive_store::FsLimits,
}

fn connected(conn: &Connection, drive_id: &str) -> Option<Target> {
    let drive = files::drive_root(conn, drive_id).ok()?;
    let root = PathBuf::from(&drive.mount_point);
    let layout = Layout::detect(&root)?;
    let limits = drive_store::fs_limits(&root);
    Some(Target {
        root,
        layout,
        label: label_or_default(&drive.label),
        limits,
    })
}

fn drive_label(conn: &Connection, drive_id: &str) -> String {
    let label = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .map(|d| d.label)
        .unwrap_or_default();
    label_or_default(&label)
}

fn label_or_default(label: &str) -> String {
    if label.trim().is_empty() {
        "Unnamed drive".to_string()
    } else {
        label.to_string()
    }
}

/// The folder's own name, or the drive's name for a whole drive.
fn folder_name(source_path: &str, drive_label: &str) -> String {
    source_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| drive_label.to_string())
}

fn backup_state(row: &ProtectionRow, now: i64) -> status::BackupState {
    status::state(
        status::Record {
            last_ok_at: row.last_ok_at,
            failing_since: row.failing_since,
            last_error: &row.last_error,
            hard: row.hard,
            since: row.created_at,
        },
        now,
    )
}

/// Freeze the backup's deleted-files clock. Best-effort: a failure is logged,
/// and the run still reports why it stopped.
fn pause_clock(target: &Target, id: &str, now: i64) {
    let Some(store) = drive_store::Store::existing(&target.root, &target.layout, id) else {
        return;
    };
    let result = store.read_manifest().and_then(|manifest| match manifest {
        Some(mut manifest) => {
            manifest.pause(now);
            store.write_manifest(&manifest)
        }
        None => Ok(()),
    });
    if let Err(e) = result {
        tracing::warn!(error = %e, id, "could not pause the deleted-files clock");
    }
}

fn source_gone(
    db: &crate::Db,
    row: &ProtectionRow,
    target: &Target,
    now: i64,
) -> anyhow::Result<RunOutcome> {
    pause_clock(target, &row.id, now);
    let reason = "The folder was deleted or moved somewhere Luna can't follow.";
    with_conn(db, |c| {
        db::set_protection_state(c, &row.id, db::PROTECTION_SOURCE_GONE, reason)
    })?;
    Ok(problem_outcome(reason))
}

/// Only a folder that is really missing counts as gone. Anything else (no
/// permission, a disk error) is a passing problem.
fn is_not_found(e: &files::FilesError) -> bool {
    match e {
        files::FilesError::Io(e) => e.kind() == ErrorKind::NotFound,
        files::FilesError::Path(luna_core::path::PathError::NotFound(e)) => {
            e.kind() == ErrorKind::NotFound
        }
        _ => false,
    }
}

/// Record a failed run on the row and report it as an empty outcome.
fn fail(
    db: &crate::Db,
    id: &str,
    message: &str,
    hard: bool,
    now: i64,
) -> anyhow::Result<RunOutcome> {
    with_conn(db, |c| {
        db::record_protection_error(c, id, message, hard, now)
    })?;
    Ok(problem_outcome(message))
}

/// Run `f` with the database lock held. The lock is taken and released per
/// call, so copying never happens under it.
fn with_conn<T>(db: &crate::Db, f: impl FnOnce(&Connection) -> T) -> T {
    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
    f(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::CurrentUser;
    use luna_core::marker::{Marker, pick_prefix};

    const NOW: i64 = 1_800_000_000;

    struct Setup {
        _dir: tempfile::TempDir,
        db: crate::Db,
        admin: CurrentUser,
        src: String,
        src_root: PathBuf,
        tgt: String,
        tgt_root: PathBuf,
    }

    fn new_drive(dir: &Path, conn: &Connection, id: &str, label: &str) -> PathBuf {
        let root = dir.join(id);
        fs::create_dir_all(&root).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(&root, &Marker::new(id.to_string(), label), &prefix)
                .unwrap(),
        );
        db::upsert_drive(conn, id, label, "as_is", "ext4", id, root.to_str().unwrap()).unwrap();
        root
    }

    /// Two drives with markers ("Photos" source, "Backup" target) and a
    /// `Docs` folder on the source.
    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_user(&conn, "admin", "admin", "Admin", "", "admin").unwrap();
        let src = "drive-src".to_string();
        let tgt = "drive-tgt".to_string();
        let src_root = new_drive(dir.path(), &conn, &src, "Photos");
        let tgt_root = new_drive(dir.path(), &conn, &tgt, "Backup");
        fs::create_dir_all(src_root.join("Docs")).unwrap();
        Setup {
            _dir: dir,
            db: crate::Db::new(conn),
            admin: CurrentUser {
                id: "admin".into(),
                username: "admin".into(),
                role: "admin".into(),
            },
            src,
            src_root,
            tgt,
            tgt_root,
        }
    }

    fn docs(s: &Setup) -> PathBuf {
        s.src_root.join("Docs")
    }

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn make_backup(s: &Setup) -> String {
        let conn = s.db.lock().unwrap();
        create(&conn, &s.admin, &s.src, "Docs", &s.tgt).unwrap().id
    }

    fn row(s: &Setup, id: &str) -> ProtectionRow {
        let conn = s.db.lock().unwrap();
        db::get_protection(&conn, id).unwrap().unwrap()
    }

    fn store(s: &Setup, id: &str) -> drive_store::Store {
        let layout = Layout::detect(&s.tgt_root).unwrap();
        drive_store::Store::existing(&s.tgt_root, &layout, id).unwrap()
    }

    fn manifest(s: &Setup, id: &str) -> drive_store::Manifest {
        store(s, id).read_manifest().unwrap().unwrap()
    }

    #[test]
    fn create_refuses_whole_drive_for_non_admin() {
        let s = setup();
        let member = CurrentUser {
            id: "m".into(),
            username: "m".into(),
            role: "member".into(),
        };
        let conn = s.db.lock().unwrap();
        let err = create(&conn, &member, &s.src, "", &s.tgt).unwrap_err();
        assert_eq!(err.0, "Only an Admin can back up a whole drive.");
    }

    #[test]
    fn create_refuses_member_without_read_on_source() {
        let s = setup();
        let member = CurrentUser {
            id: "m".into(),
            username: "m".into(),
            role: "member".into(),
        };
        let conn = s.db.lock().unwrap();
        let err = create(&conn, &member, &s.src, "Docs", &s.tgt).unwrap_err();
        assert_eq!(err.0, "You need Read access to this folder to back it up.");
    }

    #[test]
    fn create_refuses_same_drive() {
        let s = setup();
        let conn = s.db.lock().unwrap();
        let err = create(&conn, &s.admin, &s.src, "Docs", &s.src).unwrap_err();
        assert_eq!(
            err.0,
            "A backup has to go on a different drive from the folder it copies."
        );
    }

    #[test]
    fn create_returns_existing_backup_for_same_pair() {
        let s = setup();
        let first = make_backup(&s);
        let again = make_backup(&s);
        assert_eq!(first, again);
    }

    #[test]
    fn first_run_copies_and_second_run_is_unchanged() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        write(&docs(&s).join("sub/b.txt"), "two");
        let id = make_backup(&s);

        let first = run(&s.db, &id, NOW).unwrap();
        assert_eq!(
            first,
            RunOutcome {
                copied: 2,
                ..RunOutcome::default()
            }
        );

        let second = run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(
            second,
            RunOutcome {
                unchanged: 2,
                ..RunOutcome::default()
            }
        );

        let r = row(&s, &id);
        assert_eq!(r.state, db::PROTECTION_ACTIVE);
        assert_eq!(r.last_ok_at, NOW + 60);
        assert!(r.last_error.is_empty());
    }

    #[test]
    fn modified_file_keeps_previous_copy_in_versions() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        write(&docs(&s).join("a.txt"), "one, but longer now");
        let outcome = run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(outcome.copied, 1);
        assert_eq!(store(&s, &id).version_times().unwrap().len(), 1);
    }

    #[test]
    fn deleted_file_is_recorded_in_manifest() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        write(&docs(&s).join("b.txt"), "two");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        fs::remove_file(docs(&s).join("a.txt")).unwrap();
        let outcome = run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(outcome.removed, 1);
        assert!(manifest(&s, &id).deleted.contains_key("a.txt"));
        assert_eq!(
            store(&s, &id).current_files().unwrap(),
            vec!["b.txt".to_string()]
        );
    }

    #[test]
    fn failed_run_keeps_deleted_files_listed() {
        let s = setup();
        for name in ["a.txt", "b.txt", "c.txt", "d.txt"] {
            write(&docs(&s).join(name), "x");
        }
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        fs::remove_file(docs(&s).join("a.txt")).unwrap();
        fs::remove_file(docs(&s).join("b.txt")).unwrap();
        FAIL_REMOVAL_OF.with(|f| *f.borrow_mut() = Some("b.txt".into()));
        run(&s.db, &id, NOW + 60).unwrap();
        FAIL_REMOVAL_OF.with(|f| *f.borrow_mut() = None);

        // a.txt was moved aside; b.txt is still in current/ and both are listed.
        let deleted = manifest(&s, &id).deleted;
        assert!(deleted.contains_key("a.txt"));
        assert!(deleted.contains_key("b.txt"));
        assert_eq!(
            store(&s, &id).current_files().unwrap(),
            vec!["b.txt".to_string(), "c.txt".to_string(), "d.txt".to_string()]
        );

        // The next clean run finishes the removal and keeps both entries.
        let outcome = run(&s.db, &id, NOW + 120).unwrap();
        assert_eq!(outcome.removed, 1);
        assert_eq!(
            store(&s, &id).current_files().unwrap(),
            vec!["c.txt".to_string(), "d.txt".to_string()]
        );
        let deleted = manifest(&s, &id).deleted;
        assert!(deleted.contains_key("a.txt"));
        assert!(deleted.contains_key("b.txt"));
    }

    #[test]
    fn revoked_access_survives_a_run_in_progress() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        {
            let conn = s.db.lock().unwrap();
            db::insert_user(&conn, "member", "member", "Member", "", "member").unwrap();
            db::insert_access_member(
                &conn,
                &db::AccessMemberRow {
                    id: "grant-1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: s.src.clone(),
                    path: "Docs".into(),
                    album_id: String::new(),
                    user_id: "member".into(),
                    caps: crate::access::CAP_VIEW.into(),
                    created_by: "admin".into(),
                },
            )
            .unwrap();
        }
        run(&s.db, &id, NOW).unwrap();
        assert!(row(&s, &id).access_json.contains("member"));

        // Revoke the grant while the next run is copying.
        let src = s.src.clone();
        BEFORE_RECORD.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |db: &crate::Db| {
                let conn = db.lock().unwrap();
                db::delete_access_member(&conn, "grant-1").unwrap();
                ops::on_grants_changed(&conn, &src);
            }));
        });
        run(&s.db, &id, NOW + 60).unwrap();

        assert!(!row(&s, &id).access_json.contains("member"));
        assert!(!manifest(&s, &id).access.users.contains(&"member".to_string()));
    }

    #[test]
    fn move_during_a_run_survives_it() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        // Move the folder while the next run is copying.
        let src = s.src.clone();
        BEFORE_RECORD.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |db: &crate::Db| {
                let conn = db.lock().unwrap();
                ops::on_moved(&conn, &src, "Docs", &src, "Papers");
            }));
        });
        run(&s.db, &id, NOW + 60).unwrap();

        assert_eq!(row(&s, &id).source_path, "Papers");
        assert_eq!(manifest(&s, &id).source_path, "Papers");
    }

    #[test]
    fn mass_delete_guard_holds_until_overridden() {
        let s = setup();
        for i in 0..30 {
            write(&docs(&s).join(format!("f{i}.txt")), "x");
        }
        let id = make_backup(&s);
        assert_eq!(run(&s.db, &id, NOW).unwrap().copied, 30);

        for i in 0..25 {
            fs::remove_file(docs(&s).join(format!("f{i}.txt"))).unwrap();
        }
        let held = run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(held.removed, 0);
        assert!(held.problem.as_deref().unwrap().starts_with("Most of Docs seems to be gone"));
        let r = row(&s, &id);
        assert!(r.hard);
        assert!(r.last_error.starts_with("Most of Docs seems to be gone"));
        assert_eq!(store(&s, &id).current_files().unwrap().len(), 30);

        let forced = run_allowing_mass_delete(&s.db, &id, NOW + 120).unwrap();
        assert_eq!(forced.removed, 25);
        assert!(row(&s, &id).last_error.is_empty());
        assert_eq!(store(&s, &id).current_files().unwrap().len(), 5);
    }

    #[test]
    fn missing_source_drive_is_soft_and_pauses_clock() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        {
            let conn = s.db.lock().unwrap();
            db::set_drive_state(&conn, &s.src, "missing").unwrap();
        }
        run(&s.db, &id, NOW + 100).unwrap();

        let r = row(&s, &id);
        assert_eq!(r.last_error, "Waiting: Photos isn't connected.");
        assert!(!r.hard);
        assert_eq!(manifest(&s, &id).paused_since, NOW + 100);
    }

    #[test]
    fn source_folder_gone_waits_and_revives_when_back() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        fs::remove_dir_all(docs(&s)).unwrap();
        let gone = run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(
            gone.problem.as_deref(),
            Some("The folder was deleted or moved somewhere Luna can't follow.")
        );
        let r = row(&s, &id);
        assert_eq!(r.state, db::PROTECTION_SOURCE_GONE);
        assert_eq!(
            r.stop_reason,
            "The folder was deleted or moved somewhere Luna can't follow."
        );
        assert!(manifest(&s, &id).paused_since > 0);

        // Back again (restored from the trash): the backup runs on its own.
        fs::create_dir_all(docs(&s)).unwrap();
        write(&docs(&s).join("a.txt"), "one");
        let back = run(&s.db, &id, NOW + 120).unwrap();
        assert_eq!(back.copied + back.unchanged, 1);
        assert_eq!(back.problem, None);
        let r = row(&s, &id);
        assert_eq!(r.state, db::PROTECTION_ACTIVE);
        assert!(r.last_error.is_empty());
        assert_eq!(manifest(&s, &id).paused_since, 0);
    }

    #[test]
    fn create_revives_a_backup_whose_folder_was_gone() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        fs::remove_dir_all(docs(&s)).unwrap();
        run(&s.db, &id, NOW + 60).unwrap();
        assert_eq!(row(&s, &id).state, db::PROTECTION_SOURCE_GONE);

        fs::create_dir_all(docs(&s)).unwrap();
        assert_eq!(make_backup(&s), id);
        assert_eq!(row(&s, &id).state, db::PROTECTION_ACTIVE);
    }

    #[test]
    fn stopped_backup_stays_stopped_and_says_why() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        with_conn(&s.db, |c| {
            db::set_protection_state(c, &id, db::PROTECTION_STOPPED, "Stopped for testing.")
        })
        .unwrap();

        let r = run(&s.db, &id, NOW).unwrap();
        assert_eq!(r.problem.as_deref(), Some("Stopped for testing."));
        assert_eq!(row(&s, &id).state, db::PROTECTION_STOPPED);
    }

    #[test]
    fn already_running_backup_says_so() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        let _slot = RunSlot::take(&id).unwrap();

        let r = run(&s.db, &id, NOW).unwrap();
        assert_eq!(
            r.problem.as_deref(),
            Some("This backup is already running. Its status updates when it finishes.")
        );
    }

    #[test]
    fn only_missing_folders_count_as_gone() {
        let missing = files::FilesError::Io(io::Error::from(ErrorKind::NotFound));
        let denied = files::FilesError::Io(io::Error::from(ErrorKind::PermissionDenied));
        assert!(is_not_found(&missing));
        assert!(!is_not_found(&denied));
    }

    #[test]
    fn case_only_names_match_on_case_blind_targets() {
        let blind = drive_store::FsLimits {
            case_insensitive: true,
            max_file: None,
        };
        let exact = drive_store::FsLimits {
            case_insensitive: false,
            max_file: None,
        };
        assert_eq!(name_key("Docs/A.txt", blind), name_key("docs/a.txt", blind));
        assert_ne!(name_key("Docs/A.txt", exact), name_key("docs/a.txt", exact));
    }

    #[test]
    fn clock_skips_a_long_gap_between_runs() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        write(&docs(&s).join("b.txt"), "two");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();

        // Nobody could look for three hours; then b.txt is deleted.
        fs::remove_file(docs(&s).join("b.txt")).unwrap();
        let later = NOW + 3 * 60 * 60;
        run(&s.db, &id, later).unwrap();
        let m = manifest(&s, &id);
        assert_eq!(m.paused_secs, 3 * 60 * 60);
        assert_eq!(m.deleted.get("b.txt"), Some(&NOW));
    }

    #[test]
    fn manifest_records_the_source_drive() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();
        assert_eq!(manifest(&s, &id).source_drive_id, s.src);
    }

    #[test]
    fn file_gone_before_the_copy_is_skipped() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        let id = make_backup(&s);
        let r = row(&s, &id);
        let target = with_conn(&s.db, |c| connected(c, &s.tgt)).unwrap();
        let access = with_conn(&s.db, |c| {
            access_list::for_source(c, &r.source_drive, &r.source_path)
        })
        .unwrap();
        // gone.txt was in the walk but is no longer on disk.
        let walked = vec![
            scope::Entry {
                rel: "a.txt".into(),
                abs: docs(&s).join("a.txt"),
                size: 3,
                mtime: 0,
            },
            scope::Entry {
                rel: "gone.txt".into(),
                abs: docs(&s).join("gone.txt"),
                size: 3,
                mtime: 0,
            },
        ];
        let outcome = sync_target(&target, &r, "Photos", walked, &access, false, NOW)
            .unwrap()
            .unwrap();
        assert_eq!(outcome.copied, 1);
        assert!(outcome.notes.is_empty());
    }

    #[test]
    fn name_clashes_and_big_files_become_notes() {
        // exFAT/FAT-style target: capitals don't count, and files over the
        // limit are left out. Tested on the planner directly because a real
        // drive's limits can't be steered from a test.
        fn entry(rel: &str, size: u64) -> scope::Entry {
            scope::Entry {
                rel: rel.into(),
                abs: PathBuf::from(format!("/src/{rel}")),
                size,
                mtime: 0,
            }
        }
        let limits = drive_store::FsLimits {
            case_insensitive: true,
            max_file: Some(100),
        };
        let (out, notes, kept) = plan_names(
            vec![
                entry("B.txt", 1),
                entry("a.txt", 1),
                entry("A.txt", 1),
                entry("big.bin", 200),
            ],
            limits,
            "Backup",
        );
        let names: Vec<&str> = out.iter().map(|(rel, _)| rel.as_str()).collect();
        assert_eq!(names, vec!["A.txt", "B.txt", "a (2).txt"]);
        assert_eq!(kept, vec!["big.bin".to_string()]);
        assert_eq!(notes.len(), 2);
        assert!(notes[0].contains("saved as a (2).txt"));
        assert_eq!(
            notes[1],
            "big.bin is too big for Backup's format (largest 4 GB)."
        );
    }

    /// The target's connection with the given filesystem limits. The real
    /// limits of a temp folder can't be steered from a test.
    fn with_limits(s: &Setup, limits: drive_store::FsLimits) -> Target {
        Target {
            limits,
            ..with_conn(&s.db, |c| connected(c, &s.tgt)).unwrap()
        }
    }

    #[test]
    fn album_list_is_written_next_to_the_manifest() {
        let s = setup();
        write(&docs(&s).join("a.txt"), "one");
        {
            let conn = drive_db::open(&s.src_root).unwrap();
            conn.execute(
                "INSERT INTO albums (id, owner_user_id, name, created_at) VALUES ('trip', 'admin', 'Trip', 100)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO album_items (album_id, drive_id, path, added_at) VALUES ('trip', ?1, 'Docs/a.txt', 1)",
                [&s.src],
            )
            .unwrap();
        }
        let id = make_backup(&s);
        run(&s.db, &id, NOW).unwrap();
        let body =
            fs::read_to_string(store(&s, &id).root().join(albums_export::ALBUMS_FILE)).unwrap();
        assert!(body.contains("\"Trip\""), "{body}");
        assert!(body.contains("a.txt"), "{body}");
    }

    #[test]
    fn file_over_the_fat_limit_keeps_its_existing_copy() {
        let s = setup();
        let doc = docs(&s).join("a.txt");
        write(&doc, "one");
        let id = make_backup(&s);
        let r = row(&s, &id);
        let access = with_conn(&s.db, |c| {
            access_list::for_source(c, &r.source_drive, &r.source_path)
        })
        .unwrap();
        let roomy = with_limits(&s, drive_store::FsLimits::default());
        let walked = scope::walk(&docs(&s)).unwrap();
        sync_target(&roomy, &r, "Photos", walked, &access, false, NOW)
            .unwrap()
            .unwrap();

        // The file grows past a 5-byte limit, like a FAT drive's file cap.
        write(&doc, "much longer than five bytes");
        let small = with_limits(
            &s,
            drive_store::FsLimits {
                case_insensitive: false,
                max_file: Some(5),
            },
        );
        let walked = scope::walk(&docs(&s)).unwrap();
        let outcome = sync_target(&small, &r, "Photos", walked, &access, false, NOW)
            .unwrap()
            .unwrap();
        assert!(outcome.notes.iter().any(|n| n.contains("a.txt")), "{:?}", outcome.notes);
        assert_eq!(
            fs::read_to_string(store(&s, &id).current_dir().join("a.txt")).unwrap(),
            "one"
        );
    }

    #[test]
    fn case_only_rename_keeps_the_file_in_current() {
        let s = setup();
        let doc = docs(&s).join("notes.txt");
        write(&doc, "one");
        let id = make_backup(&s);
        let r = row(&s, &id);
        let access = with_conn(&s.db, |c| {
            access_list::for_source(c, &r.source_drive, &r.source_path)
        })
        .unwrap();
        let ci = with_limits(
            &s,
            drive_store::FsLimits {
                case_insensitive: true,
                max_file: None,
            },
        );
        let walked = scope::walk(&docs(&s)).unwrap();
        sync_target(&ci, &r, "Photos", walked, &access, false, NOW)
            .unwrap()
            .unwrap();

        // Same name with different capitals, same content.
        fs::rename(&doc, docs(&s).join("Notes.txt")).unwrap();
        let walked = scope::walk(&docs(&s)).unwrap();
        sync_target(&ci, &r, "Photos", walked, &access, false, NOW)
            .unwrap()
            .unwrap();

        let files = store(&s, &id).current_files().unwrap();
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[0].to_lowercase(), "notes.txt");
    }
}
