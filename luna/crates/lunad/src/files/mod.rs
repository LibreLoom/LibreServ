//! File operations on adopted drives.
//!
//! Every path is resolved through the canonicalizing path jail from
//! `luna-core`; `..`, absolute paths, and symlink escapes are impossible.
//! Writes are temp-file + fsync + atomic-rename so a power cut can never
//! leave a half-written user file.

use std::path::{Path, PathBuf};

use luna_core::path::resolve_child;
use serde::Serialize;

use crate::db::{self, DriveRow};

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct FileEntry {
    pub name: String,
    pub kind: String, // "dir" | "file" | "symlink" | "other"
    pub size: u64,
    pub modified: i64,
    pub hidden: bool,
    /// True while Luna still holds this file in RAM and has not finished
    /// writing it to the drive. UI may show "Saving…".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub saving: bool,
}

/// How many items sit directly inside a folder — folders, files, anything else.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
pub struct ChildCounts {
    pub dirs: u64,
    pub files: u64,
    pub other: u64,
}

/// Recursive totals for a folder: content bytes of real files plus full
/// descendant counts. Built by [`folder_totals`] (filesystem walk) or
/// `index::folder_totals_indexed` (index fast path); both count only what
/// the requester may read.
#[derive(Debug, Default, Serialize, PartialEq, Eq, Clone, Copy)]
pub struct FolderTotals {
    pub bytes: u64,
    pub dirs: u64,
    pub files: u64,
    pub other: u64,
    /// False when the count stopped at a safety bound — every figure is
    /// then a lower bound ("at least"), not a final total.
    pub complete: bool,
}

/// Rich metadata for one path — powers the Properties panel, which has room
/// for far more than a list row can show.
#[derive(Debug, Serialize, PartialEq, Clone)]
pub struct FileStat {
    pub name: String,
    pub kind: String, // "dir" | "file" | "symlink" | "other"
    pub size: u64,
    pub modified: i64,
    /// Creation time — not every filesystem tracks it (FAT32 doesn't).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    pub hidden: bool,
    /// Stored target when `kind == "symlink"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// Direct children — only filled for folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<ChildCounts>,
    /// True while Luna still holds this file in RAM and has not finished
    /// writing it to the drive.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub saving: bool,
    /// Can the requesting user change (rename/move/delete) this item.
    pub writable: bool,
    /// Original drive-relative path for items sitting in `.luna-trash`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_from: Option<String>,
    /// Recursive size + counts for folders — `None` when the tree was too
    /// large to count quickly, or for non-folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals: Option<FolderTotals>,
}

/// One row in the drive's trash dir, with the path it came from when metadata
/// exists.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TrashEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    /// Drive-relative path before the item was trashed (empty when unknown).
    pub original_path: String,
}

/// Stable API-facing alias for the drive's real `.luna-<uuid>-trash`
/// directory — responses and requests use `.luna-trash` so the on-disk
/// prefix never leaks into the web API contract.
pub const TRASH_API_ALIAS: &str = ".luna-trash";

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error(
        "Luna doesn't know this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
    )]
    UnknownDrive,
    #[error("{0}")]
    Path(luna_core::path::PathError),
    #[error("{0}")]
    Io(#[source] std::io::Error),
    #[error("{0}")]
    Db(#[source] anyhow::Error),
}

impl From<luna_core::path::PathError> for FilesError {
    fn from(e: luna_core::path::PathError) -> Self {
        FilesError::Path(e)
    }
}

pub fn drive_root(conn: &rusqlite::Connection, drive_id: &str) -> Result<DriveRow, FilesError> {
    db::get_drive(conn, drive_id)
        .map_err(FilesError::Db)?
        .filter(|d| !d.mount_point.is_empty())
        .ok_or(FilesError::UnknownDrive)
}

pub(crate) fn open_drive_db(drive: &DriveRow) -> Result<rusqlite::Connection, FilesError> {
    crate::drives::drive_db::open(std::path::Path::new(&drive.mount_point)).map_err(FilesError::Db)
}

/// List one directory. Directories first, then case-insensitive by name.
///
/// Serves from the in-RAM listing cache when trusted, else the SQLite index
/// whenever the directory mtime matches; any change (Luna, WebDAV, or direct
/// access) falls back to one fresh read_dir. Dirty in-flight writes are
/// overlaid so Files sees saves immediately.
pub fn list_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<Vec<FileEntry>, FilesError> {
    list_dir_with_cache(conn, drive_id, rel, None)
}

/// Like [`list_dir`], optionally using the process RAM cache.
pub fn list_dir_with_cache(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    cache: Option<&crate::drives::ram_cache::RamCache>,
) -> Result<Vec<FileEntry>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let dir = resolve_child(&root, rel.as_ref())?;
    if !dir.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "not a directory",
        )));
    }

    // Hot path: trust a very recent RAM listing without touching USB mtime.
    if let Some(cache) = cache
        && let Some(mut entries) = cache.get_listing(drive_id, &rel, None)
    {
        cache.overlay_dirty_listing(drive_id, &rel, &mut entries);
        return Ok(entries);
    }

    let meta = std::fs::metadata(&dir).map_err(FilesError::Io)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    if let Some(cache) = cache
        && let Some(mut entries) = cache.get_listing(drive_id, &rel, Some(mtime))
    {
        cache.overlay_dirty_listing(drive_id, &rel, &mut entries);
        return Ok(entries);
    }

    let drive_conn = open_drive_db(&drive)?;
    let mut entries = if let Some(entries) =
        crate::files::index::fresh_entries(&drive_conn, drive_id, &rel, mtime)
    {
        entries
    } else {
        let entries = read_dir_entries(&dir)?;
        let _ = crate::files::index::replace_dir(&drive_conn, drive_id, &rel, mtime, &entries);
        entries
    };

    if let Some(cache) = cache {
        cache.put_listing(drive_id, &rel, mtime, entries.clone());
        cache.overlay_dirty_listing(drive_id, &rel, &mut entries);
    }
    Ok(entries)
}

