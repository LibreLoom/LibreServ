//! Which files a backup copies (plan §2 "What's included").
//!
//! Everything under the source, judged by path segments *below* the source
//! root: a segment inside any drive's `.luna-<uuid>` namespace is Luna's own
//! (trash, thumbs, upload parts, marker files, other backups, private items)
//! and is skipped, except a form's files folder, which travels with its form.

use std::path::{Path, PathBuf};

/// One regular file a backup should copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Path relative to the source root, `/`-joined, no leading slash. For a
    /// single-file source, the file's own name.
    pub rel: String,
    /// Absolute path on disk.
    pub abs: PathBuf,
    pub size: u64,
    /// Modification time, unix seconds.
    pub mtime: i64,
}

/// True when `segment` (one path component) is inside any drive's Luna
/// namespace (`luna_core::marker::extract_prefix`).
pub fn is_luna_segment(segment: &str) -> bool {
    let _ = segment;
    todo!("task A")
}

/// Every file to copy under `source` (an absolute, already resolved file or
/// directory). Never follows symlinks.
pub fn walk(source: &Path) -> std::io::Result<Vec<Entry>> {
    let _ = source;
    todo!("task A")
}
