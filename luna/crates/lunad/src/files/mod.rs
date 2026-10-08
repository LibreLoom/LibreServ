//! File operations on adopted drives.
//!
//! Every path is resolved through the canonicalizing path jail from
//! `luna-core`; `..`, absolute paths, and symlink escapes are impossible.
//! Writes are temp-file + fsync + atomic-rename so a power cut can never
//! leave a half-written user file.

use std::path::{Path, PathBuf};

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
    /// Luna held this file in RAM but couldn't write it to the drive (it
    /// was unplugged, or the write failed). UI shows "Didn't save".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub save_failed: bool,
    /// The name the item had before it was trashed — only set on rows
    /// listed inside `.luna-trash`, whose on-disk names carry a
    /// `{nonce}-` prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_name: Option<String>,
    /// Drive-relative path the item lived at before it was trashed, when
    /// `trash_meta` still knows it. Only set inside `.luna-trash`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    /// Stored target when `kind == "symlink"` — the same value `stat`
    /// reports. Guests (share links) have it scrubbed before the listing
    /// leaves the API: it can be an absolute host path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// The requesting user's capabilities on this entry, stamped by the API
    /// layer ("full+share", "view", "upload", …). Empty when unstamped —
    /// internal producers and guest-link listings never carry it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub caps: String,
    /// A private folder — a boundary only its owner and the people it is
    /// shared with can reach. Stamped on listings from the drive's
    /// private-item rows.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
    /// An ordinary item protected because a private folder sits above it.
    /// Not set on the private folder itself.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_private: bool,
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
    /// The pre-trash name for top-level trash entries (nonce prefix
    /// stripped) — the UI shows this instead of the on-disk name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_name: Option<String>,
    /// Recursive size + counts for folders — `None` when the tree was too
    /// large to count quickly, or for non-folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals: Option<FolderTotals>,
    /// The requesting user's capabilities on this path, stamped by the API
    /// layer. Empty when unstamped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub caps: String,
    /// A private folder (see [`FileEntry::private`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
    /// Protected because a private folder sits above this path — not a
    /// boundary itself (see [`FileEntry::in_private`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_private: bool,
}

/// One row in the drive's trash dir, with the path it came from when metadata
/// exists. Test-only: the API lists trash through `list_trash_dir`.
#[cfg(test)]
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TrashEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    /// Drive-relative path before the item was trashed (empty when unknown).
    pub original_path: String,
    /// A private item: it answers to its owner, wherever it came from.
    pub private: bool,
}

/// Stable API-facing alias for the drive's real `.luna-<uuid>-trash`
/// directory — responses and requests use `.luna-trash` so the on-disk
/// prefix never leaks into the web API contract.
pub const TRASH_API_ALIAS: &str = ".luna-trash";

/// Shown when the drive row exists and the mount is there, but the
/// `.luna-<uuid>.sqlite3` microdb is gone. This is not an unplug.
pub const MISSING_DRIVE_DB_MSG: &str = "Luna's database for this drive is missing. The drive is still plugged in. On the Drives page, remove this drive, then add it again.";

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error(
        "Luna doesn't know this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in."
    )]
    UnknownDrive,
    #[error("{}", MISSING_DRIVE_DB_MSG)]
    MissingDriveDb,
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

pub(crate) use luna_core::path::{resolve_child, resolve_for_create_nofollow};

/// The name a file goes by: its own, or for a private item (stored under a
/// `.luna-` name) the real one. Names, extensions and types come from this,
/// never from the storage name.
pub fn leaf_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if crate::drives::layout::Layout::is_luna_name(name) {
        return crate::private::name_for_disk(name);
    }
    Some(name.to_string())
}

/// Where `name` lives in the folder at `dir`: its own path, or the
/// `.luna-` entry of the private item that has that name.
pub fn entry_path(dir: &Path, name: &str) -> PathBuf {
    match crate::private::entry_in(dir, name) {
        Some(disk) => dir.join(disk),
        None => dir.join(name),
    }
}

/// Is `name` taken in the folder at `dir`, by a plain or a private item?
pub fn name_taken(dir: &Path, name: &str) -> bool {
    entry_path(dir, name).symlink_metadata().is_ok()
}

