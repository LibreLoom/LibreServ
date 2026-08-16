//! Resumable chunked uploads.
//!
//! Sessions survive daemon restarts (SQLite + a temp file on the destination
//! drive). Clients PUT byte ranges in any order; completion verifies the file
//! is exactly the promised size before atomically installing it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, UploadRow};
use crate::files::{self, FileEntry, FilesError};

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
pub fn write_chunk(
    db: &Arc<Mutex<Connection>>,
    id: &str,
    start: u64,
    data: &[u8],
) -> Result<u64, UploadError> {
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    let upload = load(&conn, id)?;
    if upload.state_not_active(&conn)? {
        return Err(UploadError::NotActive);
    }
    let end = start
        .checked_add(data.len() as u64)
        .filter(|end| *end <= upload.size)
        .ok_or(UploadError::SizeMismatch)?;

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(&upload.temp)
        .map_err(UploadError::Io)?;
    use std::io::{Seek, SeekFrom, Write};
    file.seek(SeekFrom::Start(start)).map_err(UploadError::Io)?;
    file.write_all(data).map_err(UploadError::Io)?;
    file.flush().map_err(UploadError::Io)?;

    let received = upload.received.max(end);
    db::update_upload_received(&conn, id, received).map_err(UploadError::Db)?;
    Ok(received)
}

/// Verify length and install. The caller chooses overwrite semantics.
pub fn complete(
    db: &Arc<Mutex<Connection>>,
    id: &str,
    overwrite: bool,
) -> Result<FileEntry, UploadError> {
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    let upload = load(&conn, id)?;
    if upload.state_not_active(&conn)? {
        return Err(UploadError::NotActive);
    }

    let meta = std::fs::metadata(&upload.temp).map_err(UploadError::Io)?;
    if meta.len() != upload.size || upload.received < upload.size {
        db::set_upload_state(&conn, id, "error", "incomplete").map_err(UploadError::Db)?;
        return Err(UploadError::SizeMismatch);
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
    files::install_temp(&upload.temp, &dest)?;

    let final_meta = std::fs::metadata(&dest).map_err(UploadError::Io)?;
    let modified = final_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    db::delete_upload(&conn, id).map_err(UploadError::Db)?;

    Ok(FileEntry {
        name: upload.name,
        kind: "file".into(),
        size: final_meta.len(),
        modified,
        hidden: false,
    })
}

/// Cancel and remove temp data.
pub fn cancel(db: &Arc<Mutex<Connection>>, id: &str) -> Result<(), UploadError> {
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    let upload = load(&conn, id)?;
    let _ = std::fs::remove_file(&upload.temp);
    db::delete_upload(&conn, id).map_err(UploadError::Db)?;
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

        let entry = complete(&db, &up.id, false).unwrap();
        assert_eq!(entry.size, 1000);

        let row = db::get_upload(&db.lock().unwrap(), &up.id).unwrap();
        assert!(row.is_none(), "session removed after completion");
    }

    #[test]
    fn incomplete_upload_cannot_complete() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "", "x.bin", 100).unwrap();
        drop(conn);
        write_chunk(&db, &up.id, 0, &[1u8; 10]).unwrap();
        assert!(matches!(
            complete(&db, &up.id, false),
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