/// Read one directory into sorted entries (no index involvement).
pub fn read_dir_entries(dir: &Path) -> Result<Vec<FileEntry>, FilesError> {
    let mut entries = Vec::new();
    let read = std::fs::read_dir(dir).map_err(FilesError::Io)?;
    for entry in read {
        let entry = entry.map_err(FilesError::Io)?;
        // Skip names that aren't losslessly UTF-8: a lossy mangle would show a
        // file the UI can never resolve back to its real bytes (stranding it),
        // and two distinct names could collide in the index.
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let meta = std::fs::symlink_metadata(entry.path()).map_err(FilesError::Io)?;
        if is_internal_temp(name) {
            continue;
        }
        let kind = if meta.file_type().is_dir() {
            "dir"
        } else if meta.file_type().is_symlink() {
            "symlink"
        } else if meta.file_type().is_file() {
            "file"
        } else {
            "other"
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(FileEntry {
            hidden: name.starts_with('.'),
            name: name.to_string(),
            kind: kind.to_string(),
            size: meta.len(),
            modified,
            saving: false,
        });
    }

    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// If a write failed because the drive is full or read-only, transition the
/// drive to `readonly` so every later attempt fails fast and the UI can say
/// what happened in plain language.
pub fn note_write_failure(conn: &rusqlite::Connection, drive_id: &str, error: &str) {
    let lower = error.to_ascii_lowercase();
    if lower.contains("no space")
        || lower.contains("read-only")
        || lower.contains("readonly")
        || lower.contains("disk full")
    {
        let _ = crate::db::set_drive_state(conn, drive_id, "readonly");
    }
}

/// Resolve any existing path (file or directory) inside a drive.
pub fn resolve_any(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let path = resolve_child(&root, rel.as_ref())?;
    let meta = std::fs::metadata(&path).map_err(FilesError::Io)?;
    Ok((path, meta))
}

/// Stat one path (file, folder, or symlink) inside a drive.
///
/// `children` counts a folder's direct contents unfiltered — API callers that
/// owe per-user visibility should recount from their filtered listing.
/// `writable` and `trashed_from` are request context the caller fills in.
pub fn stat(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<FileStat, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    let (path, leaf) = resolve_leaf(&root, rel.as_ref())?;
    let meta = std::fs::symlink_metadata(&path).map_err(FilesError::Io)?;
    let file_type = meta.file_type();
    let kind = if file_type.is_dir() {
        "dir"
    } else if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    };
    let name = leaf;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let link_target = if file_type.is_symlink() {
        std::fs::read_link(&path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned())
    } else {
        None
    };
    let children = if file_type.is_dir() {
        let entries = read_dir_entries(&path)?;
        let mut counts = ChildCounts {
            dirs: 0,
            files: 0,
            other: 0,
        };
        for entry in &entries {
            match entry.kind.as_str() {
                "dir" => counts.dirs += 1,
                "file" => counts.files += 1,
                _ => counts.other += 1,
            }
        }
        Some(counts)
    } else {
        None
    };
    Ok(FileStat {
        hidden: name.starts_with('.'),
        name,
        kind: kind.to_string(),
        size: meta.len(),
        modified,
        created,
        link_target,
        children,
        saving: false,
        writable: false,
        trashed_from: None,
        totals: None,
    })
}

/// Resolve `rel` to an absolute path without following the leaf itself:
/// canonicalize the parent folder (still jailed to `root`), then join the
/// leaf name on top. Returns the resolved path and the leaf name — a symlink
/// leaf stays a symlink so callers can `symlink_metadata` the entry itself.
fn resolve_leaf(root: &Path, rel: &str) -> Result<(PathBuf, String), FilesError> {
    let trimmed = rel.trim_end_matches('/');
    let requested = Path::new(trimmed);
    if requested.is_absolute() {
        return Err(FilesError::Path(luna_core::path::PathError::Absolute));
    }
    for component in requested.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        ) {
            return Err(FilesError::Path(luna_core::path::PathError::Escape));
        }
    }
    let (parent_rel, leaf) = match requested.file_name().and_then(|n| n.to_str()) {
        Some(name) => (
            requested.parent().and_then(|p| p.to_str()).unwrap_or(""),
            name,
        ),
        None => ("", ""),
    };
    let parent = resolve_child(root, parent_rel)?;
    Ok((
        if leaf.is_empty() {
            parent
        } else {
            parent.join(leaf)
        },
        leaf.to_string(),
    ))
}

/// Upper bound for one size walk — beyond this the answer costs more than a
/// properties panel is worth, so callers show counts only.
const TOTALS_MAX_ENTRIES: u64 = 60_000;
/// Wall-clock bound for the same walk, checked periodically (not per entry).
const TOTALS_TIME_BUDGET: std::time::Duration = std::time::Duration::from_millis(2_500);

/// Recursive totals for the folder at `rel`: content bytes of real files
/// plus full descendant counts.
///
/// `include(dir_rel)` gates which directories contribute their entries —
/// callers pass a per-user read check so restricted content never leaks
/// into a total. Unreadable directories are still descended: a deeper
/// granted folder must not be hidden by its ancestor. Symlinks are never
/// followed, so the walk cannot leave the drive. `Ok(None)` only when `rel`
/// is not a real directory; a tree too large to finish yields a partial
/// (`complete: false`) lower-bound answer rather than nothing.
pub fn folder_totals(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    include: &mut impl FnMut(&str) -> bool,
) -> Result<Option<FolderTotals>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    let start = resolve_leaf(&root, rel.as_ref())?.0;
    let meta = std::fs::symlink_metadata(&start).map_err(FilesError::Io)?;
    if !meta.file_type().is_dir() {
        return Ok(None);
    }
    Ok(Some(walk_totals(
        start,
        rel.trim_end_matches('/'),
        include,
        TOTALS_MAX_ENTRIES,
        std::time::Instant::now() + TOTALS_TIME_BUDGET,
    )))
}

/// The walk behind [`folder_totals`], split out so tests can shrink the
/// bounds. `start` must already be verified a real directory.
fn walk_totals(
    start: PathBuf,
    start_rel: &str,
    include: &mut impl FnMut(&str) -> bool,
    max_entries: u64,
    deadline: std::time::Instant,
) -> FolderTotals {
    let mut totals = FolderTotals::default();
    let mut seen = 0u64;
    let mut stack = vec![(start_rel.to_string(), start)];
    while let Some((dir_rel, dir)) = stack.pop() {
        let readable = include(&dir_rel);
        // Best-effort: a folder deleted or denied mid-walk skips rather than
        // failing the whole count.
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read {
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if is_internal_temp(name) {
                continue;
            }
            seen += 1;
            if seen > max_entries
                || (seen.is_multiple_of(512) && std::time::Instant::now() > deadline)
            {
                // Stopped early — what was counted stands as a lower bound.
                return totals;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let file_type = meta.file_type();
            if file_type.is_dir() {
                if readable {
                    totals.dirs += 1;
                }
                let child = if dir_rel.is_empty() {
                    name.to_string()
                } else {
                    format!("{dir_rel}/{name}")
                };
                stack.push((child, entry.path()));
            } else if readable {
                if file_type.is_file() {
                    totals.files += 1;
                    totals.bytes += meta.len();
                } else {
                    totals.other += 1;
                }
            }
        }
    }
    totals.complete = true;
    totals
}

/// Resolve a file for download/streaming, returning its path and metadata.
pub fn file_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let (path, meta) = resolve_any(conn, drive_id, rel)?;
    if !meta.is_file() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a file",
        )));
    }
    Ok((path, meta))
}

/// Cap how many files a folder zip may include (walk DoS guard).
pub const ZIP_MAX_FILES: usize = 50_000;

/// Basename used inside a folder zip and for the `.zip` download name.
pub fn zip_archive_basename(rel: &str) -> String {
    let trimmed = rel.trim_matches('/');
    if trimmed.is_empty() {
        return "drive".into();
    }
    let base = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let cleaned = content_disposition_filename(base);
    if cleaned == "download" {
        "folder".into()
    } else {
        cleaned
    }
}