/// Create a new directory at `dest`, failing when the name is taken —
/// including by a private item, which sits under another name on disk.
pub fn create_dir_new(dest: &Path) -> std::io::Result<()> {
    if crate::private::sibling_clash(dest) {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::create_dir(dest)
}

fn already_exists() -> FilesError {
    FilesError::Io(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
}

pub fn drive_root(conn: &rusqlite::Connection, drive_id: &str) -> Result<DriveRow, FilesError> {
    crate::private::install();
    db::get_drive(conn, drive_id)
        .map_err(FilesError::Db)?
        // An unplugged or ejected drive keeps its old mount path in the row;
        // reading it would only find an empty folder and blame the drive's
        // database. Say it is not connected instead.
        .filter(|d| !d.mount_point.is_empty() && d.state != "missing" && d.state != "ejected")
        .ok_or(FilesError::UnknownDrive)
}

pub(crate) fn open_drive_db(drive: &DriveRow) -> Result<rusqlite::Connection, FilesError> {
    crate::drives::drive_db::open(std::path::Path::new(&drive.mount_point))
        .map_err(files_error_from_drive_db)
}

/// A missing adoption microdb is its own failure. Other database problems
/// stay [`FilesError::Db`].
fn files_error_from_drive_db(err: anyhow::Error) -> FilesError {
    let text = err.to_string();
    if text.contains("no .luna-") && text.contains("marker") {
        FilesError::MissingDriveDb
    } else {
        FilesError::Db(err)
    }
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
    list_dir_with_cache_at(&drive_root(conn, drive_id)?, rel, cache)
}

/// [`list_dir_with_cache`] for a drive row already in hand, so the caller can
/// release the central database lock before touching the drive.
pub fn list_dir_with_cache_at(
    drive: &DriveRow,
    rel: &str,
    cache: Option<&crate::drives::ram_cache::RamCache>,
) -> Result<Vec<FileEntry>, FilesError> {
    let rel = canonical_rel(rel)?;
    let mut entries = list_dir_unstamped(drive, &rel, cache)?;
    // The index and RAM cache hold names only; which entries are private
    // comes from the drive's rows, so it is always current.
    let root = PathBuf::from(&drive.mount_point);
    let parent = real_rel(&root, &rel);
    let private = crate::private::children_of(&root, &parent);
    let in_private = crate::private::boundary_for(&root, &parent).is_some();
    if !private.is_empty() || in_private {
        let names: std::collections::HashSet<&str> = private.values().map(|i| i.name()).collect();
        for entry in &mut entries {
            entry.private = names.contains(entry.name.as_str());
            entry.in_private = in_private && !entry.private;
        }
    }
    Ok(entries)
}

fn list_dir_unstamped(
    drive: &DriveRow,
    rel: &str,
    cache: Option<&crate::drives::ram_cache::RamCache>,
) -> Result<Vec<FileEntry>, FilesError> {
    let drive_id = drive.id.as_str();
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
    // Nanosecond stamp, not seconds: a whole-second comparison would hide
    // any write that lands in the same second as the last index fill.
    let mtime = index::dir_stamp(&meta);

    if let Some(cache) = cache
        && let Some(mut entries) = cache.get_listing(drive_id, &rel, Some(mtime))
    {
        cache.overlay_dirty_listing(drive_id, &rel, &mut entries);
        return Ok(entries);
    }

    let drive_conn = open_drive_db(drive)?;
    let mut entries = if let Some(entries) =
        crate::files::index::fresh_entries(&drive_conn, drive_id, &rel, mtime)
    {
        entries
    } else {
        let entries = read_dir_entries_in(
            &dir,
            &crate::private::children_of(&root, &rel),
            crate::private::boundary_for(&root, &rel).is_some(),
        )?;
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
    read_dir_entries_in(dir, &std::collections::HashMap::new(), false)
}

/// Like [`read_dir_entries`], showing each private item under its real name.
/// `private` maps on-disk names to rows (see [`crate::private::children_of`]);
/// any other `.luna-` entry stays hidden, so a private entry with no row is
/// hidden from everyone.
/// `dir_in_private` says the directory being listed sits at or below a
/// private boundary — every ordinary child is then "in a private folder".
pub fn read_dir_entries_in(
    dir: &Path,
    private: &std::collections::HashMap<String, crate::private::Item>,
    dir_in_private: bool,
) -> Result<Vec<FileEntry>, FilesError> {
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
        let meta = entry.metadata().map_err(FilesError::Io)?;
        let item = private.get(name);
        if item.is_none() && is_internal_temp(name) {
            continue;
        }
        let shown = item.map_or(name, |i| i.name());
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
        let link_target = if meta.file_type().is_symlink() {
            std::fs::read_link(entry.path())
                .ok()
                .map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        };
        entries.push(FileEntry {
            hidden: luna_core::scan::is_hidden_name(shown),
            name: shown.to_string(),
            kind: kind.to_string(),
            size: meta.len(),
            modified,
            saving: false,
            save_failed: false,
            original_name: None,
            original_path: None,
            link_target,
            caps: String::new(),
            private: item.is_some(),
            in_private: dir_in_private && item.is_none(),
        });
    }

    // Folders first, then case-insensitively by name. The lowercase name is
    // built once per entry, not once per comparison.
    entries.sort_by_cached_key(|e| (e.kind != "dir", e.name.to_lowercase()));
    Ok(entries)
}

/// Forget the indexed listings a write may have invalidated: `api_rel`'s
/// parent directory plus `api_rel` itself and its indexed subtree (renames
/// and deletes of a folder). The dir-mtime freshness check alone cannot see
/// writes inside the filesystem's timestamp granularity — one second is
/// common, two on FAT32 — so every Luna write that lands must call this.
/// Best-effort: an unreadable microdb leaves the mtime guard as backstop.
pub fn note_write(conn: &rusqlite::Connection, drive_id: &str, api_rel: &str) {
    let Ok(drive) = drive_root(conn, drive_id) else {
        return;
    };
    note_write_at(&drive, drive_id, api_rel);
}

/// [`note_write`] for a drive row already in hand.
pub fn note_write_at(drive: &DriveRow, drive_id: &str, api_rel: &str) {
    let Ok(dconn) = open_drive_db(drive) else {
        return;
    };
    let root = PathBuf::from(&drive.mount_point);
    let api_rel = canonical_rel(api_rel).unwrap_or_else(|_| api_rel.to_string());
    let rel = real_rel(&root, &api_rel);
    let parent = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let _ = index::forget_dir(&dconn, drive_id, parent);
    let _ = index::forget_dir_tree(&dconn, drive_id, &rel);
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
    resolve_any_ex(conn, drive_id, rel, false)
}

/// Like [`resolve_any`], but the `.luna-trash` alias resolves into the
/// drive's real trash dir. Read paths only — writes stay rejected.
pub fn resolve_any_including_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    resolve_any_ex(conn, drive_id, rel, true)
}

fn resolve_any_ex(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    allow_trash: bool,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    resolve_any_at(&drive_root(conn, drive_id)?, rel, allow_trash)
}

/// [`resolve_any`] (or, with `allow_trash`, [`resolve_any_including_trash`])
/// for a drive row already in hand.
pub fn resolve_any_at(
    drive: &DriveRow,
    rel: &str,
    allow_trash: bool,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let root = PathBuf::from(&drive.mount_point);
    let rel = canonical_rel(rel)?;
    let real = real_rel(&root, &rel).into_owned();
    // Trash resolves through the `.luna-trash` API alias only — a raw
    // `{prefix}-trash` name would reach any entry with no origin check.
    if is_internal_temp(&real) && !(allow_trash && is_trash_api(&rel)) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let path = resolve_child(&root, real.as_ref())?;
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
    stat_at(&drive_root(conn, drive_id)?, rel)
}

/// [`stat`] for a drive row already in hand.
pub fn stat_at(drive: &DriveRow, rel: &str) -> Result<FileStat, FilesError> {
    let root = PathBuf::from(&drive.mount_point);
    let rel = canonical_rel(rel)?;
    let real = real_rel(&root, &rel).into_owned();
    // Trash entries answer through the `.luna-trash` alias only — a raw
    // `{prefix}-trash` name would stat any entry with no origin check.
    if is_trash_rel(&real) && !is_trash_api(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let rel = real;
    // The trash root is created on the first delete. Until then it is an
    // empty folder, the same answer `list_trash_dir` gives.
    if is_trash_root(&rel)
        && std::fs::symlink_metadata(root.join(rel.trim_matches('/')))
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(FileStat {
            name: rel.trim_matches('/').to_string(),
            kind: "dir".into(),
            size: 0,
            modified: 0,
            created: None,
            hidden: true,
            link_target: None,
            children: Some(ChildCounts {
                dirs: 0,
                files: 0,
                other: 0,
            }),
            saving: false,
            writable: false,
            trashed_from: None,
            original_name: None,
            totals: None,
            caps: String::new(),
            private: false,
            in_private: false,
        });
    }
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
        let entries = read_dir_entries_in(
            &path,
            &crate::private::children_of(&root, &rel),
            crate::private::boundary_for(&root, &rel).is_some(),
        )?;
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
        original_name: None,
        totals: None,
        caps: String::new(),
        private: crate::private::item_at(&root, &rel).is_some(),
        in_private: crate::private::item_at(&root, &rel).is_none()
            && crate::private::boundary_for(&root, &rel).is_some(),
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
    // A private leaf sits on disk under its `.luna-` name.
    let path = if leaf.is_empty() {
        parent
    } else {
        parent.join(
            crate::private::disk_leaf(root, trimmed)
                .as_deref()
                .unwrap_or(leaf),
        )
    };
    Ok((path, leaf.to_string()))
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
    let rel = canonical_rel(rel)?;
    let real = real_rel(&root, &rel).into_owned();
    if is_trash_rel(&real) && !is_trash_api(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let start = resolve_leaf(&root, real.as_ref())?.0;
    let meta = std::fs::symlink_metadata(&start).map_err(FilesError::Io)?;
    if !meta.file_type().is_dir() {
        return Ok(None);
    }
    Ok(Some(walk_totals(
        &root,
        start,
        real.trim_end_matches('/'),
        include,
        TOTALS_MAX_ENTRIES,
        std::time::Instant::now() + TOTALS_TIME_BUDGET,
    )))
}

/// The walk behind [`folder_totals`], split out so tests can shrink the
/// bounds. `start` must already be verified a real directory.
fn walk_totals(
    root: &Path,
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
        let private = crate::private::children_of(root, &dir_rel);
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
            let Some(disk) = name.to_str() else {
                continue;
            };
            let item = private.get(disk);
            if item.is_none() && is_internal_temp(disk) {
                continue;
            }
            let name = item.map_or(disk, |i| i.name());
            seen += 1;
            if seen > max_entries
                || (seen.is_multiple_of(512) && std::time::Instant::now() > deadline)
            {
                // Stopped early — what was counted stands as a lower bound.
                return totals;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let file_type = meta.file_type();
            let child = if dir_rel.is_empty() {
                name.to_string()
            } else {
                format!("{dir_rel}/{name}")
            };
            // A private item counts only for people who may read it.
            let readable = readable && (item.is_none() || include(&child));
            if file_type.is_dir() {
                if readable {
                    totals.dirs += 1;
                }
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

/// [`file_path`] / [`file_path_including_trash`] for a drive row already in
/// hand.
pub fn file_path_at(
    drive: &DriveRow,
    rel: &str,
    allow_trash: bool,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let (path, meta) = resolve_any_at(drive, rel, allow_trash)?;
    if !meta.is_file() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a file",
        )));
    }
    Ok((path, meta))
}

/// Like [`file_path`], but `.luna-trash` alias paths resolve — reading a
/// trashed file is allowed; writing is not.
pub fn file_path_including_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let (path, meta) = resolve_any_including_trash(conn, drive_id, rel)?;
    if !meta.is_file() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a file",
        )));
    }
    Ok((path, meta))
}

