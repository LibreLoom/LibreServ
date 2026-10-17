//! One cloud backup run for a protection: copy changed chunks into packs,
//! upload them, then commit a signed snapshot in a single transaction.
//!
//! Only one run per protection is allowed at a time. The database lock is
//! held briefly for each read or write and never while copying or uploading.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use anyhow::{anyhow, Result};
use rand_core::{OsRng, RngCore};
use rusqlite::Connection;

use super::crypto::{self, Signer};
use super::format::{self, PackBuilder, SnapshotRecord, Tree, TreeEntry};
use super::identity;
use super::keys::{self, Recipients};
use super::store::CloudStore;
use crate::backup::{access_list, scope};
use crate::db::{self, BackupKey};
use crate::files;

/// Wraps each pack's random key under the backup key.
pub(super) const PACK_KEY_WRAP_AAD: &[u8] = b"luna-pack-key-wrap-v1";
/// Domain for deriving the opaque scope id that stands in for a protection.
const SCOPE_DOMAIN: &[u8] = b"luna-scope-v1";
/// A pack is uploaded once its plain bytes reach this size.
const PACK_FLUSH_BYTES: usize = 8 << 20;

/// What one run did. `problem` is set, and no snapshot is committed, when the run failed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CloudOutcome {
    pub uploaded_bytes: u64,
    pub files: u64,
    pub reused_chunks: u64,
    pub snapshot_id: Option<String>,
    pub problem: Option<String>,
}

/// Runs one backup for `protection_id` against `store` and returns what happened.
pub fn run_once(
    db: &crate::Db,
    protection_id: &str,
    store: &dyn CloudStore,
    now: i64,
) -> Result<CloudOutcome> {
    let root = {
        let conn = lock(db);
        let row = db::get_protection(&conn, protection_id)?
            .ok_or_else(|| anyhow!("This backup no longer exists."))?;
        let drive = files::drive_root(&conn, &row.source_drive)?;
        PathBuf::from(&drive.mount_point).join(row.source_path.trim_start_matches('/'))
    };
    run_with_root(db, protection_id, &root, store, now)
}

/// The run itself, reading from `root` instead of resolving the drive. Tests use this.
fn run_with_root(
    db: &crate::Db,
    protection_id: &str,
    root: &Path,
    store: &dyn CloudStore,
    now: i64,
) -> Result<CloudOutcome> {
    let Some(_slot) = RunSlot::take(protection_id) else {
        return Ok(problem_outcome(
            "A backup of this folder is already running. Wait for it to finish, then try again.",
        ));
    };

    // Failing here means no run row was opened, so there is nothing to close.
    let (ctx, publish) = match prepare(db, protection_id, now) {
        Ok(prepared) => prepared,
        Err(e) => return Ok(problem_outcome(&e.to_string())),
    };

    let result = publish_and_copy(db, &ctx, publish, root, store, now);
    // The run is over whether or not it committed, so always close it.
    if let Err(e) = db::end_run(&lock(db), &ctx.run_id, now) {
        return Ok(problem_outcome(&e.to_string()));
    }

    Ok(match result {
        Ok(outcome) => outcome,
        Err(e) => problem_outcome(&e.to_string()),
    })
}

/// Recipients and their keys, kept for publishing a key version that is new.
type Publish = (Recipients, HashMap<String, [u8; 32]>);

/// Everything a run needs that does not change while it copies.
struct RunContext {
    run_id: String,
    protection_id: String,
    scope: String,
    scope_id: [u8; 32],
    key: BackupKey,
    key_bytes: [u8; 32],
    dedup_key: [u8; 32],
    key_version: u32,
    luna_id: String,
    signer: Signer,
}

