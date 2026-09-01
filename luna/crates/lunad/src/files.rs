//! File operations on adopted drives.
//!
//! Every path is resolved through the canonicalizing path jail from
//! `luna-core`; `..`, absolute paths, and symlink escapes are impossible.
//! Writes are temp-file + fsync + atomic-rename so a power cut can never
//! leave a half-written user file.

use std::path::{Path, PathBuf};

use luna_core::path::resolve_child;
use serde::{Deserialize, Serialize};

use crate::db::{self, DriveRow};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub kind: String, // "dir" | "file" | "symlink" | "other"
    pub size: u64,
    pub modified: i64,
    pub hidden: bool,
}

/// One row in `.luna-trash`, with the path it came from when metadata exists.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TrashEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    /// Drive-relative path before the item was trashed (empty when unknown).
    pub original_path: String,
}

const TRASH_DIR_NAME: &str = ".luna-trash";
const TRASH_META_DIR_NAME: &str = ".meta";

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct TrashMeta {
    original_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error("Luna doesn't know this drive.")]
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

/// List one directory. Directories first, then case-insensitive by name.
///
/// Serves from the SQLite index whenever the directory mtime matches; any
/// change (Luna, WebDAV, or direct access) falls back to one fresh read_dir.
pub fn list_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<Vec<FileEntry>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let dir = resolve_child(&root, rel)?;
    if !dir.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "not a directory",
        )));
    }

    let meta = std::fs::metadata(&dir).map_err(FilesError::Io)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if let Some(entries) = crate::index::fresh_entries(conn, drive_id, rel, mtime) {
        return Ok(entries);
    }

    let entries = read_dir_entries(&dir)?;
    let _ = crate::index::replace_dir(conn, drive_id, rel, mtime, &entries);
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
    if is_internal_temp(rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "not found",
        )));
    }
    let path = resolve_child(&root, rel)?;
    let meta = std::fs::metadata(&path).map_err(FilesError::Io)?;
    Ok((path, meta))
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

/// Destination directory for a new file.
pub fn dest_dir(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<PathBuf, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let dir = resolve_child(&root, rel)?;
    if !dir.is_dir() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "not a directory",
        )));
    }
    Ok(dir)
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

/// Temporary upload/protect files Luna writes while saving. Never list or
/// download them — they are incomplete bytes, not user files.
pub fn is_internal_temp(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    base == crate::gallery::THUMBS_DIR_NAME
        || base == crate::gallery::GALLERY_DIR_NAME
        || base == crate::gallery::SHARED_ALBUMS_DIR_NAME
        || base == TRASH_DIR_NAME
        || base == TRASH_META_DIR_NAME
        || base.starts_with(".luna-upload.")
        || (base.starts_with('.') && base.ends_with(".part"))
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

/// Move a file or folder to `.luna-trash` on the same drive (atomic rename,
/// same filesystem). Returns the trash-relative path.
pub fn delete_to_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<String, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let path = resolve_child(&root, rel)?;
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

    let trash = root.join(TRASH_DIR_NAME);
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
    write_trash_meta(&trash, &trash_entry_name, &trash_rel)?;
    Ok(dest
        .strip_prefix(&root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .into_owned())
}

fn trash_meta_dir(trash: &Path) -> PathBuf {
    trash.join(TRASH_META_DIR_NAME)
}

fn trash_meta_path(trash: &Path, entry_name: &str) -> PathBuf {
    trash_meta_dir(trash).join(format!("{entry_name}.json"))
}

fn write_trash_meta(trash: &Path, entry_name: &str, original_path: &str) -> Result<(), FilesError> {
    let meta_dir = trash_meta_dir(trash);
    std::fs::create_dir_all(&meta_dir).map_err(FilesError::Io)?;
    let payload = TrashMeta {
        original_path: original_path.to_string(),
    };
    let data = serde_json::to_vec(&payload).map_err(|e| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e.to_string(),
        ))
    })?;
    let path = trash_meta_path(trash, entry_name);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp = meta_dir.join(format!(".luna-upload.{}.{nonce}", std::process::id()));
    std::fs::write(&temp, &data).map_err(FilesError::Io)?;
    if let Ok(file) = std::fs::File::open(&temp) {
        let _ = file.sync_all();
    }
    install_temp(&temp, &path, true)?;
    Ok(())
}

fn read_trash_meta(trash: &Path, entry_name: &str) -> Option<String> {
    let path = trash_meta_path(trash, entry_name);
    let data = std::fs::read(&path).ok()?;
    let meta: TrashMeta = serde_json::from_slice(&data).ok()?;
    Some(meta.original_path)
}

fn remove_trash_meta(trash: &Path, entry_name: &str) {
    let path = trash_meta_path(trash, entry_name);
    let _ = std::fs::remove_file(path);
}

fn trash_entry_name(trash_rel: &str) -> Option<&str> {
    trash_rel
        .strip_prefix(TRASH_DIR_NAME)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|name| !name.is_empty())
}

