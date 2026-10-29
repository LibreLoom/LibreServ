//! Rebuilds the cloud backup index after Luna's database is lost.
//!
//! Snapshot records live on Connect and are signed by Luna's signing key, so the recovered
//! identity checks each one. A readable snapshot gets its row, its tree pack and the pack's
//! live state. The tree also names every chunk and the data pack it lives in, so those rows are
//! rebuilt too. The snapshot's sealed meta names its protection, so the protection row and its
//! backup key are restored from it. Packs the index does not know are never deleted, so they are
//! left alone.

use std::cell::RefCell;
use std::collections::HashMap;

use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use zeroize::Zeroizing;

use super::crypto;
use super::format::{self, BackupMeta, SignedRecord, SnapshotRecord};
use super::identity::Identity;
use super::run::PACK_KEY_WRAP_AAD;
use super::store::{CloudStore, RESTORE_RECORD_PAGE_SIZE, RecordPage};
use crate::backup::access_list::AccessList;
use crate::db::{self, BackupKey, SnapshotInsert};

const SNAPSHOT_KIND: &str = "snapshots";
const RECOVERED_RUN: &str = "recovered";

/// What a rebuild did, one count per snapshot record on Connect.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Recovered {
    /// Snapshots newly written into the index.
    pub snapshots: u32,
    /// Snapshots that were already in the index.
    pub already_indexed: u32,
    /// Records that could not be verified or opened, or have no backup key here.
    pub skipped: u32,
}

/// One snapshot's fetched and decrypted parts.
pub struct PreparedSnapshot {
    /// The signed record bytes, kept as the index's copy of the snapshot.
    pub record_bytes: Vec<u8>,
    pub record: SnapshotRecord,
    /// The tree pack's size as stored on Connect.
    pub tree_pack_size: i64,
    /// The scope tag of this snapshot's packs.
    pub scope: String,
    pub tree: Zeroizing<format::Tree>,
    pub meta: Zeroizing<BackupMeta>,
    /// The backup key this snapshot was opened with.
    pub key: Zeroizing<BackupKey>,
}

/// Rebuild the snapshot index from the snapshot records on the store.
/// `keys` are the backup keys handed back during recovery; a snapshot needs the key for its version.
pub fn rebuild_snapshot_index(
    conn: &mut Connection,
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    now: i64,
) -> Result<Recovered> {
    let conn = RefCell::new(conn);
    fetch_incrementally_with_existing_check(
        store,
        identity,
        keys,
        |snapshot_id| {
            let conn = conn.borrow();
            already_indexed(&conn, snapshot_id)
        },
        |snapshot| {
            let mut conn_ref = conn.borrow_mut();
            let conn: &mut Connection = &mut conn_ref;
            if already_indexed(conn, &snapshot.record.snapshot_id)? {
                Ok(RestoreDisposition::AlreadyIndexed)
            } else {
                write_snapshot_for_restore(conn, snapshot, now)?;
                Ok(RestoreDisposition::Written)
            }
        },
        |_processed, _total, _counts| Ok(()),
    )
}

/// Fetch and verify one snapshot at a time, handing it to the caller for an independent write.
/// Only one bounded name page is held at a time. Each tree pack (bounded by the store's per-pack
/// limit) and decrypted tree are dropped before the next snapshot; chunk data packs are indexed
/// from tree references but never fetched. The callback reports completed records, including records that could not be verified.
pub enum RestoreDisposition {
    Written,
    AlreadyIndexed,
}

pub fn fetch_incrementally(
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    handle: impl FnMut(PreparedSnapshot) -> Result<RestoreDisposition>,
    progress: impl FnMut(u32, u32, &Recovered) -> Result<()>,
) -> Result<Recovered> {
    fetch_incrementally_with_existing_check(store, identity, keys, |_| Ok(false), handle, progress)
}

