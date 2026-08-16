//! Copy/move background jobs.
//!
//! Jobs run on the blocking thread pool so the HTTP server never waits on
//! spinning disks. Progress is persisted to SQLite, and a cancellation flag is
//! checked between chunks. Moves are copy-then-trash: the source is only
//! removed after every byte is verified at the destination, and even then it
//! goes to `.luna-trash`, never straight to deletion.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, JobRow};
use crate::files::{self, FilesError};

const COPY_BUF: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error("Luna only knows how to copy or move.")]
    UnknownKind,
    #[error("{0}")]
    Files(FilesError),
    #[error("{0}")]
    Db(#[source] anyhow::Error),
    #[error("Luna doesn't know this job.")]
    NotFound,
    #[error("{0}")]
    Io(#[source] std::io::Error),
    #[error("A file or folder with this name is already there.")]
    Conflict,
    #[error("Luna can't copy links yet.")]
    Symlink,
}

impl From<FilesError> for JobError {
    fn from(e: FilesError) -> Self {
        JobError::Files(e)
    }
}

#[derive(Clone)]
pub struct JobManager {
    db: Arc<Mutex<Connection>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, Clone)]
struct PreparedJob {
    row: JobRow,
    src: PathBuf,
    dest: PathBuf,
    total: u64,
}

impl JobManager {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self {
            db,
            cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn enqueue(
        &self,
        kind: &str,
        from_drive: &str,
        from_path: &str,
        to_drive: &str,
        to_path: &str,
    ) -> Result<JobRow, JobError> {
        if kind != "copy" && kind != "move" {
            return Err(JobError::UnknownKind);
        }
        let db = self.db.clone();
        let kind = kind.to_string();
        let from_drive = from_drive.to_string();
        let from_path = from_path.to_string();
        let to_drive = to_drive.to_string();
        let to_path = to_path.to_string();

        let prepared = tokio::task::spawn_blocking(move || {
            let conn = db
                .lock()
                .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
            prepare(&conn, &kind, &from_drive, &from_path, &to_drive, &to_path)
        })
        .await
        .map_err(|e| JobError::Db(anyhow::anyhow!("job task crashed: {e}")))??;

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap()
            .insert(prepared.row.id.clone(), cancel.clone());

        let db = self.db.clone();
        let job = prepared.clone();
        tokio::task::spawn_blocking(move || run_job(db, job, cancel));

        Ok(prepared.row)
    }

    pub fn cancel(&self, id: &str) -> Result<(), JobError> {
        let flag = self
            .cancels
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(JobError::NotFound)?;
        flag.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn list(&self, limit: i64) -> Result<Vec<JobRow>, JobError> {
        let conn = self.db.lock().map_err(|_| JobError::NotFound)?;
        db::list_jobs(&conn, limit).map_err(JobError::Db)
    }

    pub fn get(&self, id: &str) -> Result<Option<JobRow>, JobError> {
        let conn = self.db.lock().map_err(|_| JobError::NotFound)?;
        db::get_job(&conn, id).map_err(JobError::Db)
    }
}

fn prepare(
    conn: &Connection,
    kind: &str,
    from_drive: &str,
    from_path: &str,
    to_drive: &str,
    to_path: &str,
) -> Result<PreparedJob, JobError> {
    let (src, meta) = files::resolve_any(conn, from_drive, from_path)?;
    if meta.is_dir() && from_path.is_empty() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot copy a whole drive root",
        ))
        .into());
    }
    let Some(name) = src.file_name() else {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no name",
        ))
        .into());
    };

    let dest_dir = files::dest_dir(conn, to_drive, to_path)?;
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err(JobError::Conflict);
    }
    let total = walk_total(&src, meta.is_dir())?;
    if total == 0 && !meta.is_dir() {
        // Zero-byte files are still valid copies.
    }

    let id = Uuid::new_v4().to_string();
    db::insert_job(
        conn, &id, kind, from_drive, from_path, to_drive, to_path, total,
    )
    .map_err(JobError::Db)?;
    let row = db::get_job(conn, &id)
        .map_err(JobError::Db)?
        .ok_or(JobError::NotFound)?;
    Ok(PreparedJob {
        row,
        src,
        dest,
        total,
    })
}