/// The real on-drive rel path for an API path — translates the
/// `.luna-trash` alias into this drive's `{prefix}-trash` name. Callers
/// that open the filesystem directly (open_verified) need the real name;
/// the alias exists only in the API.
pub fn real_rel_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<String, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    Ok(real_rel(&root, &canonical_rel(rel)?).into_owned())
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
    include_rel: impl FnMut(&str) -> bool,
) -> Result<usize, FilesError> {
    write_folder_zip_ex(conn, drive_id, rel, writer, include_rel, false)
}

/// Like [`write_folder_zip`], but `.luna-trash` alias paths resolve — a
/// trashed folder can be downloaded before it is purged or put back.
pub fn write_folder_zip_including_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    writer: impl std::io::Write + std::io::Seek,
    include_rel: impl FnMut(&str) -> bool,
) -> Result<usize, FilesError> {
    write_folder_zip_ex(conn, drive_id, rel, writer, include_rel, true)
}

fn write_folder_zip_ex(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    writer: impl std::io::Write + std::io::Seek,
    include_rel: impl FnMut(&str) -> bool,
    allow_trash: bool,
) -> Result<usize, FilesError> {
    let plan = zip_plan(conn, drive_id, rel, allow_trash)?;
    write_zip_from_plan(plan, writer, include_rel)
}

/// What a folder zip needs from the database, gathered up front so the walk
/// and compression that follow can run without holding the database lock.
pub struct ZipPlan {
    folder: PathBuf,
    root: PathBuf,
    rel: String,
    archive_root: String,
    trash_names: std::collections::HashMap<String, String>,
}

pub fn zip_plan(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    allow_trash: bool,
) -> Result<ZipPlan, FilesError> {
    let rel = canonical_rel(rel)?;
    let (folder, meta) = resolve_any_ex(conn, drive_id, &rel, allow_trash)?;
    if !meta.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a directory",
        )));
    }
    let root = PathBuf::from(drive_root(conn, drive_id)?.mount_point);

    // A top-level trash entry's on-disk name carries a `{nonce}-` prefix —
    // the zip should be named after what the folder used to be called.
    let archive_root = match rel.strip_prefix(&format!("{TRASH_API_ALIAS}/")) {
        Some(rest) if !rest.contains('/') => {
            content_disposition_filename(&original_name_from_trash(rest))
        }
        _ => zip_archive_basename(&rel),
    };
    // Zipping the trash root itself gives each top-level entry its real
    // name inside the archive instead of `{nonce}-` storage noise.
    let trash_names = if allow_trash && rel == TRASH_API_ALIAS {
        trash_top_level_names(conn, drive_id)
    } else {
        std::collections::HashMap::new()
    };
    Ok(ZipPlan {
        folder,
        root,
        rel,
        archive_root,
        trash_names,
    })
}