/// Reads the key and recipients and opens the run row. Nothing after `start_run` can fail.
fn prepare(db: &crate::Db, protection_id: &str, now: i64) -> Result<(RunContext, Option<Publish>)> {
    let conn = lock(db);
    let row = db::get_protection(&conn, protection_id)?
        .ok_or_else(|| anyhow!("This backup no longer exists."))?;
    let identity = identity::load_or_create(&conn, now)?;
    let seed = db::get_cloud_identity(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
        .signing_seed;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;
    let access = access_list::for_source(&conn, &row.source_drive, &row.source_path)?;

    let user_pub: HashMap<String, [u8; 32]> = db::list_user_keys(&conn)?
        .into_iter()
        .filter_map(|k| Some((k.user_id, k.x25519_public.as_slice().try_into().ok()?)))
        .collect();
    let mut ids = Vec::new();
    for user in db::list_users(&conn)? {
        let is_admin = user.role == "admin";
        if access.allows(&user.id, is_admin) && user_pub.contains_key(&user.id) {
            ids.push(user.id);
        }
    }
    let recipients = Recipients::new(ids);
    let before = db::latest_backup_key(&conn, protection_id)?.map(|k| k.version);
    let key = keys::ensure_key(&conn, protection_id, &recipients, now)?;
    let is_new = before != Some(key.version);

    let key_bytes: [u8; 32] = key
        .key
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This backup's key is damaged."))?;
    let dedup_key: [u8; 32] = key
        .dedup_key
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("This backup's key is damaged."))?;
    let scope_id = crypto::chunk_id(&dedup_key, SCOPE_DOMAIN);
    let scope = hex(&scope_id[..16]);
    let run_id = random_id();
    db::start_run(&conn, &run_id, protection_id, &scope, now)?;

    let ctx = RunContext {
        run_id,
        protection_id: protection_id.to_string(),
        scope,
        scope_id,
        key_version: key.version as u32,
        key,
        key_bytes,
        dedup_key,
        luna_id: identity.luna_id.clone(),
        signer: Signer::from_seed(seed),
    };
    let publish = is_new.then_some((recipients, user_pub));
    Ok((ctx, publish))
}

/// Publishes a new key version outside the lock, then copies and commits.
fn publish_and_copy(
    db: &crate::Db,
    ctx: &RunContext,
    publish: Option<Publish>,
    root: &Path,
    store: &dyn CloudStore,
    now: i64,
) -> Result<CloudOutcome> {
    if let Some((recipients, user_pub)) = publish {
        keys::publish_key(
            store,
            &ctx.signer,
            &ctx.luna_id,
            &ctx.protection_id,
            &ctx.key,
            &recipients,
            |user| user_pub.get(user).copied(),
        )?;
    }
    copy_and_commit(db, ctx, root, store, now)
}

/// Mutable state for walking the source and filling packs.
struct CopyState<'a> {
    db: &'a crate::Db,
    ctx: &'a RunContext,
    store: &'a dyn CloudStore,
    now: i64,
    builder: Option<PackBuilder>,
    /// Chunks in the pack being built, with where each sits in it.
    pending: Vec<([u8; 32], u64, u32)>,
    /// Chunks already placed in this run, so a repeat in the same run is not stored twice.
    placed: HashSet<[u8; 32]>,
    /// Pack ids this run references, for the commit.
    pack_ids: Vec<String>,
    uploaded_bytes: u64,
    reused_chunks: u64,
}

