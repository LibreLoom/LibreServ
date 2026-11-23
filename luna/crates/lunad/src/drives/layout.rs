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

impl Layout {
    /// Detect this drive's prefix from its `.luna-<uuid>.sqlite3` marker.
    /// `None` when the drive is not adopted.
    pub fn detect(root: &Path) -> Option<Self> {
        let cache = DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

        // Read and release before touching the filesystem. A USB drive may be
        // slow or may vanish mid-scan; holding a global lock across read_dir
        // would stall every other drive's detect behind it.
        {
            let cache = cache.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((at, prefix, marker)) = cache.get(root) {
                if at.elapsed() < DETECT_TTL && marker.is_file() {
                    return Some(Self::from_prefix(prefix.clone()));
                }
            }
        }

        let found = crate::drives::drive_db::prefix_for(root).map(Self::from_prefix);
        if let Some(layout) = &found {
            let marker = root.join(format!("{}.sqlite3", layout.prefix));
            let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
            // Ejected drives must not leave entries behind forever.
            if cache.len() > 64 {
                cache.retain(|_, (_, _, marker)| marker.is_file());
            }
            cache.insert(
                root.to_path_buf(),
                (Instant::now(), layout.prefix.clone(), marker),
            );
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
