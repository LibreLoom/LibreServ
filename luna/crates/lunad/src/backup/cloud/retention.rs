//! Cloud retention: which snapshots stay, and how packs that no
//! snapshot uses are marked, waited on, and deleted from the cloud.

use std::sync::MutexGuard;

use anyhow::{anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};

use crate::backup::cloud::private::{PSCOPES_KIND, snapshot_record_ref};
use crate::backup::cloud::store::{CloudStore, StoreError};
use crate::db;

/// Seconds a pack stays `marked` before it may be deleted. Matches `db::deletable_packs`.
const GRACE_SECS: i64 = 86_400;
/// Staggered windows: the newest snapshot of each of the last `KEEP_DAYS` days,
/// `KEEP_WEEKS` ISO weeks and `KEEP_MONTHS` calendar months is kept (their union).
/// Days, weeks and months are counted in UTC. Manual and scheduled snapshots count alike.
pub const KEEP_DAYS: i64 = 7;
pub const KEEP_WEEKS: i64 = 4;
pub const KEEP_MONTHS: i64 = 3;
const DAY_SECS: i64 = 86_400;

/// What one `thin` pass changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Thinned {
    pub snapshots_removed: u32,
    pub packs_marked: u32,
    pub packs_deleted: u32,
    pub bytes_freed: u64,
}

/// Which snapshots the staggered windows keep. `times` are creation times, newest
/// first (the order `list_cloud_snapshots` returns). The newest snapshot is always
/// kept; each other kept snapshot is the newest one in its day, week or month.
pub fn keep_flags(times: &[i64], now: i64) -> Vec<bool> {
    let day_now = now.div_euclid(DAY_SECS);
    // ISO weeks start on Monday; 1970-01-05 was the first Monday after the epoch.
    let week_of = |day: i64| (day - 4).div_euclid(7);
    let week_now = week_of(day_now);
    let month_now = month_key(day_now);
    let mut seen_day = std::collections::HashSet::new();
    let mut seen_week = std::collections::HashSet::new();
    let mut seen_month = std::collections::HashSet::new();
    times
        .iter()
        .enumerate()
        .map(|(index, &at)| {
            let day = at.div_euclid(DAY_SECS);
            // The first snapshot seen in a bucket is the newest, so it takes the slot.
            let first_day = seen_day.insert(day);
            let first_week = seen_week.insert(week_of(day));
            let first_month = seen_month.insert(month_key(day));
            let in_day = first_day && (day_now - KEEP_DAYS + 1..=day_now).contains(&day);
            let in_week =
                first_week && (week_now - KEEP_WEEKS + 1..=week_now).contains(&week_of(day));
            let in_month =
                first_month && (month_now - KEEP_MONTHS + 1..=month_now).contains(&month_key(day));
            index == 0 || in_day || in_week || in_month
        })
        .collect()
}

/// Year and month of a day count since 1970-01-01 as one number, so months compare
/// by subtraction. Howard Hinnant's civil-from-days algorithm.
fn month_key(days: i64) -> i64 {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    year * 12 + (month - 1)
}