fn normalize_zip_rel(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

/// Write a zip of `rel` (a folder) into `writer`.
///
/// Paths inside the archive are rooted at the folder name (or `drive/` for the
/// drive root). Symlinks and Luna internal folders are skipped. `include_rel`
/// receives each drive-relative path and may exclude entries the caller
/// cannot browse.
pub fn write_folder_zip(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    writer: impl std::io::Write + std::io::Seek,
    mut include_rel: impl FnMut(&str) -> bool,
) -> Result<usize, FilesError> {
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let (folder, meta) = resolve_any(conn, drive_id, rel)?;
    if !meta.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a directory",
        )));
    }

    let archive_root = zip_archive_basename(rel);
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut file_count = 0usize;
    // (absolute dir, path inside zip, drive-relative dir)
    let mut stack = vec![(folder, archive_root.clone(), normalize_zip_rel(rel))];

    zip.add_directory(format!("{archive_root}/"), options)
        .map_err(|e| FilesError::Io(std::io::Error::other(e)))?;

    while let Some((abs_dir, zip_prefix, drive_rel)) = stack.pop() {
        let read = std::fs::read_dir(&abs_dir).map_err(FilesError::Io)?;
        for entry in read {
            let entry = entry.map_err(FilesError::Io)?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if is_internal_temp(name) {
                continue;
            }
            let child_rel = if drive_rel.is_empty() {
                name.to_string()
            } else {
                format!("{drive_rel}/{name}")
            };
            if !include_rel(&child_rel) {
                continue;
            }
            let meta = std::fs::symlink_metadata(entry.path()).map_err(FilesError::Io)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let zip_path = format!("{zip_prefix}/{name}");
            if meta.is_dir() {
                zip.add_directory(format!("{zip_path}/"), options)
                    .map_err(|e| FilesError::Io(std::io::Error::other(e)))?;
                stack.push((entry.path(), zip_path, child_rel));
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            if file_count >= ZIP_MAX_FILES {
                return Err(FilesError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "folder too large to download as a zip",
                )));
            }
            zip.start_file(&zip_path, options)
                .map_err(|e| FilesError::Io(std::io::Error::other(e)))?;
            let mut input = std::fs::File::open(entry.path()).map_err(FilesError::Io)?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = input.read(&mut buf).map_err(FilesError::Io)?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n]).map_err(FilesError::Io)?;
            }
            file_count += 1;
        }
    }

    zip.finish()
        .map_err(|e| FilesError::Io(std::io::Error::other(e)))?;
    Ok(file_count)
}

/// Destination directory for a new file.
pub fn dest_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<PathBuf, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let dir = resolve_child(&root, rel.as_ref())?;
    if !dir.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "not a directory",
        )));
    }
    Ok(dir)
}

/// Destination directory for a new file, creating missing folders along the
/// way. Uploads arrive holding the sender's folder layout (a folder dropped on
/// the web UI, a backup/sync subfolder from the desktop app) — refusing to
/// create the intermediate folders drops those files outright.
///
/// Each path prefix is re-resolved through `resolve_for_create_nofollow`
/// immediately before it is created, so a symlink planted between steps can
/// never steer creation outside the drive root.
pub fn dest_dir_create(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<PathBuf, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    match resolve_child(&root, rel.as_ref()) {
        Ok(dir) => {
            if !dir.is_dir() {
                return Err(FilesError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    "not a directory",
                )));
            }
            Ok(dir)
        }
        Err(luna_core::path::PathError::NotFound(_)) => ensure_dir(&root, rel.as_ref()),
        // A file sits where a folder should be: canonicalize reports ENOTDIR.
        // ensure_dir's per-prefix walk turns it into a clean NotADirectory.
        Err(luna_core::path::PathError::Io(e)) if e.kind() == std::io::ErrorKind::NotADirectory => {
            ensure_dir(&root, rel.as_ref())
        }
        Err(e) => Err(FilesError::Path(e)),
    }
}

/// Create every missing component of `rel` under `root`, component by
/// component. The lexical `..`/absolute checks happened in `resolve_child`
/// before we got here (it rejects those instead of returning NotFound).
fn ensure_dir(root: &Path, rel: &str) -> Result<PathBuf, FilesError> {
    let mut prefix = String::new();
    for part in rel.split('/').filter(|s| !s.is_empty()) {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(part);
        let p = luna_core::path::resolve_for_create_nofollow(root, &prefix)
            .map_err(FilesError::Path)?;
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(FilesError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotADirectory,
                    "not a directory",
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&p) {
                    Ok(()) => {}
                    // A concurrent upload created it first — fine, as long as
                    // what exists now is a real directory.
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(FilesError::Io(e)),
                }
                // Re-check after create: a swapped-in symlink between the
                // resolve and the mkdir must not hand the caller a path that
                // left the drive.
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                    _ => {
                        return Err(FilesError::Io(std::io::Error::new(
                            std::io::ErrorKind::NotADirectory,
                            "not a directory",
                        )));
                    }
                }
            }
            Err(e) => return Err(FilesError::Io(e)),
        }
    }
    // Final whole-path check before the caller writes into the result: if any
    // component was swapped for a symlink during the walk, canonicalizing the
    // full path lands outside the drive root and we refuse it.
    resolve_child(root, rel).map_err(FilesError::Path)
}

/// MIME types safe to render inline at the Luna origin. Everything else is
/// forced to download so a crafted HTML/SVG/PDF/JS file sitting on a drive can
/// never execute as a Luna page (stored XSS). `nosniff` must also be set on
/// the response for this to hold.
pub fn inline_safe(mime: &str) -> bool {
    let t = mime.to_ascii_lowercase();
    (t.starts_with("image/") && t != "image/svg+xml")
        || t.starts_with("video/")
        || t.starts_with("audio/")
        || t.starts_with("font/")
        || t == "text/plain"
        || t == "text/csv"
}

/// Names Luna owns on a drive plus in-flight temp files. Never list, index,
/// or download them — they are bookkeeping or incomplete bytes, not user
/// files. The check works on basenames and whole rel paths: any `.luna-<uuid>`
/// namespaced segment (marker, trash, thumbs, protected copies, upload temps)
/// marks the path as Luna's.
pub fn is_internal_temp(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    name.split('/')
        .any(crate::drives::layout::Layout::is_luna_name)
        || (base.starts_with('.') && base.ends_with(".part"))
}

/// Translate the `.luna-trash/...` API alias into this drive's real
/// `{prefix}-trash/...` path. Non-alias paths pass through unchanged.
fn real_rel<'a>(root: &Path, rel: &'a str) -> std::borrow::Cow<'a, str> {
    match rel.strip_prefix(TRASH_API_ALIAS) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            match crate::drives::layout::Layout::detect(root) {
                Some(l) => std::borrow::Cow::Owned(format!("{}{}", l.trash_name(), rest)),
                None => std::borrow::Cow::Borrowed(rel),
            }
        }
        _ => std::borrow::Cow::Borrowed(rel),
    }
}

/// Is `rel` the drive's `{prefix}-trash` dir or a path inside it? Operates on
/// real (post-translation) paths.
fn is_trash_rel(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    luna_core::marker::extract_prefix(first).is_some_and(|p| first == format!("{p}-trash"))
}

/// Conservative Content-Disposition filename: no quotes, slashes, or control
/// characters, so a crafted name cannot split the header.
pub fn content_disposition_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\' && *c != '/' && *c != ':')
        .take(180)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "download".into()
    } else {
        trimmed.to_string()
    }
}

