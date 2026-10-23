//! Moves a cloud backup to its newest key version in the background.
//!
//! After a "someone may have it" save, the backup starts key version N+1. Packs sealed under
//! older versions still hold most of the data, so this module moves them one step at a time:
//! download a pack, open it with the older key, seal the same chunks under the newest key into a
//! new pack, upload it, and point the local index at it. When every pack a retained snapshot
//! uses has moved, the snapshot is rewritten under the newest key. Old packs are only marked for
//! the normal mark-then-delete cleanup. Nothing is deleted here, and a full store pauses the move.
//!
//! A pack counts as "under an older version" when it was created before the newest key version
//! was. Runs are serialized per backup, so a pack's creation time places it under one version.
//! A clock set back before the newest key stops the move with an error rather than looping.

use std::collections::BTreeSet;

use anyhow::{Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::crypto::{self, Signer};
use super::format::{
    self, ChunkRef, PackBuilder, SealedPack, SignedRecord, SnapshotRecord, Tree, TreeEntry,
};
use super::identity;
use super::run::{self, RunSlot, Sealer, SharedSealer};
use super::store::{CloudStore, StoreError};
use crate::db::{self, BackupKey, SnapshotInsert};

/// What one call to [`step`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Nothing is left to move for this backup.
    Done,
    /// A run or another step holds this backup. Nothing was touched.
    Busy,
    /// One pack was re-sealed under the newest key version.
    Moved,
    /// One snapshot was rewritten under the newest key version.
    Rewrote,
    /// The store is full. The move waits, and nothing was deleted.
    PausedFull,
}

/// What the backup row and the phrase page show while a move is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveStatus {
    /// Bytes moved over bytes still under older versions, as a whole percent.
    pub percent: u32,
    pub paused_full: bool,
}

/// The newest key version a move targets, with what the move needs from it.
struct Target {
    version: i64,
    created_at: i64,
    key: [u8; 32],
    dedup_key: [u8; 32],
}

/// What the next step should do.
enum Work {
    /// Re-seal this pack (an older version's pack that a snapshot still uses).
    Move { pack: String },
    /// Rewrite this snapshot under the newest key version.
    Rewrite(SnapshotInsert),
}

fn moved_key(protection_id: &str) -> String {
    format!("cloud_move:{protection_id}")
}

fn paused_key(protection_id: &str) -> String {
    format!("cloud_move_paused:{protection_id}")
}

fn fixed(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("This backup's key is damaged."))
}

/// The dedup scope id and its text form, the same values a run derives from the dedup key.
fn scope_of(dedup_key: &[u8; 32]) -> ([u8; 32], String) {
    let id = crypto::chunk_id(dedup_key, run::SCOPE_DOMAIN);
    (id, run::hex(&id[..16]))
}

/// The newest key version of a shared backup. Private backups are moved by their own code (later).
fn load_target(conn: &Connection, protection_id: &str) -> Result<Option<Target>> {
    let Some(row) = db::get_protection(conn, protection_id)? else {
        return Ok(None);
    };
    if !row.private_owner.is_empty() {
        return Ok(None);
    }
    let Some(latest) = db::latest_backup_key(conn, protection_id)? else {
        return Ok(None);
    };
    Ok(Some(Target {
        version: latest.version,
        created_at: latest.created_at,
        key: fixed(&latest.key)?,
        dedup_key: fixed(&latest.dedup_key)?,
    }))
}

/// Packs a snapshot links to that are under an older version and still hold chunks, in id order.
/// The snapshot's own tree pack is never moved; its snapshot is rewritten instead.
fn candidates(
    conn: &Connection,
    snapshot: &SnapshotInsert,
    scope: &str,
    target_created_at: i64,
) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.size FROM cloud_snapshot_packs sp
         JOIN cloud_packs p ON p.id = sp.pack_id
         WHERE sp.snapshot_id = ?1 AND p.scope = ?2 AND p.id != ?3 AND p.created_at < ?4
           AND EXISTS (SELECT 1 FROM cloud_chunks c WHERE c.pack_id = p.id)
         ORDER BY p.id",
    )?;
    let rows = stmt
        .query_map(
            params![snapshot.id, scope, snapshot.tree_pack_id, target_created_at],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// True when key version `version` of the backup has the same dedup key as the target.
fn same_dedup_line(
    conn: &Connection,
    protection_id: &str,
    version: i64,
    dedup_key: &[u8; 32],
) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM backup_keys
                        WHERE protection_id = ?1 AND version = ?2 AND dedup_key = ?3)",
        params![protection_id, version, dedup_key.as_slice()],
        |r| r.get(0),
    )?)
}

/// True when a snapshot still links to a pack from an older version (even one with no chunks left).
fn has_old_link(
    conn: &Connection,
    snapshot: &SnapshotInsert,
    target_created_at: i64,
) -> Result<bool> {
    let found: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM cloud_snapshot_packs sp
                        JOIN cloud_packs p ON p.id = sp.pack_id
                        WHERE sp.snapshot_id = ?1 AND p.id != ?2 AND p.created_at < ?3)",
        params![snapshot.id, snapshot.tree_pack_id, target_created_at],
        |r| r.get(0),
    )?;
    Ok(found)
}

/// The next piece of work, newest snapshot first: its older packs, then its own rewrite.
fn next_work(
    conn: &Connection,
    protection_id: &str,
    target: &Target,
    scope: &str,
) -> Result<Option<Work>> {
    for snapshot in db::list_cloud_snapshots(conn, protection_id)? {
        // A snapshot under a version with another dedup key (a membership change) is left alone:
        // its readers open it with its own version key, and its chunks are not in this scope.
        if !same_dedup_line(conn, protection_id, snapshot.key_version, &target.dedup_key)? {
            continue;
        }
        if let Some((pack, _)) = candidates(conn, &snapshot, scope, target.created_at)?
            .into_iter()
            .next()
        {
            return Ok(Some(Work::Move { pack }));
        }
        if snapshot.key_version < target.version
            || has_old_link(conn, &snapshot, target.created_at)?
        {
            return Ok(Some(Work::Rewrite(snapshot)));
        }
    }
    Ok(None)
}

/// Bytes still under older versions: the distinct older packs that hold chunks and are linked.
fn remaining_bytes(
    conn: &Connection,
    protection_id: &str,
    scope: &str,
    target_created_at: i64,
    dedup_key: &[u8; 32],
) -> Result<u64> {
    let bytes: i64 = conn.query_row(
        "SELECT COALESCE(SUM(p.size), 0) FROM cloud_packs p
         WHERE p.scope = ?1 AND p.created_at < ?2
           AND EXISTS (SELECT 1 FROM cloud_chunks c WHERE c.pack_id = p.id)
           AND p.id IN (SELECT sp.pack_id FROM cloud_snapshot_packs sp
                        JOIN cloud_snapshots s ON s.id = sp.snapshot_id
                        WHERE s.protection_id = ?3
                          AND EXISTS (SELECT 1 FROM backup_keys k
                                      WHERE k.protection_id = s.protection_id
                                        AND k.version = s.key_version AND k.dedup_key = ?4))
           AND p.id NOT IN (SELECT tree_pack_id FROM cloud_snapshots WHERE protection_id = ?3)",
        params![
            scope,
            target_created_at,
            protection_id,
            dedup_key.as_slice()
        ],
        |r| r.get(0),
    )?;
    Ok(bytes.max(0) as u64)
}

/// Whole percent of moved bytes over all bytes that were or still are under older versions.
/// With nothing to move, the move is complete: 100.
pub fn percent(moved: u64, remaining: u64) -> u32 {
    let total = moved.saturating_add(remaining);
    if total == 0 {
        return 100;
    }
    (moved.saturating_mul(100) / total).min(100) as u32
}

fn read_moved(conn: &Connection, protection_id: &str, target_version: i64) -> Result<u64> {
    let Some(text) = db::get_meta(conn, &moved_key(protection_id))? else {
        return Ok(0);
    };
    // The counter belongs to one target version. A newer version starts it again from zero.
    let Some((version, bytes)) = text.split_once(':') else {
        return Ok(0);
    };
    if version.parse::<i64>().ok() != Some(target_version) {
        return Ok(0);
    }
    Ok(bytes.parse().unwrap_or(0))
}