/// Like `fetch_incrementally`, but checks the signed snapshot ID against the local index before
/// fetching its tree pack. The write callback should still check again to cover concurrent restores.
pub fn fetch_incrementally_with_existing_check(
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    mut already_indexed: impl FnMut(&str) -> Result<bool>,
    mut handle: impl FnMut(PreparedSnapshot) -> Result<RestoreDisposition>,
    mut progress: impl FnMut(u32, u32, &Recovered) -> Result<()>,
) -> Result<Recovered> {
    let mut out = Recovered::default();
    let mut after: Option<String> = None;
    let mut processed = 0u64;
    let mut total = 0u32;
    let mut expected_total = None;
    let mut inventory_version = None;
    loop {
        let page = store
            .list_record_page_versioned(
                SNAPSHOT_KIND,
                after.as_deref(),
                RESTORE_RECORD_PAGE_SIZE,
                inventory_version,
                expected_total,
            )
            .map_err(|e| anyhow!("{e}"))?;
        if expected_total.is_some_and(|expected| expected != page.total) {
            return Err(anyhow!(
                "The cloud backup list changed during restore. Try restoring again."
            ));
        }
        expected_total = Some(page.total);
        inventory_version = Some(page.version);
        validate_restore_page(&page, after.as_deref(), processed)?;
        total = total.max(page.total.min(u64::from(u32::MAX)) as u32);
        for name in &page.names {
            let bytes = store
                .get_record(SNAPSHOT_KIND, name)
                .map_err(|e| anyhow!("{e}"))?;
            let Some(bytes) = bytes else {
                return Err(anyhow!(
                    "The cloud backup list changed during restore. Try restoring again."
                ));
            };
            let snapshot = fetch_one(store, identity, keys, bytes, &mut already_indexed)?;
            match snapshot {
                FetchOutcome::Prepared(snapshot) => match handle(*snapshot)? {
                    RestoreDisposition::AlreadyIndexed => out.already_indexed += 1,
                    RestoreDisposition::Written => out.snapshots += 1,
                },
                FetchOutcome::AlreadyIndexed => out.already_indexed += 1,
                FetchOutcome::Skipped => out.skipped += 1,
            }
            processed = processed.saturating_add(1);
            let done = processed.min(u64::from(u32::MAX)) as u32;
            progress(done, total.max(done), &out)?;
        }
        let Some(next_after) = page.next_after else {
            let verify_after = page.names.last().map(String::as_str).or(after.as_deref());
            let verification = store
                .list_record_page_versioned(
                    SNAPSHOT_KIND,
                    verify_after,
                    RESTORE_RECORD_PAGE_SIZE,
                    inventory_version,
                    expected_total,
                )
                .map_err(|e| anyhow!("{e}"))?;
            validate_restore_page(&verification, verify_after, processed)?;
            if verification.total != page.total || !verification.names.is_empty() {
                return Err(anyhow!(
                    "The cloud backup list changed during restore. Try restoring again."
                ));
            }
            break;
        };
        after = Some(next_after);
    }
    Ok(out)
}

enum FetchOutcome {
    Prepared(Box<PreparedSnapshot>),
    AlreadyIndexed,
    Skipped,
}

fn validate_restore_page(page: &RecordPage, after: Option<&str>, processed: u64) -> Result<()> {
    if page.names.len() > RESTORE_RECORD_PAGE_SIZE {
        return Err(anyhow!(
            "Luna Connect returned an oversized backup-listing page."
        ));
    }
    let mut previous = after.unwrap_or("");
    for name in &page.names {
        if name.as_str() <= previous {
            return Err(anyhow!(
                "Luna Connect returned an invalid backup-listing order."
            ));
        }
        previous = name;
    }
    if let Some(cursor) = page.next_after.as_deref() {
        if page.names.len() != RESTORE_RECORD_PAGE_SIZE
            || page.names.last().map(String::as_str) != Some(cursor)
            || after.is_some_and(|previous| cursor <= previous)
        {
            return Err(anyhow!(
                "Luna Connect returned an invalid backup-listing cursor."
            ));
        }
    } else if processed.saturating_add(page.names.len() as u64) != page.total {
        return Err(anyhow!(
            "Luna Connect ended the backup listing before all records were returned. Try restoring again."
        ));
    }
    Ok(())
}

/// Check one record and fetch its tree. `None` means the record is skipped.
fn fetch_one(
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    bytes: Vec<u8>,
    already_indexed: &mut impl FnMut(&str) -> Result<bool>,
) -> Result<FetchOutcome> {
    let Some(signed) = SignedRecord::from_bytes(&bytes).ok() else {
        return Ok(FetchOutcome::Skipped);
    };
    let Some(record) = signed.verify(&identity.public()).ok() else {
        return Ok(FetchOutcome::Skipped);
    };
    if record.luna_id != identity.luna_id() {
        return Ok(FetchOutcome::Skipped);
    }
    let Some(key) = keys.iter().find(|k| {
        k.protection_id == record.protection_id && k.version == i64::from(record.key_version)
    }) else {
        return Ok(FetchOutcome::Skipped);
    };
    let Ok(tree_key) = <[u8; 32]>::try_from(key.key.as_slice()) else {
        return Ok(FetchOutcome::Skipped);
    };
    let tree_key = Zeroizing::new(tree_key);
    let Ok(dedup_key) = <[u8; 32]>::try_from(key.dedup_key.as_slice()) else {
        return Ok(FetchOutcome::Skipped);
    };
    let dedup_key = Zeroizing::new(dedup_key);

    if already_indexed(&record.snapshot_id)? {
        return Ok(FetchOutcome::AlreadyIndexed);
    }

    // The tree pack must open with this key and hold the tree the record names.
    let pack_bytes = store.get_pack(&record.tree_pack_id)?;
    // A protection's tree pack may have been sealed with any version of that protection's key.
    // The snapshot record's own version still opens its tree and metadata below.
    let mut held: Vec<&BackupKey> = keys
        .iter()
        .filter(|k| k.protection_id == record.protection_id)
        .collect();
    held.sort_by_key(|k| std::cmp::Reverse(k.version));
    let unwrap = |wrapped: &[u8]| -> Result<[u8; 32]> {
        for held_key in &held {
            let Ok(key_bytes) = <[u8; 32]>::try_from(held_key.key.as_slice()) else {
                continue;
            };
            let key_bytes = Zeroizing::new(key_bytes);
            let Ok(plain) = crypto::decrypt(&key_bytes, PACK_KEY_WRAP_AAD, wrapped) else {
                continue;
            };
            let plain = Zeroizing::new(plain);
            if let Ok(pack_key) = <[u8; 32]>::try_from(plain.as_slice()) {
                return Ok(pack_key);
            }
        }
        Err(anyhow!(
            "A backup file could not be opened with this Luna's keys."
        ))
    };
    let Ok(pack) = format::open_pack(&pack_bytes, &record.tree_pack_id, unwrap) else {
        return Ok(FetchOutcome::Skipped);
    };
    let sealed = match pack.chunk(&record.tree_hash) {
        Some(sealed) if format::sha256(sealed) == record.tree_hash => sealed,
        _ => return Ok(FetchOutcome::Skipped),
    };
    let Ok(tree) = format::decrypt_tree(sealed, &tree_key) else {
        return Ok(FetchOutcome::Skipped);
    };
    let tree = Zeroizing::new(tree);
    let Ok(meta) = format::decrypt_meta(&record.meta, &tree_key) else {
        return Ok(FetchOutcome::Skipped);
    };
    let meta = Zeroizing::new(meta);

    // The pack's scope tag is derived from the dedup key, so a wrong dedup key cannot match it.
    let expected_scope = hex(&crypto::chunk_id(&dedup_key, b"luna-scope-v1")[..16]);
    let scope = hex(&pack.scope_id()[..16]);
    if scope != expected_scope {
        return Ok(FetchOutcome::Skipped);
    }
    Ok(FetchOutcome::Prepared(Box::new(PreparedSnapshot {
        record_bytes: bytes,
        tree_pack_size: pack_bytes.len() as i64,
        scope,
        record,
        tree,
        meta,
        key: Zeroizing::new(key.clone()),
    })))
}

