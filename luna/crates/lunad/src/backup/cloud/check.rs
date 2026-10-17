//! Cloud backup check: confirms a protection's cloud backup is still complete and readable.
//!
//! Each snapshot record is verified against Luna's signing key, and its tree pack is
//! downloaded and opened. Sampled packs are downloaded and opened (hash and decrypt).
//! Store calls never run while the database lock is held.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::{anyhow, Result};
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection};

use super::crypto;
use super::format::{self, OpenedPack, SignedRecord, SnapshotRecord, Tree};
use super::identity;
use super::run::{self, PACK_KEY_WRAP_AAD};
use super::store::{CloudStore, StoreError};
use crate::db::{self, BackupKey, SnapshotInsert};

/// What a check found. An empty list means nothing was found wrong with that kind of piece.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckReport {
    pub snapshots_checked: u32,
    pub packs_checked: u32,
    /// Packs the store does not have, or packs a snapshot needs that it does not list.
    pub missing_packs: Vec<String>,
    /// Packs the store has, but that fail the hash check or cannot be decrypted.
    pub damaged_packs: Vec<String>,
    /// Snapshot records that are missing, fail the signature check, or do not match the database.
    pub bad_records: Vec<String>,
    /// One plain sentence summarising the most serious finding, or `None` when all good.
    pub problem: Option<String>,
}

/// Which packs to download and open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sample {
    All,
    /// This many packs, picked at random.
    Random(u32),
}

/// What the check needs from the database, read in one short lock.
struct Plan {
    public: [u8; 32],
    keys: Vec<BackupKey>,
    snapshots: Vec<SnapshotInsert>,
    /// Snapshot id -> the pack ids listed for it.
    listed: HashMap<String, HashSet<String>>,
    /// Chunk id -> the pack that holds it, for packs of this protection.
    chunk_pack: HashMap<[u8; 32], String>,
}

pub fn check(
    db: &crate::Db,
    protection_id: &str,
    store: &dyn CloudStore,
    sample: Sample,
    now: i64,
) -> Result<CheckReport> {
    let plan = {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        read_plan(&conn, protection_id)?
    };

    let mut report = CheckReport::default();
    let mut examined: HashSet<String> = HashSet::new();
    let unwrap = unwrap_with(&plan.keys);

    // Every snapshot: verify its record, then open its tree pack.
    for snap in &plan.snapshots {
        let Some(record) = load_record(store, snap, protection_id, &plan.public)? else {
            report.bad_records.push(snap.id.clone());
            continue;
        };
        report.snapshots_checked += 1;
        let Some(listed) = plan.listed.get(&snap.id) else {
            report.bad_records.push(snap.id.clone());
            continue;
        };
        if !listed.contains(&snap.tree_pack_id) {
            report.bad_records.push(snap.id.clone());
            continue;
        }
        let Some(key) = plan
            .keys
            .iter()
            .find(|k| k.version == i64::from(record.key_version))
        else {
            return Err(anyhow!(
                "The backup key for this cloud backup is missing from this Luna's database."
            ));
        };
        let key: [u8; 32] = key
            .key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("The backup key for this cloud backup is damaged."))?;
        if examine_pack(store, &snap.tree_pack_id, &unwrap, &mut report, &mut examined)?.is_none() {
            continue;
        }
        // The tree chunk is found by the record's `tree_hash`, so no pack chunk listing is needed.
        let Ok(tree) = run::read_tree(store, &record, &key) else {
            report.bad_records.push(snap.id.clone());
            continue;
        };
        let tree_chunks: Vec<[u8; 32]> = tree
            .entries
            .iter()
            .flat_map(|e| e.chunks.iter().copied())
            .collect();
        let (packs, unknown) = unlisted_chunks(&tree_chunks, listed, &plan.chunk_pack);
        for pack in packs {
            if !report.missing_packs.contains(&pack) {
                report.missing_packs.push(pack);
            }
        }
        if unknown > 0 {
            report.bad_records.push(snap.id.clone());
        }
    }

    // The other packs of this protection: sample them and open each one.
    let rest: BTreeSet<String> = plan
        .listed
        .values()
        .flatten()
        .filter(|p| !examined.contains(*p))
        .cloned()
        .collect();
    for pack_id in sample_packs(rest.into_iter().collect(), sample) {
        examine_pack(store, &pack_id, &unwrap, &mut report, &mut examined)?;
    }

    report.problem = summarise(&report);
    {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        db::set_meta(&conn, &format!("cloud_checked:{protection_id}"), &now.to_string())?;
    }
    Ok(report)
}

