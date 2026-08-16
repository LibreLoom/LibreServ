//! The `.luna` adoption marker.
//!
//! Adopting a drive writes exactly one file at the drive root. Nothing else on
//! the drive is ever created, moved, or modified by adoption. The file is a
//! small JSON document so a human (or another Luna) can read it with any tool.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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
    Parse(#[source] serde_json::Error),
    #[error("could not write the marker: {0}")]
    Write(#[source] std::io::Error),
}

/// Read a marker if the drive has one. Returns `Ok(None)` when the drive root
/// exists and is a directory but has no `.luna` file.
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
    let marker: Marker = serde_json::from_slice(&bytes).map_err(MarkerError::Parse)?;
    Ok(Some(marker))
}

/// Adopt a drive: atomically write one `.luna` marker file at its root.
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
    let encoded = serde_json::to_vec_pretty(marker).map_err(MarkerError::Parse)?;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(MarkerError::Write)?;
    file.write_all(&encoded).map_err(MarkerError::Write)?;
    file.write_all(b"\n").map_err(MarkerError::Write)?;
    file.sync_all().map_err(MarkerError::Write)?;
    drop(file);

    fs::rename(&tmp, &marker_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        MarkerError::Write(e)
    })?;

    // Persist the directory entry itself so the marker survives power loss.
    if let Ok(dir) = fs::File::open(root) {
        let _ = dir.sync_all();
    }
    Ok(())
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
        assert!(matches!(read_marker(root), Err(MarkerError::NotADirectory)));
        assert!(write_marker(root, &Marker::new("id", "x")).is_err());
    }

    #[test]
    fn round_trip_and_single_file_created() {
        let root = temp_dir();
        let marker = Marker::new("drive-uuid-1", "Photos Drive");
        write_marker(&root, &marker).unwrap();

        let entries: Vec<_> = fs::read_dir(&root).unwrap().collect();
        assert_eq!(entries.len(), 1, "adoption must create exactly one file");
        assert_eq!(entries[0].as_ref().unwrap().file_name(), MARKER_FILE_NAME);

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
}
