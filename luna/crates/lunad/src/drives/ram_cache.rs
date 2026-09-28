//! Reclaimable in-RAM caches for thumbs, directory listings, and in-flight
//! small writes — the hot layer above USB-resident `.luna-<uuid>-*` state.
//!
//! Clean caches (thumbs, listings, hot-read bodies) drop under memory pressure.
//! Dirty write buffers never vanish silently: pressure flushes them to USB or
//! refuses new dirty accepts with a plain-language error. A buffer that can't
//! reach the drive becomes a failed-save row the listing shows, never a quiet
//! drop.
//!
//! One writer per buffer: [`RamCache::flush_dirty_to_disk`] claims the entry,
//! and any other caller waits for that write to settle. Eject relies on this —
//! it closes the drive to new buffers, then flushes and waits for every
//! in-flight write before unmounting.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::budget::{self, CacheBudget};
use crate::files::{self, FileEntry, FilesError};

const MIB: u64 = 1024 * 1024;
/// Browser/private caches may keep thumbs this long; validators still revalidate.
pub const THUMB_MAX_AGE_SECS: u64 = 3600;
/// Listing hits skip the USB `metadata()` check for this long after a warm fill.
const LISTING_TRUST_TTL: Duration = Duration::from_secs(2);
/// How long a failed save stays visible in its folder listing.
const FAILED_SAVE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Cap on remembered failed saves (names only — a few bytes each).
const MAX_FAILED_SAVES: usize = 1024;

#[derive(Clone, Debug)]
pub struct ThumbBytes {
    pub bytes: Arc<[u8]>,
    pub mtime_secs: u64,
    pub etag: String,
}

#[derive(Clone, Debug)]
struct ThumbEntry {
    bytes: Arc<[u8]>,
    mtime_secs: u64,
    etag: String,
}

