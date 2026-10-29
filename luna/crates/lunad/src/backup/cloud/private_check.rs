//! Private items in the cloud: checks that a private item's cloud copy is intact.
//!
//! Luna never trusts Connect's answer and never opens the data. It checks the newest private
//! snapshot's signed record against its own database copy, then checks pack hashes. No owner
//! secret is needed.

use anyhow::{Result, anyhow};
use rand_core::{OsRng, RngCore};

use super::check::{CheckReport, Sample};
use super::crypto::{SigPublic, Signer};
use super::format::{self, SignedRecord};
use super::identity;
use super::private::{self, PRIVATE_SNAPSHOT_DOMAIN, PSCOPES_KIND, PSNAPSHOTS_KIND};
use super::run::lock;
use super::store::{CloudStore, StoreError};
use crate::db;

const SNAPSHOT_PROBLEM: &str =
    "The newest cloud version of this private item is missing or changed. Run the backup again.";
const PACK_PROBLEM: &str =
    "Part of this private item's cloud backup is missing or damaged. Run the backup again.";

/// Check a private backup the way plan §5 says. Same signature and report type as
/// `check::check`, so `ops::check` can dispatch to it.
pub fn check(
    db: &crate::Db,
    protection_id: &str,
    store: &dyn CloudStore,
    sample: Sample,
    _now: i64,
) -> Result<CheckReport> {
    let job = read_job(db, protection_id)?;
    let Some(job) = job else {
        return Ok(CheckReport::default());
    };
    let mut report = CheckReport {
        snapshots_checked: 1,
        ..CheckReport::default()
    };

    // Re-publish the scope record if Connect lost it. Needs the owner's keys and a local scope row.
    if let (Some(scope), Some(auth_public)) = (&job.scope, &job.auth_public) {
        let present = store
            .get_record(PSCOPES_KIND, &scope.scope)
            .map_err(store_err)?;
        if present.is_none() {
            private::publish_scope(store, &job.signer, &job.luna_id, scope, auth_public)?;
        }
    }

    let name = private::psnapshot_name(&job.scope_name, &job.snapshot_id);
    let record_ok = match store
        .get_record(PSNAPSHOTS_KIND, &name)
        .map_err(store_err)?
    {
        None => false,
        Some(stored) => {
            stored == job.record
                && SignedRecord::from_bytes(&stored)
                    .ok()
                    .and_then(|signed| {
                        signed
                            .verify_with(&job.public, PRIVATE_SNAPSHOT_DOMAIN)
                            .ok()
                    })
                    .is_some()
        }
    };
    if !record_ok {
        report.bad_records.push(job.snapshot_id.clone());
        report.problem = Some(SNAPSHOT_PROBLEM.to_string());
    }

    let mut data_packs: Vec<String> = job
        .pack_ids
        .iter()
        .filter(|id| **id != job.tree_pack_id)
        .cloned()
        .collect();
    data_packs = sample_packs(data_packs, sample);
    let mut to_check = vec![job.tree_pack_id.clone()];
    to_check.extend(data_packs);

    for id in &to_check {
        let raw = unhex(id)?;
        match store.get_pack(&raw) {
            Ok(bytes) => {
                report.packs_checked += 1;
                if format::sha256(&bytes) != raw {
                    report.damaged_packs.push(id.clone());
                    report
                        .problem
                        .get_or_insert_with(|| PACK_PROBLEM.to_string());
                }
            }
            Err(StoreError::NotFound) => {
                report.missing_packs.push(id.clone());
                report
                    .problem
                    .get_or_insert_with(|| PACK_PROBLEM.to_string());
            }
            Err(e) => return Err(anyhow!("{e}")),
        }
    }

    Ok(report)
}

/// What the check needs from the database, read in one short lock.
struct Job {
    snapshot_id: String,
    scope_name: String,
    record: Vec<u8>,
    tree_pack_id: String,
    pack_ids: Vec<String>,
    scope: Option<db::PrivateScope>,
    auth_public: Option<SigPublic>,
    public: SigPublic,
    luna_id: String,
    signer: Signer,
}