/// Write one prepared snapshot, its packs, chunks, protection row and backup key in one transaction.
pub(crate) fn write_snapshot_for_restore(
    conn: &mut Connection,
    snapshot: PreparedSnapshot,
    now: i64,
) -> Result<()> {
    let PreparedSnapshot {
        record_bytes,
        record,
        tree_pack_size,
        scope,
        tree,
        meta,
        key,
    } = snapshot;
    let tree_pack_id = hex(&record.tree_pack_id);
    let index_row = SnapshotInsert {
        id: record.snapshot_id.clone(),
        protection_id: record.protection_id.clone(),
        created_at: record.created_at,
        key_version: i64::from(record.key_version),
        tree_pack_id: tree_pack_id.clone(),
        record: record_bytes,
    };
    let tx = conn.transaction()?;
    // A pack row may already exist (for example from a run that was interrupted), so keep it.
    tx.execute(
        "INSERT OR IGNORE INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
         VALUES (?1, ?2, 'live', ?3, ?4, 0, ?5)",
        params![tree_pack_id, scope, RECOVERED_RUN, tree_pack_size, now],
    )?;
    db::insert_cloud_snapshot(&tx, &index_row)?;
    tx.execute(
        "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
        params![index_row.id, tree_pack_id],
    )?;
    index_tree_chunks(&tx, &scope, &index_row.id, &tree, now)?;
    // Keep an existing protection row and key as they are; restore them only when missing.
    if db::get_protection(&tx, &record.protection_id)?.is_none() {
        // Older records can leave the starter empty, so fall back to the first Admin.
        let created_by = Zeroizing::new(if meta.started_by.is_empty() {
            db::first_admin(&tx)?.map(|u| u.id).unwrap_or_default()
        } else {
            meta.started_by.clone()
        });
        db::insert_protection(
            &tx,
            &db::NewProtection {
                id: &record.protection_id,
                kind: db::PROTECTION_CLOUD,
                source_drive: &meta.source_drive,
                source_path: &meta.source_path,
                target_drive: "",
                private_owner: "",
                created_by: created_by.as_str(),
                created_at: record.created_at,
            },
        )?;
        // A shared backup is visible to every Admin, so the standing Admins entry comes back with it.
        let access = AccessList {
            users: Vec::new(),
            admins: true,
        };
        db::set_protection_access(&tx, &record.protection_id, &serde_json::to_string(&access)?)?;
    }
    if !backup_key_exists(&tx, &key.protection_id, key.version)? {
        db::insert_backup_key(&tx, &key)?;
    }
    tx.commit()?;
    Ok(())
}