fn is_in_trash(rel: &str) -> bool {
    rel == TRASH_DIR_NAME || rel.starts_with(&format!("{TRASH_DIR_NAME}/"))
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

/// List items sitting in `.luna-trash` on this drive.
pub fn list_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
) -> Result<Vec<TrashEntry>, FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let trash = PathBuf::from(&drive.mount_point).join(TRASH_DIR_NAME);
    if !trash.exists() {
        return Ok(Vec::new());
    }
    let entries = read_dir_entries(&trash)?;
    Ok(entries
        .into_iter()
        .map(|entry| TrashEntry {
            original_path: read_trash_meta(&trash, &entry.name).unwrap_or_default(),
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            modified: entry.modified,
        })
        .collect())
}

/// Drive-relative path the trashed item came from, if metadata exists.
pub fn trash_original_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<Option<String>, FilesError> {
    if !is_in_trash(trash_rel) || trash_rel == TRASH_DIR_NAME {
        return Ok(None);
    }
    let drive = drive_root(conn, drive_id)?;
    let trash = PathBuf::from(&drive.mount_point).join(TRASH_DIR_NAME);
    let Some(entry_name) = trash_entry_name(trash_rel) else {
        return Ok(None);
    };
    Ok(read_trash_meta(&trash, entry_name))
}

/// Move an item out of `.luna-trash` onto the same drive (atomic rename).
/// `dest_rel` is the destination path including the restored file name.
pub fn restore_from_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
    dest_rel: &str,
) -> Result<(), FilesError> {
    if !is_in_trash(trash_rel) || trash_rel == ".luna-trash" {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    if is_in_trash(dest_rel) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot restore into trash",
        )));
    }
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let src = resolve_child(&root, trash_rel)?;
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
    if let Some(entry_name) = trash_entry_name(trash_rel) {
        remove_trash_meta(&root.join(TRASH_DIR_NAME), entry_name);
    }
    Ok(())
}

/// Permanently remove one item that is already in `.luna-trash`.
pub fn purge_trash(
    conn: &rusqlite::Connection,
    drive_id: &str,
    trash_rel: &str,
) -> Result<(), FilesError> {
    if !is_in_trash(trash_rel) || trash_rel == ".luna-trash" {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a trash item",
        )));
    }
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let path = resolve_child(&root, trash_rel)?;
    let meta = std::fs::symlink_metadata(&path).map_err(FilesError::Io)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(FilesError::Io)?;
    } else {
        std::fs::remove_file(&path).map_err(FilesError::Io)?;
    }
    if let Some(entry_name) = trash_entry_name(trash_rel) {
        remove_trash_meta(&root.join(TRASH_DIR_NAME), entry_name);
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
    let path = resolve_child(&root, rel)?;
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

pub fn temp_path(dir: &Path) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".luna-upload.{}.{nonce}", std::process::id()))
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
        std::fs::write(root.join("keep.txt"), b"k").unwrap();
        std::fs::write(root.join(".luna-upload.1.2"), b"tmp").unwrap();
        let entries = list_dir(&conn, &id, "").unwrap();
        assert!(entries.iter().all(|e| e.name != ".luna-upload.1.2"));
        assert!(file_path(&conn, &id, ".luna-upload.1.2").is_err());
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
    fn internal_temps_are_hidden() {
        assert!(is_internal_temp(".luna-upload.12.99"));
        assert!(is_internal_temp("folder/.luna-upload.1.2"));
        assert!(is_internal_temp(".luna-upload.1.2.part"));
        assert!(is_internal_temp(".lunathumbs"));
        assert!(!is_internal_temp("photo.jpg"));
        assert!(!is_internal_temp("notes.part"));
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
        assert!(trash_rel.starts_with(".luna-trash/"));
        assert!(!root.join("renamed.txt").exists());
        assert!(root.join(&trash_rel).exists());

        let listed = list_trash(&conn, &id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].original_path, "renamed.txt");

        restore_from_trash(&conn, &id, &trash_rel, "back.txt").unwrap();
        assert!(root.join("back.txt").exists());
        assert!(!root.join(&trash_rel).exists());
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
        delete_to_trash(&conn, &id, "note.txt").unwrap();
        assert!(root.join(".luna-trash/.meta").is_dir());
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
        assert!(root.join(&trash_rel).exists());
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
        let temp = dir.path().join(".luna-upload.1");
        std::fs::write(&temp, b"hello").unwrap();
        let dest = dir.path().join("file.txt");
        install_temp(&temp, &dest, false).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }

    #[test]
    fn install_temp_never_overwrites_without_opt_in() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".luna-upload.1");
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
        let temp = dir.path().join(".luna-upload.1");
        let dest = dir.path().join("clip.webm");
        std::fs::write(&temp, b"webm-bytes").unwrap();
        install_by_exclusive_rename(&temp, &dest).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
    }

    #[test]
    fn exclusive_rename_refuses_to_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".luna-upload.1");
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
        let temp = dir.path().join(".luna-upload.1");
        std::fs::write(&temp, b"webm-bytes").unwrap();
        let dest = dir.path().join("clip.webm");
        install_temp(&temp, &dest, false).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"webm-bytes");
    }
}