/// Sanitize a client-provided file name to a bare, non-empty basename.
pub fn safe_name(name: &str) -> Result<String, FilesError> {
    if name.contains(['/', '\\', '\0']) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid file name",
        )));
    }
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.len() > 255 {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid file name",
        )));
    }
    // Names inside the `.luna-<uuid>` namespace are Luna's bookkeeping —
    // creating one would make an invisible file. `.luna-trash` is the API
    // alias for the real trash dir; a literal folder by that name would be
    // shadowed by the alias and unreachable.
    if crate::drives::layout::Layout::is_luna_name(trimmed) || trimmed == TRASH_API_ALIAS {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    Ok(trimmed.to_string())
}

/// Atomically install `temp` as `dest`.
///
/// When `overwrite` is false, the install must fail if `dest` already exists.
/// Prefer `renameat2(RENAME_NOREPLACE)` (atomic, works on ext4 and on
/// FAT/exFAT same-folder). Fall back to hard link, then to a checked rename,
/// because some USB/FUSE mounts reject `link(2)` with EPERM.
pub fn install_temp(temp: &Path, dest: &Path, overwrite: bool) -> Result<(), FilesError> {
    if overwrite {
        std::fs::rename(temp, dest).map_err(FilesError::Io)?;
    } else {
        install_no_overwrite(temp, dest)?;
    }
    // Persist the directory entry so the rename/link survives power loss.
    if let Some(parent) = dest.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn install_no_overwrite(temp: &Path, dest: &Path) -> Result<(), FilesError> {
    match rename_noreplace(temp, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(FilesError::Io(e)),
        Err(e) if noreplace_unavailable(&e) => match std::fs::hard_link(temp, dest) {
            Ok(()) => std::fs::remove_file(temp).map_err(FilesError::Io),
            Err(e2) if e2.kind() == std::io::ErrorKind::AlreadyExists => Err(FilesError::Io(e2)),
            Err(e2) if hard_link_unsupported(&e2) => install_by_exclusive_rename(temp, dest),
            Err(e2) => Err(FilesError::Io(e2)),
        },
        Err(e) => Err(FilesError::Io(e)),
    }
}

/// Try an atomic same-filesystem move that never overwrites `to`.
///
/// Returns `Ok(true)` when the rename succeeded. Returns `Ok(false)` when the
/// kernel reports a cross-device move (EXDEV) so the caller can fall back to
/// copy-then-trash. Other failures stay as errors (conflict, I/O, etc.).
pub fn try_rename_move(from: &Path, to: &Path) -> Result<bool, FilesError> {
    match rename_noreplace(from, to) {
        Ok(()) => {
            if let Some(parent) = to.parent()
                && let Ok(dir) = std::fs::File::open(parent)
            {
                let _ = dir.sync_all();
            }
            if let Some(parent) = from.parent()
                && let Ok(dir) = std::fs::File::open(parent)
            {
                let _ = dir.sync_all();
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(FilesError::Io(e)),
        Err(e) if is_cross_device(&e) => Ok(false),
        // Some USB/FUSE mounts reject renameat2(RENAME_NOREPLACE). Plain
        // rename(2) still works for a real same-filesystem move when the
        // destination does not exist (prepare already refused conflicts).
        Err(e) if noreplace_unavailable(&e) => match to.symlink_metadata() {
            Ok(_) => Err(FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "destination exists",
            ))),
            Err(e2) if e2.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::rename(from, to) {
                    Ok(()) => {
                        if let Some(parent) = to.parent()
                            && let Ok(dir) = std::fs::File::open(parent)
                        {
                            let _ = dir.sync_all();
                        }
                        Ok(true)
                    }
                    Err(e3) if is_cross_device(&e3) => Ok(false),
                    Err(e3) => Err(FilesError::Io(e3)),
                }
            }
            Err(e2) => Err(FilesError::Io(e2)),
        },
        Err(e) => Err(FilesError::Io(e)),
    }
}

fn is_cross_device(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::CrossesDevices)
        || matches!(err.raw_os_error(), Some(libc::EXDEV))
}

fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from_c = std::ffi::CString::new(from.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path"))?;
        let to_c = std::ffi::CString::new(to.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path"))?;
        // musl 1.2.x has SYS_renameat2 but no renameat2() wrapper, so the
        // ISO's musl lunad must call the syscall. glibc has both; syscall
        // works on either.
        // SAFETY: both paths are NUL-terminated CStrings; AT_FDCWD is a valid dirfd.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (from, to);
        Err(std::io::Error::from_raw_os_error(38))
    }
}

fn noreplace_unavailable(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::Unsupported)
        || matches!(err.raw_os_error(), Some(22 | 38 | 45 | 95))
}

/// `link(2)` is not supported on FAT, exFAT, NTFS-3G, and some FUSE mounts.
/// Linux reports EPERM (os error 1) or EOPNOTSUPP; others use ENOSYS / EXDEV.
fn hard_link_unsupported(err: &std::io::Error) -> bool {
    if matches!(
        err.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
    ) {
        return true;
    }
    matches!(err.raw_os_error(), Some(1 | 18 | 38 | 45 | 95))
}

/// Same-directory rename when hard links are unavailable. `rename(2)` replaces
/// an existing dest, so refuse if the name is already there.
fn install_by_exclusive_rename(temp: &Path, dest: &Path) -> Result<(), FilesError> {
    match dest.symlink_metadata() {
        Ok(_) => Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination exists",
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::rename(temp, dest).map_err(FilesError::Io)
        }
        Err(e) => Err(FilesError::Io(e)),
    }
}

/// Move a file or folder to the drive's `{prefix}-trash` dir on the same
/// drive (atomic rename, same filesystem). Returns the `.luna-trash/...`
/// API-alias path.
pub fn delete_to_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<String, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let path = resolve_child(&root, rel.as_ref())?;
    if path == root {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot trash the drive root",
        )));
    }
    let Some(name) = path.file_name().map(|s| s.to_string_lossy().into_owned()) else {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid path",
        )));
    };

    let layout = crate::drives::layout::Layout::detect(&root).ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "drive is not adopted",
        ))
    })?;
    let trash = layout.trash_dir(&root);
    std::fs::create_dir_all(&trash).map_err(FilesError::Io)?;
    let trash_rel = rel.trim().trim_matches('/').to_string();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dest = trash.join(format!("{nonce}-{name}"));
    let mut n = 1;
    // No-replace moves into the trash: two concurrent deletes within the same
    // second each land on their own nonce suffix instead of racing on an
    // exists() check and having rename(2) clobber the first entry.
    loop {
        match rename_noreplace(&path, &dest) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                dest = trash.join(format!("{nonce}-{n}-{name}"));
                n += 1;
            }
            Err(e) => return Err(FilesError::Io(e)),
        }
    }
    if let Ok(dir) = std::fs::File::open(&trash) {
        let _ = dir.sync_all();
    }
    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    let trash_entry_name = dest
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_trash_meta(&root, &trash_entry_name, &trash_rel)?;
    // Return the API-alias path (`trash_meta` keeps the real entry name, which
    // is shared by both forms since the alias only swaps the dir prefix).
    let real = dest
        .strip_prefix(&root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .into_owned();
    match real.split_once('/') {
        Some((_, entry)) => Ok(format!("{TRASH_API_ALIAS}/{entry}")),
        None => Ok(real),
    }
}

