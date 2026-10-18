//! Private items in the cloud: the backup run that saves a private item.
//!
//! A private item is sealed to its owner's recovery phrase key, not to the backup key. This run
//! never calls `keys::*`, never writes `snapshots/` or `keys/` records, and never needs an Admin.

use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use rusqlite::Connection;

use super::crypto::{self, Signer};
use super::format::{BackupMeta, SnapshotRecord, Tree};
use super::identity;
use super::private::{self, PRIVATE_SNAPSHOT_DOMAIN, PSNAPSHOTS_KIND};
use super::run::{
    CHECK_FAILED, CloudOutcome, RunContext, RunSlot, SOURCE_MISSING, Sealer, copy_and_commit, lock,
    most_files_missing, problem_outcome, random_id, source_root,
};
use super::store::CloudStore;
use crate::db;
use crate::drives::layout::Layout;
use crate::files;

const NO_PHRASE: &str =
    "Set up your recovery phrase in Settings → Cloud backup to start this backup.";
const NO_OWNER: &str =
    "This private item's owner no longer has an account. An Admin can remove its backups.";

/// Run one private item's cloud backup. Same outcome shape as `run::run_once`.
pub fn run_once(
    db: &crate::Db,
    protection_id: &str,
    store: &dyn CloudStore,
    accept_missing: bool,
    now: i64,
) -> Result<CloudOutcome> {
    let (drive_root, root) = {
        let conn = lock(db);
        let row = db::get_protection(&conn, protection_id)?
            .ok_or_else(|| anyhow!("This backup no longer exists."))?;
        if row.private_owner.is_empty() {
            return Err(anyhow!("This backup is not a private item's backup."));
        }
        let drive = files::drive_root(&conn, &row.source_drive)?;
        let drive_root = PathBuf::from(&drive.mount_point);
        let root = source_root(&drive_root, &row.source_path);
        (drive_root, root)
    };
    // An unplugged drive has no Luna marker, so its folder is never read as empty.
    if Layout::detect(&drive_root).is_none() {
        return Ok(problem_outcome(SOURCE_MISSING));
    }
    run_with_root(db, protection_id, &root, store, accept_missing, now)
}

/// The run itself, reading from `root` instead of resolving the drive. Tests use this.
pub(super) fn run_with_root(
    db: &crate::Db,
    protection_id: &str,
    root: &Path,
    store: &dyn CloudStore,
    accept_missing: bool,
    now: i64,
) -> Result<CloudOutcome> {
    let Some(_slot) = RunSlot::take(db, protection_id) else {
        return Ok(problem_outcome(
            "A backup of this folder is already running. Wait for it to finish, then try again.",
        ));
    };

    // Held before any run row is opened, so nothing is committed and nothing needs closing.
    // If the last copy cannot be read, the run is held too: a check that cannot run must not pass.
    if !accept_missing {
        match source_looks_missing(db, protection_id, root) {
            Ok(true) => {
                return Ok(CloudOutcome {
                    source_missing: true,
                    ..problem_outcome(SOURCE_MISSING)
                });
            }
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(error = %err, protection_id, "could not check the source against the last copy; holding the run");
                return Ok(CloudOutcome {
                    source_missing: true,
                    ..problem_outcome(CHECK_FAILED)
                });
            }
        }
    }

    // Failing here means no run row was opened, so there is nothing to close.
    let prepared = match prepare(db, protection_id, now) {
        Ok(prepared) => prepared,
        Err(e) => return Ok(problem_outcome(&e.to_string())),
    };

    let result = publish_and_copy(db, &prepared, root, store, now);
    // The run is over whether or not it committed, so always close it.
    if let Err(e) = db::end_run(&lock(db), &prepared.ctx.run_id, now) {
        return Ok(problem_outcome(&e.to_string()));
    }

    Ok(match result {
        Ok(outcome) => outcome,
        Err(e) => problem_outcome(&e.to_string()),
    })
}