/// Walk and compress a planned folder. Touches the drive only.
pub fn write_zip_from_plan(
    plan: ZipPlan,
    writer: impl std::io::Write + std::io::Seek,
    mut include_rel: impl FnMut(&str) -> bool,
) -> Result<usize, FilesError> {
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let ZipPlan {
        folder,
        root,
        rel,
        archive_root,
        trash_names,
    } = plan;
    let rel = rel.as_str();
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut file_count = 0usize;
    // (absolute dir, path inside zip, drive-relative dir)
    let mut stack = vec![(folder, archive_root.clone(), normalize_zip_rel(rel))];

    zip.add_directory(format!("{archive_root}/"), options)
        .map_err(|e| FilesError::Io(std::io::Error::other(e)))?;

    while let Some((abs_dir, zip_prefix, drive_rel)) = stack.pop() {
        let read = std::fs::read_dir(&abs_dir).map_err(FilesError::Io)?;
        let private = crate::private::children_of(&root, &real_rel(&root, &drive_rel));
        for entry in read {
            let entry = entry.map_err(FilesError::Io)?;
            let file_name = entry.file_name();
            let Some(disk) = file_name.to_str() else {
                continue;
            };
            let item = private.get(disk);
            if item.is_none() && is_internal_temp(disk) {
                continue;
            }
            let name = item.map_or(disk, |i| i.name());
            let child_rel = if drive_rel.is_empty() {
                name.to_string()
            } else {
                format!("{drive_rel}/{name}")
            };
            if !include_rel(&child_rel) {
                continue;
            }
            let meta = entry.metadata().map_err(FilesError::Io)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let zip_name = trash_names.get(name).map(String::as_str).unwrap_or(name);
            let zip_path = format!("{zip_prefix}/{zip_name}");
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
    let rel = real_rel(&root, &canonical_rel(rel)?).into_owned();
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
    let rel = real_rel(&root, &canonical_rel(rel)?).into_owned();
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

/// [`is_internal_temp`] for an absolute on-disk path: a private item's
/// `.luna-<uuid>-<id>` segment is the item itself, not Luna bookkeeping.
pub fn is_internal_abs(path: &str) -> bool {
    path.split('/').any(|seg| {
        crate::drives::layout::Layout::is_luna_name(seg)
            && !crate::private::is_private_disk_name(seg)
    }) || path
        .rsplit('/')
        .next()
        .is_some_and(|base| base.starts_with('.') && base.ends_with(".part"))
}

/// Translate the `.luna-trash/...` API alias into this drive's real
/// `{prefix}-trash/...` path. Non-alias paths pass through unchanged.
pub(crate) fn real_rel<'a>(root: &Path, rel: &'a str) -> std::borrow::Cow<'a, str> {
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
pub(crate) fn is_trash_rel(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    luna_core::marker::extract_prefix(first).is_some_and(|p| first == format!("{p}-trash"))
}

/// Is `rel` the trash ROOT itself — the `{prefix}-trash` dir with no entry
/// beneath it? Operates on real (post-translation) paths, so a resolved
/// `.luna-trash` alias root lands here too.
pub(crate) fn is_trash_root(rel: &str) -> bool {
    let trimmed = rel.trim_matches('/');
    is_trash_rel(trimmed) && !trimmed.contains('/')
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

/// The one spelling every drive-relative path is reduced to: empty and `.`
/// segments fold away (so `a//b`, `a/./b`, `/a/b/` are all `a/b`), while
/// `..` and `\` are refused outright rather than reinterpreted. Grants,
/// private rows, capability checks and the path jail must all answer on
/// this same form — a path that only reaches a file un-normalized is a
/// path checked under one spelling and opened under another.
pub fn canonical_rel(rel: &str) -> Result<String, FilesError> {
    if rel.contains('\\') {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid path",
        )));
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in rel.trim().trim_matches('/').split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                return Err(FilesError::Path(luna_core::path::PathError::Escape));
            }
            s => out.push(s),
        }
    }
    Ok(out.join("/"))
}

