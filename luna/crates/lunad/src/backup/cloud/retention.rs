//! Cloud retention (plan §5): which snapshots stay, and how packs that no
//! snapshot uses are marked, waited on, and deleted from the cloud.

use std::collections::HashSet;
use std::sync::MutexGuard;

use anyhow::{anyhow, bail};
use rusqlite::{params, Connection, OptionalExtension};

use crate::backup::cloud::store::{CloudStore, StoreError};
use crate::backup::drive_store::keep_versions;
use crate::db;

/// Seconds a pack stays `marked` before it may be deleted. Matches `db::deletable_packs`.
const GRACE_SECS: i64 = 86_400;

/// What one `thin` pass changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Thinned {
    pub snapshots_removed: u32,
    pub packs_marked: u32,
    pub packs_deleted: u32,
    pub bytes_freed: u64,
}

/// Drop the snapshots the retention buckets no longer keep, then mark and delete
/// packs nothing uses. Safe to run again at any time: a pass that stops part-way
/// is finished by the next one.
pub fn thin(
    db: &crate::Db,
    protection_id: &str,
    scope: &str,
    store: &dyn CloudStore,
    now: i64,
) -> anyhow::Result<Thinned> {
    let mut out = Thinned::default();

    // Snapshots, newest first. The latest one is always kept.
    let snapshots = {
        let conn = lock(db)?;
        db::list_cloud_snapshots(&conn, protection_id)?
    };
    let times: Vec<i64> = snapshots.iter().map(|s| s.created_at).collect();
    let keep_times: HashSet<i64> = keep_versions(&times, now).into_iter().collect();
    let mut seen_times = HashSet::new();
    for (index, snap) in snapshots.iter().enumerate() {
        // keep_versions works on times, so keep only the first snapshot at each kept time.
        let first_at_time = seen_times.insert(snap.created_at);
        let keep = index == 0 || (first_at_time && keep_times.contains(&snap.created_at));
        if keep {
            continue;
        }
        // Store first: if it fails, the row stays and the next pass tries again.
        match store.delete_record("snapshots", &snap.id) {
            Ok(()) | Err(StoreError::NotFound) => {}
            Err(e) => return Err(anyhow!("{e}")),
        }
        let conn = lock(db)?;
        db::delete_cloud_snapshot(&conn, &snap.id)?;
        out.snapshots_removed += 1;
    }

    // Packs that no snapshot uses any more start their 24 h wait.
    {
        let mut conn = lock(db)?;
        out.packs_marked = db::mark_unused_packs_tx(&mut conn, scope, now)?.len() as u32;
    }

    // Marked packs past their wait, plus any left `deleting` by an earlier pass.
    let candidates = {
        let conn = lock(db)?;
        let mut ids = db::deletable_packs(&conn, scope, now)?;
        ids.extend(db::list_packs(&conn, scope, "deleting")?);
        ids
    };
    for id in candidates {
        let claim = {
            let conn = lock(db)?;
            claim_pack(&conn, &id, scope, now)?
        };
        let Some(claim) = claim else { continue };
        match store.delete_pack(&unhex(&id)?) {
            Ok(()) | Err(StoreError::NotFound) => {}
            Err(e) => {
                if claim.fresh {
                    let conn = lock(db)?;
                    release_pack(&conn, &id)?;
                }
                return Err(anyhow!("{e}"));
            }
        }
        let conn = lock(db)?;
        db::delete_pack_row(&conn, &id)?;
        out.packs_deleted += 1;
        out.bytes_freed += claim.size;
    }
    Ok(out)
}

fn lock(db: &crate::Db) -> anyhow::Result<MutexGuard<'_, Connection>> {
    db.lock()
        .map_err(|_| anyhow!("Luna could not reach its database. Try again."))
}

/// A pack this pass may delete. `fresh` means this pass moved it to `deleting`
/// and must move it back if the cloud delete fails.
struct Claim {
    size: u64,
    fresh: bool,
}

/// Move a pack to `deleting` in one statement, only if it is still safe to delete.
/// A commit that linked the pack meanwhile has made it `live`, so the move fails
/// and the pack is skipped. `deleting` is refused by `commit_snapshot_tx`, so no
/// new snapshot can use the pack once it is claimed.
fn claim_pack(conn: &Connection, id: &str, scope: &str, now: i64) -> anyhow::Result<Option<Claim>> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT size, state FROM cloud_packs WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((size, state)) = row else {
        return Ok(None);
    };
    match state.as_str() {
        "deleting" => Ok(Some(Claim {
            size: size as u64,
            fresh: false,
        })),
        "marked" => {
            let changed = conn.execute(
                "UPDATE cloud_packs SET state = 'deleting'
                 WHERE id = ?1 AND scope = ?2 AND state = 'marked'
                   AND ?3 - marked_at >= ?4
                   AND NOT EXISTS (
                       SELECT 1 FROM cloud_runs r
                       WHERE r.scope = ?2 AND r.started_at <= cloud_packs.marked_at
                         AND r.ended_at = 0)",
                params![id, scope, now, GRACE_SECS],
            )?;
            Ok((changed == 1).then_some(Claim {
                size: size as u64,
                fresh: true,
            }))
        }
        _ => Ok(None),
    }
}