/// True when most files of the newest private snapshot are gone from `root`. The file list is
/// read from the database, so no owner secret is needed. A protection with no private snapshot
/// is never held.
fn source_looks_missing(db: &crate::Db, protection_id: &str, root: &Path) -> Result<bool> {
    let conn = lock(db);
    for snap in db::list_cloud_snapshots(&conn, protection_id)? {
        if db::private_scope_of_snapshot(&conn, &snap.id)?.is_none() {
            continue;
        }
        let Some(bytes) = db::get_private_tree(&conn, &snap.id)? else {
            return Ok(false);
        };
        let tree: Tree = serde_json::from_slice(&bytes)?;
        return Ok(most_files_missing(&tree, root));
    }
    Ok(false)
}

/// Everything the copy needs, read and checked before the run row is opened.
struct Prepared {
    ctx: RunContext,
    scope: db::PrivateScope,
    auth_public: [u8; 32],
}

/// Checks the owner and Luna's identity, makes the owner's scope if missing, and opens the run.
/// Nothing after `start_run` can fail.
fn prepare(db: &crate::Db, protection_id: &str, now: i64) -> Result<Prepared> {
    let conn = lock(db);
    let row = db::get_protection(&conn, protection_id)?
        .ok_or_else(|| anyhow!("This backup no longer exists."))?;
    let owner = row.private_owner.clone();
    if crate::private::owner_state(&conn, &owner) != crate::private::OwnerState::Active {
        return Err(anyhow!(NO_OWNER));
    }
    let keys = db::get_user_keys(&conn, &owner)?.ok_or_else(|| anyhow!(NO_PHRASE))?;
    let owner_public: [u8; 32] = keys
        .x25519_public
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!(NO_PHRASE))?;
    crypto::check_public_key(&owner_public).map_err(|_| anyhow!(NO_PHRASE))?;
    let auth_public: [u8; 32] = keys
        .auth_public
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This private backup's key is damaged."))?;

    // A run never mints an identity: a Luna without one has never been set up for cloud backup.
    let identity = identity::load(&conn)?
        .ok_or_else(|| anyhow!("Set up cloud backup on this Luna before running a backup."))?;
    let seed = db::get_cloud_identity(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
        .signing_seed;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;
    let luna_id = identity.luna_id().to_string();

    let (scope, _) = private::ensure_scope(&conn, &owner, &owner_public, now)?;
    let dedup: [u8; 32] = scope
        .dedup_key
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This private backup's key is damaged."))?;
    let (scope_id, _) = private::scope_of(&dedup);

    // The name is the last folder of the source. Protections have no name column, so this is the choice.
    let name = row
        .source_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(&row.source_drive)
        .to_string();
    let started_by_name = db::get_user(&conn, &row.created_by)?
        .map(|user| {
            if user.display_name.is_empty() {
                user.username
            } else {
                user.display_name
            }
        })
        .unwrap_or_default();
    let meta = private::seal_meta(
        &owner_public,
        &luna_id,
        &scope.scope,
        &BackupMeta {
            name,
            source_drive: row.source_drive.clone(),
            source_path: row.source_path.clone(),
            started_by: row.created_by.clone(),
            started_by_name,
        },
    )?;

    let run_id = random_id();
    db::start_run(&conn, &run_id, protection_id, &scope.scope, now)?;
    let ctx = RunContext {
        run_id,
        protection_id: protection_id.to_string(),
        scope: scope.scope.clone(),
        scope_id,
        dedup_key: dedup,
        key_version: 0,
        luna_id: luna_id.clone(),
        signer: Signer::from_seed(seed),
        meta,
        sealer: Box::new(PrivateSealer {
            owner_public,
            luna_id,
            scope: scope.scope.clone(),
        }),
    };
    Ok(Prepared {
        ctx,
        scope,
        auth_public,
    })
}

/// Puts the scope record on Connect outside the lock, then copies and commits.
fn publish_and_copy(
    db: &crate::Db,
    prepared: &Prepared,
    root: &Path,
    store: &dyn CloudStore,
    now: i64,
) -> Result<CloudOutcome> {
    private::publish_scope(
        store,
        &prepared.ctx.signer,
        &prepared.ctx.luna_id,
        &prepared.scope,
        &prepared.auth_public,
    )?;
    copy_and_commit(db, &prepared.ctx, root, store, now)
}