/// Atomically install `temp` as `dest`.
///
/// When `overwrite` is false, the install must fail if `dest` already exists.
/// Prefer `renameat2(RENAME_NOREPLACE)` (atomic, works on ext4 and on
/// FAT/exFAT same-folder). Fall back to hard link, then to a checked rename,
/// because some USB/FUSE mounts reject `link(2)` with EPERM.
pub fn install_temp(temp: &Path, dest: &Path, overwrite: bool) -> Result<(), FilesError> {
    if overwrite {
        if crate::private::sibling_clash(dest) {
            return Err(already_exists());
        }
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

pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    if crate::private::sibling_clash(to) {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
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
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from_c = std::ffi::CString::new(from.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path"))?;
        let to_c = std::ffi::CString::new(to.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path"))?;
        // renamex_np(RENAME_EXCL) is macOS's atomic no-replace rename —
        // EEXIST when `to` is taken, same contract as RENAME_NOREPLACE.
        // SAFETY: both paths are NUL-terminated CStrings.
        let rc = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
    let rel = real_rel(&root, &canonical_rel(rel)?).into_owned();
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
    // A private item goes in under its `.luna-` disk name; the `{nonce}-`
    // entry name is its real name in the trash, as for any other item.
    let private_leaf = crate::private::disk_leaf(&root, &trash_rel);
    let name = if private_leaf.is_some() {
        trash_rel.rsplit('/').next().unwrap_or(&name).to_string()
    } else {
        name
    };
    let mut entry = format!("{nonce}-{name}");
    let mut n = 1;
    // No-replace moves into the trash: two concurrent deletes within the same
    // second each land on their own nonce suffix instead of racing on an
    // exists() check and having rename(2) clobber the first entry.
    let dest = loop {
        let dest = trash.join(private_leaf.as_deref().unwrap_or(&entry));
        let logical = format!("{}/{entry}", layout.trash_name());
        let taken = crate::private::item_at(&root, &logical).is_some()
            || (private_leaf.is_some() && std::fs::symlink_metadata(trash.join(&entry)).is_ok());
        if !taken {
            match rename_noreplace(&path, &dest) {
                Ok(()) => break dest,
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists && private_leaf.is_none() => {}
                Err(e) => return Err(FilesError::Io(e)),
            }
        }
        entry = format!("{nonce}-{n}-{name}");
        n += 1;
    };
    // The private boundary this item sat under (or was) BEFORE its row
    // moves into the trash namespace below.
    let provenance = crate::private::boundary_for(&root, &trash_rel);
    if let Err(e) = crate::private::repath(
        &root,
        &trash_rel,
        &format!("{}/{entry}", layout.trash_name()),
    ) {
        // Put the item back so its row and its place on disk still agree.
        let _ = rename_noreplace(&dest, &path);
        return Err(FilesError::Db(e));
    }
    crate::api::forms::repath_form_files_named(&root, &path, &name, &root, &dest, &entry);
    if let Ok(dir) = std::fs::File::open(&trash) {
        let _ = dir.sync_all();
    }
    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    // Record where it came from AND the private boundary it sat under at
    // delete time — the boundary row itself may move or disappear later,
    // but the entry's confidentiality must not depend on that. `provenance`
    // was computed above, before `repath` moved this item's own row.
    write_trash_meta(
        &root,
        &entry,
        &TrashMeta {
            original_path: trash_rel.clone(),
            private_owner: provenance
                .as_ref()
                .map(|b| b.owner.clone())
                .unwrap_or_default(),
            private_path: provenance.map(|b| b.path).unwrap_or_default(),
        },
    )?;
    // Trash is a revoke, not a move: grants on the trashed subject die here
    // and restoring the file never brings them back.
    crate::access::drop_subjects_under(conn, drive_id, &trash_rel).map_err(FilesError::Db)?;
    note_write(conn, drive_id, &trash_rel);
    // Return the API-alias path (`trash_meta` keeps the real entry name, which
    // is shared by both forms since the alias only swaps the dir prefix).
    Ok(format!("{TRASH_API_ALIAS}/{entry}"))
}

/// What a top-level trash entry remembers: where it came from and the
/// private folder it sat under when it was deleted (`private_*` empty when
/// it was not protected). Provenance survives the boundary's row moving or
/// disappearing — a private folder renamed, trashed, or purged later can
/// never expose a child that was deleted while inside it.
#[derive(Debug, Clone, Default)]
pub struct TrashMeta {
    pub original_path: String,
    /// Owner of the private folder the item sat under ("" = none).
    pub private_owner: String,
    /// That private folder's path at delete time.
    pub private_path: String,
}

fn write_trash_meta(
    drive_root: &Path,
    entry_name: &str,
    meta: &TrashMeta,
) -> Result<(), FilesError> {
    let conn = crate::drives::drive_db::open(drive_root).map_err(files_error_from_drive_db)?;
    conn.execute(
        "INSERT OR REPLACE INTO trash_meta (entry_name, original_path, private_owner, private_path)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            entry_name,
            meta.original_path,
            meta.private_owner,
            meta.private_path
        ],
    )
    .map_err(|e| FilesError::Db(e.into()))?;
    Ok(())
}

fn read_trash_meta(drive_root: &Path, entry_name: &str) -> Option<TrashMeta> {
    let conn = crate::drives::drive_db::open(drive_root).ok()?;
    conn.query_row(
        "SELECT original_path, private_owner, private_path FROM trash_meta WHERE entry_name = ?1",
        rusqlite::params![entry_name],
        |row| {
            Ok(TrashMeta {
                original_path: row.get(0)?,
                private_owner: row.get(1)?,
                private_path: row.get(2)?,
            })
        },
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

/// The leaf name a trash path should display as. `trash_rel` is the real
/// `{prefix}-trash/...` form. Top-level entries strip their `{nonce}-`
/// prefix; deeper paths already carry real names. `None` when `trash_rel`
/// is not inside a trash dir.
pub fn trash_display_name(trash_rel: &str) -> Option<String> {
    let (entry, rest) = trash_entry_parts(trash_rel)?;
    Some(match rest {
        None => original_name_from_trash(entry),
        Some(rest) => rest.rsplit('/').next().unwrap_or(rest).to_string(),
    })
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

/// List a directory inside the drive's trash — the `.luna-trash` API
/// alias, at any depth. Trash is never indexed or listing-cached, so this
/// is always a fresh `read_dir`. A drive with nothing deleted has no
/// trash dir at all: the root then lists as empty rather than "not found".
pub fn list_trash_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<Vec<FileEntry>, FilesError> {
    list_trash_dir_at(&drive_root(conn, drive_id)?, rel)
}

/// [`list_trash_dir`] for a drive row already in hand.
pub fn list_trash_dir_at(drive: &DriveRow, rel: &str) -> Result<Vec<FileEntry>, FilesError> {
    let root = PathBuf::from(&drive.mount_point);
    let rel = canonical_rel(rel)?;
    // The API alias only: a raw `{prefix}-trash` name would list entries
    // with no origin-based filtering at all.
    if !is_trash_api(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let rel = real_rel(&root, &rel).into_owned();
    if !is_trash_rel(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let dir = match resolve_child(&root, rel.as_ref()) {
        Ok(dir) => dir,
        Err(luna_core::path::PathError::NotFound(_)) => {
            let is_root =
                crate::drives::layout::Layout::detect(&root).is_some_and(|l| rel == l.trash_name());
            if is_root {
                return Ok(Vec::new());
            }
            return Err(FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            )));
        }
        Err(e) => return Err(FilesError::Path(e)),
    };
    if !dir.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "not a directory",
        )));
    }
    read_dir_entries_in(
        &dir,
        &crate::private::children_of(&root, &rel),
        crate::private::boundary_for(&root, &rel).is_some(),
    )
}

/// List items sitting in the drive's `{prefix}-trash` dir (test-only).
#[cfg(test)]
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
    let entries = read_dir_entries_in(
        &trash,
        &crate::private::children_of(&root, &layout.trash_name()),
        false,
    )?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let meta = read_trash_meta(&root, &entry.name).unwrap_or_default();
            TrashEntry {
                original_path: meta.original_path,
                name: entry.name,
                kind: entry.kind,
                size: entry.size,
                modified: entry.modified,
                // A private row repathed into trash marks it; so does
                // provenance recorded for an ordinary child of a private
                // folder, whose protection no live row still describes.
                private: entry.private || !meta.private_owner.is_empty(),
            }
        })
        .collect())
}

/// Every `trash_meta` row for the drive rooted at `drive_root`:
/// trash entry name → its provenance.
pub fn trash_meta_map(drive_root: &Path) -> std::collections::HashMap<String, TrashMeta> {
    let Ok(conn) = crate::drives::drive_db::open(drive_root) else {
        return Default::default();
    };
    let Ok(mut stmt) = conn
        .prepare("SELECT entry_name, original_path, private_owner, private_path FROM trash_meta")
    else {
        return Default::default();
    };
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            TrashMeta {
                original_path: row.get(1)?,
                private_owner: row.get(2)?,
                private_path: row.get(3)?,
            },
        ))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