fn write_trash_meta(
    drive_root: &Path,
    entry_name: &str,
    original_path: &str,
) -> Result<(), FilesError> {
    let conn = crate::drives::drive_db::open(drive_root).map_err(FilesError::Db)?;
    conn.execute(
        "INSERT OR REPLACE INTO trash_meta (entry_name, original_path) VALUES (?1, ?2)",
        rusqlite::params![entry_name, original_path],
    )
    .map_err(|e| FilesError::Db(e.into()))?;
    Ok(())
}

fn read_trash_meta(drive_root: &Path, entry_name: &str) -> Option<String> {
    let conn = crate::drives::drive_db::open(drive_root).ok()?;
    conn.query_row(
        "SELECT original_path FROM trash_meta WHERE entry_name = ?1",
        rusqlite::params![entry_name],
        |row| row.get(0),
    )
    .ok()
}

fn remove_trash_meta(drive_root: &Path, entry_name: &str) {
    if let Ok(conn) = crate::drives::drive_db::open(drive_root) {
        let _ = conn.execute(
            "DELETE FROM trash_meta WHERE entry_name = ?1",
            rusqlite::params![entry_name],
        );
    }
}

/// The entry name inside the trash dir, from a real `{prefix}-trash/<entry>`
/// rel path.
fn trash_entry_name(trash_rel: &str) -> Option<&str> {
    if !is_trash_rel(trash_rel) {
        return None;
    }
    trash_rel
        .split_once('/')
        .map(|(_, name)| name)
        .filter(|name| !name.is_empty())
}

/// Best-effort original name: trash files are `{unix}-{name}` or `{unix}-{n}-{name}`.
pub fn original_name_from_trash(trash_name: &str) -> String {
    let Some((first, rest)) = trash_name.split_once('-') else {
        return trash_name.to_string();
    };
    if !first.chars().all(|c| c.is_ascii_digit()) {
        return trash_name.to_string();
    }
    if let Some((maybe_n, original)) = rest.split_once('-')
        && maybe_n.chars().all(|c| c.is_ascii_digit())
        && !maybe_n.is_empty()
    {
        return original.to_string();
    }
    rest.to_string()
}

/// List items sitting in the drive's `{prefix}-trash` dir.
pub fn list_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
) -> Result<Vec<TrashEntry>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let Some(layout) = crate::drives::layout::Layout::detect(&root) else {
        return Ok(Vec::new());
    };
    let trash = layout.trash_dir(&root);
    if !trash.exists() {
        return Ok(Vec::new());
    }
    let entries = read_dir_entries(&trash)?;
    Ok(entries
        .into_iter()
        .map(|entry| TrashEntry {
            original_path: read_trash_meta(&root, &entry.name).unwrap_or_default(),
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            modified: entry.modified,
        })
        .collect())
}

/// Drive-relative path the trashed item came from, if metadata exists.
/// `trash_rel` may use the `.luna-trash` API alias or the real
/// `{prefix}-trash` name.
pub fn trash_original_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<Option<String>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let trash_rel = real_rel(&root, trash_rel);
    if !is_trash_rel(&trash_rel) {
        return Ok(None);
    }
    let Some(entry_name) = trash_entry_name(&trash_rel) else {
        return Ok(None);
    };
    Ok(read_trash_meta(&root, entry_name))
}

/// Move an item out of trash onto the same drive (atomic rename).
/// `trash_rel` accepts the `.luna-trash` API alias or the real name;
/// `dest_rel` is the destination path including the restored file name.
pub fn restore_from_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
    dest_rel: &str,
) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let trash_rel = real_rel(&root, trash_rel);
    if !is_trash_rel(&trash_rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    if is_trash_rel(dest_rel)
        || is_internal_temp(dest_rel)
        || dest_rel == TRASH_API_ALIAS
        || dest_rel.starts_with(&format!("{TRASH_API_ALIAS}/"))
    {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot restore into trash",
        )));
    }
    let src = resolve_child(&root, trash_rel.as_ref())?;
    // Destination does not exist yet, so jail the parent (which must) and join
    // a safe file name. resolve_child() requires an existing path.
    let dest_path = Path::new(dest_rel);
    let dest_name = dest_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| {
            FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid restore name",
            ))
        })?;
    let dest_name = safe_name(dest_name)?;
    let parent_rel = dest_path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = if parent_rel.is_empty() || parent_rel == "." {
        resolve_child(&root, "")?
    } else {
        resolve_child(&root, &parent_rel)?
    };
    let dest = parent.join(&dest_name);
    // No-replace move: a concurrent restore to the same name gets
    // AlreadyExists instead of silently clobbering the earlier winner.
    rename_noreplace(&src, &dest).map_err(FilesError::Io)?;
    if let Some(parent) = dest.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    if let Some(entry_name) = trash_entry_name(&trash_rel) {
        remove_trash_meta(&root, entry_name);
    }
    Ok(())
}

/// Permanently remove one item that is already in the drive's trash dir.
/// `trash_rel` accepts the `.luna-trash` API alias or the real name.
pub fn purge_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let trash_rel = real_rel(&root, trash_rel);
    if !is_trash_rel(&trash_rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    let path = resolve_child(&root, trash_rel.as_ref())?;
    let meta = std::fs::symlink_metadata(&path).map_err(FilesError::Io)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(FilesError::Io)?;
    } else {
        std::fs::remove_file(&path).map_err(FilesError::Io)?;
    }
    if let Some(entry_name) = trash_entry_name(&trash_rel) {
        remove_trash_meta(&root, entry_name);
    }
    Ok(())
}

/// Create a directory at `rel`. The parent must already exist. Never overwrites.
pub fn mkdir(conn: &rusqlite::Connection, drive_id: &str, rel: &str) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    if rel.is_empty() || rel == "." {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot create the drive root",
        )));
    }
    if is_internal_temp(rel) || rel.split('/').next() == Some(TRASH_API_ALIAS) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let path = luna_core::path::resolve_for_create_nofollow(&root, rel)?;
    // Reject creating more than one missing component (parent must exist).
    let parent = path.parent().ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?;
    if !parent.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "parent folder does not exist",
        )));
    }
    match std::fs::create_dir(&path) {
        Ok(()) => {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(FilesError::Io(e)),
        Err(e) => Err(FilesError::Io(e)),
    }
}

/// Create an empty file at `rel`. The parent must already exist. Never overwrites.
pub fn create(conn: &rusqlite::Connection, drive_id: &str, rel: &str) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    if rel.is_empty() || rel == "." {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot create at the drive root without a name",
        )));
    }
    let leaf = rel.rsplit_once('/').map(|(_, name)| name).unwrap_or(rel);
    let _ = safe_name(leaf)?;
    if is_internal_temp(rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let path = luna_core::path::resolve_for_create_nofollow(&root, rel)?;
    // Reject creating more than one missing component (parent must exist).
    let parent = path.parent().ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?;
    if !parent.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "parent folder does not exist",
        )));
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => {
            let _ = file.sync_all();
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(FilesError::Io(e)),
        Err(e) => Err(FilesError::Io(e)),
    }
}

