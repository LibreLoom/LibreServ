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
use super::format::{self, BackupMeta, ChunkRef, PackBuilder, SnapshotRecord, Tree, TreeEntry};
use super::identity;
use super::keys::{self, Recipients};
use super::store::CloudStore;
use crate::backup::{access_list, scope};
use crate::db::{self, BackupKey};
use crate::drives::layout::Layout;
use crate::files;

/// Wraps each pack's random key under the backup key.
pub(super) const PACK_KEY_WRAP_AAD: &[u8] = b"luna-pack-key-wrap-v1";
/// Domain for deriving the opaque scope id that stands in for a protection.
const SCOPE_DOMAIN: &[u8] = b"luna-scope-v1";
/// A pack is uploaded once its plain bytes reach this size.
const PACK_FLUSH_BYTES: usize = 8 << 20;

/// Shown when a run is held because its source drive or folder is gone.
const NO_ADMIN_PHRASE: &str = "Waiting for an Admin to set up the recovery phrase.";
pub(crate) const SOURCE_MISSING: &str = "The source looks missing or unplugged. Plug the drive back in, then try again.";

/// Shown when a run is held because it could not be compared with the last copy.
pub(crate) const CHECK_FAILED: &str = "Luna couldn't compare this folder with the last cloud copy, so it paused this backup. Try again, or choose Back up anyway if the folder looks right.";

/// What one run did. `problem` is set, and no snapshot is committed, when the run failed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CloudOutcome {
    pub uploaded_bytes: u64,
    pub files: u64,
    pub reused_chunks: u64,
    pub snapshot_id: Option<String>,
    pub problem: Option<String>,
    /// True when the run was held because most of the source looks gone. A person can
    /// then choose "Back up anyway", which runs it with `accept_missing`.
    pub source_missing: bool,
}

/// The folder on disk for a backup's logical path. A private item's disk name differs from its path.
pub(crate) fn source_root(drive_root: &Path, source_path: &str) -> PathBuf {
    drive_root.join(crate::private::disk_rel(drive_root, source_path.trim_start_matches('/')))
}

/// Runs one backup for `protection_id` against `store` and returns what happened.
/// `started_by` is the user who asked for it, or empty for a scheduled run.
/// `accept_missing` lets the run go ahead when most of the source is gone, once a person has
/// checked the drive. Without it, such a run is held.
pub fn run_once(
    db: &crate::Db,
    protection_id: &str,
    store: &dyn CloudStore,
    started_by: &str,
    accept_missing: bool,
    now: i64,
) -> Result<CloudOutcome> {
    let (drive_root, root) = {
        let conn = lock(db);
        let row = db::get_protection(&conn, protection_id)?
            .ok_or_else(|| anyhow!("This backup no longer exists."))?;
        let drive = files::drive_root(&conn, &row.source_drive)?;
        let drive_root = PathBuf::from(&drive.mount_point);
        let root = source_root(&drive_root, &row.source_path);
        (drive_root, root)
    };
    // An unplugged drive has no Luna marker, so its folder is never read as empty.
    if Layout::detect(&drive_root).is_none() {
        return Ok(problem_outcome(SOURCE_MISSING));
    }
    run_with_root(db, protection_id, &root, store, started_by, accept_missing, now)
}