/// The private boundary recorded for a trash path, if the entry it belongs
/// to was inside a private folder (or was one) when deleted. Survives the
/// boundary's row later moving or disappearing.
pub fn trash_private_meta(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<Option<TrashMeta>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    // Provenance answers through the `.luna-trash` alias only — a raw
    // `{prefix}-trash` name must not hand the API another spelling.
    let Ok(trash_rel) = canonical_rel(trash_rel) else {
        return Ok(None);
    };
    if !is_trash_api(&trash_rel) {
        return Ok(None);
    }
    let trash_rel = real_rel(&root, &trash_rel);
    let Some((entry_name, _rest)) = trash_entry_parts(&trash_rel) else {
        return Ok(None);
    };
    Ok(read_trash_meta(&root, entry_name).filter(|m| !m.private_owner.is_empty()))
}

/// Whether `rel` is the `.luna-trash` API alias root or a path inside it.
/// Real `{prefix}-trash` names are covered by [`is_trash_rel`].
pub fn is_trash_api(rel: &str) -> bool {
    rel == TRASH_API_ALIAS || rel.starts_with(&format!("{}/", TRASH_API_ALIAS))
}

/// Drop origin metadata for a top-level trash entry that left trash through
/// a raw move (jobs engine, `move_rel`). Restore and purge handle their own
/// metadata; nested paths keep the entry's meta — it still owns the rest.
pub fn forget_trash_entry(conn: &rusqlite::Connection, drive_id: &str, api_rel: &str) {
    let Ok(drive) = drive_root(conn, drive_id) else {
        return;
    };
    let root = PathBuf::from(&drive.mount_point);
    let Ok(api_rel) = canonical_rel(api_rel) else {
        return;
    };
    if !is_trash_api(&api_rel) {
        return;
    }
    let real = real_rel(&root, &api_rel);
    if let Some((entry, None)) = trash_entry_parts(&real) {
        remove_trash_meta(&root, entry);
    }
}

/// The leaf name a trash path lands under when copied or moved out — the
/// original basename for top-level entries (the `{nonce}-` prefix is
/// storage noise), the real leaf name for paths deeper inside a trashed
/// folder. `None` for non-trash paths.
pub fn trash_api_leaf(
    conn: &rusqlite::Connection,
    drive_id: &str,
    api_rel: &str,
) -> Result<Option<String>, FilesError> {
    let api_rel = canonical_rel(api_rel)?;
    // The origin metadata holds the true name — a rename in trash retitles
    // the meta while the on-disk name keeps its `{nonce}-` prefix.
    if let Ok(Some(origin)) = trash_original_path(conn, drive_id, &api_rel)
        && let Some(leaf) = origin.rsplit('/').next()
        && !leaf.is_empty()
    {
        return Ok(Some(leaf.to_string()));
    }
    let real = real_rel_path(conn, drive_id, &api_rel)?;
    // A raw `{prefix}-trash` name is never a leaf source: the API alias is
    // the only spelling that maps an entry to its origin.
    if is_trash_rel(&real) && !is_trash_api(&api_rel) {
        return Ok(None);
    }
    Ok(trash_display_name(&real))
}

/// `{nonce}-entry` → display leaf for every top-level trash entry. Copies
/// and archives out of the trash root rename their children so the
/// storage prefix never leaves the drive.
pub fn trash_top_level_names(
    conn: &rusqlite::Connection,
    drive_id: &str,
) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(drive) = drive_root(conn, drive_id) else {
        return map;
    };
    let root = PathBuf::from(&drive.mount_point);
    let meta = trash_meta_map(&root);
    let Some(layout) = crate::drives::layout::Layout::detect(&root) else {
        return map;
    };
    let Ok(read) = std::fs::read_dir(layout.trash_dir(&root)) else {
        return map;
    };
    let private = crate::private::children_of(&root, &layout.trash_name());
    for entry in read.flatten() {
        let Some(disk) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let name = private.get(&disk).map_or(disk, |i| i.name().to_string());
        let leaf = meta
            .get(&name)
            .and_then(|m| m.original_path.rsplit('/').next())
            .map(str::to_string)
            .unwrap_or_else(|| original_name_from_trash(&name));
        map.insert(name, leaf);
    }
    map
}

/// Split a real `{prefix}-trash/...` rel path into its top-level trash
/// entry name and the path inside that entry (if any).
fn trash_entry_parts(trash_rel: &str) -> Option<(&str, Option<&str>)> {
    if !is_trash_rel(trash_rel) {
        return None;
    }
    let after_root = trash_rel.split_once('/')?.1;
    if after_root.is_empty() {
        return None;
    }
    match after_root.split_once('/') {
        Some((entry, rest)) => Some((entry, Some(rest))),
        None => Some((after_root, None)),
    }
}

/// Drive-relative path the trashed item came from, if metadata exists.
/// `trash_rel` must use the `.luna-trash` API alias — a raw
/// `{prefix}-trash` name never answers — and may point inside a trashed
/// folder: a nested path inherits its top-level entry's origin (`docs`
/// trashed → `docs/sub/file` is the origin of `.luna-trash/{entry}/sub/file`).
pub fn trash_original_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<Option<String>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let trash_rel = canonical_rel(trash_rel)?;
    if !is_trash_api(&trash_rel) {
        return Ok(None);
    }
    let trash_rel = real_rel(&root, &trash_rel);
    let Some((entry_name, rest)) = trash_entry_parts(&trash_rel) else {
        return Ok(None);
    };
    Ok(read_trash_meta(&root, entry_name).map(|meta| match rest {
        Some(rest) => format!("{}/{rest}", meta.original_path),
        None => meta.original_path,
    }))
}

