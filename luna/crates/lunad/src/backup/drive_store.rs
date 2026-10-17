//! A drive backup's storage on its target drive (plan §3, §4).
//!
//! Layout: `<target-root>/{prefix}-backups/<protection-id>/`
//! - `current/`: plain files mirroring the source.
//! - `versions/<unix-seconds>/<rel>`: earlier copies of changed or deleted
//!   files, moved there (never hardlinked) when replaced.
//! - `manifest.json`: what this backup is, so the drive describes itself.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::access_list::AccessList;
use crate::drives::layout::Layout;

pub const MANIFEST: &str = "manifest.json";
pub const MANIFEST_FORMAT: u32 = 1;

/// How long a deleted file's last copy is kept (plan §3).
pub const DELETED_KEEP_SECS: i64 = 30 * 86_400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub protection_id: String,
    /// The lasting Luna id (plan §5). Empty until cloud setup provides it.
    pub luna_id: String,
    pub source_drive_id: String,
    /// The source drive's name when last seen, for "came from" labels.
    pub source_drive_label: String,
    pub source_path: String,
    /// Owner user id for a private item's backup.
    pub private_owner: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    /// Saved at each successful run (plan §2).
    pub access: AccessList,
    pub last_ok_at: i64,
    /// Files deleted from the source: rel path → deletion time on the
    /// backup's own clock ([`Manifest::clock`]).
    pub deleted: BTreeMap<String, i64>,
    /// Total seconds the deleted-files clock has been frozen.
    pub paused_secs: i64,
    /// When the current freeze began; 0 while running.
    pub paused_since: i64,
}

impl Manifest {
    /// The backup's own clock: wall time minus every frozen stretch, so a
    /// missing source never ages its deleted files out.
    pub fn clock(&self, now: i64) -> i64 {
        let _ = now;
        todo!("task B")
    }

    /// Freeze the clock (source missing or gone). No-op when already frozen.
    pub fn pause(&mut self, now: i64) {
        let _ = now;
        todo!("task B")
    }

    /// Unfreeze the clock. No-op when running.
    pub fn resume(&mut self, now: i64) {
        let _ = now;
        todo!("task B")
    }
}

/// What [`Store::put`] did with one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    Unchanged,
    Added,
    /// The previous copy moved into `versions/`.
    Updated,
}

/// One backup's directory on its target drive.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// The store for `protection_id` on the drive mounted at `target_root`,
    /// creating its directories when missing.
    pub fn open(target_root: &Path, layout: &Layout, protection_id: &str) -> std::io::Result<Store> {
        let _ = (target_root, layout, protection_id);
        todo!("task B")
    }

    /// The store if it already exists; never creates anything.
    pub fn existing(target_root: &Path, layout: &Layout, protection_id: &str) -> Option<Store> {
        let _ = (target_root, layout, protection_id);
        todo!("task B")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn current_dir(&self) -> PathBuf {
        self.root.join("current")
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn read_manifest(&self) -> std::io::Result<Option<Manifest>> {
        todo!("task B")
    }

    /// Write the manifest atomically (temp file, then rename).
    pub fn write_manifest(&self, manifest: &Manifest) -> std::io::Result<()> {
        let _ = manifest;
        todo!("task B")
    }

    /// Copy `src` to `current/<rel>` unless the copy there already matches
    /// (size and mtime). A different existing copy moves to
    /// `versions/<now>/<rel>` first; the new one is written temp-file-then-
    /// rename and keeps the source mtime.
    pub fn put(&self, rel: &str, src: &Path, src_meta: &std::fs::Metadata, now: i64) -> std::io::Result<Put> {
        let _ = (rel, src, src_meta, now);
        todo!("task B")
    }

    /// The source no longer has `rel`: move `current/<rel>` to
    /// `versions/<now>/<rel>`. Returns whether there was a copy to move.
    pub fn remove(&self, rel: &str, now: i64) -> std::io::Result<bool> {
        let _ = (rel, now);
        todo!("task B")
    }

    /// Every file under `current/`, as rel paths.
    pub fn current_files(&self) -> std::io::Result<Vec<String>> {
        todo!("task B")
    }

    /// Version directory timestamps, oldest first.
    pub fn version_times(&self) -> std::io::Result<Vec<i64>> {
        todo!("task B")
    }

    /// Apply retention (plan §3): drop earlier versions not kept by
    /// [`keep_versions`] per file, and the last copy of files deleted more
    /// than [`DELETED_KEEP_SECS`] ago on the manifest's clock (removing them
    /// from `manifest.deleted`). Empty version dirs are removed. Returns the
    /// number of files removed.
    pub fn thin(&self, manifest: &mut Manifest, now: i64) -> std::io::Result<u64> {
        let _ = (manifest, now);
        todo!("task B")
    }
}

/// Every backup store on the drive mounted at `target_root`.
pub fn list_stores(target_root: &Path, layout: &Layout) -> Vec<Store> {
    let _ = (target_root, layout);
    todo!("task B")
}

/// Retention for one file's earlier versions (plan §3): given their times,
/// which to keep. At most one per bucket, the oldest in each: up to 1 day
/// old, up to 1 week, up to ~1 month (31 days). Older ones are dropped.
pub fn keep_versions(times: &[i64], now: i64) -> Vec<i64> {
    let _ = (times, now);
    todo!("task B")
}

/// What a target drive's filesystem can't do (plan §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FsLimits {
    /// `a` and `A` are the same name (exFAT/FAT).
    pub case_insensitive: bool,
    /// Largest file it can hold (FAT: 4 GiB - 1).
    pub max_file: Option<u64>,
}

pub fn fs_limits(target_root: &Path) -> FsLimits {
    let _ = target_root;
    todo!("task B")
}
