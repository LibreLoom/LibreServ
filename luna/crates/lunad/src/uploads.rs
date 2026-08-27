//! Resumable chunked uploads.
//!
//! Sessions survive daemon restarts (SQLite + a temp file on the destination
//! drive). Clients PUT byte ranges in any order; completion verifies the file
//! is exactly the promised size before atomically installing it.
//!
//! Progress rows are coalesced (every ~2 MiB or ~2s, and always on
//! complete/cancel) so a multi-gigabyte upload does not issue one SQLite
//! commit per chunk against the OS eMMC.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, UploadRow};
use crate::files::{self, FileEntry, FilesError};

/// Flush upload progress to SQLite at least this often (bytes received).
const PROGRESS_FLUSH_BYTES: u64 = 2 * 1024 * 1024;
/// Flush upload progress to SQLite at least this often (wall clock).
const PROGRESS_FLUSH_SECS: i64 = 2;

struct PendingProgress {
    received: u64,
    size: u64,
    chunks: Vec<(u64, u64)>,
    last_flush_unix: i64,
    last_flushed_received: u64,
}

fn pending_map() -> &'static Mutex<HashMap<String, PendingProgress>> {
    static MAP: OnceLock<Mutex<HashMap<String, PendingProgress>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn flush_pending(conn: &Connection, id: &str) -> Result<(), UploadError> {
    let pending = {
        let mut map = pending_map().lock().map_err(|_| UploadError::NotFound)?;
        map.remove(id)
    };
    let Some(pending) = pending else {
        return Ok(());
    };
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| UploadError::Db(e.into()))?;
    db::update_upload_received(&tx, id, pending.received).map_err(UploadError::Db)?;
    for (start, end) in pending.chunks {
        db::upsert_upload_chunk(&tx, id, start, end).map_err(UploadError::Db)?;
    }
    tx.commit().map_err(|e| UploadError::Db(e.into()))?;
    Ok(())
}

fn clear_pending(id: &str) {
    if let Ok(mut map) = pending_map().lock() {
        map.remove(id);
    }
}

fn should_flush(p: &PendingProgress, now: i64) -> bool {
    if p.received >= p.size {
        return true;
    }
    if p.received.saturating_sub(p.last_flushed_received) >= PROGRESS_FLUSH_BYTES {
        return true;
    }
    if now.saturating_sub(p.last_flush_unix) >= PROGRESS_FLUSH_SECS {
        return true;
    }
    false
}

pub struct UploadManager;

#[derive(Debug, Clone)]
pub struct Upload {
    pub id: String,
    pub drive_id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub received: u64,
    pub temp: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("Luna doesn't know this upload.")]
    NotFound,
    #[error("This upload is already finished or cancelled.")]
    NotActive,
    #[error("{0}")]
    Files(FilesError),
    #[error("{0}")]
    Db(#[source] anyhow::Error),
    #[error("{0}")]
    Io(#[source] std::io::Error),
    #[error("The chunk size doesn't match the upload.")]
    SizeMismatch,
}

impl From<FilesError> for UploadError {
    fn from(e: FilesError) -> Self {
        UploadError::Files(e)
    }
}

/// Create an upload session: resolve + jail the destination, create the temp
/// file, and persist the row.
pub fn create(
    conn: &Connection,
    drive_id: &str,
    dest_path: &str,
    name: &str,
    size: u64,
) -> Result<Upload, UploadError> {
    let name = files::safe_name(name).map_err(|_| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid file name",
        ))
    })?;
    let dir = files::dest_dir(conn, drive_id, dest_path)?;
    let id = Uuid::new_v4().to_string();
    let temp = temp_for(&dir, &id);

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(UploadError::Io)?;

    db::insert_upload(conn, &id, drive_id, dest_path, &name, size).map_err(UploadError::Db)?;
    Ok(Upload {
        id,
        drive_id: drive_id.into(),
        path: dest_path.into(),
        name,
        size,
        received: 0,
        temp,
    })
}

/// Rehydrate a session row into an `Upload` with its temp path.
pub fn load(conn: &Connection, id: &str) -> Result<Upload, UploadError> {
    let row = get_row(conn, id)?;
    to_upload(conn, &row)
}

pub fn get_row(conn: &Connection, id: &str) -> Result<UploadRow, UploadError> {
    db::get_upload(conn, id)
        .map_err(UploadError::Db)?
        .ok_or(UploadError::NotFound)
}