/// Rebuild where each chunk of a snapshot's files is stored: its data pack, offset and length.
/// Packs are INSERT OR IGNORE, since many snapshots share the same data packs.
/// A data pack's real size is not in the tree. The end of its furthest chunk in this tree is the
/// least it can be, so the size is an estimate: cleanup and usage treat it as a lower bound.
fn index_tree_chunks(
    tx: &rusqlite::Transaction,
    scope: &str,
    snapshot_id: &str,
    tree: &format::Tree,
    now: i64,
) -> Result<()> {
    let mut pack_sizes: HashMap<[u8; 32], i64> = HashMap::new();
    for chunk in tree.entries.iter().flat_map(|entry| entry.chunks.iter()) {
        let end = (chunk.offset + u64::from(chunk.len)) as i64;
        let size = pack_sizes.entry(chunk.pack).or_insert(0);
        *size = (*size).max(end);
    }
    for entry in &tree.entries {
        for chunk in &entry.chunks {
            let pack_id = hex(&chunk.pack);
            let size = pack_sizes.get(&chunk.pack).copied().unwrap_or(0);
            tx.execute(
                "INSERT OR IGNORE INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
                 VALUES (?1, ?2, 'live', ?3, ?4, 0, ?5)",
                params![pack_id, scope, RECOVERED_RUN, size, now],
            )?;
            db::insert_chunk(
                tx,
                scope,
                &chunk.id,
                &pack_id,
                chunk.offset as i64,
                i64::from(chunk.len),
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
                params![snapshot_id, pack_id],
            )?;
        }
    }
    Ok(())
}

fn backup_key_exists(conn: &Connection, protection_id: &str, version: i64) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM backup_keys WHERE protection_id = ?1 AND version = ?2",
            params![protection_id, version],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