impl CopyState<'_> {
    fn chunk(&mut self, plain: &[u8]) -> Result<[u8; 32]> {
        let id = crypto::chunk_id(&self.ctx.dedup_key, plain);
        if self.placed.contains(&id) {
            return Ok(id);
        }
        let known = {
            let conn = lock(self.db);
            db::find_chunk(&conn, &self.ctx.scope, &id)?
        };
        if let Some((pack_id, _, _)) = known {
            self.reused_chunks += 1;
            if !self.pack_ids.contains(&pack_id) {
                self.pack_ids.push(pack_id);
            }
            return Ok(id);
        }
        let builder = self
            .builder
            .get_or_insert_with(|| PackBuilder::new(self.ctx.scope_id));
        let (offset, len) = builder.add(id, plain);
        self.pending.push((id, offset, len));
        self.placed.insert(id);
        if builder.len() >= PACK_FLUSH_BYTES {
            self.flush()?;
        }
        Ok(id)
    }

    /// Seals the pending pack, uploads it, and records its chunks.
    fn flush(&mut self) -> Result<()> {
        let Some(builder) = self.builder.take() else {
            return Ok(());
        };
        let key = self.ctx.key_bytes;
        let sealed = builder.finish(|pack_key| crypto::encrypt(&key, PACK_KEY_WRAP_AAD, pack_key));
        let pack_id = hex(&sealed.id);
        {
            let conn = lock(self.db);
            db::insert_pending_pack(&conn, &pack_id, &self.ctx.scope, &self.ctx.run_id, self.now)?;
        }
        self.store
            .put_pack(&sealed.id, Some(&self.ctx.scope), &sealed.bytes)
            .map_err(|e| anyhow!("{e}"))?;
        {
            let conn = lock(self.db);
            for (chunk_id, offset, len) in self.pending.drain(..) {
                db::insert_chunk(
                    &conn,
                    &self.ctx.scope,
                    &chunk_id,
                    &pack_id,
                    offset as i64,
                    i64::from(len),
                )?;
            }
        }
        self.uploaded_bytes += sealed.bytes.len() as u64;
        self.pack_ids.push(pack_id);
        Ok(())
    }
}

/// Copies every file under `root`, uploads the tree and a signed snapshot record, and commits.
fn copy_and_commit(
    db: &crate::Db,
    ctx: &RunContext,
    root: &Path,
    store: &dyn CloudStore,
    now: i64,
) -> Result<CloudOutcome> {
    let mut copy = CopyState {
        db,
        ctx,
        store,
        now,
        builder: None,
        pending: Vec::new(),
        placed: HashSet::new(),
        pack_ids: Vec::new(),
        uploaded_bytes: 0,
        reused_chunks: 0,
    };

    let mut entries = Vec::new();
    let files = scope::walk(root).map_err(|e| anyhow!("Could not read the folder being backed up: {e}"))?;
    for entry in &files {
        let mut file = File::open(&entry.abs)
            .map_err(|e| anyhow!("Could not open {}: {e}", entry.rel))?;
        let mut chunk_ids = Vec::new();
        format::chunks(&mut file, |plain| {
            chunk_ids.push(copy.chunk(plain)?);
            Ok(())
        })?;
        entries.push(TreeEntry {
            path: entry.rel.clone(),
            size: entry.size,
            mtime: entry.mtime,
            chunks: chunk_ids,
        });
    }
    copy.flush()?;

    // The tree goes into a pack of its own, so restores can find it from the snapshot.
    let tree_bytes = format::encrypt_tree(&Tree { entries }, &ctx.key_bytes);
    // The tree's chunk id is its hash, so the snapshot record alone says where the tree is.
    let tree_hash = format::sha256(&tree_bytes);
    let mut tree_builder = PackBuilder::new(ctx.scope_id);
    let (tree_offset, tree_len) = tree_builder.add(tree_hash, &tree_bytes);
    let key = ctx.key_bytes;
    let tree_pack = tree_builder.finish(|pack_key| crypto::encrypt(&key, PACK_KEY_WRAP_AAD, pack_key));
    let tree_pack_id = hex(&tree_pack.id);
    {
        let conn = lock(db);
        db::insert_pending_pack(&conn, &tree_pack_id, &ctx.scope, &ctx.run_id, now)?;
    }
    store
        .put_pack(&tree_pack.id, Some(&ctx.scope), &tree_pack.bytes)
        .map_err(|e| anyhow!("{e}"))?;
    {
        let conn = lock(db);
        db::insert_chunk(
            &conn,
            &ctx.scope,
            &tree_hash,
            &tree_pack_id,
            tree_offset as i64,
            i64::from(tree_len),
        )?;
    }
    copy.uploaded_bytes += tree_pack.bytes.len() as u64;
    copy.pack_ids.push(tree_pack_id.clone());

    let snapshot_id = random_id();
    let record = SnapshotRecord {
        luna_id: ctx.luna_id.clone(),
        protection_id: ctx.protection_id.clone(),
        snapshot_id: snapshot_id.clone(),
        created_at: now,
        key_version: ctx.key_version,
        tree_pack_id: tree_pack.id,
        tree_hash,
        meta: Vec::new(),
    };
    let signed = record.sign(&ctx.signer);
    let signed_bytes = signed.to_bytes();
    store
        .put_record("snapshots", &snapshot_id, &signed_bytes)
        .map_err(|e| anyhow!("{e}"))?;

    {
        let mut conn = lock(db);
        db::commit_snapshot_tx(
            &mut conn,
            &db::SnapshotInsert {
                id: snapshot_id.clone(),
                protection_id: ctx.protection_id.clone(),
                created_at: now,
                key_version: i64::from(ctx.key_version),
                tree_pack_id: tree_pack_id.clone(),
                record: signed_bytes,
            },
            &copy.pack_ids,
        )?;
    }

    Ok(CloudOutcome {
        uploaded_bytes: copy.uploaded_bytes,
        files: files.len() as u64,
        reused_chunks: copy.reused_chunks,
        snapshot_id: Some(snapshot_id),
        problem: None,
    })
}

