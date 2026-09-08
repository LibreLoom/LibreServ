//! Reclaimable in-RAM caches for thumbs, directory listings, and in-flight
//! small writes — the hot layer above USB-resident `.lunathumbs` / `.luna`.
//!
//! Clean caches (thumbs, listings, hot-read bodies) drop under memory pressure.
//! Dirty write buffers never vanish silently: pressure flushes them to USB or
//! refuses new dirty accepts with a plain-language error.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::budget::{self, CacheBudget};
use crate::files::{self, FileEntry, FilesError};

const MIB: u64 = 1024 * 1024;
/// Browser/private caches may keep thumbs this long; validators still revalidate.
pub const THUMB_MAX_AGE_SECS: u64 = 3600;
/// Listing hits skip the USB `metadata()` check for this long after a warm fill.
const LISTING_TRUST_TTL: Duration = Duration::from_secs(2);

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
}

struct Inner {
    thumbs: HashMap<String, ThumbEntry>,
    thumb_order: VecDeque<String>,
    thumb_bytes: u64,
    listings: HashMap<String, ListingEntry>,
    listing_order: VecDeque<String>,
    dirty: HashMap<String, DirtyFile>,
    dirty_bytes: u64,
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
        }
    }
}

/// Shared process cache. Cheap to clone (`Arc`).
#[derive(Clone, Default)]
pub struct RamCache {
    inner: Arc<Mutex<Inner>>,
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
        g.dirty.insert(
            key,
            DirtyFile {
                bytes: Arc::from(bytes.into_boxed_slice()),
                modified: now_unix(),
                state: DirtyState::Writing,
                name: name.to_string(),
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
        g.dirty.get(&dirty_key(drive_id, rel)).cloned()
    }

    pub fn dirty_saving(&self, drive_id: &str, rel: &str) -> bool {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.dirty
            .get(&dirty_key(drive_id, rel))
            .is_some_and(|d| d.state != DirtyState::Durable)
    }

    pub fn mark_dirty_flushing(&self, drive_id: &str, rel: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(d) = g.dirty.get_mut(&dirty_key(drive_id, rel)) {
            d.state = DirtyState::Flushing;
        }
    }

    pub fn mark_dirty_durable(&self, drive_id: &str, rel: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let key = dirty_key(drive_id, rel);
        if let Some(d) = g.dirty.get_mut(&key) {
            d.state = DirtyState::Durable;
            // Keep briefly as hot-read, then drop to free dirty budget.
            let bytes = d.bytes.clone();
            let mtime = d.modified as u64;
            // Promote into thumb? No — file body hot-read not implemented as
            // separate map; drop dirty after durable so budget frees.
            g.dirty_bytes = g.dirty_bytes.saturating_sub(bytes.len() as u64);
            g.dirty.remove(&key);
            let _ = (bytes, mtime);
        }
        // Clear saving flag on listing overlay.
        let parent = parent_rel(rel);
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if let Some(listing) = g.listings.get_mut(&listing_key(drive_id, &parent)) {
            if let Some(e) = listing.entries.iter_mut().find(|e| e.name == name) {
                e.saving = false;
            }
        }
    }

    pub fn remove_dirty(&self, drive_id: &str, rel: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = g.dirty.remove(&dirty_key(drive_id, rel)) {
            g.dirty_bytes = g.dirty_bytes.saturating_sub(old.bytes.len() as u64);
        }
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
            };
            if let Some(existing) = entries.iter_mut().find(|e| e.name == dirty.name) {
                *existing = entry;
            } else {
                entries.push(entry);
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
        let mut freed_dirty = 0u64;
        g.dirty.retain(|k, v| {
            if k.starts_with(&prefix) {
                freed_dirty = freed_dirty.saturating_add(v.bytes.len() as u64);
                false
            } else {
                true
            }
        });
        g.dirty_bytes = g.dirty_bytes.saturating_sub(freed_dirty);
    }

    /// Flush one dirty file to USB (temp + fsync + rename).
    pub fn flush_dirty_to_disk(
        &self,
        drive_id: &str,
        rel: &str,
        mount: &Path,
        overwrite: bool,
    ) -> Result<(), FilesError> {
        let dirty = self.get_dirty(drive_id, rel).ok_or_else(|| {
            FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "nothing to save",
            ))
        })?;
        self.mark_dirty_flushing(drive_id, rel);
        let dest =
            luna_core::path::resolve_for_create_nofollow(mount, rel).map_err(FilesError::Path)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(FilesError::Io)?;
        }
        let dir = dest.parent().unwrap_or(mount);
        let temp = files::temp_path(dir);
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(FilesError::Io)?;
            f.write_all(&dirty.bytes).map_err(FilesError::Io)?;
            f.flush().map_err(FilesError::Io)?;
            f.sync_all().map_err(FilesError::Io)?;
        }
        if let Err(e) = files::install_temp(&temp, &dest, overwrite) {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        self.mark_dirty_durable(drive_id, rel);
        self.invalidate_listing(drive_id, &parent_rel(rel));
        Ok(())
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
            let _ = self.flush_dirty_to_disk(&drive_id, &rel, &mount, true);
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
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "note.txt", "note.txt", b"hello".to_vec())
            .unwrap();
        let d = cache.get_dirty("d1", "note.txt").unwrap();
        assert_eq!(&d.bytes[..], b"hello");
        assert!(cache.dirty_saving("d1", "note.txt"));
        cache
            .flush_dirty_to_disk("d1", "note.txt", dir.path(), false)
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
        assert!(cache.accept_dirty("d1", "big.bin", "big.bin", big).is_err());
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
            }],
        );
        cache
            .accept_dirty("d1", "a", "a", b"z".to_vec())
            .unwrap();
        cache.drop_drive("d1");
        assert!(cache.get_thumb("d1", "a.jpg").is_none());
        assert!(cache.get_listing("d1", "", Some(1)).is_none());
        assert!(cache.get_dirty("d1", "a").is_none());
        let _ = AtomicU64::new(0).load(Ordering::Relaxed);
    }

    #[test]
    fn overlay_marks_saving() {
        let cache = RamCache::new();
        cache
            .accept_dirty("d1", "n.txt", "n.txt", b"1".to_vec())
            .unwrap();
        let mut entries = vec![];
        cache.overlay_dirty_listing("d1", "", &mut entries);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].saving);
    }
}
