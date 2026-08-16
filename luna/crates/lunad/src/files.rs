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

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub kind: String, // "dir" | "file" | "symlink" | "other"
    pub size: u64,
    pub modified: i64,
    pub hidden: bool,
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

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(FilesError::Io)?;
    for entry in read {
        let entry = entry.map_err(FilesError::Io)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = std::fs::symlink_metadata(entry.path()).map_err(FilesError::Io)?;
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
            name,
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

/// Resolve a file for download/streaming, returning its path and metadata.
pub fn file_path(
    conn: &rusqlite::Connection,
    drive_id: &str,
    rel: &str,
) -> Result<(PathBuf, std::fs::Metadata), FilesError> {
    let drive = drive_root(conn, drive_id)?;
    let root = PathBuf::from(&drive.mount_point);
    let path = resolve_child(&root, rel)?;
    let meta = std::fs::metadata(&path).map_err(FilesError::Io)?;
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

/// Atomically install `temp` as `dest`. `dest` must not exist.
pub fn install_temp(temp: &Path, dest: &Path) -> Result<(), FilesError> {
    std::fs::rename(temp, dest).map_err(FilesError::Io)?;
    // Persist the directory entry so the rename survives power loss.
    if let Some(parent) = dest.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
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

    let trash = root.join(".luna-trash");
    std::fs::create_dir_all(&trash).map_err(FilesError::Io)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dest = trash.join(format!("{nonce}-{name}"));
    let mut n = 1;
    while dest.exists() {
        dest = trash.join(format!("{nonce}-{n}-{name}"));
        n += 1;
    }

    std::fs::rename(&path, &dest).map_err(FilesError::Io)?;
    if let Ok(dir) = std::fs::File::open(&trash) {
        let _ = dir.sync_all();
    }
    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(dest
        .strip_prefix(&root)
        .unwrap_or(&dest)
        .to_string_lossy()
        .into_owned())
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
    if dest.exists() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination exists",
        )));
    }
    std::fs::rename(&path, &dest).map_err(FilesError::Io)?;
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
    fn safe_name_rejects_traversal() {
        assert!(safe_name("../x").is_err());
        assert!(safe_name("a/b").is_err());
        assert_eq!(safe_name("photo.jpg").unwrap(), "photo.jpg");
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
    fn install_temp_is_atomic_and_persists_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join(".luna-upload.1");
        std::fs::write(&temp, b"hello").unwrap();
        let dest = dir.path().join("file.txt");
        install_temp(&temp, &dest).unwrap();
        assert!(!temp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    }
}