fn write_moved(
    conn: &Connection,
    protection_id: &str,
    target_version: i64,
    moved: u64,
) -> Result<()> {
    db::set_meta(
        conn,
        &moved_key(protection_id),
        &format!("{target_version}:{moved}"),
    )
}

fn paused(conn: &Connection, protection_id: &str) -> Result<bool> {
    Ok(db::get_meta(conn, &paused_key(protection_id))?.is_some())
}

fn set_paused(conn: &Connection, protection_id: &str, on: bool) -> Result<()> {
    if on {
        db::set_meta(conn, &paused_key(protection_id), "1")
    } else {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            params![paused_key(protection_id)],
        )?;
        Ok(())
    }
}

/// Forgets the move's counters once nothing is left to move.
fn finish_counters(conn: &Connection, protection_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM meta WHERE key IN (?1, ?2)",
        params![moved_key(protection_id), paused_key(protection_id)],
    )?;
    Ok(())
}

/// The move's status for one backup, or `None` when nothing is left to move.
pub fn status(conn: &Connection, protection_id: &str) -> Result<Option<MoveStatus>> {
    let Some(target) = load_target(conn, protection_id)? else {
        return Ok(None);
    };
    let (_, scope) = scope_of(&target.dedup_key);
    if next_work(conn, protection_id, &target, &scope)?.is_none() {
        return Ok(None);
    }
    let remaining = remaining_bytes(
        conn,
        protection_id,
        &scope,
        target.created_at,
        &target.dedup_key,
    )?;
    let moved = read_moved(conn, protection_id, target.version)?;
    Ok(Some(MoveStatus {
        percent: percent(moved, remaining),
        paused_full: paused(conn, protection_id)?,
    }))
}

/// The `moving` value for a backup row: `{percent, paused_full}`, or `null` when nothing moves.
pub fn status_json(conn: &Connection, protection_id: &str) -> Value {
    match status(conn, protection_id) {
        Ok(Some(s)) => json!({ "percent": s.percent, "paused_full": s.paused_full }),
        Ok(None) => Value::Null,
        Err(err) => {
            tracing::warn!(error = %err, protection_id, "could not read the move status");
            Value::Null
        }
    }
}

/// Whether `row`'s move counts for `user`: the backup's newest reader list names them (`mine` holds
/// those backups), or they are an Admin who can see the backup under the usual access rules.
fn counts_for(row: &db::ProtectionRow, user: &crate::auth::CurrentUser, mine: &[String]) -> bool {
    mine.contains(&row.id) || (user.role == "admin" && super::ops::visible_to(row, user))
}

/// The `moving` value for a backup row, as `user` sees it: `null` unless the move concerns them.
pub fn status_json_for(
    conn: &Connection,
    row: &db::ProtectionRow,
    user: &crate::auth::CurrentUser,
) -> Value {
    let mine = super::keys::current_backups_of(conn, &user.id).unwrap_or_default();
    if counts_for(row, user, &mine) {
        status_json(conn, &row.id)
    } else {
        Value::Null
    }
}

/// The `moving` value for the phrase page: the lowest percent across the backups that are moving
/// and concern `user` (see `counts_for`), and paused if any of them is paused. `null` when none is.
pub fn status_for_luna(conn: &Connection, user: &crate::auth::CurrentUser) -> Value {
    let Ok(protections) = db::list_protections(conn) else {
        return Value::Null;
    };
    let mine = super::keys::current_backups_of(conn, &user.id).unwrap_or_default();
    let mut combined: Option<MoveStatus> = None;
    for row in protections
        .iter()
        .filter(|row| counts_for(row, user, &mine))
    {
        match status(conn, &row.id) {
            Ok(Some(s)) => {
                combined = Some(match combined {
                    None => s,
                    Some(c) => MoveStatus {
                        percent: c.percent.min(s.percent),
                        paused_full: c.paused_full || s.paused_full,
                    },
                });
            }
            Ok(None) => {}
            Err(err) => tracing::warn!(error = %err, "could not read a backup's move status"),
        }
    }
    match combined {
        Some(s) => json!({ "percent": s.percent, "paused_full": s.paused_full }),
        None => Value::Null,
    }
}

/// Runs one step of the move for `protection_id`. Takes the backup's run lock, so a run and the
/// move take turns. Each step moves one pack or rewrites one snapshot.
pub fn step(db: &crate::Db, protection_id: &str, store: &dyn CloudStore, now: i64) -> Result<Step> {
    // The drive-backup hold first, then the cloud run lock: the same order a run, delete or
    // restore uses. Both are only tried, never waited on, so nothing can deadlock. A restore
    // that starts mid-step is refused, and a step that finds a restore running does nothing.
    let Some(_hold) = crate::backup::drive_backup::try_hold(db, protection_id) else {
        return Ok(Step::Busy);
    };
    let Some(_slot) = RunSlot::take(db, protection_id) else {
        return Ok(Step::Busy);
    };
    resync_records(db, protection_id, store)?;
    let (target, scope, work) = {
        let conn = run::lock(db);
        let Some(target) = load_target(&conn, protection_id)? else {
            return Ok(Step::Done);
        };
        let (_, scope) = scope_of(&target.dedup_key);
        match next_work(&conn, protection_id, &target, &scope)? {
            Some(work) => (target, scope, work),
            None => {
                finish_counters(&conn, protection_id)?;
                return Ok(Step::Done);
            }
        }
    };

    // The step's own run row keeps mark-then-delete from deleting packs this step is using, and
    // lets startup recovery clean up a pack uploaded before a crash.
    let run_id = run::random_id();
    db::start_run(&run::lock(db), &run_id, protection_id, &scope, now)?;
    let result = match work {
        Work::Move { pack } => move_one(
            db,
            store,
            protection_id,
            &target,
            &scope,
            &pack,
            &run_id,
            now,
        ),
        Work::Rewrite(snapshot) => rewrite_one(
            db,
            store,
            protection_id,
            &target,
            &scope,
            &snapshot,
            &run_id,
            now,
        ),
    };
    db::end_run(&run::lock(db), &run_id, now)?;
    result
}

/// One pass of the idle trickle: tries each backup in turn and runs the first step that does work.
/// A backup that fails is logged and skipped, so one bad backup cannot hold up the others.
pub fn tick(db: &crate::Db, store: &dyn CloudStore, now: i64) -> Step {
    let ids: Vec<String> = match db::list_protections(&run::lock(db)) {
        Ok(rows) => rows.into_iter().map(|row| row.id).collect(),
        Err(err) => {
            tracing::warn!(error = %err, "could not list backups for the move");
            return Step::Done;
        }
    };
    for id in ids {
        match step(db, &id, store, now) {
            Ok(Step::Done | Step::Busy) => {}
            Ok(done_or_moved) => return done_or_moved,
            Err(err) => {
                tracing::warn!(error = %err, protection_id = %id, "a cloud move step failed; it will retry")
            }
        }
    }
    Step::Done
}

/// How many steps one trickle pass may take before it waits for the next pass.
const STEPS_PER_PASS: usize = 4;

/// What the daemon's background loop calls. With no store (Luna Connect is not active) nothing
/// happens. Otherwise it takes up to a few steps, stopping early when nothing is left to do, the
/// store is full, or every backup is busy. Blocking: call it from a blocking worker.
pub fn trickle(db: &crate::Db, store: Option<&dyn CloudStore>, now: i64) -> usize {
    let Some(store) = store else {
        return 0;
    };
    let mut worked = 0;
    for _ in 0..STEPS_PER_PASS {
        match tick(db, store, now) {
            Step::Moved | Step::Rewrote => worked += 1,
            Step::Done | Step::Busy | Step::PausedFull => break,
        }
    }
    worked
}