/// Read a snapshot's tree: fetch its tree pack, open it with `tree_key`, and decrypt the tree.
/// The tree chunk id is the record's `tree_hash`, so the record and the backup key are enough.
pub fn read_tree(store: &dyn CloudStore, record: &SnapshotRecord, tree_key: &[u8; 32]) -> Result<Tree> {
    let bytes = store.get_pack(&record.tree_pack_id).map_err(|e| anyhow!("{e}"))?;
    let unwrap = |wrapped: &[u8]| -> Result<[u8; 32]> {
        let plain = crypto::decrypt(tree_key, PACK_KEY_WRAP_AAD, wrapped)?;
        <[u8; 32]>::try_from(plain.as_slice())
            .map_err(|_| anyhow!("This backup file's key could not be read."))
    };
    let pack = format::open_pack(&bytes, &record.tree_pack_id, unwrap)?;
    let sealed = pack
        .chunk(&record.tree_hash)
        .ok_or_else(|| anyhow!("This backup's file list is missing from its backup file."))?;
    if format::sha256(sealed) != record.tree_hash {
        return Err(anyhow!("This backup's file list does not match its fingerprint. It may be damaged."));
    }
    format::decrypt_tree(sealed, tree_key)
}

fn problem_outcome(message: &str) -> CloudOutcome {
    CloudOutcome {
        problem: Some(message.to_string()),
        ..Default::default()
    }
}

/// Holds a protection's place in [`RUNNING`] until it is dropped.
struct RunSlot(String);

static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

impl RunSlot {
    fn take(id: &str) -> Option<Self> {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        running.insert(id.to_string()).then(|| Self(id.to_string()))
    }
}

impl Drop for RunSlot {
    fn drop(&mut self) {
        RUNNING.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

fn lock(db: &crate::Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}

fn random_id() -> String {
    hex(&random_bytes::<16>())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::store::MemoryStore;

    /// A database with one admin who has keys, and a protection for each id the tests use.
    fn setup(dir: &Path) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "admin").unwrap();
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
        for id in ["p1", "p2", "p3", "p4", "p5"] {
            db::insert_protection(
                &conn,
                &db::NewProtection {
                    id,
                    kind: "folder",
                    source_drive: "drive-src",
                    source_path: id,
                    target_drive: "drive-dst",
                    private_owner: "",
                    created_by: "owner",
                    created_at: 1,
                },
            )
            .unwrap();
        }
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

    #[test]
    fn first_run_uploads_everything_then_second_run_reuses_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();

        let first = run_with_root(&db, "p1", &src, &store, 100).unwrap();
        assert_eq!(first.problem, None);
        assert!(first.snapshot_id.is_some());
        assert_eq!(first.files, 2);
        assert!(first.uploaded_bytes >= 5 << 20);

        let second = run_with_root(&db, "p1", &src, &store, 200).unwrap();
        assert_eq!(second.problem, None);
        assert!(second.reused_chunks > 0);
        assert!(second.uploaded_bytes < first.uploaded_bytes / 10);
    }