/// Undo a claim after the cloud delete failed, so a later pass retries it.
fn release_pack(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_packs SET state = 'marked' WHERE id = ?1 AND state = 'deleting'",
        params![id],
    )?;
    Ok(())
}

/// Lowercase hex (as the database stores pack ids) back to the 32-byte id.
fn unhex(text: &str) -> anyhow::Result<[u8; 32]> {
    if text.len() != 64 || !text.is_ascii() {
        bail!("Backup pack id {text} is not valid.");
    }
    let mut out = [0u8; 32];
    for (i, pair) in text.as_bytes().chunks(2).enumerate() {
        let digits = std::str::from_utf8(pair)?;
        out[i] = u8::from_str_radix(digits, 16)
            .map_err(|_| anyhow!("Backup pack id {text} is not valid."))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::crypto::pack_id;
    use crate::backup::cloud::store::MemoryStore;
    use crate::db::SnapshotInsert;

    const DAY: i64 = 86_400;
    const NOW: i64 = 100 * DAY;
    const SCOPE: &str = "scope-a";

    fn hex(id: &[u8; 32]) -> String {
        id.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn setup(dir: &std::path::Path) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "admin").unwrap();
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id: "p1",
                kind: "folder",
                source_drive: "drive-src",
                source_path: "p1",
                target_drive: "drive-dst",
                private_owner: "",
                created_by: "owner",
                created_at: 1,
            },
        )
        .unwrap();
        crate::Db::new(conn)
    }

    /// Store a pack and record it as live in the database, as a finished backup would.
    fn add_pack(db: &crate::Db, store: &MemoryStore, bytes: &[u8]) -> [u8; 32] {
        let id = pack_id(bytes);
        store.put_pack(&id, Some(SCOPE), bytes).unwrap();
        let conn = db.lock().unwrap();
        db::insert_pending_pack(&conn, &hex(&id), SCOPE, "run-setup", 1).unwrap();
        db::set_pack_live(&conn, &hex(&id), bytes.len() as i64).unwrap();
        id
    }

    /// Store a snapshot record and commit its row with the packs it uses.
    fn add_snapshot(db: &crate::Db, store: &MemoryStore, id: &str, created_at: i64, packs: &[[u8; 32]]) {
        store.put_record("snapshots", id, b"record").unwrap();
        let snap = SnapshotInsert {
            id: id.into(),
            protection_id: "p1".into(),
            created_at,
            key_version: 1,
            tree_pack_id: packs.first().map(hex).unwrap_or_default(),
            record: b"record".to_vec(),
        };
        let ids: Vec<String> = packs.iter().map(hex).collect();
        let mut conn = db.lock().unwrap();
        db::commit_snapshot_tx(&mut conn, &snap, &ids).unwrap();
    }

    fn snapshot_ids(db: &crate::Db) -> Vec<String> {
        let conn = db.lock().unwrap();
        let mut ids: Vec<String> = db::list_cloud_snapshots(&conn, "p1")
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        ids.sort();
        ids
    }

    fn packs_in_state(db: &crate::Db, state: &str) -> Vec<String> {
        let conn = db.lock().unwrap();
        db::list_packs(&conn, SCOPE, state).unwrap()
    }

    #[test]
    fn old_snapshots_are_thinned_by_bucket_and_latest_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        add_snapshot(&db, &store, "latest", NOW - 10, &[]);
        add_snapshot(&db, &store, "week-young", NOW - 2 * DAY, &[]);
        add_snapshot(&db, &store, "week-old", NOW - 3 * DAY, &[]);
        add_snapshot(&db, &store, "month", NOW - 10 * DAY, &[]);
        add_snapshot(&db, &store, "too-old", NOW - 40 * DAY, &[]);

        let out = thin(&db, "p1", SCOPE, &store, NOW).unwrap();

        assert_eq!(out.snapshots_removed, 2);
        // Oldest per bucket survives: week-old (3 days) over week-young, and month.
        assert_eq!(snapshot_ids(&db), ["latest", "month", "week-old"]);
        assert!(store.get_record("snapshots", "week-young").unwrap().is_none());
        assert!(store.get_record("snapshots", "too-old").unwrap().is_none());
        assert!(store.get_record("snapshots", "month").unwrap().is_some());
    }

    #[test]
    fn latest_snapshot_is_kept_even_when_it_is_past_every_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        add_snapshot(&db, &store, "only", NOW - 40 * DAY, &[]);

        let out = thin(&db, "p1", SCOPE, &store, NOW).unwrap();

        assert_eq!(out.snapshots_removed, 0);
        assert_eq!(snapshot_ids(&db), ["only"]);
    }

    #[test]
    fn pack_used_by_a_kept_snapshot_is_never_marked() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let unused = add_pack(&db, &store, b"unused pack");
        add_snapshot(&db, &store, "latest", NOW - 10, &[kept]);
        add_snapshot(&db, &store, "gone", NOW - 40 * DAY, &[unused]);

        let out = thin(&db, "p1", SCOPE, &store, NOW).unwrap();

        assert_eq!(out.packs_marked, 1);
        assert_eq!(packs_in_state(&db, "live"), [hex(&kept)]);
        assert_eq!(packs_in_state(&db, "marked"), [hex(&unused)]);
    }

    #[test]
    fn marked_pack_is_deleted_only_after_a_day() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let unused = add_pack(&db, &store, b"unused pack bytes");
        add_snapshot(&db, &store, "latest", NOW - 10, &[kept]);
        add_snapshot(&db, &store, "gone", NOW - 40 * DAY, &[unused]);
        thin(&db, "p1", SCOPE, &store, NOW).unwrap();

        let early = thin(&db, "p1", SCOPE, &store, NOW + 100).unwrap();
        assert_eq!(early.packs_deleted, 0);
        assert!(store.get_pack(&unused).is_ok());

        let later = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();
        assert_eq!(later.packs_deleted, 1);
        assert_eq!(later.bytes_freed, b"unused pack bytes".len() as u64);
        assert!(store.get_pack(&unused).is_err());
        assert!(store.get_pack(&kept).is_ok());
        assert!(packs_in_state(&db, "marked").is_empty());
    }

    #[test]
    fn marked_pack_waits_while_an_older_run_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let unused = add_pack(&db, &store, b"unused pack");
        add_snapshot(&db, &store, "latest", NOW - 10, &[kept]);
        add_snapshot(&db, &store, "gone", NOW - 40 * DAY, &[unused]);
        thin(&db, "p1", SCOPE, &store, NOW).unwrap();
        // A run that began before the mark might still be using the pack.
        {
            let conn = db.lock().unwrap();
            db::start_run(&conn, "run-old", "p1", SCOPE, NOW - 5).unwrap();
        }

        let blocked = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();
        assert_eq!(blocked.packs_deleted, 0);
        assert!(store.get_pack(&unused).is_ok());

        {
            let conn = db.lock().unwrap();
            db::end_run(&conn, "run-old", NOW + DAY).unwrap();
        }
        let done = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();
        assert_eq!(done.packs_deleted, 1);
        assert!(store.get_pack(&unused).is_err());
    }

    #[test]
    fn marked_pack_used_again_before_deletion_is_unmarked_and_survives() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let reused = add_pack(&db, &store, b"reused pack");
        add_snapshot(&db, &store, "latest", NOW - 10, &[kept]);
        add_snapshot(&db, &store, "gone", NOW - 40 * DAY, &[reused]);
        thin(&db, "p1", SCOPE, &store, NOW).unwrap();
        assert_eq!(packs_in_state(&db, "marked"), [hex(&reused)]);

        // A new backup uses the marked pack again, which makes it live.
        add_snapshot(&db, &store, "again", NOW + 100, &[reused]);
        let out = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();

        assert_eq!(out.packs_deleted, 0);
        assert!(store.get_pack(&reused).is_ok());
        assert!(packs_in_state(&db, "live").contains(&hex(&reused)));
    }

    #[test]
    fn pack_already_missing_from_the_cloud_is_removed_from_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let unused = add_pack(&db, &store, b"unused pack");
        add_snapshot(&db, &store, "latest", NOW - 10, &[kept]);
        add_snapshot(&db, &store, "gone", NOW - 40 * DAY, &[unused]);
        thin(&db, "p1", SCOPE, &store, NOW).unwrap();
        store.delete_pack(&unused).unwrap();

        let out = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();

        assert_eq!(out.packs_deleted, 1);
        assert!(packs_in_state(&db, "deleting").is_empty());
        let conn = db.lock().unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM cloud_packs WHERE id = ?1", params![hex(&unused)], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
}