fn read_job(db: &crate::Db, protection_id: &str) -> Result<Option<Job>> {
    let conn = lock(db);
    let mut newest = None;
    for snap in db::list_cloud_snapshots(&conn, protection_id)? {
        if let Some(scope_name) = db::private_scope_of_snapshot(&conn, &snap.id)? {
            newest = Some((snap, scope_name));
            break;
        }
    }
    let Some((snap, scope_name)) = newest else {
        return Ok(None);
    };

    let identity = identity::load(&conn)?
        .ok_or_else(|| anyhow!("Set up cloud backup on this Luna before checking a backup."))?;
    let seed: [u8; 32] = db::get_cloud_identity(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
        .signing_seed
        .try_into()
        .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;

    let mut stmt =
        conn.prepare("SELECT pack_id FROM cloud_snapshot_packs WHERE snapshot_id = ?1")?;
    let pack_ids = stmt
        .query_map([&snap.id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let scope = db::get_private_scope(&conn, &scope_name)?;
    let auth_public = match &scope {
        Some(row) => db::get_user_keys(&conn, &row.owner)?
            .map(|keys| keys.auth_public.as_slice().try_into())
            .transpose()
            .map_err(|_| anyhow!("This private backup's key is damaged."))?,
        None => None,
    };

    Ok(Some(Job {
        snapshot_id: snap.id,
        scope_name,
        record: snap.record,
        tree_pack_id: snap.tree_pack_id,
        pack_ids,
        scope,
        auth_public,
        public: identity.public(),
        luna_id: identity.luna_id().to_string(),
        signer: Signer::from_seed(seed),
    }))
}

/// Maps a store failure to an error the caller reports as "could not check".
fn store_err(e: StoreError) -> anyhow::Error {
    anyhow!("{e}")
}

/// Picks up to `n` data packs at random, or all of them.
fn sample_packs(mut ids: Vec<String>, sample: Sample) -> Vec<String> {
    match sample {
        Sample::All => ids,
        Sample::Random(n) => {
            for i in (1..ids.len()).rev() {
                let j = (OsRng.next_u64() % (i as u64 + 1)) as usize;
                ids.swap(i, j);
            }
            ids.truncate(n as usize);
            ids
        }
    }
}

/// Reads a pack id (64 lowercase hex characters) back into its 32 bytes.
fn unhex(text: &str) -> Result<[u8; 32]> {
    if text.len() != 64 || !text.is_ascii() {
        return Err(anyhow!("Backup pack id {text} is not valid."));
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
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::private_run::run_with_root;
    use crate::backup::cloud::store::MemoryStore;
    use crate::backup::cloud::store::Usage;
    use std::path::{Path, PathBuf};

    /// A database with an owner who has recovery-phrase keys, plus a private protection `p1`.
    fn setup(dir: &Path) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "member").unwrap();
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
                phrase_words: 0,
            },
        )
        .unwrap();
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id: "p1",
                kind: "folder",
                source_drive: "drive-src",
                source_path: "p1",
                target_drive: "drive-dst",
                private_owner: "owner",
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

    fn source(dir: &Path) -> PathBuf {
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.bin"), random_vec(3 << 20)).unwrap();
        std::fs::write(src.join("b.bin"), random_vec(2 << 20)).unwrap();
        src
    }

    /// Runs a backup and returns the id of the snapshot it made.
    fn backup(db: &crate::Db, src: &Path, store: &dyn CloudStore) -> String {
        let out = run_with_root(db, "p1", src, store, false, 100).unwrap();
        assert_eq!(out.problem, None);
        out.snapshot_id.unwrap()
    }

    /// The psnapshot record name for the newest private snapshot.
    fn record_name(db: &crate::Db, snapshot_id: &str) -> String {
        let conn = lock(db);
        let scope = db::private_scope_of_snapshot(&conn, snapshot_id)
            .unwrap()
            .unwrap();
        private::psnapshot_name(&scope, snapshot_id)
    }

    /// Serves every pack normally, but flips one byte of the target pack.
    struct CorruptStore {
        inner: MemoryStore,
        target: [u8; 32],
    }

    impl CloudStore for CorruptStore {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
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
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    #[test]
    fn healthy_private_backup_passes() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        backup(&db, &src, &store);

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.problem, None);
        assert!(report.bad_records.is_empty());
        assert!(report.missing_packs.is_empty());
        assert!(report.damaged_packs.is_empty());
        assert_eq!(report.snapshots_checked, 1);
        assert!(report.packs_checked > 0);
    }

    #[test]
    fn changed_record_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let snapshot_id = backup(&db, &src, &store);

        let name = record_name(&db, &snapshot_id);
        store
            .put_record(PSNAPSHOTS_KIND, &name, b"changed")
            .unwrap();

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.problem.as_deref(), Some(SNAPSHOT_PROBLEM));
        assert_eq!(report.bad_records, vec![snapshot_id]);
    }

    #[test]
    fn damaged_pack_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let inner = MemoryStore::new();
        let snapshot_id = backup(&db, &src, &inner);

        let tree_pack = {
            let conn = lock(&db);
            db::list_cloud_snapshots(&conn, "p1")
                .unwrap()
                .into_iter()
                .find(|s| s.id == snapshot_id)
                .unwrap()
                .tree_pack_id
        };
        let store = CorruptStore {
            inner,
            target: unhex(&tree_pack).unwrap(),
        };

        let report = check(&db, "p1", &store, Sample::All, 200).unwrap();
        assert_eq!(report.problem.as_deref(), Some(PACK_PROBLEM));
        assert_eq!(report.damaged_packs, vec![tree_pack]);
    }
}
