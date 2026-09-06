//! The `.luna` adoption marker — a SQLite microdb at the drive root.
//!
//! Adopting a drive writes exactly one file named `.luna`. That file is a
//! SQLite database (DELETE journal mode) whose `identity` row holds the drive
//! id and label. Lunad opens the same file for index, hashes, gallery, trash
//! metadata, and upload sessions. Adoption itself only requires identity.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub const MARKER_FILE_NAME: &str = ".luna";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    /// Marker format version.
    pub v: u32,
    /// Stable identity for this drive (a UUID generated at adoption time).
    pub id: String,
    /// Human label chosen by the user ("Photos Drive").
    pub label: String,
}

impl Marker {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            v: 1,
            id: id.into(),
            label: label.into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MarkerError {
    #[error("drive root does not exist or is not a directory")]
    NotADirectory,
    #[error("could not read the marker: {0}")]
    Read(#[source] std::io::Error),
    #[error("could not parse the marker: {0}")]
    Parse(String),
    #[error("could not write the marker: {0}")]
    Write(#[source] std::io::Error),
    #[error("could not open the drive database: {0}")]
    Db(#[source] rusqlite::Error),
}

/// Read a marker if the drive has one. Returns `Ok(None)` when the drive root
/// exists and is a directory but has no `.luna` file.
///
/// Supports legacy JSON stickers (pre-microdb) by parsing them in place.
pub fn read_marker(root: &Path) -> Result<Option<Marker>, MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }
    let marker_path = root.join(MARKER_FILE_NAME);
    let bytes = match fs::read(&marker_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(MarkerError::Read(e)),
    };
    if bytes.first() == Some(&b'{') {
        let marker: Marker = serde_json::from_slice(&bytes)
            .map_err(|e| MarkerError::Parse(e.to_string()))?;
        return Ok(Some(marker));
    }
    let conn = open_db(&marker_path)?;
    let marker = conn
        .query_row(
            "SELECT id, label, format_version FROM identity LIMIT 1",
            [],
            |row| {
                Ok(Marker {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    v: row.get::<_, i64>(2)? as u32,
                })
            },
        )
        .optional()
        .map_err(MarkerError::Db)?;
    Ok(marker)
}

/// Remove the `.luna` adoption marker if present.
///
/// Returns `Ok(true)` when a marker file was deleted, `Ok(false)` when there
/// was no marker. Also clears leftover `-wal`/`-shm` sidecars if any remain.
pub fn remove_marker(root: &Path) -> Result<bool, MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }
    let marker_path = root.join(MARKER_FILE_NAME);
    let removed = match fs::remove_file(&marker_path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(MarkerError::Write(e)),
    };
    let _ = fs::remove_file(root.join(format!("{MARKER_FILE_NAME}-wal")));
    let _ = fs::remove_file(root.join(format!("{MARKER_FILE_NAME}-shm")));
    Ok(removed)
}

/// Adopt a drive: atomically write one `.luna` SQLite marker at its root.
///
/// Safety properties:
/// - fails if `root` is not an existing directory;
/// - never creates directories, never touches anything except a temp file and
///   the final `.luna` name;
/// - writes via `temp + fsync + rename` so a power cut cannot leave a torn marker.
pub fn write_marker(root: &Path, marker: &Marker) -> Result<(), MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }

    let marker_path = root.join(MARKER_FILE_NAME);
    let tmp = temp_path(root)?;
    // Build the SQLite DB at a temp path, then rename into place.
    {
        let conn = Connection::open(&tmp).map_err(MarkerError::Db)?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(MarkerError::Db)?;
        conn.pragma_update(None, "journal_mode", "DELETE")
            .map_err(MarkerError::Db)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(MarkerError::Db)?;
        conn.execute_batch(
            "CREATE TABLE identity (
                id TEXT PRIMARY KEY NOT NULL,
                label TEXT NOT NULL,
                format_version INTEGER NOT NULL DEFAULT 1
             );",
        )
        .map_err(MarkerError::Db)?;
        conn.execute(
            "INSERT INTO identity (id, label, format_version) VALUES (?1, ?2, ?3)",
            params![marker.id, marker.label, marker.v as i64],
        )
        .map_err(MarkerError::Db)?;
        // Ensure DELETE journal finished; no -wal left beside the temp file.
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .ok();
        drop(conn);
    }
    // fsync the temp file before rename.
    if let Ok(file) = fs::File::open(&tmp) {
        let _ = file.sync_all();
    }

    fs::rename(&tmp, &marker_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        MarkerError::Write(e)
    })?;

    if let Ok(dir) = fs::File::open(root) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn open_db(path: &Path) -> Result<Connection, MarkerError> {
    let conn = Connection::open(path).map_err(MarkerError::Db)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(MarkerError::Db)?;
    conn.pragma_update(None, "journal_mode", "DELETE")
        .map_err(MarkerError::Db)?;
    Ok(conn)
}

fn temp_path(root: &Path) -> Result<PathBuf, MarkerError> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    Ok(root.join(format!(".luna.tmp.{pid}.{nonce}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("luna-marker-test-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_root_is_an_error_not_a_write() {
        let root = Path::new("/nonexistent/luna/drive");
        assert!(matches!(
            read_marker(root),
            Err(MarkerError::NotADirectory)
        ));
        assert!(write_marker(root, &Marker::new("id", "x")).is_err());
    }

    #[test]
    fn round_trip_and_single_file_created() {
        let root = temp_dir();
        let marker = Marker::new("drive-uuid-1", "Photos Drive");
        write_marker(&root, &marker).unwrap();

        let entries: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let s = name.to_string_lossy();
                !s.starts_with(".luna.tmp.")
            })
            .collect();
        assert_eq!(entries.len(), 1, "adoption must create exactly one file");
        assert_eq!(entries[0].file_name(), MARKER_FILE_NAME);
        assert!(!root.join(".luna-wal").exists());
        assert!(!root.join(".luna-shm").exists());

        let back = read_marker(&root).unwrap().expect("marker exists");
        assert_eq!(back, marker);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preexisting_files_are_untouched() {
        let root = temp_dir();
        fs::write(root.join("keep-me.txt"), b"hello").unwrap();
        fs::create_dir(root.join("pics")).unwrap();
        write_marker(&root, &Marker::new("id", "Backup Drive")).unwrap();

        assert_eq!(fs::read(root.join("keep-me.txt")).unwrap(), b"hello");
        assert!(root.join("pics").is_dir());
        assert!(read_marker(&root).unwrap().is_some());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_marker_is_none() {
        let root = temp_dir();
        assert!(read_marker(&root).unwrap().is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn remove_marker_deletes_only_the_sticker() {
        let root = temp_dir();
        fs::write(root.join("keep-me.txt"), b"hello").unwrap();
        write_marker(&root, &Marker::new("id", "Photos")).unwrap();
        assert!(remove_marker(&root).unwrap());
        assert!(read_marker(&root).unwrap().is_none());
        assert_eq!(fs::read(root.join("keep-me.txt")).unwrap(), b"hello");
        assert!(!remove_marker(&root).unwrap());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn legacy_json_marker_still_reads() {
        let root = temp_dir();
        fs::write(
            root.join(MARKER_FILE_NAME),
            br#"{
  "v": 1,
  "id": "legacy-id",
  "label": "Old Stick"
}
"#,
        )
        .unwrap();
        let m = read_marker(&root).unwrap().unwrap();
        assert_eq!(m.id, "legacy-id");
        assert_eq!(m.label, "Old Stick");
        fs::remove_dir_all(&root).unwrap();
    }
}