/// Move an item out of trash onto the same drive (atomic rename).
/// `trash_rel` must use the `.luna-trash` API alias — a raw
/// `{prefix}-trash` name would relocate any entry with no origin check.
/// `dest_rel` is the destination path including the restored file name.
pub fn restore_from_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
    dest_rel: &str,
) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let trash_api = canonical_rel(trash_rel)?;
    let dest_rel = canonical_rel(dest_rel)?;
    let trash_rel = real_rel(&root, &trash_api);
    // Only whole top-level entries restore — a nested move-out would orphan
    // the parent's trash_meta (its original path is still needed to put the
    // rest back).
    if !is_trash_api(&trash_api)
        || trash_entry_parts(&trash_rel).is_none_or(|(_, rest)| rest.is_some())
    {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    if is_trash_rel(&dest_rel)
        || is_internal_temp(&dest_rel)
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
    let dest_path = Path::new(&dest_rel);
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
    // A private item keeps its `.luna-` disk name; its real name must be
    // free of plain and private items alike.
    let dest_real = dest_rel.as_str();
    let private_leaf = crate::private::disk_leaf(&root, &trash_rel);
    if crate::private::item_at(&root, dest_real).is_some()
        || (private_leaf.is_some() && resolve_child(&root, dest_real).is_ok())
    {
        return Err(already_exists());
    }
    let dest = parent.join(private_leaf.as_deref().unwrap_or(&dest_name));
    // No-replace move: a concurrent restore to the same name gets
    // AlreadyExists instead of silently clobbering the earlier winner.
    rename_noreplace(&src, &dest).map_err(FilesError::Io)?;
    if let Err(e) = crate::private::repath(&root, &trash_rel, dest_real) {
        let _ = rename_noreplace(&dest, &src);
        return Err(FilesError::Db(e));
    }
    crate::api::forms::repath_form_files_named(
        &root,
        &src,
        trash_entry_name(&trash_rel).unwrap_or(&dest_name),
        &root,
        &dest,
        &dest_name,
    );
    if let Some(parent) = dest.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    if let Some(entry_name) = trash_entry_name(&trash_rel) {
        remove_trash_meta(&root, entry_name);
    }
    note_write(conn, drive_id, &dest_rel);
    note_write(conn, drive_id, &trash_rel);
    Ok(())
}

/// Permanently remove one item that is already in the drive's trash dir.
/// `trash_rel` must use the `.luna-trash` API alias — a raw
/// `{prefix}-trash` name would delete any entry with no origin check.
pub fn purge_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<(), FilesError> {
    purge_trash_at(&drive_root(conn, drive_id)?, drive_id, trash_rel)
}

/// [`purge_trash`] for a drive row already in hand, so the (possibly long)
/// delete runs without the database lock. Callers hold the drive's mutation
/// lock instead.
pub fn purge_trash_at(drive: &DriveRow, drive_id: &str, trash_rel: &str) -> Result<(), FilesError> {
    let root = PathBuf::from(&drive.mount_point);
    let trash_api = canonical_rel(trash_rel)?;
    if !is_trash_api(&trash_api) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    let trash_rel = real_rel(&root, &trash_api);
    let Some((entry_name, rest)) = trash_entry_parts(&trash_rel) else {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    };
    let path = resolve_child(&root, trash_rel.as_ref())?;
    let meta = std::fs::symlink_metadata(&path).map_err(FilesError::Io)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(FilesError::Io)?;
    } else {
        std::fs::remove_file(&path).map_err(FilesError::Io)?;
        // A form's files folder and answers file go with it.
        crate::api::forms::remove_form_files(&root, &path);
    }
    crate::private::remove_under(&root, &trash_rel).map_err(FilesError::Db)?;
    // Only a whole top-level entry owns a trash_meta row — purging a child
    // inside a trashed folder must leave the entry's origin intact so the
    // rest still restores to the right place.
    if rest.is_none() {
        remove_trash_meta(&root, entry_name);
    }
    note_write_at(drive, drive_id, &trash_rel);
    Ok(())
}

/// Create a directory at `rel`. The parent must already exist. Never overwrites.
pub fn mkdir(conn: &rusqlite::Connection, drive_id: &str, rel: &str) -> Result<(), FilesError> {
    mkdir_as(conn, drive_id, rel, None)
}

/// Record a new private item at `rel` before its disk entry exists. `None`
/// owner means a plain item. A name already taken (plain or private) is
/// `AlreadyExists`, so nothing says which kind it clashed with.
fn begin_private(
    root: &Path,
    rel: &str,
    plain_path: &Path,
    owner: Option<&str>,
) -> Result<bool, FilesError> {
    let Some(owner) = owner else {
        return Ok(false);
    };
    if std::fs::symlink_metadata(plain_path).is_ok() || crate::private::item_at(root, rel).is_some()
    {
        return Err(already_exists());
    }
    crate::private::create(root, rel, owner).map_err(FilesError::Db)?;
    Ok(true)
}

/// [`mkdir`], making the folder private to `private_owner` when given.
pub fn mkdir_as(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    private_owner: Option<&str>,
) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = canonical_rel(rel)?;
    if rel.is_empty() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot create the drive root",
        )));
    }
    if is_internal_temp(&rel) || rel.split('/').next() == Some(TRASH_API_ALIAS) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let path = resolve_for_create_nofollow(&root, &rel)?;
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
    let private = begin_private(&root, &rel, &path, private_owner)?;
    let path = if private {
        resolve_for_create_nofollow(&root, &rel)?
    } else {
        path.clone()
    };
    match std::fs::create_dir(&path) {
        Ok(()) => {
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            note_write(conn, drive_id, &rel);
            Ok(())
        }
        Err(e) => {
            if private {
                let _ = crate::private::remove(&root, &rel);
            }
            Err(FilesError::Io(e))
        }
    }
}

/// Create an empty file at `rel`. The parent must already exist. Never overwrites.
/// Files are never private items — only folders are; a file inside a
/// private folder is protected by the folder's boundary.
pub fn create(conn: &rusqlite::Connection, drive_id: &str, rel: &str) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let rel = canonical_rel(rel)?;
    if rel.is_empty() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot create at the drive root without a name",
        )));
    }
    let leaf = rel.rsplit_once('/').map(|(_, name)| name).unwrap_or(&rel);
    let _ = safe_name(leaf)?;
    if is_internal_temp(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let path = resolve_for_create_nofollow(&root, &rel)?;
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
            note_write(conn, drive_id, &rel);
            Ok(())
        }
        Err(e) => Err(FilesError::Io(e)),
    }
}

