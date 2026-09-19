//! The `.luna-<uuid>` adoption marker — a SQLite microdb at the drive root.
//!
//! Adopting a drive picks a unique `.luna-<uuid>` prefix that never collides
//! with files already on the drive, then writes one file named
//! `.luna-<uuid>.sqlite3`. That file is a SQLite database (DELETE journal
//! mode) whose `identity` row holds the drive id and label. Lunad opens the
//! same file for index, hashes, gallery, trash metadata, and upload sessions.
//! Every other name Luna creates on the drive — trash, thumbnails, protected
//! copies, upload temps — starts with the same `.luna-<uuid>` prefix, so a
//! drive full of existing files can never clash with Luna's own bookkeeping.
//! Adoption itself only requires identity.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Every Luna-owned name on a drive starts with this prefix plus a UUID.
pub const MARKER_PREFIX: &str = ".luna-";
/// The marker/microdb file for prefix `P` is `P.sqlite3`.
pub const MARKER_EXT: &str = ".sqlite3";

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

/// Extract the `.luna-<uuid>` prefix from an entry name, when the name sits
/// inside Luna's namespace (`.luna-<uuid>` itself, `.luna-<uuid>.sqlite3`,
/// `.luna-<uuid>-trash`, `.luna-<uuid>-upload.1.part`, …).
pub fn extract_prefix(name: &str) -> Option<String> {
    let rest = name.strip_prefix(MARKER_PREFIX)?;
    let uuid_part = rest.get(..36)?;
    uuid::Uuid::parse_str(uuid_part).ok()?;
    Some(format!("{MARKER_PREFIX}{uuid_part}"))
}

/// Marker file name for a prefix: `.luna-<uuid>.sqlite3`.
pub fn marker_file_name(prefix: &str) -> String {
    format!("{prefix}{MARKER_EXT}")
}

/// True when `name` is exactly a marker file name (`.luna-<uuid>.sqlite3`) —
/// not a sidecar like `-wal` and not a sibling dir like `-trash`.
pub fn is_marker_name(name: &str) -> bool {
    extract_prefix(name).is_some_and(|p| marker_file_name(&p) == name)
}

/// Every marker file at a drive root, as `(prefix, path)` pairs sorted by name
/// so callers get a deterministic choice when a drive carries several.
pub fn find_markers(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            if is_marker_name(&name) && e.path().is_file() {
                extract_prefix(&name).map(|p| (p, e.path()))
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Read every marker identity at `root`. Marker files that cannot be opened
/// as a microdb (a stray file with a marker-shaped name) are skipped.
pub fn read_markers(root: &Path) -> Result<Vec<(String, Marker)>, MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }
    let mut out = Vec::new();
    for (prefix, path) in find_markers(root) {
        let Ok(conn) = open_db(&path) else {
            continue;
        };
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
        if let Some(m) = marker {
            out.push((prefix, m));
        }
    }
    Ok(out)
}

/// Read the first marker if the drive has one. Returns `Ok(None)` when the
/// drive root exists and is a directory but has no `.luna-*.sqlite3` file.
pub fn read_marker(root: &Path) -> Result<Option<Marker>, MarkerError> {
    Ok(read_markers(root)?.into_iter().next().map(|(_, m)| m))
}

/// Pick a `.luna-<uuid>` prefix no existing entry uses: retries with fresh
/// random UUIDs until nothing at the drive root starts with the candidate.
pub fn pick_prefix(root: &Path) -> Result<String, MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }
    let names: Vec<String> = fs::read_dir(root)
        .map_err(MarkerError::Read)?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    loop {
        let candidate = format!("{MARKER_PREFIX}{}", uuid::Uuid::new_v4());
        if !names.iter().any(|n| n.starts_with(&candidate)) {
            return Ok(candidate);
        }
    }
}