    #[test]
    fn modified_file_uploads_only_changed_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p2", &src, &store, 100).unwrap();

        let mut data = std::fs::read(src.join("a.bin")).unwrap();
        data[100] ^= 0xff;
        std::fs::write(src.join("a.bin"), data).unwrap();
        let second = run_with_root(&db, "p2", &src, &store, 200).unwrap();

        assert_eq!(second.problem, None);
        assert!(second.reused_chunks > 0);
        assert!(second.uploaded_bytes < first.uploaded_bytes);
    }

    #[test]
    fn full_store_sets_problem_and_commits_no_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::with_quota(1024);

        let out = run_with_root(&db, "p3", &src, &store, 100).unwrap();
        assert_eq!(out.problem.as_deref(), Some("Your cloud storage is full."));
        assert_eq!(out.snapshot_id, None);
        assert!(store.list_records("snapshots").unwrap().is_empty());
    }

    #[test]
    fn tree_reads_back_from_the_record_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p5", &src, &store, 100).unwrap();
        assert_eq!(out.problem, None);
        let snapshot_id = out.snapshot_id.unwrap();

        let conn = lock(&db);
        let identity = identity::load(&conn).unwrap().unwrap();
        let bytes = store.get_record("snapshots", &snapshot_id).unwrap().unwrap();
        let record = format::SignedRecord::from_bytes(&bytes)
            .unwrap()
            .verify(&identity.public())
            .unwrap();
        let backup_key = db::latest_backup_key(&conn, "p5").unwrap().unwrap();
        let tree_key: [u8; 32] = backup_key.key.as_slice().try_into().unwrap();

        let tree = read_tree(&store, &record, &tree_key).unwrap();
        let mut paths: Vec<&str> = tree.entries.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, ["a.bin", "b.bin"]);
        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_chunks WHERE chunk_id = ?1",
                [&record.tree_hash[..]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, 1);
    }

    #[test]
    fn snapshot_record_verifies_and_chunk_ids_stay_out_of_packs() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p4", &src, &store, 100).unwrap();
        let snapshot_id = out.snapshot_id.unwrap();

        let conn = lock(&db);
        let identity = identity::load(&conn).unwrap().unwrap();
        let bytes = store.get_record("snapshots", &snapshot_id).unwrap().unwrap();
        let record = format::SignedRecord::from_bytes(&bytes).unwrap();
        assert!(record.verify(&identity.public()).is_ok());

        let key = db::latest_backup_key(&conn, "p4").unwrap().unwrap();
        let dedup: [u8; 32] = key.dedup_key.as_slice().try_into().unwrap();
        let mut chunk_ids = Vec::new();
        let mut file = File::open(src.join("b.bin")).unwrap();
        format::chunks(&mut file, |plain| {
            chunk_ids.push(crypto::chunk_id(&dedup, plain));
            Ok(())
        })
        .unwrap();
        assert!(!chunk_ids.is_empty());

        let mut stmt = conn.prepare("SELECT id FROM cloud_packs").unwrap();
        let pack_ids: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(!pack_ids.is_empty());
        for pack_id in pack_ids {
            let id: [u8; 32] = (0..32)
                .map(|i| u8::from_str_radix(&pack_id[2 * i..2 * i + 2], 16).unwrap())
                .collect::<Vec<u8>>()
                .try_into()
                .unwrap();
            let pack = store.get_pack(&id).unwrap();
            for chunk_id in &chunk_ids {
                assert!(!pack.windows(32).any(|w| w == chunk_id));
            }
        }
    }
}