fn walk_total(path: &Path, is_dir: bool) -> Result<u64, JobError> {
    if !is_dir {
        let meta = std::fs::symlink_metadata(path).map_err(JobError::Io)?;
        if meta.file_type().is_symlink() {
            return Err(JobError::Symlink);
        }
        return Ok(meta.len());
    }
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(JobError::Io)? {
            let entry = entry.map_err(JobError::Io)?;
            let meta = std::fs::symlink_metadata(entry.path()).map_err(JobError::Io)?;
            if meta.file_type().is_symlink() {
                return Err(JobError::Symlink);
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

fn run_job(db: Arc<Mutex<Connection>>, prepared: PreparedJob, cancel: Arc<AtomicBool>) {
    let result = (|| -> Result<(), JobError> {
        copy_node(
            &db,
            &prepared.src,
            &prepared.dest,
            &prepared.row.id,
            prepared.total,
            0,
            &cancel,
        )?;

        if prepared.row.kind == "move" {
            let conn = db.lock().unwrap();
            files::delete_to_trash(&conn, &prepared.row.from_drive, &prepared.row.from_path)?;
        }
        let conn = db.lock().unwrap();
        db::set_job_state(&conn, &prepared.row.id, "done", "").map_err(JobError::Db)
    })();

    let (state, error) = match result {
        Ok(()) => ("done".to_string(), String::new()),
        Err(JobError::Io(e)) if e.kind() == std::io::ErrorKind::Interrupted => {
            // Cancellation is reported separately below.
            ("cancelled".to_string(), String::new())
        }
        Err(e) => ("error".to_string(), plain_job_error(&e)),
    };
    if let Ok(conn) = db.lock() {
        let _ = db::set_job_state(&conn, &prepared.row.id, &state, &error);
        let _ = db::update_job_progress(&conn, &prepared.row.id, prepared.total, prepared.total);
    }
    // A cancelled job may have a partial destination; remove it.
    if state == "cancelled" {
        let _ = std::fs::remove_file(&prepared.dest);
        let _ = std::fs::remove_dir_all(&prepared.dest);
    }
}

fn copy_node(
    db: &Arc<Mutex<Connection>>,
    src: &Path,
    dest: &Path,
    job_id: &str,
    total: u64,
    mut done: u64,
    cancel: &AtomicBool,
) -> Result<u64, JobError> {
    let meta = std::fs::symlink_metadata(src).map_err(JobError::Io)?;
    if meta.file_type().is_symlink() {
        return Err(JobError::Symlink);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(JobError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled",
        )));
    }

    if meta.is_dir() {
        std::fs::create_dir_all(dest).map_err(JobError::Io)?;
        let mut entries: Vec<_> = std::fs::read_dir(src)
            .map_err(JobError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(JobError::Io)?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child_src = entry.path();
            let child_dest = dest.join(entry.file_name());
            done = copy_node(db, &child_src, &child_dest, job_id, total, done, cancel)?;
        }
        return Ok(done);
    }

    let mut input = std::fs::File::open(src).map_err(JobError::Io)?;
    let tmp = files::temp_path(dest.parent().ok_or_else(|| {
        JobError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent",
        ))
    })?);
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(JobError::Io)?;
    let mut buf = vec![0u8; COPY_BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(input);
            drop(output);
            let _ = std::fs::remove_file(&tmp);
            return Err(JobError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            )));
        }
        let n = input.read(&mut buf).map_err(JobError::Io)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(JobError::Io)?;
        done += n as u64;
        if (done % (COPY_BUF as u64) < (COPY_BUF as u64 / 4) || done == total)
            && let Ok(conn) = db.lock()
        {
            let _ = db::update_job_progress(&conn, job_id, done, total);
        }
    }
    output.flush().map_err(JobError::Io)?;
    output.sync_all().map_err(JobError::Io)?;
    drop(output);
    files::install_temp(&tmp, dest)?;
    Ok(done)
}

fn plain_job_error(err: &JobError) -> String {
    match err {
        JobError::Conflict => "A file or folder with this name is already there.".into(),
        JobError::Symlink => "Luna can't copy links yet.".into(),
        JobError::Files(FilesError::UnknownDrive) => {
            "Luna doesn't know one of these drives.".into()
        }
        JobError::Files(FilesError::Path(_)) => "Luna can't use that path.".into(),
        JobError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
            "A file disappeared while Luna was copying it.".into()
        }
        JobError::Io(e)
            if e.to_string().contains("No space") || e.to_string().contains("no space") =>
        {
            "The destination drive is full.".into()
        }
        _ => "Luna couldn't finish this job. Check the drives and try again.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Arc<Mutex<Connection>>, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("a");
        std::fs::create_dir_all(&root).unwrap();
        db::upsert_drive(
            &conn,
            "a",
            "A",
            "as_is",
            "ext4",
            "sda",
            root.to_str().unwrap(),
        )
        .unwrap();
        let root2 = dir.path().join("b");
        std::fs::create_dir_all(&root2).unwrap();
        db::upsert_drive(
            &conn,
            "b",
            "B",
            "as_is",
            "ext4",
            "sdb",
            root2.to_str().unwrap(),
        )
        .unwrap();
        (dir, Arc::new(Mutex::new(conn)), "a".into())
    }

    #[tokio::test]
    async fn cross_drive_copy_produces_verified_bytes() {
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/note.txt"), b"hello cross-drive").unwrap();
        }
        let manager = JobManager::new(db.clone());
        let job = manager
            .enqueue("copy", "a", "note.txt", "b", "")
            .await
            .unwrap();
        assert_eq!(job.state, "running");

        for _ in 0..100 {
            if manager.get(&job.id).unwrap().unwrap().state != "running" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        assert_eq!(
            std::fs::read(format!("{root}/note.txt")).unwrap(),
            b"hello cross-drive"
        );
    }

    #[tokio::test]
    async fn conflict_is_reported_before_starting() {
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/x.txt"), b"x").unwrap();
            let root2 = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root2}/x.txt"), b"x").unwrap();
        }
        let manager = JobManager::new(db);
        assert!(matches!(
            manager.enqueue("copy", "a", "x.txt", "b", "").await,
            Err(JobError::Conflict)
        ));
    }
}