fn read_plan(conn: &Connection, protection_id: &str) -> Result<Plan> {
    let identity = identity::load(conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?;
    let snapshots = db::list_cloud_snapshots(conn, protection_id)?;
    let keys = db::list_backup_keys(conn, protection_id)?;

    let mut listed: HashMap<String, HashSet<String>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT p.snapshot_id, p.pack_id FROM cloud_snapshot_packs p
         JOIN cloud_snapshots s ON s.id = p.snapshot_id
         WHERE s.protection_id = ?1",
    )?;
    let rows = stmt.query_map(params![protection_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (snap, pack) = row?;
        listed.entry(snap).or_default().insert(pack);
    }

    let mut chunk_pack = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT c.chunk_id, c.pack_id FROM cloud_chunks c
         WHERE c.pack_id IN (
             SELECT p.pack_id FROM cloud_snapshot_packs p
             JOIN cloud_snapshots s ON s.id = p.snapshot_id
             WHERE s.protection_id = ?1)",
    )?;
    let rows = stmt.query_map(params![protection_id], |r| {
        Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (blob, pack) = row?;
        if let Ok(id) = <[u8; 32]>::try_from(blob.as_slice()) {
            chunk_pack.insert(id, pack);
        }
    }

    Ok(Plan {
        public: identity.public(),
        keys,
        snapshots,
        listed,
        chunk_pack,
    })
}

/// Fetch a snapshot record and verify it. `None` means the record is missing, fails the
/// signature check, or does not match what the database says about the snapshot.
fn load_record(
    store: &dyn CloudStore,
    snap: &SnapshotInsert,
    protection_id: &str,
    public: &[u8; 32],
) -> Result<Option<SnapshotRecord>> {
    let bytes = match store.get_record("snapshots", &snap.id) {
        Ok(Some(bytes)) => bytes,
        Ok(None) | Err(StoreError::NotFound) => return Ok(None),
        Err(e) => return Err(anyhow!("{e}")),
    };
    let Ok(signed) = SignedRecord::from_bytes(&bytes) else {
        return Ok(None);
    };
    let Ok(record) = signed.verify(public) else {
        return Ok(None);
    };
    let matches_db = record.snapshot_id == snap.id
        && record.protection_id == protection_id
        && hex(&record.tree_pack_id) == snap.tree_pack_id;
    Ok(matches_db.then_some(record))
}

/// Download and open one pack, recording the outcome. `None` when the pack was not usable.
fn examine_pack(
    store: &dyn CloudStore,
    pack_id: &str,
    unwrap: &dyn Fn(&[u8]) -> Result<[u8; 32]>,
    report: &mut CheckReport,
    examined: &mut HashSet<String>,
) -> Result<Option<OpenedPack>> {
    examined.insert(pack_id.to_string());
    report.packs_checked += 1;
    let Some(id) = parse_id(pack_id) else {
        report.damaged_packs.push(pack_id.to_string());
        return Ok(None);
    };
    match store.get_pack(&id) {
        Err(StoreError::NotFound) => {
            report.missing_packs.push(pack_id.to_string());
            Ok(None)
        }
        Err(e) => Err(anyhow!("{e}")),
        Ok(bytes) => match format::open_pack(&bytes, &id, unwrap) {
            Ok(pack) => Ok(Some(pack)),
            Err(_) => {
                report.damaged_packs.push(pack_id.to_string());
                Ok(None)
            }
        },
    }
}

/// Unwrap a pack's key with any of the protection's backup keys.
fn unwrap_with(keys: &[BackupKey]) -> impl Fn(&[u8]) -> Result<[u8; 32]> + '_ {
    move |wrapped: &[u8]| {
        for k in keys {
            let Ok(key) = <[u8; 32]>::try_from(k.key.as_slice()) else {
                continue;
            };
            if let Ok(plain) = crypto::decrypt(&key, PACK_KEY_WRAP_AAD, wrapped) {
                if let Ok(pack_key) = <[u8; 32]>::try_from(plain.as_slice()) {
                    return Ok(pack_key);
                }
            }
        }
        Err(anyhow!("A backup file could not be opened with this Luna's keys."))
    }
}

/// The chunks a tree names that are not held by a pack listed for its snapshot.
/// Returns the packs that hold such chunks, and how many chunks no known pack holds.
fn unlisted_chunks(
    chunks: &[[u8; 32]],
    listed: &HashSet<String>,
    chunk_pack: &HashMap<[u8; 32], String>,
) -> (BTreeSet<String>, usize) {
    let mut packs = BTreeSet::new();
    let mut unknown = 0;
    for chunk in chunks {
        match chunk_pack.get(chunk) {
            Some(pack) if !listed.contains(pack) => {
                packs.insert(pack.clone());
            }
            Some(_) => {}
            None => unknown += 1,
        }
    }
    (packs, unknown)
}