fn to_upload(conn: &Connection, row: &UploadRow) -> Result<Upload, UploadError> {
    let dir = files::dest_dir(conn, &row.drive_id, &row.path)?;
    Ok(Upload {
        id: row.id.clone(),
        drive_id: row.drive_id.clone(),
        path: row.path.clone(),
        name: row.name.clone(),
        size: row.size,
        received: row.received,
        temp: temp_for(&dir, &row.id),
    })
}

/// Temp files are named after the upload id so restart recovery is trivial.
fn temp_for(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!(".luna-upload.{id}.part"))
}

/// Write one chunk at `start` (seek + write + flush). Never fsyncs per chunk —
/// the final `complete` call fsyncs once.
///
/// The DB mutex is held only for session lookup and coalesced progress updates
/// — not during the disk write — so browsing stays responsive while large
/// uploads land. Progress is flushed every ~2 MiB / ~2s (and on complete).
pub fn write_chunk(
    db: &Arc<Mutex<Connection>>,
    id: &str,
    start: u64,
    data: &[u8],
) -> Result<u64, UploadError> {
    let (temp, size, prev_received, drive_id) = {
        let conn = db.lock().map_err(|_| UploadError::NotFound)?;
        let upload = load(&conn, id)?;
        if upload.state_not_active(&conn)? {
            return Err(UploadError::NotActive);
        }
        // Prefer in-memory received if we have unflushed progress.
        let pending_received = pending_map()
            .lock()
            .ok()
            .and_then(|m| m.get(id).map(|p| p.received));
        (
            upload.temp.clone(),
            upload.size,
            pending_received.unwrap_or(upload.received),
            upload.drive_id.clone(),
        )
    };
    let end = start
        .checked_add(data.len() as u64)
        .filter(|end| *end <= size)
        .ok_or(UploadError::SizeMismatch)?;

    let write_err = (|| -> Result<(), std::io::Error> {
        let mut file = std::fs::OpenOptions::new().write(true).open(&temp)?;
        use std::io::{Seek, SeekFrom, Write};
        file.seek(SeekFrom::Start(start))?;
        file.write_all(data)?;
        file.flush()?;
        Ok(())
    })();
    if let Err(e) = write_err {
        if let Ok(conn) = db.lock() {
            files::note_write_failure(&conn, &drive_id, &e.to_string());
        }
        return Err(UploadError::Io(e));
    }

    let received = prev_received.max(end);
    let now = db::now_unix();
    let do_flush = {
        let mut map = pending_map().lock().map_err(|_| UploadError::NotFound)?;
        let entry = map
            .entry(id.to_string())
            .or_insert_with(|| PendingProgress {
                received: prev_received,
                size,
                chunks: Vec::new(),
                last_flush_unix: now,
                last_flushed_received: prev_received,
            });
        entry.received = received;
        entry.size = size;
        entry.chunks.push((start, end));
        should_flush(entry, now)
    };
    if do_flush {
        let conn = db.lock().map_err(|_| UploadError::NotFound)?;
        flush_pending(&conn, id)?;
    }
    Ok(received)
}