fn resync_prefix(protection_id: &str) -> String {
    format!("rewrap_resync:{protection_id}:")
}

/// True while any rewritten snapshot's new record has not reached the cloud yet. Until it has,
/// the cloud record still names the old tree pack, so cleanup must not delete any pack.
/// A marker whose backup no longer exists can never be uploaded, so it never counts.
pub fn record_upload_pending(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM meta WHERE substr(key, 1, 14) = 'rewrap_resync:' \
             AND EXISTS (SELECT 1 FROM protections p \
                         WHERE substr(meta.key, 15, length(p.id) + 1) = p.id || ':') \
             LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Forgets everything the move kept for a backup that is being deleted: its pending record
/// uploads and its counters.
pub fn forget_backup(conn: &Connection, protection_id: &str) -> Result<()> {
    let prefix = resync_prefix(protection_id);
    conn.execute(
        "DELETE FROM meta WHERE substr(key, 1, length(?1)) = ?1",
        params![prefix],
    )?;
    finish_counters(conn, protection_id)
}

/// Uploads the local record of every snapshot whose rewrite was committed but whose new record
/// never reached the cloud (a crash or an upload failure after the commit). The local row is the
/// truth, so the cloud copy is made to match it. A marker is cleared only after its upload worked.
fn resync_records(db: &crate::Db, protection_id: &str, store: &dyn CloudStore) -> Result<()> {
    let prefix = resync_prefix(protection_id);
    let pending: Vec<(String, String)> = {
        let conn = run::lock(db);
        let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?2) = ?1")?;
        stmt.query_map(params![prefix, prefix.len() as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (key, name) in pending {
        let snapshot_id = &key[prefix.len()..];
        let record: Option<Vec<u8>> = run::lock(db)
            .query_row(
                "SELECT record FROM cloud_snapshots WHERE id = ?1",
                params![snapshot_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(record) = record {
            store
                .put_record("snapshots", &name, &record)
                .map_err(|e| anyhow!("{e}"))?;
        }
        run::lock(db).execute("DELETE FROM meta WHERE key = ?1", params![key])?;
    }
    Ok(())
}

// Failpoint for tests: a simulated crash right after a pack upload, before the commit.
#[cfg(test)]
thread_local! {
    static CRASH_AFTER_UPLOAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn crash_point() -> Result<()> {
    #[cfg(test)]
    if CRASH_AFTER_UPLOAD.with(|c| c.replace(false)) {
        bail!("simulated crash after upload");
    }
    Ok(())
}

/// A pack that was never uploaded: forget its pending row. Nothing else refers to it yet.
fn forget_unsent(db: &crate::Db, pack_hex: &str) {
    if let Err(err) = db::delete_pack_row(&run::lock(db), pack_hex) {
        tracing::warn!(error = %err, "could not forget an unsent move pack");
    }
}

/// A pack that was uploaded but not committed. It is marked, so the normal cleanup deletes it
/// after its wait. Its old copies are never touched.
fn mark_uploaded_unused(db: &crate::Db, pack_hex: &str, now: i64) {
    let conn = run::lock(db);
    if let Err(err) = conn.execute(
        "UPDATE cloud_packs SET state = 'marked', marked_at = ?2 WHERE id = ?1",
        params![pack_hex, now],
    ) {
        tracing::warn!(error = %err, "could not mark an unused move pack for cleanup");
    }
}

/// Full storage pauses the move; any other store error fails the step.
fn pause_or_fail(db: &crate::Db, protection_id: &str, err: StoreError) -> Result<Step> {
    match err {
        StoreError::Full => {
            set_paused(&run::lock(db), protection_id, true)?;
            Ok(Step::PausedFull)
        }
        other => Err(anyhow!("{other}")),
    }
}

fn chunk_rows(conn: &Connection, scope: &str, pack_hex: &str) -> Result<Vec<(Vec<u8>, i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT chunk_id, offset, len FROM cloud_chunks
         WHERE scope = ?1 AND pack_id = ?2 ORDER BY offset",
    )?;
    let rows = stmt
        .query_map(params![scope, pack_hex], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Re-seals one older pack under the target key. Verifies the download before re-sealing, and
/// commits the index change and the snapshot links in one transaction.
#[allow(clippy::too_many_arguments)]
fn move_one(
    db: &crate::Db,
    store: &dyn CloudStore,
    protection_id: &str,
    target: &Target,
    scope: &str,
    pack_hex: &str,
    run_id: &str,
    now: i64,
) -> Result<Step> {
    if now < target.created_at {
        bail!("This Luna's clock is set before the newest backup key was made, so the move waits.");
    }
    let (scope_id, _) = scope_of(&target.dedup_key);
    let pack_id = run::unhex(pack_hex)?;

    let (old_keys, rows) = {
        let conn = run::lock(db);
        let old: Vec<BackupKey> = db::list_backup_keys(&conn, protection_id)?
            .into_iter()
            .filter(|k| k.version < target.version)
            .collect();
        (old, chunk_rows(&conn, scope, pack_hex)?)
    };
    if rows.is_empty() {
        bail!("This backup file no longer holds any files to move.");
    }

    // Download, check the bytes hash to the id, and open with an older key. A pack that fails any
    // of these stops the move here. Nothing is changed and nothing is deleted.
    let bytes = store.get_pack(&pack_id).map_err(|e| anyhow!("{e}"))?;
    let opened = format::open_pack(&bytes, &pack_id, run::unwrap_newest_first(&old_keys))?;
    if opened.scope_id() != scope_id {
        bail!("A backup file belongs to another backup. The move stopped and nothing was changed.");
    }

    let mut builder = PackBuilder::new(scope_id);
    for (raw_id, _, _) in &rows {
        let chunk_id = fixed(raw_id)?;
        let plain = opened.chunk(&chunk_id).ok_or_else(|| {
            anyhow!("A backup file is missing a file it should hold. The move stopped and nothing was changed.")
        })?;
        if crypto::chunk_id(&target.dedup_key, plain) != chunk_id {
            bail!(
                "A backup file does not match its contents. The move stopped and nothing was changed."
            );
        }
        builder.add(chunk_id, plain);
    }
    let sealer = SharedSealer {
        key_bytes: target.key,
    };
    let sealed = builder.finish(|pack_key| sealer.wrap_pack_key(pack_key));
    let new_hex = run::hex(&sealed.id);

    {
        let conn = run::lock(db);
        db::insert_pending_pack(&conn, &new_hex, scope, run_id, now)?;
        db::record_pack_size(&conn, &new_hex, sealed.bytes.len() as i64)?;
    }
    if let Err(err) = store.put_pack(&sealed.id, Some(scope), &sealed.bytes) {
        forget_unsent(db, &new_hex);
        return pause_or_fail(db, protection_id, err);
    }

    let committed = crash_point().and_then(|()| {
        commit_move(
            db,
            protection_id,
            target,
            scope,
            &pack_id,
            &new_hex,
            &sealed,
        )
    });
    if let Err(err) = committed {
        mark_uploaded_unused(db, &new_hex, now);
        return Err(err);
    }
    Ok(Step::Moved)
}

/// The index change, the snapshot links, and the byte count, in one transaction.
fn commit_move(
    db: &crate::Db,
    protection_id: &str,
    target: &Target,
    scope: &str,
    old_id: &[u8; 32],
    new_hex: &str,
    sealed: &SealedPack,
) -> Result<()> {
    let old_hex = run::hex(old_id);
    let mut conn = run::lock(db);
    let tx = conn.transaction()?;
    let old_size: i64 = tx.query_row(
        "SELECT size FROM cloud_packs WHERE id = ?1",
        params![old_hex],
        |r| r.get(0),
    )?;
    db::set_pack_live(&tx, new_hex, sealed.bytes.len() as i64)?;
    for (chunk_id, offset, len) in &sealed.entries {
        db::insert_chunk(
            &tx,
            scope,
            chunk_id,
            new_hex,
            *offset as i64,
            i64::from(*len),
        )?;
    }
    // Every snapshot that links the old pack also links the new one, so the new pack is never
    // unused. The old link stays until the snapshot is rewritten.
    let linking: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT sp.snapshot_id FROM cloud_snapshot_packs sp
             JOIN cloud_snapshots s ON s.id = sp.snapshot_id
             WHERE sp.pack_id = ?1 AND s.protection_id = ?2",
        )?;
        stmt.query_map(params![old_hex, protection_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for snapshot_id in &linking {
        tx.execute(
            "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
            params![snapshot_id, new_hex],
        )?;
    }
    let moved = read_moved(&tx, protection_id, target.version)? + old_size.max(0) as u64;
    write_moved(&tx, protection_id, target.version, moved)?;
    set_paused(&tx, protection_id, false)?;
    tx.commit()?;
    Ok(())
}

/// Rewrites one snapshot under the target key once every pack it uses has moved: the tree with
/// its new pack places, the metadata under the new key, and a new signed record. The commit comes
/// first and leaves a marker; the record is uploaded after, and a missed upload is retried from
/// the marker at the start of the next step.
#[allow(clippy::too_many_arguments)]
fn rewrite_one(
    db: &crate::Db,
    store: &dyn CloudStore,
    protection_id: &str,
    target: &Target,
    scope: &str,
    snapshot: &SnapshotInsert,
    run_id: &str,
    now: i64,
) -> Result<Step> {
    let (scope_id, _) = scope_of(&target.dedup_key);
    let (identity, signer, old_key) = {
        let conn = run::lock(db);
        let identity = identity::load(&conn)?
            .ok_or_else(|| anyhow!("Set up cloud backup on this Luna before running a backup."))?;
        let seed: [u8; 32] = db::get_cloud_identity(&conn)?
            .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
            .signing_seed
            .try_into()
            .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;
        let old_key = db::list_backup_keys(&conn, protection_id)?
            .into_iter()
            .find(|k| k.version == snapshot.key_version)
            .ok_or_else(|| anyhow!("The key for a backup's last copy is missing."))?;
        (identity, Signer::from_seed(seed), fixed(&old_key.key)?)
    };
    let old_record = SignedRecord::from_bytes(&snapshot.record)?.verify(&identity.public())?;
    let old_tree = run::read_tree(store, &old_record, &old_key)?;
    let meta = format::decrypt_meta(&old_record.meta, &old_key)?;

    // Point every chunk at its current pack. Each must be a committed pack under the target.
    let (entries, links) = {
        let conn = run::lock(db);
        let mut links = BTreeSet::new();
        let mut entries = Vec::with_capacity(old_tree.entries.len());
        for entry in &old_tree.entries {
            let mut chunks = Vec::with_capacity(entry.chunks.len());
            for chunk in &entry.chunks {
                let (pack_hex, offset, len): (String, i64, i64) = conn
                    .query_row(
                        "SELECT pack_id, offset, len FROM cloud_chunks WHERE scope = ?1 AND chunk_id = ?2",
                        params![scope, chunk.id.as_slice()],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?
                    .ok_or_else(|| anyhow!("A file in this backup is missing from the cloud index. Try the backup again."))?;
                let (state, created_at): (String, i64) = conn.query_row(
                    "SELECT state, created_at FROM cloud_packs WHERE id = ?1",
                    params![pack_hex],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                if state != "live" || created_at < target.created_at {
                    bail!(
                        "A file in this backup is still stored under an older version. The move stopped and nothing was changed."
                    );
                }
                links.insert(pack_hex.clone());
                chunks.push(ChunkRef {
                    id: chunk.id,
                    pack: run::unhex(&pack_hex)?,
                    offset: offset as u64,
                    len: len as u32,
                });
            }
            entries.push(TreeEntry {
                path: entry.path.clone(),
                size: entry.size,
                mtime: entry.mtime,
                chunks,
            });
        }
        (entries, links)
    };

    let sealer = SharedSealer {
        key_bytes: target.key,
    };
    let tree = Tree { entries };
    let tree_bytes = format::encrypt_tree(&tree, &target.key);
    let tree_hash = format::sha256(&tree_bytes);
    let mut builder = PackBuilder::new(scope_id);
    let (tree_offset, tree_len) = builder.add(tree_hash, &tree_bytes);
    let tree_pack = builder.finish(|pack_key| sealer.wrap_pack_key(pack_key));
    let tree_hex = run::hex(&tree_pack.id);

    let record = SnapshotRecord {
        luna_id: identity.luna_id.clone(),
        protection_id: protection_id.to_string(),
        snapshot_id: snapshot.id.clone(),
        created_at: old_record.created_at,
        key_version: target.version as u32,
        tree_pack_id: tree_pack.id,
        tree_hash,
        meta: format::encrypt_meta(&meta, &target.key),
    };
    let (kind, name, signed) = sealer.finish_record(record, &signer);

    {
        let conn = run::lock(db);
        db::insert_pending_pack(&conn, &tree_hex, scope, run_id, now)?;
        db::record_pack_size(&conn, &tree_hex, tree_pack.bytes.len() as i64)?;
    }
    if let Err(err) = store.put_pack(&tree_pack.id, Some(scope), &tree_pack.bytes) {
        forget_unsent(db, &tree_hex);
        return pause_or_fail(db, protection_id, err);
    }
    // Commit locally first, then publish the record. The commit also leaves a marker, so a crash
    // or a failed upload before the record is out is finished by `resync_records`. The old record
    // stays valid meanwhile: the old tree pack is only marked, and waits before it is deleted.
    let committed = commit_rewrite(
        db,
        protection_id,
        target,
        scope,
        snapshot,
        &tree_hex,
        &tree_hash,
        (tree_offset, tree_len),
        &signed,
        &name,
        links,
        now,
    );
    if let Err(err) = committed {
        mark_uploaded_unused(db, &tree_hex, now);
        return Err(err);
    }
    crash_point()?;
    store
        .put_record(kind, &name, &signed)
        .map_err(|e| anyhow!("{e}"))?;
    run::lock(db).execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{}{}", resync_prefix(protection_id), snapshot.id)],
    )?;
    Ok(Step::Rewrote)
}

/// The snapshot row, its pack links and the tree's index row, in one transaction. Packs no
/// snapshot uses any more are marked for the normal cleanup.
#[allow(clippy::too_many_arguments)]
fn commit_rewrite(
    db: &crate::Db,
    protection_id: &str,
    target: &Target,
    scope: &str,
    snapshot: &SnapshotInsert,
    tree_hex: &str,
    tree_hash: &[u8; 32],
    tree_place: (u64, u32),
    signed: &[u8],
    record_name: &str,
    mut links: BTreeSet<String>,
    now: i64,
) -> Result<()> {
    let mut conn = run::lock(db);
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE cloud_snapshots SET key_version = ?2, tree_pack_id = ?3, record = ?4 WHERE id = ?1",
        params![snapshot.id, target.version, tree_hex, signed],
    )?;
    tx.execute(
        "DELETE FROM cloud_snapshot_packs WHERE snapshot_id = ?1",
        params![snapshot.id],
    )?;
    // The old tree pack holds only its tree, so its index row goes with it.
    tx.execute(
        "DELETE FROM cloud_chunks WHERE scope = ?1 AND pack_id = ?2",
        params![scope, snapshot.tree_pack_id],
    )?;
    db::insert_chunk(
        &tx,
        scope,
        tree_hash,
        tree_hex,
        tree_place.0 as i64,
        i64::from(tree_place.1),
    )?;
    links.insert(tree_hex.to_string());
    for pack in &links {
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM cloud_packs WHERE id = ?1",
                params![pack],
                |r| r.get(0),
            )
            .optional()?;
        match state.as_deref() {
            None => bail!("Backup pack {pack} is missing from the database."),
            Some("deleting") => {
                bail!("Backup pack {pack} is being removed, so this backup cannot use it.")
            }
            _ => {}
        }
        tx.execute(
            "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
            params![snapshot.id, pack],
        )?;
        tx.execute(
            "UPDATE cloud_packs SET state = 'live', marked_at = 0 WHERE id = ?1",
            params![pack],
        )?;
    }
    tx.execute(
        "UPDATE cloud_packs SET state = 'marked', marked_at = ?2
         WHERE scope = ?1 AND state = 'live'
           AND id NOT IN (SELECT pack_id FROM cloud_snapshot_packs)",
        params![scope, now],
    )?;
    set_paused(&tx, protection_id, false)?;
    db::set_meta(
        &tx,
        &format!("{}{}", resync_prefix(protection_id), snapshot.id),
        record_name,
    )?;
    tx.commit()?;
    Ok(())
}

/// Test store that notes whether the backup's drive-backup hold was taken during any call.
/// A restore tries that hold, so "held while the store is used" means a restore would be refused.
#[cfg(test)]
pub(crate) struct HoldProbe {
    pub(crate) inner: super::store::MemoryStore,
    holds: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    id: String,
    pub(crate) saw_held: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl HoldProbe {
    pub(crate) fn new(db: &crate::Db, id: &str) -> Self {
        Self {
            inner: super::store::MemoryStore::new(),
            holds: std::sync::Arc::clone(db.backup_holds()),
            id: id.to_string(),
            saw_held: Default::default(),
        }
    }

    fn note(&self) {
        let held = self.holds.lock().unwrap().contains(&self.id);
        if held {
            self.saw_held
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
impl CloudStore for HoldProbe {
    fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
        self.note();
        self.inner.put_pack(id, scope, bytes)
    }
    fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
        self.note();
        self.inner.get_pack(id)
    }
    fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
        self.note();
        self.inner.delete_pack(id)
    }
    fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.note();
        self.inner.put_record(kind, name, bytes)
    }
    fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.note();
        self.inner.get_record(kind, name)
    }
    fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
        self.note();
        self.inner.delete_record(kind, name)
    }
    fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
        self.note();
        self.inner.list_records(kind)
    }
    fn usage(&self) -> Result<super::store::Usage, StoreError> {
        self.note();
        self.inner.usage()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use rand_core::{OsRng, RngCore};

    use super::*;
    use crate::backup::cloud::keys;
    use crate::backup::cloud::store::{MemoryStore, Usage};

    type Files = BTreeMap<String, Vec<u8>>;

    /// Wraps the in-memory store so tests can fail uploads, corrupt downloads, and count deletes.
    struct Faulty {
        inner: MemoryStore,
        full: AtomicBool,
        fail_records: AtomicBool,
        corrupt: Mutex<Vec<[u8; 32]>>,
        deletes: AtomicUsize,
    }

    impl Faulty {
        fn new() -> Self {
            Self {
                inner: MemoryStore::new(),
                full: AtomicBool::new(false),
                fail_records: AtomicBool::new(false),
                corrupt: Mutex::new(Vec::new()),
                deletes: AtomicUsize::new(0),
            }
        }
    }

    impl CloudStore for Faulty {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
            if self.full.load(Ordering::SeqCst) {
                return Err(StoreError::Full);
            }
            self.inner.put_pack(id, scope, bytes)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            let mut bytes = self.inner.get_pack(id)?;
            if self.corrupt.lock().unwrap().contains(id)
                && let Some(last) = bytes.last_mut()
            {
                *last ^= 1;
            }
            Ok(bytes)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            if self.fail_records.load(Ordering::SeqCst) {
                return Err(StoreError::Unavailable("records are down".into()));
            }
            self.inner.put_record(kind, name, bytes)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    fn setup(dir: &Path) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "admin").unwrap();
        identity::load_or_create(&conn, 1).unwrap();
        let keys = crypto::derive(&[7u8; 16], "luna-test");
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: "owner".into(),
                seal_public: keys.seal_public.to_vec(),
                auth_public: keys.auth_public.to_vec(),
                self_sealed: vec![3; 48],
                phrase_set_at: 1,
                last_checked_at: 0,
            },
        )
        .unwrap();
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id: "rw",
                kind: "folder",
                source_drive: "drive-src",
                source_path: "rw",
                target_drive: "drive-dst",
                private_owner: "",
                created_by: "owner",
                created_at: 1,
            },
        )
        .unwrap();
        crate::Db::new(conn)
    }

    fn random_vec(len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        OsRng.fill_bytes(&mut v);
        v
    }

    /// Two files, the first large enough to fill more than one pack.
    fn source(dir: &Path) -> PathBuf {
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.bin"), random_vec(10 << 20)).unwrap();
        std::fs::write(src.join("b.bin"), random_vec(3 << 20)).unwrap();
        src
    }

    fn read_files(src: &Path) -> Files {
        let mut out = BTreeMap::new();
        for name in ["a.bin", "b.bin"] {
            out.insert(name.to_string(), std::fs::read(src.join(name)).unwrap());
        }
        out
    }

    fn run_at(db: &crate::Db, src: &Path, store: &dyn CloudStore, now: i64) {
        let out = run::run_with_root(db, "rw", src, store, "user-1", false, now).unwrap();
        assert_eq!(out.problem, None);
    }

    /// Versions are written in order: version 1 at 100, a rotation at 200 with no changes, and a
    /// change to a.bin at 300 that lands under version 2. Returns the snapshots (newest first),
    /// the files as first saved, and the files as they are now.
    struct Built {
        snapshots: Vec<String>,
        original: Files,
        current: Files,
    }

    fn build(db: &crate::Db, src: &Path, store: &dyn CloudStore) -> Built {
        run_at(db, src, store, 100);
        let original = read_files(src);
        keys::mark_rotate(&run::lock(db), "rw").unwrap();
        run_at(db, src, store, 200);
        let mut data = std::fs::read(src.join("a.bin")).unwrap();
        data[100] ^= 0xff;
        std::fs::write(src.join("a.bin"), data).unwrap();
        run_at(db, src, store, 300);
        let current = read_files(src);
        let ids = snapshots(db).into_iter().map(|s| s.id).collect();
        Built {
            snapshots: ids,
            original,
            current,
        }
    }

    fn snapshots(db: &crate::Db) -> Vec<SnapshotInsert> {
        db::list_cloud_snapshots(&run::lock(db), "rw").unwrap()
    }

    fn held_keys(db: &crate::Db, only: Option<i64>) -> Vec<BackupKey> {
        db::list_backup_keys(&run::lock(db), "rw")
            .unwrap()
            .into_iter()
            .filter(|k| only.is_none_or(|v| k.version == v))
            .collect()
    }

    fn drain(db: &crate::Db, store: &dyn CloudStore, mut now: i64) -> Vec<Step> {
        let mut steps = Vec::new();
        for _ in 0..200 {
            now += 10;
            let outcome = step(db, "rw", store, now).unwrap();
            steps.push(outcome);
            if outcome == Step::Done {
                return steps;
            }
        }
        panic!("the move did not finish");
    }

    /// Rebuilds every file of one snapshot from its packs, opening each with `keys_held`.
    fn restore(
        db: &crate::Db,
        store: &dyn CloudStore,
        snapshot_id: &str,
        keys_held: &[BackupKey],
    ) -> anyhow::Result<Files> {
        let (record, tree_key) = {
            let conn = run::lock(db);
            let snap = db::list_cloud_snapshots(&conn, "rw")?
                .into_iter()
                .find(|s| s.id == snapshot_id)
                .ok_or_else(|| anyhow!("no such snapshot"))?;
            let identity = identity::load(&conn)?.unwrap();
            let record = SignedRecord::from_bytes(&snap.record)?.verify(&identity.public())?;
            let key = keys_held
                .iter()
                .find(|k| k.version == snap.key_version)
                .ok_or_else(|| anyhow!("key for the snapshot is not held"))?;
            (record, fixed(&key.key)?)
        };
        let tree = run::read_tree(store, &record, &tree_key)?;
        let mut out = BTreeMap::new();
        for entry in &tree.entries {
            let mut data = Vec::new();
            for chunk in &entry.chunks {
                let bytes = store.get_pack(&chunk.pack).map_err(|e| anyhow!("{e}"))?;
                let opened =
                    format::open_pack(&bytes, &chunk.pack, run::unwrap_newest_first(keys_held))?;
                data.extend_from_slice(
                    opened
                        .chunk(&chunk.id)
                        .ok_or_else(|| anyhow!("chunk missing from its pack"))?,
                );
            }
            out.insert(entry.path.clone(), data);
        }
        Ok(out)
    }

    /// Data packs of the protection created before `before` with their size and whether they hold chunks.
    fn old_data_packs(db: &crate::Db, before: i64) -> Vec<(String, i64, bool)> {
        let conn = run::lock(db);
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.size, EXISTS (SELECT 1 FROM cloud_chunks c WHERE c.pack_id = p.id)
                 FROM cloud_packs p
                 WHERE p.created_at < ?1 AND p.id NOT IN (SELECT tree_pack_id FROM cloud_snapshots)
                 ORDER BY p.id",
            )
            .unwrap();
        stmt.query_map(params![before], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    }

    fn pack_states(db: &crate::Db) -> Vec<(String, String)> {
        let conn = run::lock(db);
        let mut stmt = conn
            .prepare("SELECT id, state FROM cloud_packs ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn chunk_index(db: &crate::Db) -> Vec<(Vec<u8>, String)> {
        let conn = run::lock(db);
        let mut stmt = conn
            .prepare("SELECT chunk_id, pack_id FROM cloud_chunks ORDER BY chunk_id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn sum_bytes(packs: &[(String, i64, bool)], with_chunks: bool) -> i64 {
        packs
            .iter()
            .filter(|(_, _, chunks)| *chunks == with_chunks)
            .map(|(_, size, _)| size)
            .sum()
    }

    #[test]
    fn percent_is_moved_over_moved_plus_still_old() {
        assert_eq!(percent(0, 0), 100);
        assert_eq!(percent(0, 10), 0);
        assert_eq!(percent(3, 1), 75);
        assert_eq!(percent(10, 0), 100);
        assert_eq!(percent(1, 2), 33);
        assert_eq!(percent(1, 99), 1);
    }

    #[test]
    fn one_step_moves_one_pack_and_status_reports_the_bytes_moved() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        let before = old_data_packs(&db, 200);
        assert!(
            before.iter().filter(|p| p.2).count() >= 2,
            "the data should fill two packs"
        );
        let total = sum_bytes(&before, true);
        let status_before = status(&run::lock(&db), "rw").unwrap().unwrap();
        assert_eq!(
            status_before,
            MoveStatus {
                percent: 0,
                paused_full: false
            }
        );

        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);

        let after = old_data_packs(&db, 200);
        let remaining = sum_bytes(&after, true);
        let moved = total - remaining;
        assert!(moved > 0 && remaining > 0);
        let status_after = status(&run::lock(&db), "rw").unwrap().unwrap();
        assert_eq!(status_after.percent, (moved * 100 / total) as u32);
        assert_eq!(
            status_json(&run::lock(&db), "rw"),
            json!({ "percent": status_after.percent, "paused_full": false })
        );
    }

    #[test]
    fn mixed_version_snapshots_restore_before_and_after_the_move() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let built = build(&db, &src, &store);
        let all = held_keys(&db, None);

        // Before the move, each snapshot opens with the keys it was sealed under.
        let expected = [&built.current, &built.original, &built.original];
        for (id, want) in built.snapshots.iter().zip(expected) {
            assert_eq!(&restore(&db, &store, id, &all).unwrap(), want);
        }

        drain(&db, &store, 400);

        // After the move, the newest key alone opens every snapshot.
        let newest = held_keys(&db, Some(2));
        for (id, want) in built.snapshots.iter().zip(expected) {
            assert_eq!(&restore(&db, &store, id, &newest).unwrap(), want);
        }
    }

    #[test]
    fn a_full_move_rewrites_each_snapshot_and_marks_the_old_packs() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        drain(&db, &store, 400);

        let newest = held_keys(&db, Some(2));
        let identity = identity::load(&run::lock(&db)).unwrap().unwrap();
        for snap in snapshots(&db) {
            assert_eq!(snap.key_version, 2);
            let record = SignedRecord::from_bytes(&snap.record)
                .unwrap()
                .verify(&identity.public())
                .unwrap();
            assert_eq!(record.key_version, 2);
            // The metadata is sealed under the new key, so a reader holding only it can open it.
            assert!(
                format::decrypt_meta(&record.meta, &newest[0].key.as_slice().try_into().unwrap())
                    .is_ok()
            );
        }
        let conn = run::lock(&db);
        let stray: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_packs WHERE state = 'live'
                   AND id NOT IN (SELECT pack_id FROM cloud_snapshot_packs)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stray, 0, "every live pack must be used by a snapshot");
        let marked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_packs WHERE state = 'marked'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            marked >= 5,
            "old data and tree packs are marked for cleanup, got {marked}"
        );
        drop(conn);

        // Done is stable: a second pass adds nothing and the counters are gone.
        let packs = pack_states(&db);
        assert_eq!(step(&db, "rw", &store, 500).unwrap(), Step::Done);
        assert_eq!(pack_states(&db), packs);
        assert_eq!(status(&run::lock(&db), "rw").unwrap(), None);
        assert_eq!(status_json(&run::lock(&db), "rw"), Value::Null);
    }

    #[test]
    fn a_snapshot_is_rewritten_only_after_all_its_packs_move() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let built = build(&db, &src, &store);

        let before = snapshots(&db).into_iter().next().unwrap();
        assert_eq!(before.id, built.snapshots[0]);
        assert_eq!(
            before.key_version, 2,
            "the newest snapshot was made under version 2"
        );

        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
        // The newest snapshot still has an older pack to move, so its tree is not rewritten yet.
        let after = snapshots(&db).into_iter().next().unwrap();
        assert_eq!(after.tree_pack_id, before.tree_pack_id);
        assert_eq!(after.record, before.record);
    }

    #[test]
    fn a_crash_after_upload_resumes_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let built = build(&db, &src, &store);

        CRASH_AFTER_UPLOAD.with(|c| c.set(true));
        let err = step(&db, "rw", &store, 400).unwrap_err();
        assert!(err.to_string().contains("simulated crash"));
        {
            // The uploaded copy is marked for cleanup, and no index row points at it.
            let conn = run::lock(&db);
            let orphans: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM cloud_chunks c JOIN cloud_packs p ON p.id = c.pack_id
                     WHERE p.state = 'marked'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(orphans, 0);
        }

        drain(&db, &store, 500);
        let newest = held_keys(&db, Some(2));
        let expected = [&built.current, &built.original, &built.original];
        for (id, want) in built.snapshots.iter().zip(expected) {
            assert_eq!(&restore(&db, &store, id, &newest).unwrap(), want);
        }
        // Every index row points at a live pack once the move is done.
        let conn = run::lock(&db);
        let on_unlive: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_chunks c JOIN cloud_packs p ON p.id = c.pack_id
                 WHERE p.state != 'live'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(on_unlive, 0);
    }

    #[test]
    fn a_rotation_with_a_new_dedup_key_leaves_older_snapshots_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        run_at(&db, &src, &store, 100);
        // A membership change rotates to version 2 with a fresh dedup key. Readers open the
        // version 1 snapshot with their own version 1 key, so there is nothing to move.
        db::insert_backup_key(
            &run::lock(&db),
            &BackupKey {
                protection_id: "rw".into(),
                version: 2,
                key: random_vec(32),
                dedup_key: random_vec(32),
                created_at: 200,
            },
        )
        .unwrap();
        assert!(status(&run::lock(&db), "rw").unwrap().is_none());
        assert_eq!(step(&db, "rw", &store, 300).unwrap(), Step::Done);
        assert_eq!(step(&db, "rw", &store, 310).unwrap(), Step::Done);
        // Nothing was rewritten: the snapshot is still under version 1.
        assert_eq!(snapshots(&db)[0].key_version, 1);
        assert_eq!(rewrap_run_count(&db), 0);
    }

    /// Runs opened by move steps. A backup run is not counted because it names no key move.
    fn rewrap_run_count(db: &crate::Db) -> i64 {
        run::lock(db)
            .query_row(
                "SELECT COUNT(*) FROM cloud_runs WHERE started_at >= 300",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    #[test]
    fn the_move_shows_only_to_the_backups_readers() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);
        let user = |id: &str, role: &str| crate::auth::CurrentUser {
            id: id.into(),
            username: id.into(),
            role: role.into(),
        };
        let conn = run::lock(&db);
        // The reader sees the move.
        assert!(status_for_luna(&conn, &user("owner", "member")).is_object());
        // Someone who is not on the backup's newest reader list and is no Admin does not.
        assert!(status_for_luna(&conn, &user("stranger", "member")).is_null());
        let row = db::get_protection(&conn, "rw").unwrap().unwrap();
        assert!(status_json_for(&conn, &row, &user("stranger", "member")).is_null());
        assert!(status_json_for(&conn, &row, &user("owner", "member")).is_object());
    }

    /// Steps until the next piece of work is a snapshot rewrite.
    fn step_until_rewrite_is_next(db: &crate::Db, store: &dyn CloudStore, mut now: i64) -> i64 {
        for _ in 0..200 {
            let next_is_rewrite = {
                let conn = run::lock(db);
                let target = load_target(&conn, "rw").unwrap().unwrap();
                let (_, scope) = scope_of(&target.dedup_key);
                matches!(
                    next_work(&conn, "rw", &target, &scope).unwrap(),
                    Some(Work::Rewrite(_))
                )
            };
            if next_is_rewrite {
                return now;
            }
            now += 10;
            step(db, "rw", store, now).unwrap();
        }
        panic!("no rewrite came up");
    }

    #[test]
    fn a_crash_after_the_commit_still_publishes_the_new_record() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let built = build(&db, &src, &store);

        let now = step_until_rewrite_is_next(&db, &store, 400);
        CRASH_AFTER_UPLOAD.with(|c| c.set(true));
        let err = step(&db, "rw", &store, now + 10).unwrap_err();
        assert!(err.to_string().contains("simulated crash"));

        // The local row is rewritten and its tree pack is live; the cloud still has the old record.
        let rewritten: Vec<SnapshotInsert> = snapshots(&db)
            .into_iter()
            .filter(|s| {
                store.get_record("snapshots", &s.id).unwrap().as_deref() != Some(&s.record[..])
            })
            .collect();
        assert_eq!(rewritten.len(), 1);
        let state: String = run::lock(&db)
            .query_row(
                "SELECT state FROM cloud_packs WHERE id = ?1",
                params![rewritten[0].tree_pack_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "live");

        // The next step puts the local record in the cloud before anything else.
        drain(&db, &store, now + 100);
        for snap in snapshots(&db) {
            assert_eq!(
                store.get_record("snapshots", &snap.id).unwrap().as_deref(),
                Some(&snap.record[..]),
                "the cloud record must match the local one"
            );
        }
        let markers: i64 = run::lock(&db)
            .query_row(
                "SELECT COUNT(*) FROM meta WHERE key LIKE 'rewrap_resync:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(markers, 0);
        let newest = held_keys(&db, Some(2));
        let expected = [&built.current, &built.original, &built.original];
        for (id, want) in built.snapshots.iter().zip(expected) {
            assert_eq!(&restore(&db, &store, id, &newest).unwrap(), want);
        }
    }

    #[test]
    fn the_trickle_does_nothing_without_a_store_and_finishes_the_move_with_one() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        let before = pack_states(&db);
        assert_eq!(trickle(&db, None, 400), 0);
        assert_eq!(pack_states(&db), before);

        let mut passes = 0;
        while trickle(&db, Some(&store), 500) > 0 {
            passes += 1;
            assert!(passes < 100, "the trickle never finished");
        }
        assert!(passes > 0);
        for snap in snapshots(&db) {
            assert_eq!(snap.key_version, 2);
        }
        assert_eq!(status(&run::lock(&db), "rw").unwrap(), None);
    }

    #[test]
    fn a_full_store_pauses_the_move_and_deletes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = Faulty::new();
        let built = build(&db, &src, &store);
        let index = chunk_index(&db);
        let old = old_data_packs(&db, 200);

        store.full.store(true, Ordering::SeqCst);
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::PausedFull);

        let paused = status(&run::lock(&db), "rw").unwrap().unwrap();
        assert!(paused.paused_full);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(
            chunk_index(&db),
            index,
            "the index keeps pointing at the old packs"
        );
        for (id, _, _) in &old {
            assert!(
                store.get_pack(&run::unhex(id).unwrap()).is_ok(),
                "old pack {id} must stay"
            );
        }
        // The old copy still restores while the move waits.
        let all = held_keys(&db, None);
        assert_eq!(
            restore(&db, &store, &built.snapshots[0], &all).unwrap(),
            built.current
        );

        store.full.store(false, Ordering::SeqCst);
        assert_eq!(step(&db, "rw", &store, 500).unwrap(), Step::Moved);
        let resumed = status(&run::lock(&db), "rw").unwrap().unwrap();
        assert!(!resumed.paused_full);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_second_rotation_retargets_the_move() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
        keys::mark_rotate(&run::lock(&db), "rw").unwrap();
        run_at(&db, &src, &store, 500);
        let latest = held_keys(&db, None).last().unwrap().version;
        assert_eq!(latest, 3);

        // The move starts over for version 3: nothing has moved to it yet.
        let moving = status(&run::lock(&db), "rw").unwrap().unwrap();
        assert_eq!(moving.percent, 0);
        // The pack moved to version 2 is old again, and moves a second time.
        assert_eq!(step(&db, "rw", &store, 600).unwrap(), Step::Moved);
        drain(&db, &store, 600);

        let newest = held_keys(&db, Some(3));
        let current = read_files(&src);
        let wanted = [current.clone(), current.clone()];
        let snaps = snapshots(&db);
        assert_eq!(snaps.len(), 4);
        for snap in &snaps {
            assert_eq!(snap.key_version, 3);
        }
        for (snap, want) in snaps.iter().take(2).zip(wanted) {
            assert_eq!(restore(&db, &store, &snap.id, &newest).unwrap(), want);
        }
    }

    #[test]
    fn a_step_takes_the_drive_backup_hold_and_frees_it_after() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = HoldProbe::new(&db, "rw");
        build(&db, &src, &store);
        store.saw_held.store(false, Ordering::SeqCst);

        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
        // While the step worked, a restore would have been refused.
        assert!(store.saw_held.load(Ordering::SeqCst));
        // Afterwards the hold is free again.
        assert!(!crate::backup::drive_backup::is_running(&db, "rw"));
        assert!(crate::backup::drive_backup::try_hold(&db, "rw").is_some());
    }

    #[test]
    fn a_restore_holding_the_backup_makes_the_step_busy_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);
        let index = chunk_index(&db);

        let restore = crate::backup::drive_backup::try_hold(&db, "rw").unwrap();
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Busy);
        assert_eq!(chunk_index(&db), index);
        // The refused step did not leave the cloud run lock behind.
        assert!(RunSlot::take(&db, "rw").is_some());
        drop(restore);
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
    }

    #[test]
    fn a_failed_step_frees_the_hold() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        CRASH_AFTER_UPLOAD.with(|c| c.set(true));
        assert!(step(&db, "rw", &store, 400).is_err());
        assert!(!crate::backup::drive_backup::is_running(&db, "rw"));
        assert!(RunSlot::take(&db, "rw").is_some());
    }

    #[test]
    fn a_hold_in_another_database_does_not_make_the_step_busy() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let other_dir = tempfile::tempdir().unwrap();
        let other = setup(other_dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        let _elsewhere = crate::backup::drive_backup::try_hold(&other, "rw").unwrap();
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
    }

    #[test]
    fn a_held_run_lock_makes_the_step_wait() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);
        let index = chunk_index(&db);

        let slot = RunSlot::take(&db, "rw").unwrap();
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Busy);
        assert_eq!(chunk_index(&db), index);
        drop(slot);
        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
    }

    #[test]
    fn a_pack_that_fails_its_hash_check_stops_the_move_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = Faulty::new();
        let built = build(&db, &src, &store);
        let index = chunk_index(&db);
        let states = pack_states(&db);
        let old = old_data_packs(&db, 200);
        store
            .corrupt
            .lock()
            .unwrap()
            .extend(old.iter().map(|(id, _, _)| run::unhex(id).unwrap()));

        let err = step(&db, "rw", &store, 400).unwrap_err();
        assert!(err.to_string().contains("fingerprint"), "got: {err}");
        assert_eq!(chunk_index(&db), index);
        assert_eq!(pack_states(&db), states);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);

        store.corrupt.lock().unwrap().clear();
        let all = held_keys(&db, None);
        assert_eq!(
            restore(&db, &store, &built.snapshots[0], &all).unwrap(),
            built.current
        );
    }

    #[test]
    fn a_missing_old_key_stops_the_move_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = Faulty::new();
        build(&db, &src, &store);
        let index = chunk_index(&db);
        run::lock(&db)
            .execute("DELETE FROM backup_keys WHERE version = 1", [])
            .unwrap();

        let err = step(&db, "rw", &store, 400).unwrap_err();
        assert!(
            err.to_string().contains("could not be opened"),
            "got: {err}"
        );
        assert_eq!(chunk_index(&db), index);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_clock_behind_the_newest_key_waits_instead_of_looping() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);
        let index = chunk_index(&db);

        let err = step(&db, "rw", &store, 150).unwrap_err();
        assert!(err.to_string().contains("clock"), "got: {err}");
        assert_eq!(chunk_index(&db), index);
    }

    #[test]
    fn private_backups_are_not_moved_here() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        db::insert_protection(
            &run::lock(&db),
            &db::NewProtection {
                id: "priv",
                kind: "folder",
                source_drive: "drive-src",
                source_path: "priv",
                target_drive: "drive-dst",
                private_owner: "owner",
                created_by: "owner",
                created_at: 1,
            },
        )
        .unwrap();
        let store = MemoryStore::new();
        assert_eq!(step(&db, "priv", &store, 400).unwrap(), Step::Done);
        assert_eq!(status(&run::lock(&db), "priv").unwrap(), None);
    }

    #[test]
    fn runs_and_moves_take_turns_and_the_tick_finds_the_work() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let built = build(&db, &src, &store);

        assert_eq!(step(&db, "rw", &store, 400).unwrap(), Step::Moved);
        run_at(&db, &src, &store, 450);
        assert_eq!(tick(&db, &store, 460), Step::Moved);
        run_at(&db, &src, &store, 470);
        drain(&db, &store, 480);

        let newest = held_keys(&db, Some(2));
        let snaps = snapshots(&db);
        assert_eq!(
            restore(&db, &store, &snaps[0].id, &newest).unwrap(),
            built.current
        );
        assert_eq!(tick(&db, &store, 900), Step::Done);
    }

    #[test]
    fn a_backup_with_nothing_to_move_reports_no_status() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        assert_eq!(status(&run::lock(&db), "rw").unwrap(), None);
        assert_eq!(status_json(&run::lock(&db), "rw"), Value::Null);
        let owner = crate::auth::CurrentUser {
            id: "owner".into(),
            username: "owner".into(),
            role: "admin".into(),
        };
        assert_eq!(status_for_luna(&run::lock(&db), &owner), Value::Null);
    }

    fn tree_pack_ids(db: &crate::Db) -> Vec<String> {
        snapshots(db).into_iter().map(|s| s.tree_pack_id).collect()
    }

    #[test]
    fn cleanup_deletes_nothing_while_a_new_record_is_not_in_the_cloud() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);

        let now = step_until_rewrite_is_next(&db, &store, 400);
        let before = tree_pack_ids(&db);
        CRASH_AFTER_UPLOAD.with(|c| c.set(true));
        assert!(step(&db, "rw", &store, now + 10).is_err());
        let after = tree_pack_ids(&db);
        let replaced: Vec<&String> = before.iter().filter(|id| !after.contains(id)).collect();
        assert_eq!(replaced.len(), 1, "one tree pack was replaced");
        let old_id = run::unhex(replaced[0]).unwrap();
        assert!(
            run::lock(&db)
                .query_row(
                    "SELECT state FROM cloud_packs WHERE id = ?1",
                    params![replaced[0]],
                    |r| r.get::<_, String>(0)
                )
                .unwrap()
                == "marked"
        );
        assert!(record_upload_pending(&run::lock(&db)).unwrap());

        // A day and more later, the cloud record still names the old tree pack. Cleanup waits.
        let late = now + 10 * 86_400;
        let out =
            crate::backup::cloud::retention::thin(&db, "", &scope_for(&db), &store, late).unwrap();
        assert_eq!(out.packs_deleted, 0);
        assert!(
            store.get_pack(&old_id).is_ok(),
            "the old tree pack must stay"
        );

        // The next step publishes the record first. Only then may cleanup delete the old pack.
        step(&db, "rw", &store, late + 1).unwrap();
        assert!(!record_upload_pending(&run::lock(&db)).unwrap());
        for snap in snapshots(&db) {
            assert_eq!(
                store.get_record("snapshots", &snap.id).unwrap().as_deref(),
                Some(&snap.record[..])
            );
        }
        crate::backup::cloud::retention::thin(&db, "", &scope_for(&db), &store, late + 2).unwrap();
        crate::backup::cloud::retention::thin(&db, "", &scope_for(&db), &store, late + 3 + 86_400)
            .unwrap();
        assert!(
            store.get_pack(&old_id).is_err(),
            "now the old pack is cleaned up"
        );
    }

    fn scope_for(db: &crate::Db) -> String {
        let conn = run::lock(db);
        let target = load_target(&conn, "rw").unwrap().unwrap();
        scope_of(&target.dedup_key).1
    }

    #[test]
    fn a_failed_record_upload_blocks_cleanup_until_it_works() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = Faulty::new();
        build(&db, &src, &store);
        let now = step_until_rewrite_is_next(&db, &store, 400);
        CRASH_AFTER_UPLOAD.with(|c| c.set(true));
        assert!(step(&db, "rw", &store, now + 10).is_err());

        store.fail_records.store(true, Ordering::SeqCst);
        assert!(resync_records(&db, "rw", &store).is_err());
        assert!(
            record_upload_pending(&run::lock(&db)).unwrap(),
            "a marker stays until its upload worked"
        );
        crate::backup::cloud::ops::sweep(&db, &store, now + 10 * 86_400);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);

        store.fail_records.store(false, Ordering::SeqCst);
        resync_records(&db, "rw", &store).unwrap();
        assert!(!record_upload_pending(&run::lock(&db)).unwrap());
    }

    #[test]
    fn the_sweep_runs_the_move_and_pauses_without_deleting_when_full() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = Faulty::new();
        build(&db, &src, &store);

        store.full.store(true, Ordering::SeqCst);
        let late = 400 + 10 * 86_400;
        crate::backup::cloud::ops::sweep(&db, &store, late);
        assert!(status(&run::lock(&db), "rw").unwrap().unwrap().paused_full);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
        assert!(snapshots(&db).iter().any(|s| s.key_version == 1));

        store.full.store(false, Ordering::SeqCst);
        for i in 0..50 {
            crate::backup::cloud::ops::sweep(&db, &store, late + i * 10);
        }
        for snap in snapshots(&db) {
            assert_eq!(snap.key_version, 2);
        }
        assert_eq!(status(&run::lock(&db), "rw").unwrap(), None);
    }

    #[test]
    fn the_sweep_skips_a_backup_that_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        build(&db, &src, &store);
        let before = pack_states(&db);
        let slot = RunSlot::take(&db, "rw").unwrap();
        crate::backup::cloud::ops::sweep(&db, &store, 500);
        assert_eq!(pack_states(&db), before);
        drop(slot);
    }
}