#[derive(Clone, Debug)]
struct ListingEntry {
    entries: Vec<FileEntry>,
    dir_mtime: i64,
    filled_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirtyState {
    Writing,
    Flushing,
    Durable,
}

#[derive(Clone, Debug)]
pub struct DirtyFile {
    pub bytes: Arc<[u8]>,
    pub modified: i64,
    pub state: DirtyState,
    pub name: String,
    /// Whether the upload may replace an existing file — every flusher
    /// (background, eject, memory pressure) honors the uploader's choice.
    pub overwrite: bool,
    /// Deleted while a flush was in flight: the flusher discards its temp
    /// instead of installing it.
    cancelled: bool,
}

#[derive(Clone, Debug)]
struct FailedSave {
    name: String,
    at: Instant,
    modified: i64,
}

struct Inner {
    thumbs: HashMap<String, ThumbEntry>,
    thumb_order: VecDeque<String>,
    thumb_bytes: u64,
    listings: HashMap<String, ListingEntry>,
    listing_order: VecDeque<String>,
    dirty: HashMap<String, DirtyFile>,
    dirty_bytes: u64,
    /// Drives being ejected or removed: new dirty accepts are refused.
    closing: HashSet<String>,
    failed: HashMap<String, FailedSave>,
}

impl Inner {
    fn new() -> Self {
        Self {
            thumbs: HashMap::new(),
            thumb_order: VecDeque::new(),
            thumb_bytes: 0,
            listings: HashMap::new(),
            listing_order: VecDeque::new(),
            dirty: HashMap::new(),
            dirty_bytes: 0,
            closing: HashSet::new(),
            failed: HashMap::new(),
        }
    }
}

/// Shared process cache. Cheap to clone (`Arc`).
#[derive(Clone, Default)]
pub struct RamCache {
    inner: Arc<Mutex<Inner>>,
    /// Signalled whenever a dirty flush settles (landed, failed, cancelled).
    settled: Arc<Condvar>,
}

impl Default for Inner {
    fn default() -> Self {
        Self::new()
    }
}

fn thumb_key(drive_id: &str, rel: &str) -> String {
    format!("{drive_id}\0{rel}")
}

fn listing_key(drive_id: &str, rel: &str) -> String {
    format!("{drive_id}\0{rel}")
}

fn dirty_key(drive_id: &str, rel: &str) -> String {
    format!("{drive_id}\0{rel}")
}

fn parent_rel(rel: &str) -> String {
    match rel.rsplit_once('/') {
        Some((p, _)) => p.to_string(),
        None => String::new(),
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn thumb_etag(len: u64, mtime_secs: u64) -> String {
    format!("\"{len:x}-{mtime_secs:x}\"")
}

impl RamCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::new())),
            settled: Arc::new(Condvar::new()),
        }
    }

    fn budget() -> CacheBudget {
        let m = budget::meminfo();
        budget::cache_budget_from(m.available_bytes)
    }

    /// Insert or refresh a served thumbnail. Evicts LRU thumbs if over budget.
    pub fn put_thumb(&self, drive_id: &str, rel: &str, bytes: Vec<u8>, mtime_secs: u64) {
        if bytes.is_empty() {
            return;
        }
        let budget = Self::budget();
        if bytes.len() as u64 > budget.thumb_bytes.max(1) {
            return;
        }
        let key = thumb_key(drive_id, rel);
        let etag = thumb_etag(bytes.len() as u64, mtime_secs);
        let entry = ThumbEntry {
            bytes: Arc::from(bytes.into_boxed_slice()),
            mtime_secs,
            etag,
        };
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = g.thumbs.remove(&key) {
            g.thumb_bytes = g.thumb_bytes.saturating_sub(old.bytes.len() as u64);
            g.thumb_order.retain(|k| k != &key);
        }
        g.thumb_bytes += entry.bytes.len() as u64;
        g.thumbs.insert(key.clone(), entry);
        g.thumb_order.push_back(key);
        while g.thumb_bytes > budget.thumb_bytes {
            if !Self::evict_one_thumb(&mut g) {
                break;
            }
        }
    }

    pub fn get_thumb(&self, drive_id: &str, rel: &str) -> Option<ThumbBytes> {
        let key = thumb_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = g.thumbs.get(&key)?.clone();
        // LRU touch
        g.thumb_order.retain(|k| k != &key);
        g.thumb_order.push_back(key);
        Some(ThumbBytes {
            bytes: entry.bytes,
            mtime_secs: entry.mtime_secs,
            etag: entry.etag,
        })
    }

    pub fn invalidate_thumb(&self, drive_id: &str, rel: &str) {
        let key = thumb_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = g.thumbs.remove(&key) {
            g.thumb_bytes = g.thumb_bytes.saturating_sub(old.bytes.len() as u64);
            g.thumb_order.retain(|k| k != &key);
        }
    }

    pub fn put_listing(&self, drive_id: &str, rel: &str, dir_mtime: i64, entries: Vec<FileEntry>) {
        let key = listing_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // Cap listing map size (~4k dirs); each entry is small.
        const MAX_LISTINGS: usize = 4096;
        if !g.listings.contains_key(&key) && g.listings.len() >= MAX_LISTINGS {
            Self::evict_one_listing(&mut g);
        }
        g.listing_order.retain(|k| k != &key);
        g.listings.insert(
            key.clone(),
            ListingEntry {
                entries,
                dir_mtime,
                filled_at: Instant::now(),
            },
        );
        g.listing_order.push_back(key);
    }

    /// Hot listing when still trusted (short TTL) or when `dir_mtime` matches.
    pub fn get_listing(
        &self,
        drive_id: &str,
        rel: &str,
        dir_mtime: Option<i64>,
    ) -> Option<Vec<FileEntry>> {
        let key = listing_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = g.listings.get(&key)?;
        let fresh_ttl = entry.filled_at.elapsed() <= LISTING_TRUST_TTL;
        let mtime_ok = dir_mtime.map(|m| m == entry.dir_mtime).unwrap_or(false);
        if !fresh_ttl && !mtime_ok {
            return None;
        }
        let out = entry.entries.clone();
        g.listing_order.retain(|k| k != &key);
        g.listing_order.push_back(key);
        Some(out)
    }

    /// Drop a directory listing (and optionally trust only until next fill).
    pub fn invalidate_listing(&self, drive_id: &str, rel: &str) {
        let key = listing_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.listings.remove(&key);
        g.listing_order.retain(|k| k != &key);
    }

    pub fn invalidate_listing_tree(&self, drive_id: &str, rel: &str) {
        let parent = parent_rel(rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.listings.retain(|k, _| {
            let Some(rest) = k.strip_prefix(&format!("{drive_id}\0")) else {
                return true;
            };
            if rest == parent || rest == rel {
                return false;
            }
            if rel.is_empty() {
                return false;
            }
            !rest.starts_with(&format!("{rel}/"))
        });
        let keep: std::collections::HashSet<String> = g.listings.keys().cloned().collect();
        g.listing_order.retain(|k| keep.contains(k));
    }

    /// Accept a small complete file into the dirty map. Returns Err when the
    /// budget cannot hold it (caller should stream to USB instead).
    pub fn accept_dirty(
        &self,
        drive_id: &str,
        rel: &str,
        name: &str,
        bytes: Vec<u8>,
        overwrite: bool,
    ) -> Result<(), String> {
        let budget = Self::budget();
        let len = bytes.len() as u64;
        if len == 0 || len > budget.dirty_max_file_bytes {
            return Err(
                "This file is too large to hold in memory while saving. Luna will write it straight to the drive."
                    .into(),
            );
        }
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.closing.contains(drive_id) {
            return Err("This drive is being ejected.".into());
        }
        if g.dirty
            .get(&dirty_key(drive_id, rel))
            .is_some_and(|d| d.state == DirtyState::Flushing)
        {
            // Replacing a buffer mid-write would let the older bytes land
            // last; the caller writes straight to the drive instead.
            return Err("An earlier save of this file is still finishing.".into());
        }
        let additional = if let Some(old) = g.dirty.get(&dirty_key(drive_id, rel)) {
            len.saturating_sub(old.bytes.len() as u64)
        } else {
            len
        };
        if g.dirty_bytes.saturating_add(additional) > budget.dirty_bytes {
            return Err(
                "Luna is low on memory. Wait a moment and try saving again, or free some space by closing other apps."
                    .into(),
            );
        }
        let key = dirty_key(drive_id, rel);
        if let Some(old) = g.dirty.remove(&key) {
            g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
        }
        g.dirty_bytes += len;
        g.failed.remove(&key);
        g.dirty.insert(
            key,
            DirtyFile {
                bytes: Arc::from(bytes.into_boxed_slice()),
                modified: now_unix(),
                state: DirtyState::Writing,
                name: name.to_string(),
                overwrite,
                cancelled: false,
            },
        );
        // Parent listing must show the new file immediately.
        let parent = parent_rel(rel);
        if let Some(listing) = g.listings.get_mut(&listing_key(drive_id, &parent)) {
            let entry = FileEntry {
                name: name.to_string(),
                kind: "file".into(),
                size: len,
                modified: now_unix(),
                hidden: name.starts_with('.'),
                saving: true,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                home: false,
            };
            if let Some(existing) = listing.entries.iter_mut().find(|e| e.name == name) {
                *existing = entry;
            } else {
                listing.entries.push(entry);
                listing.entries.sort_by(|a, b| {
                    let a_dir = a.kind == "dir";
                    let b_dir = b.kind == "dir";
                    b_dir
                        .cmp(&a_dir)
                        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
            }
            listing.filled_at = Instant::now();
        } else {
            // Force next list_dir to refresh and then overlay dirty.
            g.listings.remove(&listing_key(drive_id, &parent));
        }
        Ok(())
    }

    pub fn get_dirty(&self, drive_id: &str, rel: &str) -> Option<DirtyFile> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.dirty
            .get(&dirty_key(drive_id, rel))
            .filter(|d| !d.cancelled)
            .cloned()
    }

    pub fn dirty_saving(&self, drive_id: &str, rel: &str) -> bool {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.dirty
            .get(&dirty_key(drive_id, rel))
            .is_some_and(|d| d.state != DirtyState::Durable)
    }

    /// Remove the landed buffer and clear the listing's saving flag.
    fn finish_durable(g: &mut Inner, drive_id: &str, rel: &str) {
        if let Some(old) = g.dirty.remove(&dirty_key(drive_id, rel)) {
            g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
        }
        let parent = parent_rel(rel);
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if let Some(listing) = g.listings.get_mut(&listing_key(drive_id, &parent))
            && let Some(e) = listing.entries.iter_mut().find(|e| e.name == name)
        {
            e.saving = false;
        }
    }

    /// Drop a buffer the user deleted. A flush already in flight is told to
    /// discard its write rather than land the file after the delete.
    pub fn remove_dirty(&self, drive_id: &str, rel: &str) {
        let key = dirty_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.failed.remove(&key);
        match g.dirty.get_mut(&key) {
            Some(d) if d.state == DirtyState::Flushing => d.cancelled = true,
            Some(_) => {
                if let Some(old) = g.dirty.remove(&key) {
                    g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
                }
            }
            None => {}
        }
    }

    /// A buffer that couldn't reach the drive: free its bytes and remember it
    /// as a failed save so the folder listing says so.
    pub fn mark_failed(&self, drive_id: &str, rel: &str) {
        let key = dirty_key(drive_id, rel);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::fail_locked(&mut g, &key);
        g.listings.remove(&listing_key(drive_id, &parent_rel(rel)));
        drop(g);
        self.settled.notify_all();
    }

    fn fail_locked(g: &mut Inner, key: &str) {
        let Some(old) = g.dirty.remove(key) else {
            return;
        };
        g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
        if old.cancelled {
            return;
        }
        if g.failed.len() >= MAX_FAILED_SAVES
            && let Some(oldest) = g
                .failed
                .iter()
                .min_by_key(|(_, f)| f.at)
                .map(|(k, _)| k.clone())
        {
            g.failed.remove(&oldest);
        }
        g.failed.insert(
            key.to_string(),
            FailedSave {
                name: old.name,
                at: Instant::now(),
                modified: old.modified,
            },
        );
    }

    /// True when this path's last RAM-buffered save never reached the drive.
    pub fn save_failed(&self, drive_id: &str, rel: &str) -> bool {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.failed
            .get(&dirty_key(drive_id, rel))
            .is_some_and(|f| f.at.elapsed() < FAILED_SAVE_TTL)
    }

    /// Refuse new dirty accepts for a drive that is being ejected or removed.
    pub fn begin_close(&self, drive_id: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.closing.insert(drive_id.to_string());
    }

    pub fn end_close(&self, drive_id: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.closing.remove(drive_id);
    }

    /// Overlay dirty in-flight files onto a directory listing.
    pub fn overlay_dirty_listing(&self, drive_id: &str, rel: &str, entries: &mut Vec<FileEntry>) {
        let prefix = if rel.is_empty() {
            format!("{drive_id}\0")
        } else {
            format!("{drive_id}\0{rel}/")
        };
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for (key, dirty) in &g.dirty {
            let Some(rest) = key.strip_prefix(&format!("{drive_id}\0")) else {
                continue;
            };
            let parent = parent_rel(rest);
            if parent != rel {
                continue;
            }
            let _ = prefix;
            let entry = FileEntry {
                name: dirty.name.clone(),
                kind: "file".into(),
                size: dirty.bytes.len() as u64,
                modified: dirty.modified,
                hidden: dirty.name.starts_with('.'),
                saving: dirty.state != DirtyState::Durable,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                home: false,
            };
            if let Some(existing) = entries.iter_mut().find(|e| e.name == dirty.name) {
                *existing = entry;
            } else {
                entries.push(entry);
            }
        }
        for (key, failed) in &g.failed {
            let Some(rest) = key.strip_prefix(&format!("{drive_id}\0")) else {
                continue;
            };
            if parent_rel(rest) != rel || failed.at.elapsed() >= FAILED_SAVE_TTL {
                continue;
            }
            // A failed overwrite leaves the older file on the drive: flag
            // that row. A failed new file gets a placeholder row.
            if let Some(existing) = entries.iter_mut().find(|e| e.name == failed.name) {
                existing.save_failed = true;
            } else {
                entries.push(FileEntry {
                    name: failed.name.clone(),
                    kind: "file".into(),
                    size: 0,
                    modified: failed.modified,
                    hidden: failed.name.starts_with('.'),
                    saving: false,
                    save_failed: true,
                    original_name: None,
                    original_path: None,
                    link_target: None,
                    caps: String::new(),
                    home: false,
                });
            }
        }
        entries.sort_by(|a, b| {
            let a_dir = a.kind == "dir";
            let b_dir = b.kind == "dir";
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }

    pub fn drop_drive(&self, drive_id: &str) {
        let prefix = format!("{drive_id}\0");
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut freed_thumbs = 0u64;
        g.thumbs.retain(|k, v| {
            if k.starts_with(&prefix) {
                freed_thumbs = freed_thumbs.saturating_add(v.bytes.len() as u64);
                false
            } else {
                true
            }
        });
        g.thumb_bytes = g.thumb_bytes.saturating_sub(freed_thumbs);
        let keep_thumbs: std::collections::HashSet<String> = g.thumbs.keys().cloned().collect();
        g.thumb_order.retain(|k| keep_thumbs.contains(k));
        g.listings.retain(|k, _| !k.starts_with(&prefix));
        let keep_listings: std::collections::HashSet<String> = g.listings.keys().cloned().collect();
        g.listing_order.retain(|k| keep_listings.contains(k));
        // Anything still buffered never reached the drive (it was unplugged,
        // or a flush failed): remember it as a failed save, don't drop it.
        let unsaved: Vec<String> = g
            .dirty
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in unsaved {
            Self::fail_locked(&mut g, &key);
        }
        drop(g);
        self.settled.notify_all();
    }

    /// Relative paths of in-flight dirty files for one drive (any state).
    pub fn dirty_rels_for_drive(&self, drive_id: &str) -> Vec<String> {
        let prefix = format!("{drive_id}\0");
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.dirty
            .keys()
            .filter_map(|k| k.strip_prefix(&prefix).map(|s| s.to_string()))
            .collect()
    }

    /// Flush every dirty file for `drive_id` to `mount` before eject/unmount,
    /// waiting for writes other callers already started.
    ///
    /// Call this while the mount is still available (and after
    /// [`Self::begin_close`], so nothing new arrives). Returns the first error
    /// after attempting every entry so callers can refuse eject if anything
    /// failed to land on disk.
    pub fn flush_drive_dirty(&self, drive_id: &str, mount: &Path) -> Result<(), FilesError> {
        let rels = self.dirty_rels_for_drive(drive_id);
        let mut first_err: Option<FilesError> = None;
        for rel in rels {
            if let Err(e) = self.flush_dirty_to_disk(drive_id, &rel, mount)
                && first_err.is_none()
            {
                first_err = Some(e);
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Flush one dirty file to USB (temp + fsync + rename).
    ///
    /// `Ok(true)`: this call landed it. `Ok(false)`: nothing left to write —
    /// another caller landed it, it was deleted, or it had already failed.
    /// On `Err` the buffer stays, ready for another attempt.
    pub fn flush_dirty_to_disk(
        &self,
        drive_id: &str,
        rel: &str,
        mount: &Path,
    ) -> Result<bool, FilesError> {
        let key = dirty_key(drive_id, rel);
        let (bytes, overwrite) = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                match g.dirty.get_mut(&key) {
                    None => return Ok(false),
                    Some(d) if d.state == DirtyState::Flushing => {
                        g = self.settled.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                    Some(d) if d.state == DirtyState::Durable => return Ok(false),
                    Some(d) => {
                        d.state = DirtyState::Flushing;
                        break (d.bytes.clone(), d.overwrite);
                    }
                }
            }
        };
        let result = self.write_claimed(&key, rel, mount, &bytes, overwrite);
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let landed = match &result {
            Ok(true) => {
                Self::finish_durable(&mut g, drive_id, rel);
                true
            }
            Ok(false) => {
                // Cancelled by a delete while we wrote the temp.
                if let Some(old) = g.dirty.remove(&key) {
                    g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
                }
                false
            }
            Err(_) => {
                if let Some(d) = g.dirty.get_mut(&key) {
                    d.state = DirtyState::Writing;
                }
                false
            }
        };
        drop(g);
        self.settled.notify_all();
        result?;
        if !landed {
            return Ok(false);
        }
        self.invalidate_listing(drive_id, &parent_rel(rel));
        // The landing bumps the parent dir's mtime, but the index compares
        // stamps — a landing inside the filesystem's timestamp granularity
        // leaves the indexed snapshot "fresh" while it lacks this file.
        // Forget the row outright so the next listing re-reads the dir.
        if let Ok(dconn) = crate::drives::drive_db::open(mount) {
            let real = crate::files::real_rel(mount, rel);
            let parent = real.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            let _ = crate::files::index::forget_dir(&dconn, drive_id, parent);
            let _ = crate::files::index::forget_dir_tree(&dconn, drive_id, &real);
        }
        Ok(true)
    }

    /// Write a claimed buffer. `Ok(false)` when a delete cancelled it first.
    fn write_claimed(
        &self,
        key: &str,
        rel: &str,
        mount: &Path,
        bytes: &[u8],
        overwrite: bool,
    ) -> Result<bool, FilesError> {
        let dest =
            luna_core::path::resolve_for_create_nofollow(mount, rel).map_err(FilesError::Path)?;
        let dir = dest.parent().unwrap_or(mount);
        // Checks the drive's marker first: after an unmount the mount point
        // is an empty folder on Luna's own disk, and nothing may be created
        // there — not even the parent folders.
        let temp = files::temp_path_at(mount, dir)?;
        std::fs::create_dir_all(dir).map_err(FilesError::Io)?;
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(FilesError::Io)?;
            let written = f
                .write_all(bytes)
                .and_then(|()| f.flush())
                .and_then(|()| f.sync_all());
            if let Err(e) = written {
                drop(f);
                let _ = std::fs::remove_file(&temp);
                return Err(FilesError::Io(e));
            }
        }
        let cancelled = {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.dirty.get(key).is_none_or(|d| d.cancelled)
        };
        if cancelled {
            let _ = std::fs::remove_file(&temp);
            return Ok(false);
        }
        if let Err(e) = files::install_temp(&temp, &dest, overwrite) {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        Ok(true)
    }

    /// Under pressure: drop thumbs, then listings. Dirty: flush using the
    /// provided mount resolver, or leave in place (never drop).
    pub fn reclaim_for_pressure<F>(&self, resolve_mount: F)
    where
        F: Fn(&str) -> Option<PathBuf>,
    {
        let m = budget::meminfo();
        let budget = budget::cache_budget_from(m.available_bytes);
        // When available RAM is below ~256 MiB, shrink aggressively.
        let pressure = m.available_bytes < 256 * MIB;
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        let thumb_target = if pressure {
            budget.thumb_bytes / 4
        } else {
            budget.thumb_bytes
        };
        while g.thumb_bytes > thumb_target {
            if !Self::evict_one_thumb(&mut g) {
                break;
            }
        }

        let listing_cap = if pressure { 64 } else { 4096 };
        while g.listings.len() > listing_cap {
            if !Self::evict_one_listing(&mut g) {
                break;
            }
        }

        // Snapshot dirty keys to flush outside the lock when possible.
        let dirty_keys: Vec<(String, String)> = g
            .dirty
            .iter()
            .filter(|(_, d)| d.state == DirtyState::Writing)
            .filter_map(|(k, _)| {
                let mut parts = k.splitn(2, '\0');
                let drive = parts.next()?.to_string();
                let rel = parts.next()?.to_string();
                Some((drive, rel))
            })
            .collect();
        drop(g);

        if !pressure {
            return;
        }
        for (drive_id, rel) in dirty_keys {
            let Some(mount) = resolve_mount(&drive_id) else {
                continue;
            };
            let _ = self.flush_dirty_to_disk(&drive_id, &rel, &mount);
        }
    }

    fn evict_one_thumb(g: &mut Inner) -> bool {
        let Some(key) = g.thumb_order.pop_front() else {
            return false;
        };
        if let Some(old) = g.thumbs.remove(&key) {
            g.thumb_bytes = g.thumb_bytes.saturating_sub(old.bytes.len() as u64);
            true
        } else {
            !g.thumb_order.is_empty()
        }
    }

    fn evict_one_listing(g: &mut Inner) -> bool {
        let Some(key) = g.listing_order.pop_front() else {
            return false;
        };
        g.listings.remove(&key);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn thumb_round_trip_and_lru_evict() {
        let cache = RamCache::new();
        // Force small budget by putting many large-ish thumbs; eviction is
        // relative to live MemAvailable — put one and get it back.
        cache.put_thumb("d1", "a.jpg", b"jpeg-a".to_vec(), 10);
        let hit = cache.get_thumb("d1", "a.jpg").unwrap();
        assert_eq!(&hit.bytes[..], b"jpeg-a");
        assert_eq!(hit.etag, thumb_etag(6, 10));
        cache.invalidate_thumb("d1", "a.jpg");
        assert!(cache.get_thumb("d1", "a.jpg").is_none());
    }

    #[test]
    fn listing_ttl_and_mtime() {
        let cache = RamCache::new();
        let entries = vec![FileEntry {
            name: "x".into(),
            kind: "file".into(),
            size: 1,
            modified: 1,
            hidden: false,
            saving: false,
            save_failed: false,
            original_name: None,
            original_path: None,
            link_target: None,
            caps: String::new(),
            home: false,
        }];
        cache.put_listing("d1", "", 100, entries.clone());
        assert_eq!(cache.get_listing("d1", "", Some(100)).unwrap().len(), 1);
        assert!(cache.get_listing("d1", "", Some(99)).is_some()); // TTL still fresh
        cache.invalidate_listing("d1", "");
        assert!(cache.get_listing("d1", "", Some(100)).is_none());
    }

    #[test]
    fn dirty_accept_read_flush() {
        let dir = tempfile::tempdir().unwrap();
        crate::drives::drive_db::create(
            dir.path(),
            &luna_core::marker::Marker::new("d1", "Test"),
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "note.txt", "note.txt", b"hello".to_vec(), false)
            .unwrap();
        let d = cache.get_dirty("d1", "note.txt").unwrap();
        assert_eq!(&d.bytes[..], b"hello");
        assert!(cache.dirty_saving("d1", "note.txt"));
        cache
            .flush_dirty_to_disk("d1", "note.txt", dir.path())
            .unwrap();
        assert!(!cache.dirty_saving("d1", "note.txt"));
        assert_eq!(
            std::fs::read(dir.path().join("note.txt")).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn dirty_rejects_oversize() {
        let cache = RamCache::new();
        let big = vec![0u8; (64 * MIB + 1) as usize];
        assert!(
            cache
                .accept_dirty("d1", "big.bin", "big.bin", big, false)
                .is_err()
        );
    }

    #[test]
    fn drop_drive_clears_all() {
        let cache = RamCache::new();
        cache.put_thumb("d1", "a.jpg", b"x".to_vec(), 1);
        cache.put_listing(
            "d1",
            "",
            1,
            vec![FileEntry {
                name: "a".into(),
                kind: "file".into(),
                size: 1,
                modified: 1,
                hidden: false,
                saving: false,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                home: false,
            }],
        );
        cache
            .accept_dirty("d1", "a", "a", b"z".to_vec(), false)
            .unwrap();
        cache.drop_drive("d1");
        assert!(cache.get_thumb("d1", "a.jpg").is_none());
        assert!(cache.get_listing("d1", "", Some(1)).is_none());
        assert!(cache.get_dirty("d1", "a").is_none());
        assert!(
            cache.save_failed("d1", "a"),
            "a buffer that never reached the drive is remembered, not dropped"
        );
        let _ = AtomicU64::new(0).load(Ordering::Relaxed);
    }

    #[test]
    fn flush_drive_dirty_before_drop_keeps_bytes() {
        let dir = tempfile::tempdir().unwrap();
        crate::drives::drive_db::create(
            dir.path(),
            &luna_core::marker::Marker::new("d1", "Test"),
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "keep.txt", "keep.txt", b"persist".to_vec(), false)
            .unwrap();
        cache.flush_drive_dirty("d1", dir.path()).unwrap();
        assert!(cache.get_dirty("d1", "keep.txt").is_none());
        assert_eq!(
            std::fs::read(dir.path().join("keep.txt")).unwrap(),
            b"persist"
        );
        cache.drop_drive("d1");
        assert_eq!(
            std::fs::read(dir.path().join("keep.txt")).unwrap(),
            b"persist"
        );
    }

    fn adopted_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::drives::drive_db::create(
            dir.path(),
            &luna_core::marker::Marker::new("d1", "Test"),
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn closing_drive_refuses_new_buffers_until_reopened() {
        let cache = RamCache::new();
        cache.begin_close("d1");
        assert!(
            cache
                .accept_dirty("d1", "a.txt", "a.txt", b"x".to_vec(), false)
                .is_err()
        );
        assert!(
            cache
                .accept_dirty("d2", "a.txt", "a.txt", b"x".to_vec(), false)
                .is_ok(),
            "other drives keep buffering"
        );
        cache.end_close("d1");
        assert!(
            cache
                .accept_dirty("d1", "a.txt", "a.txt", b"x".to_vec(), false)
                .is_ok()
        );
    }

    #[test]
    fn eject_flush_waits_for_a_write_already_in_flight() {
        let dir = adopted_dir();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "late.txt", "late.txt", b"late".to_vec(), false)
            .unwrap();
        // Another writer (the upload's background task) holds the claim.
        {
            let mut g = cache.inner.lock().unwrap();
            g.dirty.get_mut(&dirty_key("d1", "late.txt")).unwrap().state = DirtyState::Flushing;
        }
        let (c2, mount) = (cache.clone(), dir.path().to_path_buf());
        let eject = std::thread::spawn(move || c2.flush_drive_dirty("d1", &mount));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!eject.is_finished(), "eject must wait, not skip the file");
        // The other writer gives up (a failed attempt); eject lands it.
        {
            let mut g = cache.inner.lock().unwrap();
            g.dirty.get_mut(&dirty_key("d1", "late.txt")).unwrap().state = DirtyState::Writing;
        }
        cache.settled.notify_all();
        eject.join().unwrap().unwrap();
        assert_eq!(std::fs::read(dir.path().join("late.txt")).unwrap(), b"late");
        assert!(cache.get_dirty("d1", "late.txt").is_none());
    }

    #[test]
    fn second_flusher_reports_nothing_left() {
        let dir = adopted_dir();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "n.txt", "n.txt", b"1".to_vec(), false)
            .unwrap();
        assert!(
            cache
                .flush_dirty_to_disk("d1", "n.txt", dir.path())
                .unwrap()
        );
        assert!(
            !cache
                .flush_dirty_to_disk("d1", "n.txt", dir.path())
                .unwrap()
        );
    }

    #[test]
    fn every_flusher_honors_no_overwrite() {
        let dir = adopted_dir();
        std::fs::write(dir.path().join("keep.txt"), b"original").unwrap();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "keep.txt", "keep.txt", b"new".to_vec(), false)
            .unwrap();
        assert!(cache.flush_drive_dirty("d1", dir.path()).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("keep.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn delete_during_flush_discards_the_write() {
        let dir = adopted_dir();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "gone.txt", "gone.txt", b"x".to_vec(), false)
            .unwrap();
        let key = dirty_key("d1", "gone.txt");
        {
            let mut g = cache.inner.lock().unwrap();
            g.dirty.get_mut(&key).unwrap().state = DirtyState::Flushing;
        }
        cache.remove_dirty("d1", "gone.txt");
        assert!(cache.get_dirty("d1", "gone.txt").is_none());
        let landed = cache
            .write_claimed(&key, "gone.txt", dir.path(), b"x", false)
            .unwrap();
        assert!(!landed);
        assert!(!dir.path().join("gone.txt").exists());
    }

    #[test]
    fn unmounted_drive_gets_no_stray_folders() {
        // After unmount the mount point is an empty folder on Luna's own disk.
        let empty = tempfile::tempdir().unwrap();
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "a/b/c.txt", "c.txt", b"x".to_vec(), false)
            .unwrap();
        assert!(
            cache
                .flush_dirty_to_disk("d1", "a/b/c.txt", empty.path())
                .is_err()
        );
        assert!(!empty.path().join("a").exists());
        assert!(
            cache.get_dirty("d1", "a/b/c.txt").is_some(),
            "kept for a retry"
        );
    }

    #[test]
    fn failed_save_shows_in_its_folder() {
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "docs/new.txt", "new.txt", b"1".to_vec(), false)
            .unwrap();
        cache.mark_failed("d1", "docs/new.txt");
        assert!(cache.get_dirty("d1", "docs/new.txt").is_none());
        let mut entries = vec![];
        cache.overlay_dirty_listing("d1", "docs", &mut entries);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].save_failed && !entries[0].saving);

        // Uploading it again clears the failure.
        cache
            .accept_dirty("d1", "docs/new.txt", "new.txt", b"1".to_vec(), false)
            .unwrap();
        assert!(!cache.save_failed("d1", "docs/new.txt"));
    }

    #[test]
    fn overlay_marks_saving() {
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "n.txt", "n.txt", b"1".to_vec(), false)
            .unwrap();
        let mut entries = vec![];
        cache.overlay_dirty_listing("d1", "", &mut entries);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].saving);
    }
}