/// The run itself, reading from `root` instead of resolving the drive. Tests use this.
fn run_with_root(
    db: &crate::Db,
    protection_id: &str,
    root: &Path,
    store: &dyn CloudStore,
    started_by: &str,
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
        match source_looks_missing(db, protection_id, root, store) {
            Ok(true) => {
                return Ok(CloudOutcome {
                    source_missing: true,
                    ..problem_outcome(SOURCE_MISSING)
                })
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
    let (ctx, publish) = match prepare(db, protection_id, started_by, now) {
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

/// True when most files in the previous snapshot are gone from `root`. The previous snapshot's
/// file list is read back from the cloud. A protection with no earlier snapshot is never held.
fn source_looks_missing(db: &crate::Db, protection_id: &str, root: &Path, store: &dyn CloudStore) -> Result<bool> {
    let (record, tree_key) = {
        let conn = lock(db);
        let Some(last) = db::list_cloud_snapshots(&conn, protection_id)?.into_iter().next() else {
            return Ok(false);
        };
        let Some(identity) = identity::load(&conn)? else {
            return Err(anyhow!("Luna's cloud identity is missing."));
        };
        let record = format::SignedRecord::from_bytes(&last.record)?.verify(&identity.public())?;
        // The last copy was sealed with the key version it names, which may be older than the newest.
        let Some(key) = db::list_backup_keys(&conn, protection_id)?
            .into_iter()
            .find(|k| k.version == last.key_version)
        else {
            return Err(anyhow!("The key for the last copy is missing."));
        };
        let tree_key: [u8; 32] = key
            .key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("This backup's key is damaged."))?;
        (record, tree_key)
    };
    let tree = read_tree(store, &record, &tree_key)?;
    Ok(most_files_missing(&tree, root))
}

/// True when most files of the last tree are gone from `root`. An empty tree is never missing.
pub(crate) fn most_files_missing(tree: &Tree, root: &Path) -> bool {
    let missing = tree.entries.iter().filter(|e| !root.join(&e.path).is_file()).count();
    !tree.entries.is_empty() && missing * 2 > tree.entries.len()
}

/// How one kind of backup seals what a run writes. Shared backups use the backup key;
/// private items seal to their owner (`private_run.rs`).
pub(crate) trait Sealer: Send + Sync {
    /// The wrapped pack key stored in a pack's header.
    fn wrap_pack_key(&self, pack_key: &[u8; 32]) -> Vec<u8>;
    /// The tree as stored in its tree pack. Its SHA-256 is the record's tree_hash.
    fn seal_tree(&self, tree: &Tree) -> Result<Vec<u8>>;
    /// Sign the record; returns (record kind, record name, bytes) for `put_record`.
    fn finish_record(&self, record: SnapshotRecord, signer: &Signer) -> (&'static str, String, Vec<u8>);
    /// Commit the snapshot locally, in one transaction.
    fn commit(&self, conn: &mut Connection, snap: &db::SnapshotInsert, pack_ids: &[String], tree: &Tree) -> Result<()>;
}

/// Seals a shared backup with its backup key, exactly as runs always have.
pub(crate) struct SharedSealer {
    pub key_bytes: [u8; 32],
}

impl Sealer for SharedSealer {
    fn wrap_pack_key(&self, pack_key: &[u8; 32]) -> Vec<u8> {
        crypto::encrypt(&self.key_bytes, PACK_KEY_WRAP_AAD, pack_key)
    }

    fn seal_tree(&self, tree: &Tree) -> Result<Vec<u8>> {
        Ok(format::encrypt_tree(tree, &self.key_bytes))
    }

    fn finish_record(&self, record: SnapshotRecord, signer: &Signer) -> (&'static str, String, Vec<u8>) {
        let name = record.snapshot_id.clone();
        ("snapshots", name, record.sign(signer).to_bytes())
    }

    fn commit(&self, conn: &mut Connection, snap: &db::SnapshotInsert, pack_ids: &[String], _tree: &Tree) -> Result<()> {
        db::commit_snapshot_tx(conn, snap, pack_ids)
    }
}

/// Recipients and their keys, plus the key version to publish, kept for a key version that is new.
type Publish = (Recipients, HashMap<String, [u8; 32]>, BackupKey);

/// Everything a run needs that does not change while it copies.
pub(crate) struct RunContext {
    pub(crate) run_id: String,
    pub(crate) protection_id: String,
    pub(crate) scope: String,
    pub(crate) scope_id: [u8; 32],
    pub(crate) dedup_key: [u8; 32],
    pub(crate) key_version: u32,
    pub(crate) luna_id: String,
    pub(crate) signer: Signer,
    /// The backup's name and source, encrypted under the backup key, for recovery.
    pub(crate) meta: Vec<u8>,
    pub(crate) sealer: Box<dyn Sealer>,
}

/// Reads the key and recipients and opens the run row. Nothing after `start_run` can fail.
fn prepare(
    db: &crate::Db,
    protection_id: &str,
    _started_by: &str,
    now: i64,
) -> Result<(RunContext, Option<Publish>)> {
    let conn = lock(db);
    let row = db::get_protection(&conn, protection_id)?
        .ok_or_else(|| anyhow!("This backup no longer exists."))?;
    // A run never mints an identity: a Luna without one has never been set up for cloud backup.
    let identity = identity::load(&conn)?
        .ok_or_else(|| anyhow!("Set up cloud backup on this Luna before running a backup."))?;
    let seed = db::get_cloud_identity(&conn)?
        .ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?
        .signing_seed;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow!("Luna's cloud identity is damaged."))?;
    let access = access_list::for_row(&conn, &row)?;

    let user_pub: HashMap<String, [u8; 32]> = db::list_user_keys(&conn)?
        .into_iter()
        .filter_map(|k| Some((k.user_id, k.x25519_public.as_slice().try_into().ok()?)))
        .collect();
    let users = db::list_users(&conn)?;
    let mut ids = Vec::new();
    for user in &users {
        let is_admin = user.role == "admin";
        if access.allows(&user.id, is_admin) && user_pub.contains_key(&user.id) {
            ids.push(user.id.clone());
        }
    }
    // Only an Admin can open a key copy in a disaster, so nothing uploads until one can.
    let admin_ready = users.iter().any(|u| u.role == "admin" && ids.contains(&u.id));
    if !admin_ready {
        return Err(anyhow!(NO_ADMIN_PHRASE));
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

    // The name is the last folder of the source. Protections have no name column, so this is the choice.
    let name = row
        .source_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(&row.source_drive)
        .to_string();
    // The person who set the backup up, not whoever triggered this run. Their name goes in the
    // encrypted metadata so the Connect page can group by person without seeing names.
    let started_by_name = db::get_user(&conn, &row.created_by)?
        .map(|user| if user.display_name.is_empty() { user.username } else { user.display_name })
        .unwrap_or_default();
    let meta = format::encrypt_meta(
        &BackupMeta {
            name,
            source_drive: row.source_drive.clone(),
            source_path: row.source_path.clone(),
            started_by: row.created_by.clone(),
            started_by_name,
        },
        &key_bytes,
    );

    let key_version = key.version as u32;
    let publish = is_new.then_some((recipients, user_pub, key));
    let ctx = RunContext {
        run_id,
        meta,
        protection_id: protection_id.to_string(),
        scope,
        scope_id,
        key_version,
        dedup_key,
        luna_id: identity.luna_id.clone(),
        signer: Signer::from_seed(seed),
        sealer: Box::new(SharedSealer { key_bytes }),
    };
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
    if let Some((recipients, user_pub, key)) = publish {
        keys::publish_key(
            store,
            &ctx.signer,
            &ctx.luna_id,
            &ctx.protection_id,
            &key,
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
    /// Where each chunk this run references is stored: pack id bytes, offset, length.
    located: HashMap<[u8; 32], ([u8; 32], u64, u32)>,
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
        if let Some((pack_id, offset, len)) = known {
            self.reused_chunks += 1;
            let pack = unhex(&pack_id)?;
            self.located.insert(id, (pack, offset as u64, len as u32));
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
        let sealed = builder.finish(|pack_key| self.ctx.sealer.wrap_pack_key(pack_key));
        let pack_id = hex(&sealed.id);
        {
            let conn = lock(self.db);
            db::insert_pending_pack(&conn, &pack_id, &self.ctx.scope, &self.ctx.run_id, self.now)?;
            db::record_pack_size(&conn, &pack_id, sealed.bytes.len() as i64)?;
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
                self.located.insert(chunk_id, (sealed.id, offset, len));
            }
        }
        self.uploaded_bytes += sealed.bytes.len() as u64;
        self.pack_ids.push(pack_id);
        Ok(())
    }

    /// The pack and place of a chunk this run has already stored or reused.
    /// Call only after the final `flush`, so every pending chunk has a place.
    fn locate(&self, id: &[u8; 32]) -> Result<ChunkRef> {
        let (pack, offset, len) = self
            .located
            .get(id)
            .ok_or_else(|| anyhow!("A file's data was not stored. Try the backup again."))?;
        Ok(ChunkRef {
            id: *id,
            pack: *pack,
            offset: *offset,
            len: *len,
        })
    }
}

/// Copies every file under `root`, uploads the tree and a signed snapshot record, and commits.
pub(crate) fn copy_and_commit(
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
        located: HashMap::new(),
        pack_ids: Vec::new(),
        uploaded_bytes: 0,
        reused_chunks: 0,
    };

    // Chunk ids per file; they become `ChunkRef`s once the last pack is flushed.
    let mut drafts = Vec::new();
    let files = scope::walk(root).map_err(|e| anyhow!("Could not read the folder being backed up: {e}"))?;
    for entry in &files {
        let mut file = File::open(&entry.abs)
            .map_err(|e| anyhow!("Could not open {}: {e}", entry.rel))?;
        let mut chunk_ids = Vec::new();
        format::chunks(&mut file, |plain| {
            chunk_ids.push(copy.chunk(plain)?);
            Ok(())
        })?;
        drafts.push((entry.rel.clone(), entry.size, entry.mtime, chunk_ids));
    }
    copy.flush()?;
    let entries = drafts
        .into_iter()
        .map(|(path, size, mtime, ids)| {
            let chunks = ids
                .iter()
                .map(|id| copy.locate(id))
                .collect::<Result<Vec<_>>>()?;
            Ok(TreeEntry { path, size, mtime, chunks })
        })
        .collect::<Result<Vec<_>>>()?;

    // The tree goes into a pack of its own, so restores can find it from the snapshot.
    let tree = Tree { entries };
    let tree_bytes = ctx.sealer.seal_tree(&tree)?;
    // The tree's chunk id is its hash, so the snapshot record alone says where the tree is.
    let tree_hash = format::sha256(&tree_bytes);
    let mut tree_builder = PackBuilder::new(ctx.scope_id);
    let (tree_offset, tree_len) = tree_builder.add(tree_hash, &tree_bytes);
    let tree_pack = tree_builder.finish(|pack_key| ctx.sealer.wrap_pack_key(pack_key));
    let tree_pack_id = hex(&tree_pack.id);
    {
        let conn = lock(db);
        db::insert_pending_pack(&conn, &tree_pack_id, &ctx.scope, &ctx.run_id, now)?;
        db::record_pack_size(&conn, &tree_pack_id, tree_pack.bytes.len() as i64)?;
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
        meta: ctx.meta.clone(),
    };
    let (kind, name, signed_bytes) = ctx.sealer.finish_record(record, &ctx.signer);
    store
        .put_record(kind, &name, &signed_bytes)
        .map_err(|e| anyhow!("{e}"))?;

    {
        let mut conn = lock(db);
        ctx.sealer.commit(
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
            &tree,
        )?;
    }

    Ok(CloudOutcome {
        uploaded_bytes: copy.uploaded_bytes,
        files: files.len() as u64,
        reused_chunks: copy.reused_chunks,
        snapshot_id: Some(snapshot_id),
        problem: None,
        source_missing: false,
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

pub(crate) fn problem_outcome(message: &str) -> CloudOutcome {
    CloudOutcome {
        problem: Some(message.to_string()),
        ..Default::default()
    }
}

/// Holds a protection's place in [`RUNNING`] until it is dropped.
pub(crate) struct RunSlot(String);

/// Keyed by the database's address as well as the protection id, so two databases
/// (for example two tests) that share an id never block each other. The address is
/// stable while a run holds its slot because the run borrows the `Db`.
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

impl RunSlot {
    pub(crate) fn take(db: &crate::Db, id: &str) -> Option<Self> {
        let key = format!("{:x}:{id}", std::ptr::from_ref(db) as usize);
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        running.insert(key.clone()).then(|| Self(key))
    }
}

impl Drop for RunSlot {
    fn drop(&mut self) {
        RUNNING.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.0);
    }
}

pub(crate) fn lock(db: &crate::Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}

pub(crate) fn random_id() -> String {
    hex(&random_bytes::<16>())
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Lowercase hex (as the database stores pack ids) back to the 32-byte id.
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
    use crate::backup::cloud::store::MemoryStore;

    /// A database with one admin who has keys, and a protection for each id the tests use.
    fn setup(dir: &Path) -> crate::Db {
        let conn = db::open(&dir.join("luna.db")).unwrap();
        db::insert_user(&conn, "owner", "owner", "Owner", "x", "admin").unwrap();
        identity::load_or_create(&conn, 1).unwrap();
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
        for id in ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"] {
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
    fn run_is_held_when_most_source_files_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p6", &src, &store, "user-1", false, 100).unwrap();
        assert_eq!(first.problem, None);

        std::fs::remove_file(src.join("a.bin")).unwrap();
        std::fs::remove_file(src.join("b.bin")).unwrap();
        let held = run_with_root(&db, "p6", &src, &store, "user-1", false, 200).unwrap();
        assert_eq!(held.problem.as_deref(), Some(SOURCE_MISSING));
        assert!(held.source_missing);
        assert_eq!(held.snapshot_id, None);
        assert_eq!(store.list_records("snapshots").unwrap().len(), 1);
        let open_runs: i64 = lock(&db)
            .query_row("SELECT COUNT(*) FROM cloud_runs WHERE ended_at = 0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(open_runs, 0);
    }

    #[test]
    fn accept_missing_lets_a_held_run_through() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        run_with_root(&db, "p8", &src, &store, "user-1", false, 100).unwrap();

        std::fs::remove_file(src.join("a.bin")).unwrap();
        std::fs::remove_file(src.join("b.bin")).unwrap();
        let out = run_with_root(&db, "p8", &src, &store, "user-1", true, 200).unwrap();
        assert_eq!(out.problem, None);
        assert!(!out.source_missing);
        assert!(out.snapshot_id.is_some());
        assert_eq!(store.list_records("snapshots").unwrap().len(), 2);
    }

    #[test]
    fn an_unreadable_last_copy_holds_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        run_with_root(&db, "p7", &src, &store, "user-1", false, 100).unwrap();

        lock(&db)
            .execute("UPDATE cloud_snapshots SET record = x'00' WHERE protection_id = 'p7'", [])
            .unwrap();
        let held = run_with_root(&db, "p7", &src, &store, "user-1", false, 200).unwrap();
        assert_eq!(held.problem.as_deref(), Some(CHECK_FAILED));
        assert!(held.source_missing, "the person may choose Back up anyway");
        assert_eq!(held.snapshot_id, None);

        let forced = run_with_root(&db, "p7", &src, &store, "user-1", true, 300).unwrap();
        assert_eq!(forced.problem, None);
        assert!(forced.snapshot_id.is_some());
    }

    #[test]
    fn the_check_still_runs_after_the_key_version_changes() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        run_with_root(&db, "p9", &src, &store, "user-1", false, 100).unwrap();

        // Someone's access changed, so the newest key is a later version than the last copy's.
        let newest = db::latest_backup_key(&lock(&db), "p9").unwrap().unwrap();
        db::insert_backup_key(
            &lock(&db),
            &BackupKey { version: newest.version + 1, key: vec![7; 32], dedup_key: vec![8; 32], ..newest },
        )
        .unwrap();

        std::fs::remove_file(src.join("a.bin")).unwrap();
        std::fs::remove_file(src.join("b.bin")).unwrap();
        let held = run_with_root(&db, "p9", &src, &store, "user-1", false, 200).unwrap();
        assert_eq!(held.problem.as_deref(), Some(SOURCE_MISSING));
        assert!(held.source_missing);
    }

    #[test]
    fn a_run_without_an_identity_refuses_and_mints_none() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        lock(&db).execute("DELETE FROM cloud_identity", []).unwrap();

        let out = run_with_root(&db, "p1", &src, &store, "user-1", false, 100).unwrap();
        assert_eq!(
            out.problem.as_deref(),
            Some("Set up cloud backup on this Luna before running a backup.")
        );
        assert_eq!(out.snapshot_id, None);
        assert!(identity::load(&lock(&db)).unwrap().is_none());
        assert!(store.list_records("snapshots").unwrap().is_empty());
    }

    #[test]
    fn run_waits_until_an_admin_has_a_recovery_phrase() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        db::delete_user_keys(&lock(&db), "owner").unwrap();

        let held = run_with_root(&db, "p8", &src, &store, "user-1", false, 100).unwrap();
        assert_eq!(held.problem.as_deref(), Some(NO_ADMIN_PHRASE));
        assert_eq!(held.snapshot_id, None);
        assert!(store.list_records("snapshots").unwrap().is_empty());
        assert!(store.list_records("keys").unwrap().is_empty());

        let keys = crypto::derive(&[8u8; 16], "luna-test");
        db::set_user_keys(
            &lock(&db),
            &db::UserKeys {
                user_id: "owner".into(),
                x25519_public: keys.x25519_public.to_vec(),
                auth_public: keys.auth_public.to_vec(),
                self_sealed: vec![3; 48],
                phrase_set_at: 2,
                last_checked_at: 0,
            },
        )
        .unwrap();
        let done = run_with_root(&db, "p8", &src, &store, "user-1", false, 200).unwrap();
        assert_eq!(done.problem, None);
        assert!(done.snapshot_id.is_some());
    }

    #[test]
    fn first_run_uploads_everything_then_second_run_reuses_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();

        let first = run_with_root(&db, "p1", &src, &store, "user-1", false, 100).unwrap();
        assert_eq!(first.problem, None);
        assert!(first.snapshot_id.is_some());
        assert_eq!(first.files, 2);
        assert!(first.uploaded_bytes >= 5 << 20);

        let second = run_with_root(&db, "p1", &src, &store, "user-1", false, 200).unwrap();
        assert_eq!(second.problem, None);
        assert!(second.reused_chunks > 0);
        assert!(second.uploaded_bytes < first.uploaded_bytes / 10);
    }

    #[test]
    fn stored_pack_sizes_are_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p3", &src, &store, "user-1", false, 100).unwrap();
        assert_eq!(first.problem, None);

        let conn = lock(&db);
        let zero_sized: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_packs WHERE state = 'live' AND size = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(zero_sized, 0, "every live pack records its byte size");
        assert!(crate::backup::cloud::ops::size(&conn, "p3") >= 5 << 20);
    }

    #[test]
    fn modified_file_uploads_only_changed_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let first = run_with_root(&db, "p2", &src, &store, "user-1", false, 100).unwrap();

        let mut data = std::fs::read(src.join("a.bin")).unwrap();
        data[100] ^= 0xff;
        std::fs::write(src.join("a.bin"), data).unwrap();
        let second = run_with_root(&db, "p2", &src, &store, "user-1", false, 200).unwrap();

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

        let out = run_with_root(&db, "p7", &src, &store, "user-1", false, 100).unwrap();
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
        let out = run_with_root(&db, "p5", &src, &store, "user-1", false, 100).unwrap();
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
    fn tree_records_where_each_chunk_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p8", &src, &store, "user-1", false, 100).unwrap();
        let snapshot_id = out.snapshot_id.unwrap();

        let conn = lock(&db);
        let identity = identity::load(&conn).unwrap().unwrap();
        let bytes = store.get_record("snapshots", &snapshot_id).unwrap().unwrap();
        let record = format::SignedRecord::from_bytes(&bytes)
            .unwrap()
            .verify(&identity.public())
            .unwrap();
        let backup_key = db::latest_backup_key(&conn, "p8").unwrap().unwrap();
        let tree_key: [u8; 32] = backup_key.key.as_slice().try_into().unwrap();
        let tree = read_tree(&store, &record, &tree_key).unwrap();

        let mut checked = 0;
        for entry in &tree.entries {
            assert!(!entry.chunks.is_empty());
            for chunk in &entry.chunks {
                let (pack_id, offset, len): (String, i64, i64) = conn
                    .query_row(
                        "SELECT pack_id, offset, len FROM cloud_chunks WHERE chunk_id = ?1",
                        [&chunk.id[..]],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .unwrap();
                assert_eq!(hex(&chunk.pack), pack_id);
                assert_eq!(chunk.offset as i64, offset);
                assert_eq!(i64::from(chunk.len), len);
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn snapshot_meta_names_the_backup_and_who_started_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p8", &src, &store, "user-7", false, 100).unwrap();
        assert_eq!(out.problem, None);
        let snapshot_id = out.snapshot_id.unwrap();

        let conn = lock(&db);
        let bytes = store.get_record("snapshots", &snapshot_id).unwrap().unwrap();
        let record = format::SignedRecord::from_bytes(&bytes).unwrap();
        let identity = identity::load(&conn).unwrap().unwrap();
        let record = record.verify(&identity.public()).unwrap();
        let key = db::latest_backup_key(&conn, "p8").unwrap().unwrap();
        let key_bytes: [u8; 32] = key.key.as_slice().try_into().unwrap();
        let meta = format::decrypt_meta(&record.meta, &key_bytes).unwrap();
        let row = db::get_protection(&conn, "p8").unwrap().unwrap();
        // The protection was created by "owner" (see `setup`), not by the run's trigger "user-7".
        assert_eq!(meta.started_by, "owner");
        assert_eq!(meta.started_by_name, "Owner");
        assert_eq!(meta.source_drive, row.source_drive);
        assert_eq!(meta.source_path, row.source_path);
        assert_eq!(meta.name, row.source_path.rsplit('/').next().unwrap());
    }

    #[test]
    fn snapshot_record_verifies_and_chunk_ids_stay_out_of_packs() {
        let dir = tempfile::tempdir().unwrap();
        let db = setup(dir.path());
        let src = source(dir.path());
        let store = MemoryStore::new();
        let out = run_with_root(&db, "p4", &src, &store, "user-1", false, 100).unwrap();
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

    #[test]
    fn source_root_maps_a_private_item_to_its_disk_name() {
        crate::private::install();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("d");
        std::fs::create_dir(&root).unwrap();
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        crate::drives::drive_db::create(&root, &luna_core::marker::Marker::new("d", "d"), &prefix)
            .unwrap();
        std::fs::create_dir(root.join("Diary")).unwrap();
        std::fs::create_dir(root.join("Photos")).unwrap();
        crate::private::privatize(&root, "Diary", "owner").unwrap();

        let private = source_root(&root, "Diary");
        let name = private.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(".luna-"), "{name}");
        assert_eq!(private, root.join(crate::private::disk_rel(&root, "Diary")));
        assert_eq!(source_root(&root, "/Photos"), root.join("Photos"));
    }

    #[test]
    fn shared_sealer_names_snapshots_records() {
        let sealer = SharedSealer { key_bytes: [7u8; 32] };
        let record = SnapshotRecord {
            luna_id: "luna-1".into(),
            protection_id: "p1".into(),
            snapshot_id: "snap-1".into(),
            created_at: 1,
            key_version: 1,
            tree_pack_id: [1u8; 32],
            tree_hash: [2u8; 32],
            meta: Vec::new(),
        };
        let (kind, name, bytes) = sealer.finish_record(record, &Signer::from_seed([3u8; 32]));
        assert_eq!(kind, "snapshots");
        assert_eq!(name, "snap-1");
        assert!(!bytes.is_empty());
    }
}
