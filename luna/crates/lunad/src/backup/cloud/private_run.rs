//! Private items in the cloud: the backup run that saves a private item.
//!
//! A private item is sealed to its owner's recovery phrase key, not to the backup key. This run
//! never calls `keys::*`, never writes `snapshots/` or `keys/` records, and never needs an Admin.

#[cfg(test)]
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};

use super::crypto::{self, SigPublic, Signer};
use super::format::{BackupMeta, SnapshotRecord, Tree};
use super::identity;
use super::private::{self, PRIVATE_SNAPSHOT_DOMAIN, PSNAPSHOTS_KIND};
use super::run::{
    CloudOutcome, RunContext, RunSlot, Sealer, busy_outcome, copy_and_commit, lock,
    problem_outcome, random_id,
};
use super::source::{self, CHECK_FAILED, Folder, Walk};
use super::store::CloudStore;
use crate::db;

const NO_PHRASE: &str = "This private item's owner hasn't set up a recovery phrase yet, so its cloud backup can't start.";
const NO_OWNER: &str =
    "This private item's owner no longer has an account. An Admin can delete its backups.";

#[cfg(test)]
pub(crate) fn run_with_root(
    db: &crate::Db,
    protection_id: &str,
    root: &Path,
    store: &dyn CloudStore,
    manual: bool,
    now: i64,
) -> Result<CloudOutcome> {
    let folder = match Folder::at(root) {
        Ok(folder) => folder,
        Err(unavailable) => return unavailable.record(db, protection_id),
    };
    run_from_folder(db, protection_id, folder, store, manual, now)
}

/// `manual` and the snapshot rules are the same as for a shared backup (`run::run_from_folder`).
pub(super) fn run_from_folder(
    db: &crate::Db,
    protection_id: &str,
    folder: Folder,
    store: &dyn CloudStore,
    manual: bool,
    now: i64,
) -> Result<CloudOutcome> {
    let Some(_slot) = RunSlot::take(db, protection_id) else {
        return Ok(busy_outcome());
    };

    let walk = match folder.walk() {
        Ok(walk) => walk,
        Err(unavailable) => return unavailable.record(db, protection_id),
    };
    source::revive(db, protection_id)?;
    let prev = match previous_tree(db, protection_id) {
        Ok(prev) => prev,
        Err(err) => {
            tracing::warn!(error = %err, protection_id, "could not check the source against the last copy");
            return Ok(problem_outcome(CHECK_FAILED));
        }
    };

    // Failing here means no run row was opened, so there is nothing to close.
    let prepared = match prepare(db, protection_id, now) {
        Ok(prepared) => prepared,
        Err(e) => return Ok(problem_outcome(&e.to_string())),
    };

    let result = publish_and_copy(db, &prepared, walk, store, now, prev.as_ref(), manual);
    // The run is over whether or not it committed, so always close it.
    if let Err(e) = db::end_run(&lock(db), &prepared.ctx.run_id, now) {
        return Ok(problem_outcome(&e.to_string()));
    }

    Ok(match result {
        Ok(outcome) => outcome,
        Err(e) => problem_outcome(&e.to_string()),
    })
}

/// The latest private file list is cached locally, so no owner secret is needed.
fn previous_tree(db: &crate::Db, protection_id: &str) -> Result<Option<Tree>> {
    let conn = lock(db);
    for snap in db::list_cloud_snapshots(&conn, protection_id)? {
        if db::private_scope_of_snapshot(&conn, &snap.id)?.is_none() {
            continue;
        }
        let bytes = db::get_private_tree(&conn, &snap.id)?
            .ok_or_else(|| anyhow!("The file list for the last copy is missing."))?;
        return Ok(Some(serde_json::from_slice(&bytes)?));
    }
    Ok(None)
}

