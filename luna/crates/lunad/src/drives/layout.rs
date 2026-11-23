//! Per-drive name layout: every file and directory Luna creates on an
//! adopted drive lives under one `.luna-<uuid>` prefix chosen at adoption
//! time so it can never collide with files already on the drive.
//!
//! | name                            | contents                            |
//! | ------------------------------- | ----------------------------------- |
//! | `{p}.sqlite3`                   | marker + microdb (drive_db)         |
//! | `{p}-trash/`                    | deleted files                       |
//! | `{p}-thumbs/`                   | photos thumbnails                  |
//! | `{p}-shared-albums/`            | shared album image copies           |
//! | `{p}-backups/`                  | drive backups stored on this drive  |
//! | `{p}-upload.<id>.part`          | in-flight uploads                   |
//! | `{p}.tmp.<pid>.<nonce>`         | marker temp files                   |
//!
//! `Layout::detect` recovers the prefix from the marker file, so no prefix
//! has to be threaded through call sites or stored in `luna.db`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// `.luna-<uuid>` namespaced layout for one adopted drive.
#[derive(Debug, Clone)]
pub struct Layout {
    prefix: String,
}

/// Marker scans are cheap once, but photo scans resolve the thumb directory
/// for every image and every thumbnail request. A drive's prefix only changes
/// when it is adopted or reformatted, so remember it briefly and check the
/// marker file is still there on a cache hit. `None` is not cached: a drive
/// adopted just after a lookup must be seen on the next one.
const DETECT_TTL: Duration = Duration::from_secs(60);
static DETECT_CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, String, PathBuf)>>> =
    OnceLock::new();

/// Called wherever the drive manager forgets its own marker memo (adopt,
/// format, eject, remove, reconcile, inspect). That hook has no root argument,
/// so this clears every drive's cached prefix: inspecting one foreign drive
/// costs the other drives one `read_dir` on their next lookup. Broad but safe;
/// a per-root invalidation needs the root threaded through the manager hook.
pub fn forget_all_cached() {
    if let Some(cache) = DETECT_CACHE.get() {
        cache.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

impl Layout {
    /// Detect this drive's prefix from its `.luna-<uuid>.sqlite3` marker.
    /// `None` when the drive is not adopted.
    pub fn detect(root: &Path) -> Option<Self> {
        let cache_mutex = DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

        // Read and release before touching the filesystem. A USB drive may be
        // slow or may vanish mid-scan; holding a global lock across read_dir
        // (or even a stat) would stall every other drive's detect behind it.
        let cached = {
            let guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .get(root)
                .filter(|(at, _, _)| at.elapsed() < DETECT_TTL)
                .map(|(_, prefix, marker)| (prefix.clone(), marker.clone()))
        };
        if let Some((prefix, marker)) = cached {
            if marker.is_file() {
                return Some(Self::from_prefix(prefix));
            }
        }

        let found = crate::drives::drive_db::prefix_for(root).map(Self::from_prefix);

        // A fresh cache hit returns above; this is a size-capped backstop on
        // the miss path. The per-root removal below is what evicts an ejected
        // drive when prefix_for returns None. Collect under the lock, stat
        // outside it, then re-lock to remove.
        let sweep = {
            let guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
            if guard.len() > 64 {
                Some(
                    guard
                        .iter()
                        .map(|(key, (_, _, marker))| (key.clone(), marker.clone()))
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            }
        };
        if let Some(entries) = sweep {
            let gone = entries
                .into_iter()
                .filter_map(|(key, marker)| (!marker.is_file()).then_some(key))
                .collect::<Vec<_>>();
            if !gone.is_empty() {
                let mut guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
                for key in gone {
                    guard.remove(&key);
                }
            }
        }

        let mut guard = cache_mutex.lock().unwrap_or_else(|p| p.into_inner());
        match &found {
            Some(layout) => {
                let marker = root.join(format!("{}.sqlite3", layout.prefix));
                guard.insert(
                    root.to_path_buf(),
                    (Instant::now(), layout.prefix.clone(), marker),
                );
            }
            None => {
                guard.remove(root);
            }
        }
        found
    }

    pub fn from_prefix(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// Trash directory name at the drive root.
    pub fn trash_name(&self) -> String {
        format!("{}-trash", self.prefix)
    }

    /// Photos thumbnails directory name.
    pub fn thumbs_name(&self) -> String {
        format!("{}-thumbs", self.prefix)
    }

    /// Shared album copies directory name.
    pub fn shared_albums_name(&self) -> String {
        format!("{}-shared-albums", self.prefix)
    }

    /// Drive backups directory name.
    pub fn backups_name(&self) -> String {
        format!("{}-backups", self.prefix)
    }

    /// In-flight upload temp name for upload id `id`.
    pub fn upload_part_name(&self, id: &str) -> String {
        format!("{}-upload.{id}.part", self.prefix)
    }

    pub fn trash_dir(&self, root: &Path) -> PathBuf {
        root.join(self.trash_name())
    }

    pub fn thumbs_dir(&self, root: &Path) -> PathBuf {
        root.join(self.thumbs_name())
    }

    pub fn shared_albums_dir(&self, root: &Path) -> PathBuf {
        root.join(self.shared_albums_name())
    }

    pub fn backups_dir(&self, root: &Path) -> PathBuf {
        root.join(self.backups_name())
    }

    /// Is `name` (a single path segment, or basename of a rel path) inside
    /// *any* drive's Luna namespace? Generic on the UUID — the exact prefix
    /// is never needed to hide or reject Luna's own files.
    pub fn is_luna_name(name: &str) -> bool {
        luna_core::marker::is_namespace_name(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_hit_miss_and_vanished_marker() {
        let dir = std::env::temp_dir().join(format!(
            "luna-layout-detect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let prefix = ".luna-00000000-0000-0000-0000-000000000001";
        let marker = dir.join(format!("{prefix}.sqlite3"));

        // Not adopted yet.
        assert!(Layout::detect(&dir).is_none());
        std::fs::write(&marker, b"").unwrap();
        let found = Layout::detect(&dir).expect("marker should be detected");
        assert_eq!(found.prefix(), prefix);

        // The cached answer is used while the marker is still present.
        assert_eq!(Layout::detect(&dir).unwrap().prefix(), prefix);

        // A marker that disappears invalidates the cache immediately, even
        // inside the TTL, so an ejected drive is not treated as adopted.
        std::fs::remove_file(&marker).unwrap();
        assert!(Layout::detect(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod invalidation_tests {
    use super::*;

    #[test]
    fn detect_miss_drops_the_stale_entry() {
        let dir = std::env::temp_dir().join(format!(
            "luna-layout-miss-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join(".luna-00000000-0000-0000-0000-000000000002.sqlite3");
        std::fs::write(&marker, b"").unwrap();
        assert!(Layout::detect(&dir).is_some());

        std::fs::remove_file(&marker).unwrap();
        assert!(Layout::detect(&dir).is_none());
        let cache = DETECT_CACHE
            .get()
            .unwrap()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(
            !cache.contains_key(&dir),
            "ejected drive must be evicted on the miss path"
        );
        drop(cache);
        std::fs::remove_dir_all(&dir).ok();
    }
}