/// Seals a private backup to its owner. Owner keys are checked before this is built, so the
/// `expect` below cannot fire.
struct PrivateSealer {
    owner_public: [u8; 32],
    luna_id: String,
    scope: String,
}

impl Sealer for PrivateSealer {
    fn wrap_pack_key(&self, pack_key: &[u8; 32]) -> Vec<u8> {
        private::seal_pack_key(&self.owner_public, &self.luna_id, &self.scope, pack_key)
            .expect("owner key checked when the phrase was set")
    }

    fn seal_tree(&self, tree: &Tree) -> Result<Vec<u8>> {
        private::seal_tree(&self.owner_public, &self.luna_id, &self.scope, tree)
    }

    fn finish_record(
        &self,
        record: SnapshotRecord,
        signer: &Signer,
    ) -> (&'static str, String, Vec<u8>) {
        let name = private::psnapshot_name(&self.scope, &record.snapshot_id);
        (
            PSNAPSHOTS_KIND,
            name,
            record.sign_with(signer, PRIVATE_SNAPSHOT_DOMAIN).to_bytes(),
        )
    }

    fn commit(
        &self,
        conn: &mut Connection,
        snap: &db::SnapshotInsert,
        pack_ids: &[String],
        tree: &Tree,
    ) -> Result<()> {
        db::commit_private_snapshot_tx(
            conn,
            snap,
            pack_ids,
            &self.scope,
            &serde_json::to_vec(tree)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::store::MemoryStore;
    use crate::backup::cloud::format;
    use crate::backup::cloud::private::PSCOPES_KIND;
    use rand_core::{OsRng, RngCore};

    /// A database with an owner (with recovery-phrase keys unless `owner_keys` is false) and an
    /// Admin who has no keys, plus a private protection `p1` owned by the owner.
    fn setup(dir: &Path, owner_keys: bool) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "member").unwrap();
        db::insert_user(&conn, "admin", "admin", "Admin", "x", "admin").unwrap();
        identity::load_or_create(&conn, 1).unwrap();
        if owner_keys {
            let keys = crypto::derive(&[7u8; 16], "luna-test");
            db::set_user_keys(
                &conn,
                &db::UserKeys {
                    user_id: "owner".into(),
                    x25519_public: keys.x25519_public.to_vec(),
                    auth_public: keys.auth_public.to_vec(),
                    self_sealed: vec![3; 48],
                    phrase_set_at: 1,
                    last_checked_at: 0,
                },
            )
            .unwrap();
        }
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

    /// Writes two random files, each several chunks long.
    fn source(dir: &Path) -> PathBuf {
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.bin"), random_vec(3 << 20)).unwrap();
        std::fs::write(src.join("b.bin"), random_vec(2 << 20)).unwrap();
        src
    }

    fn active_scope(db: &crate::Db) -> String {
        db::active_private_scope(&lock(db), "owner")
            .unwrap()
            .unwrap()
            .scope
    }

    #[test]
    fn private_run_writes_only_private_records() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(out.problem, None);
        let snapshot_id = out.snapshot_id.unwrap();

        assert!(store.list_records("snapshots").unwrap().is_empty());
        assert!(store.list_records("keys").unwrap().is_empty());
        assert!(store.list_records("recipients").unwrap().is_empty());
        assert_eq!(store.list_records(PSCOPES_KIND).unwrap().len(), 1);
        let scope = active_scope(&db);
        assert_eq!(
            store.list_records(PSNAPSHOTS_KIND).unwrap(),
            vec![private::psnapshot_name(&scope, &snapshot_id)]
        );
    }

    #[test]
    fn owner_secret_opens_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        let snapshot_id = out.snapshot_id.unwrap();

        let scope = active_scope(&db);
        let conn = lock(&db);
        let identity = identity::load(&conn).unwrap().unwrap();
        let luna_id = identity.luna_id().to_string();
        let name = private::psnapshot_name(&scope, &snapshot_id);
        let stored = store.get_record(PSNAPSHOTS_KIND, &name).unwrap().unwrap();
        let record = format::SignedRecord::from_bytes(&stored)
            .unwrap()
            .verify_with(&identity.public(), PRIVATE_SNAPSHOT_DOMAIN)
            .unwrap();

