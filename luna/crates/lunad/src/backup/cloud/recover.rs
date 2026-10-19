//! Rebuilds the cloud backup index after Luna's database is lost.
//!
//! Snapshot records live on Connect and are signed by Luna's signing key, so the recovered
//! identity checks each one. A readable snapshot gets its row, its tree pack and the pack's
//! live state. The tree also names every chunk and the data pack it lives in, so those rows are
//! rebuilt too. The snapshot's sealed meta names its protection, so the protection row and its
//! backup key are restored from it. Packs the index does not know are never deleted, so they are
//! left alone.

use std::collections::HashMap;

use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};

use super::crypto;
use super::format::{self, BackupMeta, SignedRecord, SnapshotRecord};
use super::identity::Identity;
use super::run::PACK_KEY_WRAP_AAD;
use super::store::CloudStore;
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

/// Records fetched and checked from Connect, ready to write. Built without a database connection,
/// so the network work can finish before any database lock is taken.
pub struct Prepared {
    /// Records that could not be read, verified, opened, or matched to a backup key.
    pub skipped: u32,
    /// Snapshots that passed every check.
    pub snapshots: Vec<PreparedSnapshot>,
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
    pub tree: format::Tree,
    pub meta: BackupMeta,
    /// The backup key this snapshot was opened with.
    pub key: BackupKey,
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
    let prepared = fetch_recoverable(store, identity, keys)?;
    write_recovered(conn, prepared, now)
}

/// Fetch, verify and decrypt every snapshot record on the store. Makes no database changes.
pub fn fetch_recoverable(
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
) -> Result<Prepared> {
    let names = store
        .list_records(SNAPSHOT_KIND)
        .map_err(|e| anyhow!("{e}"))?;
    let mut out = Prepared {
        skipped: 0,
        snapshots: Vec::new(),
    };
    for name in names {
        let bytes = match store.get_record(SNAPSHOT_KIND, &name) {
            Ok(Some(bytes)) => bytes,
            _ => {
                out.skipped += 1;
                continue;
            }
        };
        match fetch_one(store, identity, keys, bytes) {
            Some(snapshot) => out.snapshots.push(snapshot),
            None => out.skipped += 1,
        }
    }
    Ok(out)
}

/// Write fetched snapshots into the index. Snapshots already indexed are counted and left alone.
pub fn write_recovered(conn: &mut Connection, prepared: Prepared, now: i64) -> Result<Recovered> {
    let mut out = Recovered {
        skipped: prepared.skipped,
        ..Recovered::default()
    };
    for snapshot in prepared.snapshots {
        if already_indexed(conn, &snapshot.record.snapshot_id)? {
            out.already_indexed += 1;
        } else {
            write_snapshot(conn, snapshot, now)?;
            out.snapshots += 1;
        }
    }
    Ok(out)
}

/// Check one record and fetch its tree. `None` means the record is skipped.
fn fetch_one(
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    bytes: Vec<u8>,
) -> Option<PreparedSnapshot> {
    let signed = SignedRecord::from_bytes(&bytes).ok()?;
    let record = signed.verify(&identity.public()).ok()?;
    if record.luna_id != identity.luna_id() {
        return None;
    }
    let key = keys.iter().find(|k| {
        k.protection_id == record.protection_id && k.version == i64::from(record.key_version)
    })?;
    let tree_key = <[u8; 32]>::try_from(key.key.as_slice()).ok()?;
    let dedup_key = <[u8; 32]>::try_from(key.dedup_key.as_slice()).ok()?;

    // The tree pack must open with this key and hold the tree the record names.
    let pack_bytes = store.get_pack(&record.tree_pack_id).ok()?;
    let unwrap = |wrapped: &[u8]| -> Result<[u8; 32]> {
        let plain = crypto::decrypt(&tree_key, PACK_KEY_WRAP_AAD, wrapped)?;
        <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| anyhow!("pack key"))
    };
    let pack = format::open_pack(&pack_bytes, &record.tree_pack_id, unwrap).ok()?;
    let sealed = match pack.chunk(&record.tree_hash) {
        Some(sealed) if format::sha256(sealed) == record.tree_hash => sealed,
        _ => return None,
    };
    let tree = format::decrypt_tree(sealed, &tree_key).ok()?;
    let meta = format::decrypt_meta(&record.meta, &tree_key).ok()?;

    // The pack's scope tag is derived from the dedup key, so a wrong dedup key cannot match it.
    let expected_scope = hex(&crypto::chunk_id(&dedup_key, b"luna-scope-v1")[..16]);
    let scope = hex(&pack.scope_id()[..16]);
    if scope != expected_scope {
        return None;
    }
    Some(PreparedSnapshot {
        record_bytes: bytes,
        tree_pack_size: pack_bytes.len() as i64,
        scope,
        record,
        tree,
        meta,
        key: key.clone(),
    })
}

/// Write one prepared snapshot, its packs, chunks, protection row and backup key in one transaction.
fn write_snapshot(conn: &mut Connection, snapshot: PreparedSnapshot, now: i64) -> Result<()> {
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
        let created_by = if meta.started_by.is_empty() {
            db::first_admin(&tx)?.map(|u| u.id).unwrap_or_default()
        } else {
            meta.started_by.clone()
        };
        db::insert_protection(
            &tx,
            &db::NewProtection {
                id: &record.protection_id,
                kind: db::PROTECTION_CLOUD,
                source_drive: &meta.source_drive,
                source_path: &meta.source_path,
                target_drive: "",
                private_owner: "",
                created_by: &created_by,
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

fn already_indexed(conn: &Connection, snapshot_id: &str) -> Result<bool> {
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
    use crate::backup::cloud::store::MemoryStore;

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