pub(crate) fn already_indexed(conn: &Connection, snapshot_id: &str) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM cloud_snapshots WHERE id = ?1",
            params![snapshot_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::identity;
    use crate::backup::cloud::run::PACK_KEY_WRAP_AAD;
    use crate::backup::cloud::store::MemoryStore;
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const NOW: i64 = 1_800_000_000;
    const DEDUP_KEY: [u8; 32] = [3; 32];

    /// The scope tag a backup run derives from the dedup key.
    fn scope_id() -> [u8; 32] {
        crypto::chunk_id(&DEDUP_KEY, b"luna-scope-v1")
    }
    const TREE_KEY: [u8; 32] = [9; 32];

    /// A Luna identity (its signing key) made in its own database.
    fn fixture() -> (tempfile::TempDir, Identity) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("old.db")).unwrap();
        let id = identity::load_or_create(&conn, NOW).unwrap();
        (dir, id)
    }

    fn backup_key(key: [u8; 32]) -> BackupKey {
        BackupKey {
            protection_id: "p1".into(),
            version: 1,
            key: key.to_vec(),
            dedup_key: DEDUP_KEY.to_vec(),
            created_at: NOW,
        }
    }

    #[test]
    fn incremental_restore_keeps_only_one_tree_and_retry_finishes_partial_writes() {
        let (_dir, identity) = fixture();
        let store = MemoryStore::new();
        // Exercise a larger listing while still proving that only the current snapshot reaches
        // the write callback. The provider names sort with the failed record second.
        for n in 1..=128 {
            put_snapshot(
                &store,
                &identity,
                &format!("snapshot-{n:03}"),
                identity.luna_id(),
            );
        }
        let db_dir = tempfile::tempdir().unwrap();
        let conn = RefCell::new(db::open(&db_dir.path().join("restore.db")).unwrap());
        let key = backup_key(TREE_KEY);
        let mut processed = Vec::new();
        let first = fetch_incrementally_with_existing_check(
            &store,
            &identity,
            std::slice::from_ref(&key),
            |snapshot_id| already_indexed(&conn.borrow(), snapshot_id),
            |snapshot| {
                if snapshot.record.snapshot_id == "snapshot-002" {
                    anyhow::bail!("injected failure after one committed snapshot")
                }
                let mut conn = conn.borrow_mut();
                if already_indexed(&conn, &snapshot.record.snapshot_id)? {
                    Ok(RestoreDisposition::AlreadyIndexed)
                } else {
                    write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                    Ok(RestoreDisposition::Written)
                }
            },
            |done, total, _| {
                processed.push((done, total));
                Ok(())
            },
        );
        assert!(first.is_err());
        assert_eq!(processed, vec![(1, 128)]);
        assert_eq!(
            db::list_cloud_snapshots(&conn.borrow(), "p1")
                .unwrap()
                .len(),
            1
        );
        let pack_reads_before_retry = store.pack_reads();

        let recovered = fetch_incrementally_with_existing_check(
            &store,
            &identity,
            &[key],
            |snapshot_id| already_indexed(&conn.borrow(), snapshot_id),
            |snapshot| {
                let mut conn = conn.borrow_mut();
                if already_indexed(&conn, &snapshot.record.snapshot_id)? {
                    Ok(RestoreDisposition::AlreadyIndexed)
                } else {
                    write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                    Ok(RestoreDisposition::Written)
                }
            },
            |_done, _total, _| Ok(()),
        )
        .unwrap();
        assert_eq!(recovered.snapshots, 127);
        assert_eq!(recovered.already_indexed, 1);
        assert_eq!(
            store.pack_reads() - pack_reads_before_retry,
            127,
            "retry must not download the tree pack for an already indexed snapshot"
        );
        assert_eq!(
            db::list_cloud_snapshots(&conn.borrow(), "p1")
                .unwrap()
                .len(),
            128
        );
    }

    struct FailSecondListingPage<'a> {
        inner: &'a MemoryStore,
        calls: AtomicUsize,
        truncate_terminal: bool,
        missing_record: Option<String>,
    }

    impl CloudStore for FailSecondListingPage<'_> {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> std::result::Result<(), super::super::store::StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }
        fn get_pack(
            &self,
            id: &[u8; 32],
        ) -> std::result::Result<Vec<u8>, super::super::store::StoreError> {
            self.inner.get_pack(id)
        }
        fn delete_pack(
            &self,
            id: &[u8; 32],
        ) -> std::result::Result<(), super::super::store::StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(
            &self,
            kind: &str,
            name: &str,
            bytes: &[u8],
        ) -> std::result::Result<(), super::super::store::StoreError> {
            self.inner.put_record(kind, name, bytes)
        }
        fn get_record(
            &self,
            kind: &str,
            name: &str,
        ) -> std::result::Result<Option<Vec<u8>>, super::super::store::StoreError> {
            if self.missing_record.as_deref() == Some(name) {
                return Ok(None);
            }
            self.inner.get_record(kind, name)
        }
        fn delete_record(
            &self,
            kind: &str,
            name: &str,
        ) -> std::result::Result<(), super::super::store::StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(
            &self,
            kind: &str,
        ) -> std::result::Result<Vec<String>, super::super::store::StoreError> {
            self.inner.list_records(kind)
        }
        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> std::result::Result<super::super::store::RecordPage, super::super::store::StoreError>
        {
            assert!(limit <= RESTORE_RECORD_PAGE_SIZE);
            if self.truncate_terminal {
                let mut page = self.inner.list_record_page(kind, after, limit)?;
                page.names.truncate(1);
                page.next_after = None;
                return Ok(page);
            }
            if kind == SNAPSHOT_KIND && self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(super::super::store::StoreError::Unavailable(
                    "The listing page failed.".into(),
                ));
            }
            self.inner.list_record_page(kind, after, limit)
        }
        fn usage(
            &self,
        ) -> std::result::Result<super::super::store::Usage, super::super::store::StoreError>
        {
            self.inner.usage()
        }
    }

    #[test]
    fn listing_failure_and_cancelled_page_retry_without_losing_or_duplicating_snapshots() {
        let (_dir, identity) = fixture();
        let store = MemoryStore::new();
        for n in 1..=128 {
            put_snapshot(
                &store,
                &identity,
                &format!("snapshot-{n:03}"),
                identity.luna_id(),
            );
        }
        let db_dir = tempfile::tempdir().unwrap();
        let mut conn = db::open(&db_dir.path().join("restore-page-failure.db")).unwrap();
        let key = backup_key(TREE_KEY);
        let broken = FailSecondListingPage {
            inner: &store,
            calls: AtomicUsize::new(0),
            truncate_terminal: false,
            missing_record: None,
        };
        let first = fetch_incrementally(
            &broken,
            &identity,
            std::slice::from_ref(&key),
            |snapshot| {
                write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                Ok(RestoreDisposition::Written)
            },
            |_done, _total, _| Ok(()),
        );
        assert!(
            first.is_err(),
            "a failed page must fail the restore visibly"
        );
        assert_eq!(db::list_cloud_snapshots(&conn, "p1").unwrap().len(), 64);

        let cancelled = fetch_incrementally(
            &store,
            &identity,
            std::slice::from_ref(&key),
            |snapshot| {
                if already_indexed(&conn, &snapshot.record.snapshot_id)? {
                    Ok(RestoreDisposition::AlreadyIndexed)
                } else {
                    write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                    Ok(RestoreDisposition::Written)
                }
            },
            |processed, _, _| {
                if processed == 64 {
                    anyhow::bail!("restore stopped between pages")
                }
                Ok(())
            },
        );
        assert!(cancelled.is_err());
        assert_eq!(db::list_cloud_snapshots(&conn, "p1").unwrap().len(), 64);

        let recovered = fetch_incrementally(
            &store,
            &identity,
            &[key],
            |snapshot| {
                if already_indexed(&conn, &snapshot.record.snapshot_id)? {
                    Ok(RestoreDisposition::AlreadyIndexed)
                } else {
                    write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                    Ok(RestoreDisposition::Written)
                }
            },
            |_done, _total, _| Ok(()),
        )
        .unwrap();
        assert_eq!(recovered.snapshots, 64);
        assert_eq!(recovered.already_indexed, 64);
        assert_eq!(db::list_cloud_snapshots(&conn, "p1").unwrap().len(), 128);
    }

    #[test]
    fn truncated_terminal_page_fails_before_reporting_a_successful_restore() {
        let (_dir, identity) = fixture();
        let store = MemoryStore::new();
        for n in 1..=4 {
            put_snapshot(
                &store,
                &identity,
                &format!("snapshot-{n:03}"),
                identity.luna_id(),
            );
        }
        let broken = FailSecondListingPage {
            inner: &store,
            calls: AtomicUsize::new(0),
            truncate_terminal: true,
            missing_record: None,
        };
        let handled = Cell::new(0);
        let result = fetch_incrementally(
            &broken,
            &identity,
            &[backup_key(TREE_KEY)],
            |_| {
                handled.set(handled.get() + 1);
                Ok(RestoreDisposition::Written)
            },
            |_done, _total, _| Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(
            handled.get(),
            0,
            "validate a terminal page before writing it"
        );
    }

    #[test]
    fn changed_inventory_aborts_instead_of_skipping_new_earlier_names_and_retry_finds_them() {
        let (_dir, identity) = fixture();
        let store = MemoryStore::new();
        for n in 1..=128 {
            put_snapshot(
                &store,
                &identity,
                &format!("snapshot-{n:03}"),
                identity.luna_id(),
            );
        }
        let db_dir = tempfile::tempdir().unwrap();
        let mut conn = db::open(&db_dir.path().join("restore-changing-inventory.db")).unwrap();
        let key = backup_key(TREE_KEY);
        let mut inserted = false;
        let changed = fetch_incrementally(
            &store,
            &identity,
            std::slice::from_ref(&key),
            |snapshot| {
                write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                if !inserted {
                    inserted = true;
                    store.delete_record(SNAPSHOT_KIND, "snapshot-128").unwrap();
                    put_snapshot(&store, &identity, "snapshot-000-new", identity.luna_id());
                }
                Ok(RestoreDisposition::Written)
            },
            |_done, _total, _| Ok(()),
        );
        assert!(changed.is_err(), "a changed inventory must request a retry");
        assert_eq!(db::list_cloud_snapshots(&conn, "p1").unwrap().len(), 64);

        let recovered = fetch_incrementally(
            &store,
            &identity,
            &[key],
            |snapshot| {
                if already_indexed(&conn, &snapshot.record.snapshot_id)? {
                    Ok(RestoreDisposition::AlreadyIndexed)
                } else {
                    write_snapshot_for_restore(&mut conn, snapshot, NOW)?;
                    Ok(RestoreDisposition::Written)
                }
            },
            |_done, _total, _| Ok(()),
        )
        .unwrap();
        assert_eq!(recovered.snapshots, 64);
        assert_eq!(recovered.already_indexed, 64);
        assert_eq!(db::list_cloud_snapshots(&conn, "p1").unwrap().len(), 128);
    }

    #[test]
    fn listed_snapshot_disappearing_before_fetch_fails_without_reporting_completion() {
        let (_dir, identity) = fixture();
        let store = MemoryStore::new();
        for n in 1..=2 {
            put_snapshot(
                &store,
                &identity,
                &format!("snapshot-{n:03}"),
                identity.luna_id(),
            );
        }
        let missing = FailSecondListingPage {
            inner: &store,
            calls: AtomicUsize::new(0),
            truncate_terminal: false,
            missing_record: Some("snapshot-001".into()),
        };
        let reported = Cell::new(0);
        let result = fetch_incrementally(
            &missing,
            &identity,
            &[backup_key(TREE_KEY)],
            |_| Ok(RestoreDisposition::Written),
            |processed, _, _| {
                reported.set(processed);
                Ok(())
            },
        );
        assert!(
            result.is_err(),
            "a listed record that vanished must fail visibly"
        );
        assert_eq!(
            reported.get(),
            0,
            "the missing record must not count as skipped"
        );
    }

    /// Write one snapshot of an empty tree the way a backup run does.
    fn put_snapshot(
        store: &MemoryStore,
        signer: &Identity,
        snapshot_id: &str,
        luna_id: &str,
    ) -> [u8; 32] {
        put_snapshot_with_tree(
            store,
            signer,
            snapshot_id,
            luna_id,
            &format::Tree {
                entries: Vec::new(),
            },
        )
    }

    /// The meta a backup run seals into each snapshot record.
    fn sealed_meta(key: &[u8; 32]) -> Vec<u8> {
        let meta = BackupMeta {
            name: "Photos".into(),
            source_drive: "drive-a".into(),
            source_path: "/Photos".into(),
            started_by: "user-7".into(),
            started_by_name: String::new(),
        };
        format::encrypt_meta(&meta, key)
    }

    /// Write one snapshot the way a backup run does: a sealed tree pack, then a signed record.
    fn put_snapshot_with_tree(
        store: &MemoryStore,
        signer: &Identity,
        snapshot_id: &str,
        luna_id: &str,
        tree: &format::Tree,
    ) -> [u8; 32] {
        put_snapshot_with_meta(
            store,
            signer,
            snapshot_id,
            luna_id,
            tree,
            sealed_meta(&TREE_KEY),
        )
    }

    /// Write one snapshot with the given sealed meta bytes.
    fn put_snapshot_with_meta(
        store: &MemoryStore,
        signer: &Identity,
        snapshot_id: &str,
        luna_id: &str,
        tree: &format::Tree,
        meta: Vec<u8>,
    ) -> [u8; 32] {
        let tree_bytes = format::encrypt_tree(tree, &TREE_KEY);
        let tree_hash = format::sha256(&tree_bytes);
        let mut builder = format::PackBuilder::new(scope_id());
        builder.add(tree_hash, &tree_bytes);
        let pack =
            builder.finish(|pack_key| crypto::encrypt(&TREE_KEY, PACK_KEY_WRAP_AAD, pack_key));
        store
            .put_pack(&pack.id, Some("scope"), &pack.bytes)
            .unwrap();
        let record = SnapshotRecord {
            luna_id: luna_id.into(),
            protection_id: "p1".into(),
            snapshot_id: snapshot_id.into(),
            created_at: NOW,
            key_version: 1,
            tree_pack_id: pack.id,
            tree_hash,
            meta,
        };
        let signed = record.sign(signer.signer()).to_bytes();
        store
            .put_record(SNAPSHOT_KIND, snapshot_id, &signed)
            .unwrap();
        pack.id
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn rebuilds_each_readable_snapshot_and_its_tree_pack() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        let pack_a = put_snapshot(&store, &id, "snap-a", id.luna_id());
        put_snapshot(&store, &id, "snap-b", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 2,
                already_indexed: 0,
                skipped: 0
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 2);
        assert_eq!(count(&fresh, "cloud_snapshot_packs"), 2);
        let (state, scope): (String, String) = fresh
            .query_row(
                "SELECT state, scope FROM cloud_packs WHERE id = ?1",
                params![hex(&pack_a)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "live");
        assert_eq!(scope, hex(&scope_id()[..16]));
    }

    #[test]
    fn rebuilds_chunk_places_and_data_packs_from_the_tree() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        let chunk_id = [5u8; 32];
        let mut data = format::PackBuilder::new(scope_id());
        let (offset, len) = data.add(chunk_id, b"file bytes");
        let data_pack = data.finish(|k| crypto::encrypt(&TREE_KEY, PACK_KEY_WRAP_AAD, k));
        store
            .put_pack(&data_pack.id, Some("scope"), &data_pack.bytes)
            .unwrap();
        let tree = format::Tree {
            entries: vec![format::TreeEntry {
                path: "a.txt".into(),
                size: 10,
                mtime: NOW,
                chunks: vec![format::ChunkRef {
                    id: chunk_id,
                    pack: data_pack.id,
                    offset,
                    len,
                }],
            }],
        };
        put_snapshot_with_tree(&store, &id, "snap-a", id.luna_id(), &tree);
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 1,
                already_indexed: 0,
                skipped: 0
            }
        );
        let (pack, at, size): (String, i64, i64) = fresh
            .query_row(
                "SELECT pack_id, offset, len FROM cloud_chunks WHERE chunk_id = ?1",
                params![chunk_id.to_vec()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(pack, hex(&data_pack.id));
        assert_eq!((at, size), (offset as i64, i64::from(len)));
        let state: String = fresh
            .query_row(
                "SELECT state FROM cloud_packs WHERE id = ?1",
                params![hex(&data_pack.id)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "live");
        let size: i64 = fresh
            .query_row(
                "SELECT size FROM cloud_packs WHERE id = ?1",
                params![hex(&data_pack.id)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(size, offset as i64 + i64::from(len));
        // The tree pack and the data pack both belong to the snapshot.
        assert_eq!(count(&fresh, "cloud_snapshot_packs"), 2);
        assert_eq!(count(&fresh, "cloud_packs"), 2);
    }

    #[test]
    fn skips_records_that_do_not_verify_or_belong_to_this_luna() {
        let (_dir, id) = fixture();
        let (_other_dir, other) = fixture();
        let store = MemoryStore::new();
        // Signed by a different Luna's key.
        put_snapshot(&store, &other, "foreign", id.luna_id());
        // Signed by this Luna, but naming another Luna id.
        put_snapshot(&store, &id, "wrong-luna", "some-other-luna");
        // Not a snapshot record at all.
        store
            .put_record(SNAPSHOT_KIND, "junk", b"not a record")
            .unwrap();
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 0,
                already_indexed: 0,
                skipped: 3
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 0);
        assert_eq!(count(&fresh, "cloud_packs"), 0);
    }

    #[test]
    fn skips_a_snapshot_whose_dedup_key_names_a_different_scope() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();
        // The right key bytes with a wrong dedup key: its scope does not match the pack's.
        let wrong = BackupKey {
            dedup_key: vec![4; 32],
            ..backup_key(TREE_KEY)
        };

        let out = rebuild_snapshot_index(&mut fresh, &store, &id, &[wrong], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 0,
                already_indexed: 0,
                skipped: 1
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 0);
        assert_eq!(count(&fresh, "cloud_packs"), 0);
    }

    #[test]
    fn a_newer_key_that_does_not_open_the_tree_does_not_stop_the_right_one() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        // Version 2 is held but wrong; version 1 is right. The newer wrong key is tried first and fails cleanly.
        let newer_wrong = BackupKey {
            version: 2,
            ..backup_key([4; 32])
        };
        let out = rebuild_snapshot_index(
            &mut fresh,
            &store,
            &id,
            &[backup_key(TREE_KEY), newer_wrong],
            NOW,
        )
        .unwrap();
        assert_eq!(out.snapshots, 1);
        assert_eq!(out.skipped, 0);
    }

    #[test]
    fn needs_the_backup_key_and_a_rerun_writes_nothing_twice() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        // No key: the tree cannot be opened, so nothing is indexed.
        let none = rebuild_snapshot_index(&mut fresh, &store, &id, &[], NOW).unwrap();
        assert_eq!(
            none,
            Recovered {
                snapshots: 0,
                already_indexed: 0,
                skipped: 1
            }
        );

        // A wrong key fails the same way.
        let wrong =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key([1; 32])], NOW).unwrap();
        assert_eq!(
            wrong,
            Recovered {
                snapshots: 0,
                already_indexed: 0,
                skipped: 1
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 0);

        let first =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();
        assert_eq!(
            first,
            Recovered {
                snapshots: 1,
                already_indexed: 0,
                skipped: 0
            }
        );
        let again =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();
        assert_eq!(
            again,
            Recovered {
                snapshots: 0,
                already_indexed: 1,
                skipped: 0
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 1);
        assert_eq!(count(&fresh, "cloud_snapshot_packs"), 1);
    }

    #[test]
    fn restores_the_protection_and_its_backup_key_from_the_snapshot_meta() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        put_snapshot(&store, &id, "snap-b", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        // Two snapshots share one key version: the key is written once.
        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 2,
                already_indexed: 0,
                skipped: 0
            }
        );
        let row = db::get_protection(&fresh, "p1")
            .unwrap()
            .expect("protection restored");
        assert_eq!(row.kind, db::PROTECTION_CLOUD);
        assert_eq!(row.source_drive, "drive-a");
        assert_eq!(row.source_path, "/Photos");
        assert_eq!(row.created_by, "user-7");
        assert_eq!(row.created_at, NOW);
        let key = db::latest_backup_key(&fresh, "p1")
            .unwrap()
            .expect("backup key restored");
        assert_eq!(key.version, 1);
        assert_eq!(key.key, TREE_KEY.to_vec());
        assert_eq!(count(&fresh, "backup_keys"), 1);
    }

    #[test]
    fn keeps_an_existing_protection_row_as_it_is() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();
        db::insert_protection(
            &fresh,
            &db::NewProtection {
                id: "p1",
                kind: db::PROTECTION_CLOUD,
                source_drive: "local-drive",
                source_path: "/Local",
                target_drive: "",
                private_owner: "",
                created_by: "someone",
                created_at: NOW - 1,
            },
        )
        .unwrap();

        rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        let row = db::get_protection(&fresh, "p1").unwrap().unwrap();
        assert_eq!(row.source_path, "/Local");
        assert_eq!(row.created_by, "someone");
        assert_eq!(count(&fresh, "cloud_snapshots"), 1);
    }

    #[test]
    fn skips_a_snapshot_whose_meta_does_not_open_with_its_key() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        let tree = format::Tree {
            entries: Vec::new(),
        };
        put_snapshot_with_meta(
            &store,
            &id,
            "snap-a",
            id.luna_id(),
            &tree,
            sealed_meta(&[4; 32]),
        );
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 0,
                already_indexed: 0,
                skipped: 1
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 0);
        assert!(db::get_protection(&fresh, "p1").unwrap().is_none());
        assert_eq!(count(&fresh, "backup_keys"), 0);
    }

    #[test]
    fn a_pack_row_already_in_the_index_does_not_stop_the_rebuild() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        let pack = put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();
        fresh
            .execute(
                "INSERT INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
                 VALUES (?1, 'scope', 'live', 'older-run', 5, 0, ?2)",
                params![hex(&pack), NOW],
            )
            .unwrap();

        let out =
            rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(
            out,
            Recovered {
                snapshots: 1,
                already_indexed: 0,
                skipped: 0
            }
        );
        assert_eq!(count(&fresh, "cloud_snapshots"), 1);
        let run: String = fresh
            .query_row(
                "SELECT run_id FROM cloud_packs WHERE id = ?1",
                params![hex(&pack)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run, "older-run");
    }

    #[test]
    fn the_restored_protection_is_shared_with_admins() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a", id.luna_id());
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        let row = db::get_protection(&fresh, "p1").unwrap().unwrap();
        let access: AccessList = serde_json::from_str(&row.access_json).unwrap();
        assert_eq!(
            access,
            AccessList {
                users: Vec::new(),
                admins: true
            }
        );
    }

    #[test]
    fn a_protection_without_a_starter_is_created_by_the_first_admin() {
        let (_dir, id) = fixture();
        let store = MemoryStore::new();
        let meta = format::encrypt_meta(
            &BackupMeta {
                name: "Photos".into(),
                source_drive: "drive-a".into(),
                source_path: "/Photos".into(),
                started_by: String::new(),
                started_by_name: String::new(),
            },
            &TREE_KEY,
        );
        let tree = format::Tree {
            entries: Vec::new(),
        };
        put_snapshot_with_meta(&store, &id, "snap-a", id.luna_id(), &tree, meta);
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();
        db::insert_user(&fresh, "admin-1", "owner", "Owner", "hash", "admin").unwrap();

        rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        let row = db::get_protection(&fresh, "p1").unwrap().unwrap();
        assert_eq!(row.created_by, "admin-1");
    }
}