        let keys = crypto::derive(&[7u8; 16], "luna-test");
        let secret = keys.x25519_secret;
        let bytes = store.get_pack(&record.tree_pack_id).unwrap();
        let pack = format::open_pack(&bytes, &record.tree_pack_id, |wrapped| {
            private::open_pack_key(&secret, &luna_id, &scope, wrapped)
        })
        .unwrap();
        let sealed = pack.chunk(&record.tree_hash).unwrap();
        let tree = private::open_tree(&secret, &luna_id, &scope, sealed).unwrap();
        assert_eq!(tree.entries.len(), 2);
        let local = db::get_private_tree(&conn, &snapshot_id).unwrap().unwrap();
        assert_eq!(serde_json::to_vec(&tree).unwrap(), local);
    }

    #[test]
    fn no_admin_phrase_needed() {
        // The Admin in `setup` has no keys, and the run still goes ahead.
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(out.problem, None);
        assert!(out.snapshot_id.is_some());
        assert!(store.list_records("keys").unwrap().is_empty());
    }

    #[test]
    fn no_phrase_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), false);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(out.problem.as_deref(), Some(NO_PHRASE));
        assert_eq!(out.snapshot_id, None);
        assert!(store.list_records(PSNAPSHOTS_KIND).unwrap().is_empty());
    }

    #[test]
    fn second_run_reuses_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(first.problem, None);
        let second = run_with_root(&db, "p1", &src, &store, false, 200).unwrap();
        assert_eq!(second.problem, None);
        assert!(second.reused_chunks > 0);
        assert!(second.uploaded_bytes < first.uploaded_bytes);
    }

    #[test]
    fn new_phrase_starts_a_new_scope() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(first.problem, None);
        let old_scope = active_scope(&db);

        let new_keys = crypto::derive(&[9u8; 16], "luna-test");
        {
            let conn = lock(&db);
            db::set_user_keys(
                &conn,
                &db::UserKeys {
                    user_id: "owner".into(),
                    x25519_public: new_keys.x25519_public.to_vec(),
                    auth_public: new_keys.auth_public.to_vec(),
                    self_sealed: vec![4; 48],
                    phrase_set_at: 2,
                    last_checked_at: 0,
                },
            )
            .unwrap();
        }

        let second = run_with_root(&db, "p1", &src, &store, false, 200).unwrap();
        assert_eq!(second.problem, None);
        let conn = lock(&db);
        let new_scope = db::active_private_scope(&conn, "owner").unwrap().unwrap();
        assert_ne!(new_scope.scope, old_scope);
        assert_eq!(new_scope.x25519_public, new_keys.x25519_public.to_vec());
        let old = db::get_private_scope(&conn, &old_scope).unwrap().unwrap();
        assert_eq!(old.state, "old_phrase");
        let row = db::get_protection(&conn, "p1").unwrap().unwrap();
        assert_eq!(row.id, "p1");
    }

    #[test]
    fn source_gone_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, false, 100).unwrap();
        assert_eq!(first.problem, None);

        std::fs::remove_file(src.join("a.bin")).unwrap();
        std::fs::remove_file(src.join("b.bin")).unwrap();
        let held = run_with_root(&db, "p1", &src, &store, false, 200).unwrap();
        assert_eq!(held.problem.as_deref(), Some(SOURCE_MISSING));
        assert!(held.source_missing);
        assert_eq!(held.snapshot_id, None);
        assert_eq!(store.list_records(PSNAPSHOTS_KIND).unwrap().len(), 1);
        let open_runs: i64 = lock(&db)
            .query_row(
                "SELECT COUNT(*) FROM cloud_runs WHERE ended_at = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open_runs, 0);

        let accepted = run_with_root(&db, "p1", &src, &store, true, 300).unwrap();
        assert_eq!(accepted.problem, None);
    }
}