/// Rename a file or folder within its current directory. Never overwrites.
pub fn rename(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    new_name: &str,
) -> Result<(), FilesError> {
    let new_name = safe_name(new_name)?;
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = real_rel(&root, rel).into_owned();
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let path = resolve_child(&root, rel.as_ref())?;
    let parent = path.parent().ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?;
    let dest = parent.join(&new_name);
    // No-replace move keeps the never-overwrites contract honest under
    // concurrency; plain rename(2) would silently overwrite.
    rename_noreplace(&path, &dest).map_err(FilesError::Io)?;
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Temp upload path inside `dir` on the drive `drive_id` — named inside the
/// drive's `.luna-<uuid>` namespace so it can never clash with a user file.
pub fn temp_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    dir: &Path,
) -> Result<PathBuf, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    temp_path_at(Path::new(&drive.mount_point), dir)
}

/// [`temp_path`] for callers that already hold the drive's mount point.
pub fn temp_path_at(root: &Path, dir: &Path) -> Result<PathBuf, FilesError> {
    let layout = crate::drives::layout::Layout::detect(root).ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "drive is not adopted",
        ))
    })?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(dir.join(format!(
        "{}-upload.{}.{nonce}",
        layout.prefix(),
        std::process::id()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_dir() -> (tempfile::TempDir, rusqlite::Connection, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let id = "drive-1";
        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let marker = luna_core::marker::Marker::new(id, "Test");
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        crate::drives::drive_db::create(&root, &marker, &prefix).unwrap();
        db::upsert_drive(
            &conn,
            id,
            "Test",
            "as_is",
            "ext4",
            "sdz",
            root.to_str().unwrap(),
        )
        .unwrap();
        (dir, conn, id.into())
    }

    #[test]
    fn list_sorts_dirs_first_and_jails() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("b.txt"), b"b").unwrap();
        std::fs::create_dir(root.join("a")).unwrap();

        let entries = list_dir(&conn, &id, "").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a");
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[1].name, "b.txt");

        assert!(matches!(
            list_dir(&conn, &id, "../x"),
            Err(FilesError::Path(_))
        ));
    }

    #[test]
    fn list_hides_upload_temps() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        let temp = format!(
            "{}-upload.1.2",
            crate::drives::drive_db::prefix_for(&root).unwrap()
        );
        std::fs::write(root.join("keep.txt"), b"k").unwrap();
        std::fs::write(root.join(&temp), b"tmp").unwrap();
        let entries = list_dir(&conn, &id, "").unwrap();
        assert!(entries.iter().all(|e| e.name != temp));
        assert!(file_path(&conn, &id, &temp).is_err());
    }

    #[test]
    fn safe_name_rejects_traversal() {
        assert!(safe_name("../x").is_err());
        assert!(safe_name("a/b").is_err());
        assert_eq!(safe_name("photo.jpg").unwrap(), "photo.jpg");
    }

    #[test]
    fn mkdir_creates_and_rejects_escape_and_conflict() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();

        mkdir(&conn, &id, "family").unwrap();
        assert!(root.join("family").is_dir());

        assert!(matches!(
            mkdir(&conn, &id, "family"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert!(matches!(
            mkdir(&conn, &id, "../outside"),
            Err(FilesError::Path(_))
        ));
        assert!(matches!(
            mkdir(&conn, &id, "missing-parent/child"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
        ));

        mkdir(&conn, &id, "family/album").unwrap();
        assert!(root.join("family/album").is_dir());
    }

    #[test]
    fn create_makes_empty_file_and_rejects_escape_and_conflict() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();

        mkdir(&conn, &id, "notes").unwrap();
        create(&conn, &id, "notes/shopping.txt").unwrap();
        assert!(root.join("notes/shopping.txt").is_file());
        assert_eq!(std::fs::read(root.join("notes/shopping.txt")).unwrap(), b"");

        assert!(matches!(
            create(&conn, &id, "notes/shopping.txt"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert!(matches!(
            create(&conn, &id, "../outside.txt"),
            Err(FilesError::Path(_))
        ));
        assert!(matches!(
            create(&conn, &id, "missing-parent/note.txt"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
        assert!(matches!(
            create(&conn, &id, "notes/a/b.txt"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
        assert!(create(&conn, &id, "notes/..").is_err());
        assert!(create(&conn, &id, "notes/.").is_err());
        create(&conn, &id, "readme.txt").unwrap();
        assert!(root.join("readme.txt").is_file());
    }

    #[test]
    fn dest_dir_create_makes_missing_folders_inside_the_jail() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();

        // The case that dropped backup/sync subfolders: nested destination
        // that does not exist yet is created.
        let dir = dest_dir_create(&conn, &id, "DesktopBackup/subdir/deep").unwrap();
        assert!(dir.ends_with("DesktopBackup/subdir/deep"));
        assert!(root.join("DesktopBackup/subdir/deep").is_dir());

        // Existing dirs resolve as before, and "" is the root.
        assert_eq!(
            dest_dir_create(&conn, &id, "").unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(
            dest_dir_create(&conn, &id, "DesktopBackup/subdir")
                .unwrap()
                .is_dir()
        );

        // Traversal and the `.luna-*` namespace stay off-limits; a file in the
        // way is NotADirectory, not clobbered.
        assert!(dest_dir_create(&conn, &id, "../outside").is_err());
        assert!(dest_dir_create(&conn, &id, "DesktopBackup/../x").is_err());
        std::fs::write(root.join("file.txt"), b"x").unwrap();
        assert!(matches!(
            dest_dir_create(&conn, &id, "file.txt/inside"),
            Err(FilesError::Io(ref e)) if e.kind() == std::io::ErrorKind::NotADirectory
        ));

        // A symlink mid-path must not steer creation outside the drive root.
        #[cfg(unix)]
        {
            let outside = root.parent().unwrap().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("hole")).unwrap();
            assert!(matches!(
                dest_dir_create(&conn, &id, "hole/pwned"),
                Err(FilesError::Path(_))
            ));
            assert!(!outside.join("pwned").exists());
        }
    }

    #[test]
    fn internal_temps_are_hidden() {
        let p = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f";
        assert!(is_internal_temp(&format!("{p}-upload.12.99.part")));
        assert!(is_internal_temp(&format!("folder/{p}-upload.1.2.part")));
        assert!(is_internal_temp(&format!("{p}.sqlite3")));
        assert!(is_internal_temp(&format!("{p}-thumbs")));
        assert!(is_internal_temp(&format!("{p}-trash/entry")));
        assert!(is_internal_temp(&format!("docs/{p}-trash/entry")));
        assert!(is_internal_temp("notes/.x.part"));
        assert!(!is_internal_temp("photo.jpg"));
        assert!(!is_internal_temp("notes.part"));
        // Fixed legacy names are ordinary files now — users may see them.
        assert!(!is_internal_temp(".luna-trash"));
        assert!(!is_internal_temp(".lunathumbs"));
    }

    #[test]
    fn luna_namespace_is_off_limits_to_user_writes() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        let prefix = crate::drives::drive_db::prefix_for(&root).unwrap();
        let ns = format!("{prefix}-thumbs");
        std::fs::create_dir_all(root.join(&ns)).unwrap();
        std::fs::write(root.join("note.txt"), b"n").unwrap();

        // Nothing inside a `.luna-<uuid>` dir can be listed, created, made,
        // renamed, deleted, or restored into through the file API.
        assert!(list_dir(&conn, &id, &ns).is_err());
        assert!(create(&conn, &id, &format!("{ns}/x.txt")).is_err());
        assert!(mkdir(&conn, &id, &format!("{ns}/sub")).is_err());
        assert!(mkdir(&conn, &id, &ns).is_err());
        assert!(rename(&conn, &id, &ns, "renamed").is_err());
        assert!(rename(&conn, &id, "note.txt", &ns).is_err());
        assert!(delete_to_trash(&conn, &id, &ns).is_err());
        assert!(dest_dir(&conn, &id, &ns).is_err());
        assert!(
            restore_from_trash(&conn, &id, &format!("{prefix}-trash/x"), &format!("{ns}/x"))
                .is_err()
        );
        assert!(root.join(&ns).is_dir());
        assert!(root.join("note.txt").exists());
    }

    #[test]
    fn content_disposition_strips_control_and_quotes() {
        assert_eq!(
            content_disposition_filename("hi\"\r\nX: inject.jpg"),
            "hiX inject.jpg"
        );
        assert_eq!(content_disposition_filename("\n\r"), "download");
        assert_eq!(content_disposition_filename("photo.jpg"), "photo.jpg");
    }

    #[test]
    fn delete_moves_to_trash_and_rename_works() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();

        rename(&conn, &id, "keep.txt", "renamed.txt").unwrap();
        assert!(root.join("renamed.txt").exists());
        assert!(!root.join("keep.txt").exists());

        let trash_rel = delete_to_trash(&conn, &id, "renamed.txt").unwrap();
        assert!(
            trash_rel.starts_with(".luna-trash/"),
            "API alias: {trash_rel}"
        );
        assert!(!root.join("renamed.txt").exists());
        let disk_rel = real_rel(&root, &trash_rel).into_owned();
        assert!(root.join(&disk_rel).exists());

        let listed = list_trash(&conn, &id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].original_path, "renamed.txt");

        restore_from_trash(&conn, &id, &trash_rel, "back.txt").unwrap();
        assert!(root.join("back.txt").exists());
        assert!(!root.join(&disk_rel).exists());
        assert_eq!(std::fs::read(root.join("back.txt")).unwrap(), b"keep");
    }

    #[test]
    fn trash_meta_records_nested_original_path() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::create_dir_all(root.join("family/album")).unwrap();
        std::fs::write(root.join("family/album/photo.jpg"), b"x").unwrap();
        let trash_rel = delete_to_trash(&conn, &id, "family/album/photo.jpg").unwrap();
        let listed = list_trash(&conn, &id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].original_path, "family/album/photo.jpg");
        assert_eq!(
            trash_original_path(&conn, &id, &trash_rel).unwrap(),
            Some("family/album/photo.jpg".into())
        );
    }

    #[test]
    fn list_trash_hides_meta_directory() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("note.txt"), b"n").unwrap();
        let trash_rel = delete_to_trash(&conn, &id, "note.txt").unwrap();
        // Trash restore paths live in the marker microdb, not a `.meta` folder.
        let real_trash = format!(
            "{}/.meta",
            crate::drives::drive_db::prefix_for(&root).unwrap() + "-trash"
        );
        assert!(!root.join(&real_trash).exists());
        // The on-disk entry lives under the drive's real prefix dir.
        let disk_rel = format!(
            "{}/{}",
            crate::drives::drive_db::prefix_for(&root).unwrap() + "-trash",
            trash_rel.trim_start_matches(".luna-trash/")
        );
        assert!(root.join(&disk_rel).exists());
        let listed = list_trash(&conn, &id).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed.iter().any(|e| e.name == ".meta"));
    }

    #[test]
    fn restore_is_same_drive_and_never_overwrites() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::write(root.join("taken.txt"), b"taken").unwrap();
        let trash_rel = delete_to_trash(&conn, &id, "a.txt").unwrap();
        assert!(restore_from_trash(&conn, &id, &trash_rel, "taken.txt").is_err());
        assert!(root.join(real_rel(&root, &trash_rel).as_ref()).exists());
        assert_eq!(std::fs::read(root.join("taken.txt")).unwrap(), b"taken");
    }

    #[test]
    fn purge_only_touches_trash() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();
        assert!(purge_trash(&conn, &id, "keep.txt").is_err());
        assert!(root.join("keep.txt").exists());

        let trash_rel = delete_to_trash(&conn, &id, "keep.txt").unwrap();
        purge_trash(&conn, &id, &trash_rel).unwrap();
        assert!(!root.join(&trash_rel).exists());
        assert!(list_trash(&conn, &id).unwrap().is_empty());
    }

    #[test]
    fn original_name_from_trash_strips_nonce() {
        assert_eq!(
            original_name_from_trash("1710000000-photo.jpg"),
            "photo.jpg"
        );
        assert_eq!(
            original_name_from_trash("1710000000-2-photo.jpg"),
            "photo.jpg"
        );
        assert_eq!(original_name_from_trash("plain"), "plain");
    }

    #[test]
    fn rename_never_overwrites() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::write(root.join("b.txt"), b"b").unwrap();
        assert!(rename(&conn, &id, "a.txt", "b.txt").is_err());
    }

    #[test]
    #[ignore = "benchmark; run with cargo test -- --ignored listing_benchmark"]
    fn listing_benchmark_10k_files_from_index() {
        let (_dir, conn, id) = drive_dir();
        let root = std::path::Path::new(&db::get_drive(&conn, &id).unwrap().unwrap().mount_point)
            .to_path_buf();
        for i in 0..10_000 {
            std::fs::write(root.join(format!("file-{i:05}.txt")), b"x").unwrap();
        }
        let _ = list_dir(&conn, &id, "").unwrap(); // populate index

        let start = std::time::Instant::now();
        let entries = list_dir(&conn, &id, "").unwrap();
        let elapsed = start.elapsed();
        assert_eq!(entries.len(), 10_000);
        println!("indexed listing of 10k files: {elapsed:?}");
        assert!(elapsed.as_millis() < 50, "target: <50ms, got {elapsed:?}");
    }

    #[test]
    fn install_temp_is_atomic_and_persists_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir
            .path()
            .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
        std::fs::write(&temp, b"hello").unwrap();
        let dest = dir.path().join("file.txt");
        install_temp(&temp, &dest, false).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    #[test]
    fn install_temp_never_overwrites_without_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir
            .path()
            .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
        let dest = dir.path().join("file.txt");
        std::fs::write(&temp, b"new").unwrap();
        std::fs::write(&dest, b"original").unwrap();

        // No-overwrite install must fail and leave the original intact.
        assert!(install_temp(&temp, &dest, false).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        assert!(temp.exists(), "temp is preserved so nothing is lost");

        // Overwrite install replaces it.
        install_temp(&temp, &dest, true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn exclusive_rename_installs_when_hard_links_are_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir
            .path()
            .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
        let dest = dir.path().join("clip.webm");
        std::fs::write(&temp, b"webm-bytes").unwrap();
        install_by_exclusive_rename(&temp, &dest).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
    }

    #[test]
    fn exclusive_rename_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir
            .path()
            .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
        let dest = dir.path().join("clip.webm");
        std::fs::write(&temp, b"new").unwrap();
        std::fs::write(&dest, b"original").unwrap();
        assert!(install_by_exclusive_rename(&temp, &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        assert!(temp.exists());
    }

    #[test]
    fn install_temp_puts_a_webm_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir
            .path()
            .join(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-upload.1.part");
        std::fs::write(&temp, b"webm-bytes").unwrap();
        let dest = dir.path().join("clip.webm");
        install_temp(&temp, &dest, false).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
    }

    #[test]
    fn folder_zip_includes_nested_files_and_skips_internal() {
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        std::fs::create_dir_all(root.join("album/day")).unwrap();
        std::fs::write(root.join("album/day/beach.jpg"), b"photo").unwrap();
        std::fs::write(root.join("album/note.txt"), b"hi").unwrap();
        let internal = format!(
            "album/{}-trash",
            crate::drives::drive_db::prefix_for(&root).unwrap()
        );
        std::fs::create_dir_all(root.join(&internal)).unwrap();
        std::fs::write(root.join(format!("{internal}/x")), b"no").unwrap();

        let mut buf = std::io::Cursor::new(Vec::new());
        let count = write_folder_zip(&conn, &id, "album", &mut buf, |_| true).unwrap();
        assert_eq!(count, 2);
        let bytes = buf.into_inner();
        assert!(bytes.starts_with(b"PK"));

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert!(names.iter().any(|n| n == "album/"));
        assert!(names.iter().any(|n| n == "album/day/" || n == "album/day"));
        assert!(names.iter().any(|n| n == "album/day/beach.jpg"));
        assert!(names.iter().any(|n| n == "album/note.txt"));
        assert!(!names.iter().any(|n| n.contains(".luna-")));
    }

    #[cfg(unix)]
    #[test]
    fn folder_zip_skips_symlinks() {
        use std::os::unix::fs::symlink;
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        let outside = _dir.path().join("outside");
        std::fs::create_dir_all(root.join("album")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("album/keep.txt"), b"keep").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(&outside, root.join("album/link")).unwrap();

        let mut buf = std::io::Cursor::new(Vec::new());
        let count = write_folder_zip(&conn, &id, "album", &mut buf, |_| true).unwrap();
        assert_eq!(count, 1);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buf.into_inner())).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "album/keep.txt"));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("secret") || n.contains("link"))
        );
    }

    #[test]
    fn stat_reports_kind_times_and_children() {
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        std::fs::write(root.join("note.txt"), b"hello").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/a.txt"), b"a").unwrap();

        let file = stat(&conn, &id, "note.txt").unwrap();
        assert_eq!(file.name, "note.txt");
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, 5);
        assert!(file.modified > 0);
        assert!(file.children.is_none());
        assert!(!file.hidden);

        let dir = stat(&conn, &id, "sub").unwrap();
        assert_eq!(dir.kind, "dir");
        let counts = dir.children.unwrap();
        assert_eq!(counts.files, 1);
        assert_eq!(counts.dirs, 0);

        // Drive root resolves too — empty name, kind dir.
        let root_stat = stat(&conn, &id, "").unwrap();
        assert_eq!(root_stat.kind, "dir");
        assert!(root_stat.children.unwrap().files >= 1);

        assert!(matches!(
            stat(&conn, &id, "../escape"),
            Err(FilesError::Path(_))
        ));
        assert!(matches!(
            stat(&conn, &id, "missing.txt"),
            Err(FilesError::Io(_))
        ));
    }

    #[test]
    fn folder_totals_counts_nested_content_and_respects_the_lens() {
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/one.txt"), b"12345").unwrap();
        std::fs::write(root.join("a/b/two.txt"), b"xy").unwrap();
        std::fs::write(root.join("a/.hidden"), b"h").unwrap();

        let mut all = |_: &str| true;
        let totals = folder_totals(&conn, &id, "a", &mut all).unwrap().unwrap();
        assert_eq!(totals.bytes, 5 + 2 + 1);
        assert_eq!(totals.files, 3);
        assert_eq!(totals.dirs, 1);
        assert_eq!(totals.other, 0);
        assert!(totals.complete);

        // Only "a/b" is readable: "a"'s own files stay out of the total, but
        // the granted folder inside still counts — an unreadable parent must
        // not hide a deeper grant.
        let mut only_b = |p: &str| p == "a/b";
        let scoped = folder_totals(&conn, &id, "a", &mut only_b)
            .unwrap()
            .unwrap();
        assert_eq!(scoped.bytes, 2);
        assert_eq!(scoped.files, 1);
        assert_eq!(scoped.dirs, 0);

        // A bound hit keeps what it counted as a lower bound, never zeroes
        // the answer out.
        let partial = walk_totals(
            root.join("a"),
            "a",
            &mut all,
            2,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
        );
        assert!(!partial.complete);
        assert!(partial.files + partial.dirs + partial.other <= 2);

        // Files and missing paths have no totals.
        assert!(
            folder_totals(&conn, &id, "a/one.txt", &mut all)
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            folder_totals(&conn, &id, "../escape", &mut all),
            Err(FilesError::Path(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn folder_totals_counts_a_link_but_never_follows_it() {
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        let outside = _dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"not on the drive").unwrap();
        std::fs::create_dir(root.join("a")).unwrap();
        std::fs::write(root.join("a/real.txt"), b"r").unwrap();
        // A link to a directory outside the drive: counted as "other", and
        // the walk must not descend into it.
        std::os::unix::fs::symlink(&outside, root.join("a/far")).unwrap();

        let mut all = |_: &str| true;
        let totals = folder_totals(&conn, &id, "a", &mut all).unwrap().unwrap();
        assert_eq!(totals.bytes, 1);
        assert_eq!(totals.files, 1);
        assert_eq!(totals.dirs, 0);
        assert_eq!(totals.other, 1);
    }

    #[cfg(unix)]
    #[test]
    fn stat_reports_the_link_not_its_target() {
        let (_dir, conn, id) = drive_dir();
        let root =
            std::path::PathBuf::from(db::get_drive(&conn, &id).unwrap().unwrap().mount_point);
        let outside = _dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("real.txt"), b"r").unwrap();
        std::os::unix::fs::symlink("real.txt", root.join("link.txt")).unwrap();
        // Even a link escaping the drive still reports as a symlink.
        std::os::unix::fs::symlink(&outside, root.join("far.txt")).unwrap();

        let s = stat(&conn, &id, "link.txt").unwrap();
        assert_eq!(s.kind, "symlink");
        assert_eq!(s.link_target.as_deref(), Some("real.txt"));

        let far = stat(&conn, &id, "far.txt").unwrap();
        assert_eq!(far.kind, "symlink");
    }
}

pub mod dav;
mod dav_fs;
pub mod index;
pub mod uploads;