/// Verify length, contiguous coverage, and (optionally) a client-supplied
/// blake3 hash, then install. The caller chooses overwrite semantics.
pub fn complete(
    db: &Arc<Mutex<Connection>>,
    id: &str,
    overwrite: bool,
    expected_hash: Option<&str>,
) -> Result<FileEntry, UploadError> {
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    flush_pending(&conn, id)?;
    let upload = load(&conn, id)?;
    if upload.state_not_active(&conn)? {
        return Err(UploadError::NotActive);
    }

    let meta = std::fs::metadata(&upload.temp).map_err(UploadError::Io)?;
    // The sparse temp file's logical length equals `size` even if only the tail
    // was written, so length alone is not enough — every byte must be covered
    // contiguously from 0, otherwise a resumable client that lost earlier
    // chunks would install a file full of zero holes.
    let covered = db::upload_fully_covered(&conn, id, upload.size).map_err(UploadError::Db)?;
    if meta.len() != upload.size || !covered {
        db::set_upload_state(&conn, id, "error", "incomplete").map_err(UploadError::Db)?;
        return Err(UploadError::SizeMismatch);
    }

    if let Some(expected) = expected_hash.filter(|h| !h.is_empty()) {
        let actual = blake3_hash_file(&upload.temp).map_err(UploadError::Io)?;
        if !actual.eq_ignore_ascii_case(expected) {
            db::set_upload_state(&conn, id, "error", "hash-mismatch").map_err(UploadError::Db)?;
            return Err(UploadError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "upload hash did not match",
            )));
        }
    }

    // One fsync for the whole file, then atomic rename + parent dir sync.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .open(&upload.temp)
        .map_err(UploadError::Io)?;
    file.sync_all().map_err(UploadError::Io)?;
    drop(file);

    let dir = files::dest_dir(&conn, &upload.drive_id, &upload.path)?;
    let dest = dir.join(&upload.name);
    if dest.exists() && !overwrite {
        return Err(UploadError::Files(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination exists",
        ))));
    }
    if let Err(e) = files::install_temp(&upload.temp, &dest, overwrite) {
        files::note_write_failure(&conn, &upload.drive_id, &e.to_string());
        return Err(e.into());
    }

    let final_meta = std::fs::metadata(&dest).map_err(UploadError::Io)?;
    let modified = final_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    db::delete_upload(&conn, id).map_err(UploadError::Db)?;
    db::delete_upload_chunks(&conn, id).map_err(UploadError::Db)?;

    Ok(FileEntry {
        name: upload.name,
        kind: "file".into(),
        size: final_meta.len(),
        modified,
        hidden: false,
    })
}

fn blake3_hash_file(path: &Path) -> Result<String, std::io::Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Cancel and remove temp data.
pub fn cancel(db: &Arc<Mutex<Connection>>, id: &str) -> Result<(), UploadError> {
    clear_pending(id);
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    let upload = load(&conn, id)?;
    let _ = std::fs::remove_file(&upload.temp);
    db::delete_upload(&conn, id).map_err(UploadError::Db)?;
    db::delete_upload_chunks(&conn, id).map_err(UploadError::Db)?;
    Ok(())
}

impl Upload {
    fn state_not_active(&self, conn: &Connection) -> Result<bool, UploadError> {
        Ok(db::get_upload(conn, &self.id)
            .map_err(UploadError::Db)?
            .map(|r| r.state != "active")
            .unwrap_or(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Arc<Mutex<Connection>>, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        db::upsert_drive(
            &conn,
            "d1",
            "Test",
            "as_is",
            "ext4",
            "sdz",
            root.to_str().unwrap(),
        )
        .unwrap();
        (dir, Arc::new(Mutex::new(conn)), "d1".into())
    }

    #[test]
    fn chunked_upload_survives_out_of_order_chunks() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "", "big.bin", 1000).unwrap();
        drop(conn);

        // Second half first, then first half — resumable clients do this.
        let data2 = vec![7u8; 500];
        write_chunk(&db, &up.id, 500, &data2).unwrap();
        let data1 = vec![3u8; 500];
        let received = write_chunk(&db, &up.id, 0, &data1).unwrap();
        assert_eq!(received, 1000);

        let entry = complete(&db, &up.id, false, None).unwrap();
        assert_eq!(entry.size, 1000);

        let row = db::get_upload(&db.lock().unwrap(), &up.id).unwrap();
        assert!(row.is_none(), "session removed after completion");
    }

    #[test]
    fn tail_only_upload_cannot_complete() {
        // The sparse temp file's logical length matches `size` even when only
        // the tail was written, so completion must require full coverage —
        // otherwise a resumable client that lost earlier chunks would install
        // a file full of zero holes.
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "", "sparse.bin", 1000).unwrap();
        drop(conn);
        write_chunk(&db, &up.id, 900, &[1u8; 100]).unwrap();
        assert!(matches!(
            complete(&db, &up.id, false, None),
            Err(UploadError::SizeMismatch)
        ));
    }

    #[test]
    fn incomplete_upload_cannot_complete() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "", "x.bin", 100).unwrap();
        drop(conn);
        write_chunk(&db, &up.id, 0, &[1u8; 10]).unwrap();
        assert!(matches!(
            complete(&db, &up.id, false, None),
            Err(UploadError::SizeMismatch)
        ));
    }

    #[test]
    fn cancel_removes_temp_and_row() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "", "x.bin", 10).unwrap();
        drop(conn);
        assert!(up.temp.exists());
        cancel(&db, &up.id).unwrap();
        assert!(!up.temp.exists());
        assert!(
            db::get_upload(&db.lock().unwrap(), &up.id)
                .unwrap()
                .is_none()
        );
    }
}