fn sample_packs(mut ids: Vec<String>, sample: Sample) -> Vec<String> {
    match sample {
        Sample::All => ids,
        Sample::Random(n) => {
            // Fisher-Yates shuffle with the OS random number generator, then keep the first n.
            for i in (1..ids.len()).rev() {
                let j = (OsRng.next_u64() % (i as u64 + 1)) as usize;
                ids.swap(i, j);
            }
            ids.truncate(n as usize);
            ids
        }
    }
}

fn summarise(r: &CheckReport) -> Option<String> {
    if !r.bad_records.is_empty() {
        return Some(
            "A cloud backup record failed its signature check or is missing. Contact your Admin."
                .into(),
        );
    }
    if !r.missing_packs.is_empty() {
        let n = r.missing_packs.len();
        let verb = if n == 1 { "is" } else { "are" };
        return Some(format!(
            "{} of this cloud backup {verb} missing from Luna Connect.",
            pieces(n)
        ));
    }
    if !r.damaged_packs.is_empty() {
        let n = r.damaged_packs.len();
        let verb = if n == 1 { "is" } else { "are" };
        return Some(format!(
            "{} of this cloud backup {verb} damaged. Contact your Admin.",
            pieces(n)
        ));
    }
    None
}

fn pieces(n: usize) -> String {
    if n == 1 {
        "1 piece".into()
    } else {
        format!("{n} pieces")
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_id(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::crypto::Signer;
    use crate::backup::cloud::format::{PackBuilder, TreeEntry};
    use crate::backup::cloud::identity;
    use crate::backup::cloud::store::MemoryStore;

    const AAD: &[u8] = b"luna-pack-key-wrap-v1";

    /// A store that flips one byte of one pack on the way out.
    struct CorruptStore {
        inner: MemoryStore,
        target: [u8; 32],
    }

    impl CloudStore for CorruptStore {
        fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            let mut bytes = self.inner.get_pack(id)?;
            if *id == self.target {
                bytes[10] ^= 1;
            }
            Ok(bytes)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
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
        fn usage(&self) -> Result<crate::backup::cloud::store::Usage, StoreError> {
            self.inner.usage()
        }
    }

    fn setup(dir: &std::path::Path, now: i64) -> crate::Db {
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
        identity::load_or_create(&conn, now).unwrap();
        db::insert_backup_key(
            &conn,
            &BackupKey {
                protection_id: "p1".into(),
                version: 1,
                key: vec![9; 32],
                dedup_key: vec![5; 32],
                created_at: 1,
            },
        )
        .unwrap();
        crate::Db::new(conn)
    }

    /// Write one snapshot with no extra chunks.
    fn backup(db: &crate::Db, store: &MemoryStore, now: i64) -> ([u8; 32], [u8; 32]) {
        backup_with_extra(db, store, now, &[])
    }

    /// Write one snapshot (a data pack, a tree pack, a signed record) into the store and database.
    /// The tree also names `extra` chunks, which no pack holds unless the caller stores them.
    /// Returns the data pack id and the tree pack id.
    fn backup_with_extra(
        db: &crate::Db,
        store: &MemoryStore,
        now: i64,
        extra: &[[u8; 32]],
    ) -> ([u8; 32], [u8; 32]) {
        let mut conn = db.lock().unwrap_or_else(|p| p.into_inner());
        let luna_id = identity::load(&conn).unwrap().unwrap().luna_id().to_string();
        let seed: [u8; 32] = db::get_cloud_identity(&conn)
            .unwrap()
            .unwrap()
            .signing_seed
            .try_into()
            .unwrap();
        let signer = Signer::from_seed(seed);
        let key = [9u8; 32];
        let dedup = [5u8; 32];
        let scope_id = crypto::chunk_id(&dedup, b"luna-scope-v1");
        let scope = hex(&scope_id[..16]);

        let chunk = vec![1u8; 5000];
        let cid = crypto::chunk_id(&dedup, &chunk);
        let mut builder = PackBuilder::new(scope_id);
        let (offset, len) = builder.add(cid, &chunk);
        let data = builder.finish(|pk| crypto::encrypt(&key, AAD, pk));

        let mut chunks = vec![cid];
        chunks.extend_from_slice(extra);
        let tree = Tree {
            entries: vec![TreeEntry {
                path: "a.bin".into(),
                size: 5000,
                mtime: 1,
                chunks,
            }],
        };
        let tree_bytes = format::encrypt_tree(&tree, &key);
        let tree_hash = format::sha256(&tree_bytes);
        let mut tree_builder = PackBuilder::new(scope_id);
        let (tree_offset, tree_len) = tree_builder.add(tree_hash, &tree_bytes);
        let tree_pack = tree_builder.finish(|pk| crypto::encrypt(&key, AAD, pk));

        for sealed in [&data, &tree_pack] {
            store.put_pack(&sealed.id, Some(&scope), &sealed.bytes).unwrap();
            db::insert_pending_pack(&conn, &hex(&sealed.id), &scope, "run-1", now).unwrap();
        }
        db::insert_chunk(&conn, &scope, &cid, &hex(&data.id), offset as i64, len as i64).unwrap();
        db::insert_chunk(
            &conn,
            &scope,
            &tree_hash,
            &hex(&tree_pack.id),
            tree_offset as i64,
            tree_len as i64,
        )
        .unwrap();

        let record = SnapshotRecord {
            luna_id,
            protection_id: "p1".into(),
            snapshot_id: "snap-1".into(),
            created_at: now,
            key_version: 1,
            tree_pack_id: tree_pack.id,
            tree_hash,
            meta: Vec::new(),
        };
        let signed = record.sign(&signer).to_bytes();
        store.put_record("snapshots", "snap-1", &signed).unwrap();
        let snap = SnapshotInsert {
            id: "snap-1".into(),
            protection_id: "p1".into(),
            created_at: now,
            key_version: 1,
            tree_pack_id: hex(&tree_pack.id),
            record: signed,
        };
        db::commit_snapshot_tx(&mut conn, &snap, &[hex(&data.id), hex(&tree_pack.id)]).unwrap();
        (data.id, tree_pack.id)
    }

    #[test]
    fn tree_naming_a_chunk_in_no_pack_is_bad() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let store = MemoryStore::new();
        let missing = crypto::chunk_id(&[5u8; 32], b"no pack holds this chunk");
        backup_with_extra(&db, &store, 100, &[missing]);

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.bad_records, vec!["snap-1".to_string()]);
        assert!(report.problem.is_some());
    }

    #[test]
    fn all_good_has_no_problem() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let store = MemoryStore::new();
        backup(&db, &store, 100);

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.problem, None);
        assert_eq!(report.snapshots_checked, 1);
        assert_eq!(report.packs_checked, 2);
        assert!(report.missing_packs.is_empty());
        assert!(report.damaged_packs.is_empty());
        assert!(report.bad_records.is_empty());

        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            db::get_meta(&conn, "cloud_checked:p1").unwrap(),
            Some("200".into())
        );
    }

    #[test]
    fn deleted_pack_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let store = MemoryStore::new();
        let (data_id, _) = backup(&db, &store, 100);
        store.delete_pack(&data_id).unwrap();

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.missing_packs, vec![hex(&data_id)]);
        assert!(report.problem.unwrap().contains("missing from Luna Connect"));
    }

    #[test]
    fn flipped_byte_is_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let inner = MemoryStore::new();
        let (data_id, _) = backup(&db, &inner, 100);
        let store = CorruptStore {
            inner,
            target: data_id,
        };

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.damaged_packs, vec![hex(&data_id)]);
        assert!(report.missing_packs.is_empty());
        assert!(report.problem.is_some());
    }

    #[test]
    fn tampered_record_is_bad() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let store = MemoryStore::new();
        backup(&db, &store, 100);
        let bytes = store.get_record("snapshots", "snap-1").unwrap().unwrap();
        let mut signed = SignedRecord::from_bytes(&bytes).unwrap();
        signed.record.created_at += 1;
        store
            .put_record("snapshots", "snap-1", &signed.to_bytes())
            .unwrap();

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.bad_records, vec!["snap-1".to_string()]);
        assert_eq!(report.snapshots_checked, 0);
        assert!(report.problem.unwrap().contains("signature check"));
    }

    #[test]
    fn random_sample_checks_only_that_many_packs() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), 100);
        let store = MemoryStore::new();
        backup(&db, &store, 100);

        // The tree pack is always examined; one more pack is sampled from the rest.
        let report = check(&db, "p1", &store, Sample::Random(1), 200).unwrap();
        assert_eq!(report.packs_checked, 2);
        assert_eq!(report.problem, None);
    }

    #[test]
    fn chunks_outside_listed_packs_are_reported() {
        let chunks = [[1u8; 32], [2u8; 32], [3u8; 32]];
        let listed: HashSet<String> = ["pa".to_string()].into();
        let chunk_pack = HashMap::from([
            ([1u8; 32], "pa".to_string()),
            ([2u8; 32], "pb".to_string()),
        ]);
        let (packs, unknown) = unlisted_chunks(&chunks, &listed, &chunk_pack);
        assert_eq!(packs, BTreeSet::from(["pb".to_string()]));
        assert_eq!(unknown, 1);
    }
}