/// Everything the copy needs, read and checked before the run row is opened.
struct Prepared {
    ctx: RunContext,
    scope: db::PrivateScope,
    auth_public: SigPublic,
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
    let owner_public: crypto::SealPublic = keys
        .seal_public
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!(NO_PHRASE))?;
    crypto::check_public_key(&owner_public).map_err(|_| anyhow!(NO_PHRASE))?;
    let auth_public: SigPublic = keys
        .auth_public
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This private backup's key is damaged."))?;

    // A run never mints an identity: a Luna without one has never been set up for cloud backup.
    let identity = identity::load(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing. Try again."))?;
    let seed = db::get_cloud_identity(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
        .signing_seed;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;
    let luna_id = identity.luna_id().to_string();

    let (scope, _) = private::ensure_scope(&conn, &luna_id, &owner, &owner_public, now)?;
    // Everything in the backup is sealed to the scope's own key, never to the owner's.
    let scope_public: crypto::SealPublic = scope
        .scope_public
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This private backup's key is damaged."))?;
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
        &scope_public,
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
            scope_public,
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
    walk: Walk,
    store: &dyn CloudStore,
    now: i64,
    prev: Option<&Tree>,
    manual: bool,
) -> Result<CloudOutcome> {
    private::publish_scope(
        store,
        &prepared.ctx.signer,
        &prepared.ctx.luna_id,
        &prepared.scope,
        &prepared.auth_public,
    )?;
    // Private trees live in the database as JSON, so the previous file list comes from there.
    copy_and_commit(db, &prepared.ctx, walk, store, now, prev, manual)
}

/// Seals a private backup to its scope's key. The scope key is checked before this is built, so the
/// `expect` below cannot fire.
struct PrivateSealer {
    scope_public: crypto::SealPublic,
    luna_id: String,
    scope: String,
}

impl Sealer for PrivateSealer {
    fn wrap_pack_key(&self, pack_key: &[u8; 32]) -> Vec<u8> {
        private::seal_pack_key(&self.scope_public, &self.luna_id, &self.scope, pack_key)
            .expect("scope key checked when the scope was made")
    }

    fn seal_tree(&self, tree: &Tree) -> Result<Vec<u8>> {
        private::seal_tree(&self.scope_public, &self.luna_id, &self.scope, tree)
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
        tx: &rusqlite::Transaction,
        snap: &db::SnapshotInsert,
        pack_ids: &[String],
        tree: &Tree,
    ) -> Result<()> {
        db::commit_private_snapshot_in(tx, snap, pack_ids, &self.scope, &serde_json::to_vec(tree)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::format;
    use crate::backup::cloud::private::PSCOPES_KIND;
    use crate::backup::cloud::store::MemoryStore;
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
                    seal_public: keys.seal_public.to_vec(),
                    auth_public: keys.auth_public.to_vec(),
                    self_sealed: vec![3; 48],
                    phrase_set_at: 1,
                    last_checked_at: 0,
                    phrase_words: 0,
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
        let out = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
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
    fn owner_phrase_opens_the_scope_then_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
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

        // The owner's phrase opens the scope's secret key, and only that key opens the packs.
        let keys = crypto::derive(&[7u8; 16], "luna-test");
        let owner_secret = keys.seal_secret;
        let scope_row = db::get_private_scope(&conn, &scope).unwrap().unwrap();
        let secret = private::open_scope_secret(
            &owner_secret,
            &luna_id,
            &scope,
            &scope_row.sealed_scope_secret,
        )
        .unwrap();
        let bytes = store.get_pack(&record.tree_pack_id).unwrap();
        let pack = format::open_pack(&bytes, &record.tree_pack_id, |wrapped| {
            private::open_pack_key(&secret, &luna_id, &scope, wrapped)
        })
        .unwrap();
        let sealed = pack.chunk(&record.tree_hash).unwrap();
        assert!(private::open_tree(&owner_secret, &luna_id, &scope, sealed).is_err());
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
        let out = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
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
        let out = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
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
        let first = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
        assert_eq!(first.problem, None);
        let second = run_with_root(&db, "p1", &src, &store, true, 200).unwrap();
        assert_eq!(second.problem, None);
        assert!(second.reused_chunks > 0);
        assert!(second.uploaded_bytes < first.uploaded_bytes);
    }

    #[test]
    fn a_scheduled_private_run_with_no_changes_makes_no_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
        assert!(first.snapshot_id.is_some());

        let second = run_with_root(&db, "p1", &src, &store, false, 200).unwrap();
        assert_eq!(second.problem, None);
        assert_eq!(second.snapshot_id, None);
        assert_eq!(store.list_records(PSNAPSHOTS_KIND).unwrap().len(), 1);
    }

    #[test]
    fn new_phrase_does_not_retire_the_scope_by_itself() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
        assert_eq!(first.problem, None);
        let old_scope = active_scope(&db);

        let new_keys = crypto::derive(&[9u8; 16], "luna-test");
        {
            let conn = lock(&db);
            db::set_user_keys(
                &conn,
                &db::UserKeys {
                    user_id: "owner".into(),
                    seal_public: new_keys.seal_public.to_vec(),
                    auth_public: new_keys.auth_public.to_vec(),
                    self_sealed: vec![4; 48],
                    phrase_set_at: 2,
                    last_checked_at: 0,
                    phrase_words: 0,
                },
            )
            .unwrap();
        }

        // The save (not the run) decides what happens to the scope, so the run keeps using it.
        let second = run_with_root(&db, "p1", &src, &store, true, 200).unwrap();
        assert_eq!(second.problem, None);
        let conn = lock(&db);
        let still = db::active_private_scope(&conn, "owner").unwrap().unwrap();
        assert_eq!(still.scope, old_scope);
        assert_eq!(still.state, "active");
        assert_eq!(
            still.seal_public,
            crypto::derive(&[7u8; 16], "luna-test").seal_public.to_vec()
        );
        assert_ne!(new_keys.seal_public.to_vec(), still.seal_public);
    }

    #[test]
    fn a_vanished_private_folder_holds_every_run() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path(), true);
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p1", &src, &store, true, 100).unwrap();
        assert_eq!(first.problem, None);

        std::fs::rename(&src, src.with_extension("missing")).unwrap();
        let held = run_with_root(&db, "p1", &src, &store, true, 200).unwrap();
        assert!(held.problem.is_some());
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

        let again = run_with_root(&db, "p1", &src, &store, true, 300).unwrap();
        assert!(again.problem.is_some());
        assert_eq!(again.snapshot_id, None);
        assert_eq!(store.list_records(PSNAPSHOTS_KIND).unwrap().len(), 1);
    }
}