/// Drop every snapshot the staggered windows do not keep, then mark and delete
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

    // Snapshots, newest first. A source that is gone leaves them untouched.
    let snapshots = {
        let conn = lock(db)?;
        let gone = db::get_protection(&conn, protection_id)?
            .is_some_and(|row| row.state == db::PROTECTION_SOURCE_GONE);
        if gone {
            Vec::new()
        } else {
            db::list_cloud_snapshots(&conn, protection_id)?
        }
    };
    let times: Vec<i64> = snapshots.iter().map(|s| s.created_at).collect();
    let keep = keep_flags(&times, now);
    for (snap, keep) in snapshots.iter().zip(keep) {
        if keep {
            continue;
        }
        // Store first: if it fails, the row stays and the next pass tries again.
        let (kind, name) = {
            let conn = lock(db)?;
            snapshot_record_ref(&conn, &snap.id)?
        };
        match store.delete_record(kind, &name) {
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

/// Finish the old-phrase copies whose 30-day wait is over (plan: a replaced private backup
/// is deleted after 30 days, or sooner when its owner asks). Their snapshots go at once;
/// their packs follow the normal 24 h wait; the scope's own record goes once no packs are
/// left. A pass that stops part-way is finished by the next one.
pub fn retire_old_phrases(db: &crate::Db, store: &dyn CloudStore, now: i64) -> anyhow::Result<()> {
    // Kept copies of the previous scope secret end with their 30 days too.
    db::clear_expired_kept_scope_secrets(&*lock(db)?, now)?;
    let due: Vec<String> = {
        let conn = lock(db)?;
        db::list_private_scopes(&conn, None)?
            .into_iter()
            .filter(|s| s.state == "old_phrase" && s.retire_after > 0 && now >= s.retire_after)
            .map(|s| s.scope)
            .collect()
    };
    for scope in due {
        let snapshots = {
            let conn = lock(db)?;
            db::private_snapshot_ids(&conn, &scope)?
        };
        for id in snapshots {
            // Look up the record before the row goes, since the lookup needs it.
            let (kind, name) = {
                let conn = lock(db)?;
                snapshot_record_ref(&conn, &id)?
            };
            match store.delete_record(kind, &name) {
                Ok(()) | Err(StoreError::NotFound) => {}
                Err(e) => return Err(anyhow!("{e}")),
            }
            let conn = lock(db)?;
            db::delete_cloud_snapshot(&conn, &id)?;
        }

        // Packs no snapshot uses any more are marked, then deleted after their wait.
        thin(db, "", &scope, store, now)?;

        let packs_left = {
            let conn = lock(db)?;
            let mut left = 0;
            for state in ["pending", "live", "marked", "deleting"] {
                left += db::list_packs(&conn, &scope, state)?.len();
            }
            left
        };
        if packs_left > 0 {
            continue;
        }
        // Scope record first, then the local row: if the store fails, the row stays and
        // the next pass tries again.
        match store.delete_record(PSCOPES_KIND, &scope) {
            Ok(()) | Err(StoreError::NotFound) => {}
            Err(e) => return Err(anyhow!("{e}")),
        }
        let conn = lock(db)?;
        db::delete_private_scope(&conn, &scope)?;
    }
    Ok(())
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
    use crate::backup::cloud::private::PSNAPSHOTS_KIND;
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
    fn add_snapshot(
        db: &crate::Db,
        store: &MemoryStore,
        id: &str,
        created_at: i64,
        packs: &[[u8; 32]],
    ) {
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

    /// Add a recent snapshot (newest, so kept) that carries `packs`, so older snapshots are the ones thinned.
    fn add_newer_snapshots(db: &crate::Db, store: &MemoryStore, packs: &[[u8; 32]]) {
        add_snapshot(db, store, "recent-0", NOW - 10, packs);
    }

    #[test]
    fn thin_removes_private_records_by_their_kind() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        const PSCOPE: &str = "scope-p";
        {
            let conn = db.lock().unwrap();
            db::insert_private_scope(
                &conn,
                &db::PrivateScope {
                    scope: PSCOPE.into(),
                    owner: "owner".into(),
                    seal_public: vec![5; 32],
                    scope_public: vec![5; 32],
                    sealed_scope_secret: vec![6; 16],
                    dedup_key: vec![6; 32],
                    state: "active".into(),
                    retire_after: 0,
                    created_at: 1,
                },
            )
            .unwrap();
        }
        // A private snapshot, a year old, whose record lives under the private kind.
        store
            .put_record(
                PSNAPSHOTS_KIND,
                &format!("{PSCOPE}.priv-1"),
                b"private record",
            )
            .unwrap();
        // A decoy: a standard record that happens to share the private snapshot's id.
        store.put_record("snapshots", "priv-1", b"decoy").unwrap();
        {
            let snap = SnapshotInsert {
                id: "priv-1".into(),
                protection_id: "p1".into(),
                created_at: NOW - 400 * DAY,
                key_version: 1,
                tree_pack_id: String::new(),
                record: b"private record".to_vec(),
            };
            let mut conn = db.lock().unwrap();
            db::commit_private_snapshot_tx(&mut conn, &snap, &[], PSCOPE, b"{}").unwrap();
        }
        add_newer_snapshots(&db, &store, &[]);

        let out = thin(&db, "p1", PSCOPE, &store, NOW).unwrap();

        assert_eq!(out.snapshots_removed, 1);
        assert!(
            store
                .get_record(PSNAPSHOTS_KIND, &format!("{PSCOPE}.priv-1"))
                .unwrap()
                .is_none()
        );
        assert!(
            store.get_record("snapshots", "priv-1").unwrap().is_some(),
            "decoy must stay"
        );
        assert!(store.get_record("snapshots", "recent-0").unwrap().is_some());
        assert!(!snapshot_ids(&db).contains(&"priv-1".to_string()));
    }

    #[test]
    fn staggered_windows_drop_what_no_window_keeps() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        add_snapshot(&db, &store, "newest", NOW - 1, &[]);
        add_snapshot(&db, &store, "too-old", NOW - 400 * DAY, &[]);
        add_snapshot(&db, &store, "same-day", NOW - 2, &[]);

        let out = thin(&db, "p1", SCOPE, &store, NOW).unwrap();

        assert_eq!(out.snapshots_removed, 2);
        assert_eq!(snapshot_ids(&db), ["newest"]);
        assert!(store.get_record("snapshots", "too-old").unwrap().is_none());
        assert!(store.get_record("snapshots", "same-day").unwrap().is_none());
    }

    #[test]
    fn newest_of_each_of_the_last_seven_days_is_kept() {
        // NOW is the start of day 100. Two snapshots on day 100 (newest first), then one per day back to day 93.
        let times: Vec<i64> = vec![
            NOW + 2,
            NOW + 1,
            NOW - DAY + 1,
            NOW - 2 * DAY + 1,
            NOW - 3 * DAY + 1,
            NOW - 4 * DAY + 1,
            NOW - 5 * DAY + 1,
            NOW - 6 * DAY + 1,
            NOW - 7 * DAY + 1,
        ];
        let keep = keep_flags(&times, NOW);
        assert_eq!(
            keep,
            [true, false, true, true, true, true, true, true, false]
        );
    }

    #[test]
    fn newest_of_each_of_the_last_three_months_is_kept() {
        // Day 100 is April, 70 is March (11th), 65 is March (6th), 40 is February (10th),
        // 39 is February (9th), 9 is January.
        let times: Vec<i64> = [100, 70, 65, 40, 39, 9]
            .iter()
            .map(|d| d * DAY + 1)
            .collect();
        let keep = keep_flags(&times, NOW);
        assert_eq!(keep, [true, true, false, true, false, false]);
    }

    #[test]
    fn newest_snapshot_is_kept_however_old() {
        assert_eq!(keep_flags(&[NOW - 400 * DAY], NOW), [true]);
    }

    #[test]
    fn an_old_snapshot_is_kept_while_fewer_than_seven_exist() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        add_snapshot(&db, &store, "only", NOW - 400 * DAY, &[]);

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
        add_snapshot(&db, &store, "gone", NOW - 400 * DAY, &[unused]);
        add_newer_snapshots(&db, &store, &[kept]);

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
        add_snapshot(&db, &store, "gone", NOW - 400 * DAY, &[unused]);
        add_newer_snapshots(&db, &store, &[kept]);
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
        add_snapshot(&db, &store, "gone", NOW - 400 * DAY, &[unused]);
        add_newer_snapshots(&db, &store, &[kept]);
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
        add_snapshot(&db, &store, "gone", NOW - 400 * DAY, &[reused]);
        add_newer_snapshots(&db, &store, &[kept]);
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
    fn the_sweep_drops_kept_scope_secrets_after_their_30_days() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        {
            let conn = db.lock().unwrap();
            db::insert_private_scope(
                &conn,
                &db::PrivateScope {
                    scope: SCOPE.into(),
                    owner: "owner".into(),
                    seal_public: vec![5; 32],
                    scope_public: vec![5; 32],
                    sealed_scope_secret: vec![6; 16],
                    dedup_key: vec![6; 32],
                    state: "active".into(),
                    retire_after: 0,
                    created_at: 1,
                },
            )
            .unwrap();
            db::keep_scope_secret(
                &conn,
                &db::KeptScopeSecret {
                    scope: SCOPE.into(),
                    seal_public: vec![1; 32],
                    sealed_scope_secret: vec![9; 16],
                    expires_at: NOW + 30 * DAY,
                },
            )
            .unwrap();
        }
        retire_old_phrases(&db, &store, NOW + 29 * DAY).unwrap();
        let count = |at: i64| {
            let conn = db.lock().unwrap();
            db::list_kept_scope_secrets(&conn, "owner", at)
                .unwrap()
                .len()
        };
        assert_eq!(count(NOW), 1);
        retire_old_phrases(&db, &store, NOW + 30 * DAY).unwrap();
        assert_eq!(count(0), 0);
    }

    #[test]
    fn old_phrase_scope_without_a_retire_time_is_never_retired() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        const PSCOPE: &str = "scope-old-phrase";
        {
            let conn = db.lock().unwrap();
            db::insert_private_scope(
                &conn,
                &db::PrivateScope {
                    scope: PSCOPE.into(),
                    owner: "owner".into(),
                    seal_public: vec![5; 32],
                    scope_public: vec![5; 32],
                    sealed_scope_secret: vec![6; 16],
                    dedup_key: vec![6; 32],
                    state: "old_phrase".into(),
                    retire_after: 0,
                    created_at: 1,
                },
            )
            .unwrap();
        }
        store
            .put_record(
                PSNAPSHOTS_KIND,
                &format!("{PSCOPE}.priv-1"),
                b"private record",
            )
            .unwrap();
        {
            let snap = SnapshotInsert {
                id: "priv-1".into(),
                protection_id: "p1".into(),
                created_at: NOW - 40 * DAY,
                key_version: 1,
                tree_pack_id: String::new(),
                record: b"private record".to_vec(),
            };
            let mut conn = db.lock().unwrap();
            db::commit_private_snapshot_tx(&mut conn, &snap, &[], PSCOPE, b"{}").unwrap();
        }

        retire_old_phrases(&db, &store, NOW + 1000 * DAY).unwrap();

        assert!(
            store
                .get_record(PSNAPSHOTS_KIND, &format!("{PSCOPE}.priv-1"))
                .unwrap()
                .is_some()
        );
        let conn = db.lock().unwrap();
        assert_eq!(db::private_snapshot_ids(&conn, PSCOPE).unwrap(), ["priv-1"]);
        assert!(
            db::list_private_scopes(&conn, None)
                .unwrap()
                .iter()
                .any(|s| s.scope == PSCOPE)
        );
    }

    #[test]
    fn pack_already_missing_from_the_cloud_is_removed_from_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let store = MemoryStore::new();
        let kept = add_pack(&db, &store, b"kept pack");
        let unused = add_pack(&db, &store, b"unused pack");
        add_snapshot(&db, &store, "gone", NOW - 400 * DAY, &[unused]);
        add_newer_snapshots(&db, &store, &[kept]);
        thin(&db, "p1", SCOPE, &store, NOW).unwrap();
        store.delete_pack(&unused).unwrap();

        let out = thin(&db, "p1", SCOPE, &store, NOW + DAY).unwrap();

        assert_eq!(out.packs_deleted, 1);
        assert!(packs_in_state(&db, "deleting").is_empty());
        let conn = db.lock().unwrap();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_packs WHERE id = ?1",
                params![hex(&unused)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }
}
