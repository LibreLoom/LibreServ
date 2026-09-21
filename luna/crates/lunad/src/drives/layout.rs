//! Per-drive name layout: every file and directory Luna creates on an
//! adopted drive lives under one `.luna-<uuid>` prefix chosen at adoption
//! time so it can never collide with files already on the drive.
//!
//! | name                          | contents                          |
//! |-------------------------------|-----------------------------------|
//! | `{p}.sqlite3`                 | marker + microdb (drive_db)       |
//! | `{p}-trash/`                  | deleted files                     |
//! | `{p}-thumbs/`                 | gallery thumbnails                |
//! | `{p}-shared-albums/`          | shared album image copies         |
//! | `{p}-protected/`              | protected copies                  |
//! | `{p}-upload.<id>.part`        | in-flight uploads                 |
//! | `{p}.tmp.<pid>.<nonce>`       | marker temp files                 |
//!
//! `Layout::detect` recovers the prefix from the marker file, so no prefix
//! has to be threaded through call sites or stored in `luna.db`.

use std::path::{Path, PathBuf};

/// `.luna-<uuid>` namespaced layout for one adopted drive.
#[derive(Debug, Clone)]
pub struct Layout {
    prefix: String,
}

impl Layout {
    /// Detect this drive's prefix from its `.luna-<uuid>.sqlite3` marker.
    /// `None` when the drive is not adopted.
    pub fn detect(root: &Path) -> Option<Self> {
        crate::drives::drive_db::prefix_for(root).map(Self::from_prefix)
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

    /// Gallery thumbnails directory name.
    pub fn thumbs_name(&self) -> String {
        format!("{}-thumbs", self.prefix)
    }

    /// Shared album copies directory name.
    pub fn shared_albums_name(&self) -> String {
        format!("{}-shared-albums", self.prefix)
    }

    /// Protected copies directory name.
    pub fn protected_name(&self) -> String {
        format!("{}-protected", self.prefix)
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

    pub fn protected_dir(&self, root: &Path) -> PathBuf {
        root.join(self.protected_name())
    }

    /// Is `name` (a single path segment, or basename of a rel path) inside
    /// *any* drive's Luna namespace? Generic on the UUID — the exact prefix
    /// is never needed to hide or reject Luna's own files.
    pub fn is_luna_name(name: &str) -> bool {
        luna_core::marker::extract_prefix(name).is_some()
    }
}