/// Remove the marker whose identity id matches `drive_id` (plus its
/// `-wal`/`-shm` sidecars). Other Lunas' markers are left alone.
/// Returns `Ok(true)` when a marker file was deleted.
pub fn remove_marker(root: &Path, drive_id: &str) -> Result<bool, MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }
    let mut removed = false;
    for (prefix, path) in find_markers(root) {
        let mine = match open_db(&path) {
            Ok(conn) => conn
                .query_row("SELECT id FROM identity LIMIT 1", [], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .map_err(MarkerError::Db)?
                .is_some_and(|id| id == drive_id),
            Err(_) => false,
        };
        if !mine {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(MarkerError::Write(e)),
        }
        let _ = fs::remove_file(root.join(format!("{prefix}{MARKER_EXT}-wal")));
        let _ = fs::remove_file(root.join(format!("{prefix}{MARKER_EXT}-shm")));
    }
    Ok(removed)
}

/// Adopt a drive: write the `.luna-<uuid>.sqlite3` SQLite marker at its root.
///
/// Safety properties:
/// - fails if `root` is not an existing directory;
/// - never creates directories, never touches anything except a temp file and
///   the final marker name (or an in-place identity update);
/// - when the marker is already a SQLite microdb, updates the `identity` row
///   only so index/gallery/hash/upload tables are preserved;
/// - for a new file, writes via `temp + fsync + rename` so a power cut cannot
///   leave a torn marker.
pub fn write_marker(root: &Path, marker: &Marker, prefix: &str) -> Result<(), MarkerError> {
    let meta = fs::metadata(root).map_err(|_| MarkerError::NotADirectory)?;
    if !meta.is_dir() {
        return Err(MarkerError::NotADirectory);
    }

    let marker_path = root.join(marker_file_name(prefix));
    if marker_path.is_file() {
        // Existing SQLite microdb — update identity in place; never replace the file.
        let conn = open_db(&marker_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS identity (
                id TEXT PRIMARY KEY NOT NULL,
                label TEXT NOT NULL,
                format_version INTEGER NOT NULL DEFAULT 1
             );",
        )
        .map_err(MarkerError::Db)?;
        let tx = conn.unchecked_transaction().map_err(MarkerError::Db)?;
        tx.execute("DELETE FROM identity", [])
            .map_err(MarkerError::Db)?;
        tx.execute(
            "INSERT INTO identity (id, label, format_version) VALUES (?1, ?2, ?3)",
            params![marker.id, marker.label, marker.v as i64],
        )
        .map_err(MarkerError::Db)?;
        tx.commit().map_err(MarkerError::Db)?;
        return Ok(());
    }

    let tmp = temp_path(root, prefix)?;
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
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
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

fn temp_path(root: &Path, prefix: &str) -> Result<PathBuf, MarkerError> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    Ok(root.join(format!("{prefix}.tmp.{pid}.{nonce}")))
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
    fn extract_prefix_reads_uuid_names() {
        let p = extract_prefix(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f").unwrap();
        assert_eq!(p, ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f");
        assert!(extract_prefix(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-trash").is_some());
        assert!(extract_prefix(".luna-not-a-uuid").is_none());
        assert!(extract_prefix(".luna").is_none());
        assert!(extract_prefix(".luna-trash").is_none());
        assert!(extract_prefix("notes.txt").is_none());
    }

    #[test]
    fn marker_name_match_is_exact() {
        let p = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f";
        assert!(is_marker_name(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f.sqlite3"
        ));
        assert!(!is_marker_name(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f.sqlite3-wal"
        ));
        assert!(!is_marker_name(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-trash"
        ));
        assert_eq!(marker_file_name(p), format!("{p}.sqlite3"));
    }

    #[test]
    fn pick_prefix_avoids_existing_entries() {
        let root = temp_dir();
        let p = pick_prefix(&root).unwrap();
        assert!(p.starts_with(MARKER_PREFIX));
        // Occupy the whole prefix, then pick again — must differ.
        fs::write(root.join(marker_file_name(&p)), b"x").unwrap();
        let q = pick_prefix(&root).unwrap();
        assert_ne!(p, q);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_root_is_an_error_not_a_write() {
        let root = Path::new("/nonexistent/luna/drive");
        assert!(matches!(read_marker(root), Err(MarkerError::NotADirectory)));
        assert!(write_marker(root, &Marker::new("id", "x"), ".luna-x").is_err());
    }

    #[test]
    fn round_trip_and_single_file_created() {
        let root = temp_dir();
        let prefix = pick_prefix(&root).unwrap();
        let marker = Marker::new("drive-uuid-1", "Photos Drive");
        write_marker(&root, &marker, &prefix).unwrap();

        let entries: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let s = name.to_string_lossy();
                !s.contains(".tmp.")
            })
            .collect();
        assert_eq!(entries.len(), 1, "adoption must create exactly one file");
        assert_eq!(entries[0].file_name(), marker_file_name(&prefix).as_str());
        assert!(!root.join(format!("{prefix}.sqlite3-wal")).exists());
        assert!(!root.join(format!("{prefix}.sqlite3-shm")).exists());

        let back = read_marker(&root).unwrap().expect("marker exists");
        assert_eq!(back, marker);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn preexisting_files_are_untouched() {
        let root = temp_dir();
        fs::write(root.join("keep-me.txt"), b"hello").unwrap();
        fs::create_dir(root.join("pics")).unwrap();
        let prefix = pick_prefix(&root).unwrap();
        write_marker(&root, &Marker::new("id", "Backup Drive"), &prefix).unwrap();

        assert_eq!(fs::read(root.join("keep-me.txt")).unwrap(), b"hello");
        assert!(root.join("pics").is_dir());
        assert!(read_marker(&root).unwrap().is_some());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn two_lunas_can_share_a_drive() {
        let root = temp_dir();
        let p1 = pick_prefix(&root).unwrap();
        write_marker(&root, &Marker::new("id-a", "Luna A"), &p1).unwrap();
        let p2 = pick_prefix(&root).unwrap();
        write_marker(&root, &Marker::new("id-b", "Luna B"), &p2).unwrap();

        let all = read_markers(&root).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|(p, m)| p == &p1 && m.id == "id-a"));
        assert!(all.iter().any(|(p, m)| p == &p2 && m.id == "id-b"));

        // Removing one Luna's marker leaves the other intact.
        assert!(remove_marker(&root, "id-a").unwrap());
        let all = read_markers(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1.id, "id-b");
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
        let prefix = pick_prefix(&root).unwrap();
        write_marker(&root, &Marker::new("id", "Photos"), &prefix).unwrap();
        assert!(remove_marker(&root, "id").unwrap());
        assert!(read_marker(&root).unwrap().is_none());
        assert_eq!(fs::read(root.join("keep-me.txt")).unwrap(), b"hello");
        assert!(!remove_marker(&root, "id").unwrap());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_marker_preserves_extra_sqlite_tables() {
        let root = temp_dir();
        let prefix = pick_prefix(&root).unwrap();
        write_marker(&root, &Marker::new("id-1", "First"), &prefix).unwrap();
        {
            let conn = open_db(&root.join(marker_file_name(&prefix))).unwrap();
            conn.execute_batch(
                "CREATE TABLE photos (path TEXT PRIMARY KEY);
                 INSERT INTO photos (path) VALUES ('keep.jpg');",
            )
            .unwrap();
        }
        write_marker(&root, &Marker::new("id-2", "Second"), &prefix).unwrap();
        let back = read_marker(&root).unwrap().unwrap();
        assert_eq!(back.id, "id-2");
        assert_eq!(back.label, "Second");
        let conn = open_db(&root.join(marker_file_name(&prefix))).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        fs::remove_dir_all(&root).unwrap();
    }
}