/// Rename a file or folder within its current directory. Never overwrites.
/// Trash items rename too: a top-level entry keeps its generated `{nonce}-`
/// prefix on disk (the trash_meta key stays stable) while the rename
/// retitles what it restores as; deeper paths rename like anywhere else.
pub fn rename(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
    new_name: &str,
) -> Result<(), FilesError> {
    let new_name = safe_name(new_name)?;
    // A `.part`-style or `.luna-*` leaf mints a file no listing can ever
    // show — rename is a create, so it holds the same bar as mkdir/create.
    if is_internal_temp(&new_name) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let api_rel = canonical_rel(rel)?;
    let rel = real_rel(&root, &api_rel).into_owned();
    // Trash items are only reachable through the `.luna-trash` alias, where
    // caps resolve the entry to its origin. A raw `{prefix}-trash` name
    // would retitle ANY user's trash entry with no origin check at all.
    if is_trash_rel(&rel) && !is_trash_api(&api_rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    if is_internal_temp(&rel) && !is_trash_rel(&rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    // The trash root itself is the drive's own dir — it can't be renamed.
    let top_entry = match trash_entry_parts(&rel) {
        Some((entry, None)) => Some(entry.to_string()),
        _ => None,
    };
    if is_trash_rel(&rel) && trash_entry_parts(&rel).is_none() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "can't rename the trash itself",
        )));
    }
    let path = resolve_child(&root, rel.as_ref())?;
    let parent = path.parent().ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?;
    let dest_name = match top_entry.as_deref() {
        Some(entry) => {
            let orig = original_name_from_trash(entry);
            let prefix = &entry[..entry.len().saturating_sub(orig.len())];
            format!("{prefix}{new_name}")
        }
        None => new_name.clone(),
    };
    // A private item keeps its `.luna-` disk entry; only its real name
    // changes. Either way the new name must be free of plain and private
    // items alike.
    let private_leaf = crate::private::disk_leaf(&root, &rel);
    let parent_real = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let new_real = crate::gallery::gallery_indexer::join_rel(parent_real, &dest_name);
    if crate::private::item_at(&root, &new_real).is_some() {
        return Err(already_exists());
    }
    let dest = parent.join(private_leaf.as_deref().unwrap_or(&dest_name));
    if private_leaf.is_some() {
        if resolve_child(&root, &new_real).is_ok() {
            return Err(already_exists());
        }
    } else {
        // No-replace move keeps the never-overwrites contract honest under
        // concurrency; plain rename(2) would silently overwrite.
        rename_noreplace(&path, &dest).map_err(FilesError::Io)?;
    }
    if let Err(e) = crate::private::repath(&root, &rel, &new_real) {
        // A private item never moved on disk; anything else did.
        if private_leaf.is_none() {
            let _ = rename_noreplace(&dest, &path);
        }
        return Err(FilesError::Db(e));
    }
    crate::api::forms::repath_form_files_named(
        &root,
        &path,
        rel.rsplit('/').next().unwrap_or(&rel),
        &root,
        &dest,
        &dest_name,
    );
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    // Shares follow the file: member and link rows keep pointing at the
    // renamed subject (and anything under it, for folders). Subjects store
    // API paths, so repath with the `.luna-trash` form for trash items.
    let parent_rel = api_rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let new_rel = crate::gallery::gallery_indexer::join_rel(parent_rel, &dest_name);
    crate::access::repath_subjects(conn, drive_id, &api_rel, &new_rel).map_err(FilesError::Db)?;
    // A top-level entry's origin retitles with it: `docs/old` trashed and
    // renamed to `new` restores as `docs/new`.
    if let Some(old_entry) = top_entry
        && let Some(mut meta) = read_trash_meta(&root, &old_entry)
    {
        let orig_parent = meta
            .original_path
            .rsplit_once('/')
            .map(|(p, _)| p)
            .unwrap_or("");
        meta.original_path = crate::gallery::gallery_indexer::join_rel(orig_parent, &new_name);
        write_trash_meta(&root, &dest_name, &meta)?;
        remove_trash_meta(&root, &old_entry);
    }
    note_write(conn, drive_id, &api_rel);
    Ok(())
}

/// Move `from_rel` to `to_rel` (full destination path, leaf included) within
/// one drive. Same-filesystem rename only, never overwrites. Cross-device
/// copy+trash lives in the jobs engine; in-drive moves always rename.
pub fn move_rel(
    conn: &rusqlite::Connection,
    drive_id: &str,
    from_rel: &str,
    to_rel: &str,
) -> Result<(), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let api_from = canonical_rel(from_rel)?;
    let api_to = canonical_rel(to_rel)?;
    let from_rel = real_rel(&root, &api_from).into_owned();
    let to_rel = real_rel(&root, &api_to).into_owned();
    // Trash items may move out — into trash stays impossible (a delete is
    // what puts things there). Trash sources only arrive through the `.luna-trash` alias, where caps map
    // the entry to its origin: a raw `{prefix}-trash` name would relocate
    // any user's entry with no origin check.
    if is_trash_rel(&from_rel) && !is_trash_api(&api_from) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    if (is_internal_temp(&from_rel) && !is_trash_rel(&from_rel))
        || is_internal_temp(&to_rel)
        || (is_trash_rel(&from_rel) && trash_entry_parts(&from_rel).is_none())
    {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        )));
    }
    let from = resolve_child(&root, &from_rel)?;
    // Reject moving a folder into itself before resolving the destination.
    if to_rel == from_rel || to_rel.starts_with(&format!("{from_rel}/")) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "can't move an item into itself",
        )));
    }
    let to = resolve_for_create_nofollow(&root, &to_rel)?;
    let to_parent = to.parent().ok_or_else(|| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?;
    if !to_parent.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "destination folder does not exist",
        )));
    }
    // A private item keeps its `.luna-` disk name wherever it lands; the
    // real destination name must be free of plain and private items alike.
    let to = match crate::private::disk_leaf(&root, &from_rel) {
        Some(leaf) => {
            if resolve_child(&root, &to_rel).is_ok() {
                return Err(already_exists());
            }
            to.with_file_name(leaf)
        }
        None => to,
    };
    if crate::private::item_at(&root, &to_rel).is_some() {
        return Err(already_exists());
    }
    match try_rename_move(&from, &to)? {
        true => {
            if let Err(e) = crate::private::repath(&root, &from_rel, &to_rel) {
                let _ = rename_noreplace(&to, &from);
                return Err(FilesError::Db(e));
            }
            crate::api::forms::repath_form_files_named(
                &root,
                &from,
                from_rel.rsplit('/').next().unwrap_or(&from_rel),
                &root,
                &to,
                to_rel.rsplit('/').next().unwrap_or(&to_rel),
            );
            // An item leaving trash loses its origin metadata.
            if let Some((entry, None)) = trash_entry_parts(&from_rel) {
                remove_trash_meta(&root, entry);
            }
            // Shares follow the file to its new location — API paths, so a
            // link on a trash item points at wherever it lands.
            crate::access::repath_subjects(conn, drive_id, &api_from, &api_to)
                .map_err(FilesError::Db)?;
            note_write(conn, drive_id, &api_from);
            note_write(conn, drive_id, &api_to);
            Ok(())
        }
        false => Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::CrossesDevices,
            "can't move across filesystems",
        ))),
    }
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
mod tests;

pub mod dav;
mod dav_fs;
pub mod forwarding;
pub mod index;
pub mod recents;
pub mod search;
pub mod search_indexer;
pub mod search_rank;
pub mod uploads;
