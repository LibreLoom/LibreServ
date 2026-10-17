//! Rebuilds the cloud backup index after Luna's database is lost.
//!
//! Snapshot records live on Connect and are signed by Luna's signing key, so the recovered
//! identity checks each one. A readable snapshot gets its row, its tree pack and the pack's
//! live state. Data packs are not rebuilt: nothing lists them, and tree entries name chunks,
//! not packs. Packs the index does not know are never deleted, so they are left alone.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::crypto;
use super::format::{self, SignedRecord, SnapshotRecord};
use super::identity::Identity;
use super::run::PACK_KEY_WRAP_AAD;
use super::store::CloudStore;
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

enum Step {
    Written,
    Indexed,
    Skipped,
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
    let names = store.list_records(SNAPSHOT_KIND).map_err(|e| anyhow!("{e}"))?;
    let mut out = Recovered::default();
    for name in names {
        let bytes = match store.get_record(SNAPSHOT_KIND, &name) {
            Ok(Some(bytes)) => bytes,
            _ => {
                out.skipped += 1;
                continue;
            }
        };
        match index_one(conn, store, identity, keys, &bytes, now)? {
            Step::Written => out.snapshots += 1,
            Step::Indexed => out.already_indexed += 1,
            Step::Skipped => out.skipped += 1,
        }
    }
    Ok(out)
}

fn index_one(
    conn: &mut Connection,
    store: &dyn CloudStore,
    identity: &Identity,
    keys: &[BackupKey],
    bytes: &[u8],
    now: i64,
) -> Result<Step> {
    let Ok(signed) = SignedRecord::from_bytes(bytes) else {
        return Ok(Step::Skipped);
    };
    let Ok(record) = signed.verify(&identity.public()) else {
        return Ok(Step::Skipped);
    };
    if record.luna_id != identity.luna_id() {
        return Ok(Step::Skipped);
    }
    let Some(key) = keys
        .iter()
        .find(|k| k.protection_id == record.protection_id && k.version == i64::from(record.key_version))
    else {
        return Ok(Step::Skipped);
    };
    let Ok(tree_key) = <[u8; 32]>::try_from(key.key.as_slice()) else {
        return Ok(Step::Skipped);
    };
    if already_indexed(conn, &record.snapshot_id)? {
        return Ok(Step::Indexed);
    }

    // The tree pack must open with this key and hold the tree the record names.
    let Ok(pack_bytes) = store.get_pack(&record.tree_pack_id) else {
        return Ok(Step::Skipped);
    };
    let unwrap = |wrapped: &[u8]| -> Result<[u8; 32]> {
        let plain = crypto::decrypt(&tree_key, PACK_KEY_WRAP_AAD, wrapped)?;
        <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| anyhow!("pack key"))
    };
    let Ok(pack) = format::open_pack(&pack_bytes, &record.tree_pack_id, unwrap) else {
        return Ok(Step::Skipped);
    };
    match pack.chunk(&record.tree_hash) {
        Some(sealed) if format::sha256(sealed) == record.tree_hash => {}
        _ => return Ok(Step::Skipped),
    }

    let scope = hex(&pack.scope_id()[..16]);
    let tree_pack_id = hex(&record.tree_pack_id);
    let snapshot = SnapshotInsert {
        id: record.snapshot_id.clone(),
        protection_id: record.protection_id.clone(),
        created_at: record.created_at,
        key_version: i64::from(record.key_version),
        tree_pack_id: tree_pack_id.clone(),
        record: bytes.to_vec(),
    };
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
         VALUES (?1, ?2, 'live', ?3, ?4, 0, ?5)",
        params![tree_pack_id, scope, RECOVERED_RUN, pack_bytes.len() as i64, now],
    )?;
    db::insert_cloud_snapshot(&tx, &snapshot)?;
    tx.execute(
        "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
        params![snapshot.id, tree_pack_id],
    )?;
    tx.commit()?;
    Ok(Step::Written)
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
    const SCOPE_ID: [u8; 32] = [7; 32];
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
            dedup_key: vec![3; 32],
            created_at: NOW,
        }
    }

    /// Write one snapshot the way a backup run does: a sealed tree pack, then a signed record.
    fn put_snapshot(store: &MemoryStore, signer: &Identity, snapshot_id: &str, luna_id: &str) -> [u8; 32] {
        let tree_bytes = format::encrypt_tree(&format::Tree { entries: Vec::new() }, &TREE_KEY);
        let tree_hash = format::sha256(&tree_bytes);
        let mut builder = format::PackBuilder::new(SCOPE_ID);
        builder.add(tree_hash, &tree_bytes);
        let pack = builder.finish(|pack_key| crypto::encrypt(&TREE_KEY, PACK_KEY_WRAP_AAD, pack_key));
        store.put_pack(&pack.id, Some("scope"), &pack.bytes).unwrap();
        let record = SnapshotRecord {
            luna_id: luna_id.into(),
            protection_id: "p1".into(),
            snapshot_id: snapshot_id.into(),
            created_at: NOW,
            key_version: 1,
            tree_pack_id: pack.id,
            tree_hash,
            meta: Vec::new(),
        };
        let signed = record.sign(signer.signer()).to_bytes();
        store.put_record(SNAPSHOT_KIND, snapshot_id, &signed).unwrap();
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

        let out = rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(out, Recovered { snapshots: 2, already_indexed: 0, skipped: 0 });
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
        assert_eq!(scope, hex(&SCOPE_ID[..16]));
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
        store.put_record(SNAPSHOT_KIND, "junk", b"not a record").unwrap();
        let fresh_dir = tempfile::tempdir().unwrap();
        let mut fresh = db::open(&fresh_dir.path().join("luna.db")).unwrap();

        let out = rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();

        assert_eq!(out, Recovered { snapshots: 0, already_indexed: 0, skipped: 3 });
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
        assert_eq!(none, Recovered { snapshots: 0, already_indexed: 0, skipped: 1 });

        // A wrong key fails the same way.
        let wrong = rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key([1; 32])], NOW).unwrap();
        assert_eq!(wrong, Recovered { snapshots: 0, already_indexed: 0, skipped: 1 });
        assert_eq!(count(&fresh, "cloud_snapshots"), 0);

        let first = rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();
        assert_eq!(first, Recovered { snapshots: 1, already_indexed: 0, skipped: 0 });
        let again = rebuild_snapshot_index(&mut fresh, &store, &id, &[backup_key(TREE_KEY)], NOW).unwrap();
        assert_eq!(again, Recovered { snapshots: 0, already_indexed: 1, skipped: 0 });
        assert_eq!(count(&fresh, "cloud_snapshots"), 1);
        assert_eq!(count(&fresh, "cloud_snapshot_packs"), 1);
    }
}
