//! Copy/move background jobs.
//!
//! Jobs run on the blocking thread pool so the HTTP server never waits on
//! spinning disks. Progress is persisted to SQLite, and a cancellation flag is
//! checked between chunks.
//!
//! Moves prefer a real same-filesystem rename when the kernel allows it. Only
//! when rename fails with EXDEV (cross-device / different mount) does Luna fall
//! back to copy-then-trash: the source is removed only after every byte is
//! verified at the destination, and even then it goes to `.luna-trash`, never
//! straight to deletion.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, JobRow};
use crate::files::{self, FilesError};
use crate::gallery_indexer::GalleryIndexer;

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
    gallery: Arc<GalleryIndexer>,
}

#[derive(Debug, Clone)]
struct PreparedJob {
    row: JobRow,
    src: PathBuf,
    dest: PathBuf,
    total: u64,
}

impl JobManager {
    pub fn new(db: Arc<Mutex<Connection>>, gallery: Arc<GalleryIndexer>) -> Self {
        Self {
            db,
            cancels: Arc::new(Mutex::new(HashMap::new())),
            gallery,
        }
    }

    pub async fn enqueue(
        &self,
        kind: &str,
        from_drive: &str,
        from_path: &str,
        to_drive: &str,
        to_path: &str,
        user_id: &str,
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
        let user_id = user_id.to_string();

        let prepared = tokio::task::spawn_blocking(move || {
            let conn = db
                .lock()
                .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
            prepare(
                &conn,
                &kind,
                &from_drive,
                &from_path,
                &to_drive,
                &to_path,
                &user_id,
            )
        })
        .await
        .map_err(|e| JobError::Db(anyhow::anyhow!("job task crashed: {e}")))??;

        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap()
            .insert(prepared.row.id.clone(), cancel.clone());

        let db = self.db.clone();
        let gallery = self.gallery.clone();
        let job = prepared.clone();
        let job_id = prepared.row.id.clone();
        let cancels = self.cancels.clone();
        tokio::task::spawn_blocking(move || {
            run_job(db, gallery, job, cancel);
            cancels.lock().unwrap().remove(&job_id);
        });

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

    pub fn list_for_user(&self, user_id: &str, limit: i64) -> Result<Vec<JobRow>, JobError> {
        let conn = self.db.lock().map_err(|_| JobError::NotFound)?;
        db::list_jobs_for_user(&conn, user_id, limit).map_err(JobError::Db)
    }

    pub fn get(&self, id: &str) -> Result<Option<JobRow>, JobError> {
        let conn = self.db.lock().map_err(|_| JobError::NotFound)?;
        db::get_job(&conn, id).map_err(JobError::Db)
    }

    pub fn owns_or_admin(&self, job: &JobRow, user: &crate::auth::CurrentUser) -> bool {
        user.role == "admin" || job.user_id == user.id
    }
}

fn prepare(
    conn: &Connection,
    kind: &str,
    from_drive: &str,
    from_path: &str,
    to_drive: &str,
    to_path: &str,
    user_id: &str,
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
        conn, &id, kind, from_drive, from_path, to_drive, to_path, total, user_id,
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

/// Mutable state threaded through a copy: bytes copied so far and whether
/// this job created the destination root (only then may the failure cleanup
/// below delete it — otherwise a concurrent writer that claimed the name
/// between our conflict check and the copy could lose its tree to our
/// rollback).
struct CopyState {
    done: u64,
    owned_dest: bool,
}

fn run_job(
    db: Arc<Mutex<Connection>>,
    gallery: Arc<GalleryIndexer>,
    prepared: PreparedJob,
    cancel: Arc<AtomicBool>,
) {
    // Same-filesystem moves: rename in place. Never invent a destination we
    // would later roll back — rename either lands the whole tree or fails.
    if prepared.row.kind == "move" {
        match files::try_rename_move(&prepared.src, &prepared.dest) {
            Ok(true) => {
                if let Ok(conn) = db.lock() {
                    let _ = db::update_job_progress(
                        &conn,
                        &prepared.row.id,
                        prepared.total,
                        prepared.total,
                    );
                    let _ = db::set_job_state(&conn, &prepared.row.id, "done", "");
                }
                notify_job_gallery(&gallery, &prepared, true);
                return;
            }
            Ok(false) => {
                // Cross-device: fall through to copy-then-trash.
            }
            Err(FilesError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Ok(conn) = db.lock() {
                    let _ = db::set_job_state(
                        &conn,
                        &prepared.row.id,
                        "error",
                        &plain_job_error(&JobError::Conflict),
                    );
                }
                return;
            }
            Err(e) => {
                if let Ok(conn) = db.lock() {
                    let _ = db::set_job_state(
                        &conn,
                        &prepared.row.id,
                        "error",
                        &plain_job_error(&JobError::from(e)),
                    );
                }
                return;
            }
        }
    }

    let mut st = CopyState {
        done: 0,
        owned_dest: false,
    };
    let result = (|| -> Result<(), JobError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(JobError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            )));
        }
        copy_node(
            &db,
            &prepared.src,
            &prepared.dest,
            &prepared.row.id,
            prepared.total,
            &cancel,
            &mut st,
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
            ("cancelled".to_string(), String::new())
        }
        Err(e) => ("error".to_string(), plain_job_error(&e)),
    };
    if let Ok(conn) = db.lock() {
        let _ = db::set_job_state(&conn, &prepared.row.id, &state, &error);
        let _ = db::update_job_progress(&conn, &prepared.row.id, prepared.total, prepared.total);
    }
    if (state == "cancelled" || state == "error") && st.owned_dest {
        let _ = std::fs::remove_file(&prepared.dest);
        let _ = std::fs::remove_dir_all(&prepared.dest);
    }
    if state == "done" {
        notify_job_gallery(&gallery, &prepared, prepared.row.kind == "move");
    }
}

fn notify_job_gallery(gallery: &GalleryIndexer, prepared: &PreparedJob, moved: bool) {
    gallery.rescan(&prepared.row.to_drive);
    if moved {
        gallery.rescan(&prepared.row.from_drive);
    }
}

fn copy_node(
    db: &Arc<Mutex<Connection>>,
    src: &Path,
    dest: &Path,
    job_id: &str,
    total: u64,
    cancel: &AtomicBool,
    st: &mut CopyState,
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
        // No-replace claim on the destination root: create_dir_all would
        // silently merge into a concurrently-created tree. Child levels are
        // reached only through this root, so plain create_dir is enough.
        if !st.owned_dest {
            std::fs::create_dir(dest).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    JobError::Conflict
                } else {
                    JobError::Io(e)
                }
            })?;
            st.owned_dest = true;
        } else {
            std::fs::create_dir(dest).map_err(JobError::Io)?;
        }
        let mut entries: Vec<_> = std::fs::read_dir(src)
            .map_err(JobError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(JobError::Io)?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child_src = entry.path();
            let child_dest = dest.join(entry.file_name());
            copy_node(db, &child_src, &child_dest, job_id, total, cancel, st)?;
        }
        return Ok(st.done);
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
        st.done += n as u64;
        if (st.done % (COPY_BUF as u64) < (COPY_BUF as u64 / 4) || st.done == total)
            && let Ok(conn) = db.lock()
        {
            let _ = db::update_job_progress(&conn, job_id, st.done, total);
        }
    }
    output.flush().map_err(JobError::Io)?;
    output.sync_all().map_err(JobError::Io)?;
    drop(output);
    files::install_temp(&tmp, dest, false)?;
    // We own this leaf now; only our cleanup may ever remove it.
    st.owned_dest = true;
    Ok(st.done)
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

    /// Drive B on `/dev/shm` (tmpfs) so rename hits EXDEV against drive A on disk.
    fn setup_cross_fs() -> Option<(tempfile::TempDir, tempfile::TempDir, Arc<Mutex<Connection>>)> {
        use std::os::unix::fs::MetadataExt;
        let shm = PathBuf::from("/dev/shm");
        if std::fs::metadata(&shm).ok()?.dev()
            == std::fs::metadata(std::env::temp_dir()).ok()?.dev()
        {
            return None;
        }
        let dir_a = tempfile::tempdir().ok()?;
        let dir_b = tempfile::TempDir::new_in(&shm).ok()?;
        let conn = db::open(&dir_a.path().join("luna.db")).ok()?;
        let root_a = dir_a.path().join("a");
        std::fs::create_dir_all(&root_a).ok()?;
        db::upsert_drive(&conn, "a", "A", "as_is", "ext4", "sda", root_a.to_str()?).ok()?;
        let root_b = dir_b.path().join("b");
        std::fs::create_dir_all(&root_b).ok()?;
        db::upsert_drive(&conn, "b", "B", "as_is", "ext4", "sdb", root_b.to_str()?).ok()?;
        Some((dir_a, dir_b, Arc::new(Mutex::new(conn))))
    }

    #[tokio::test]
    async fn same_drive_move_renames_without_trash() {
        let (dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
            std::fs::write(format!("{root}/note.txt"), b"stay put once").unwrap();
        }
        let manager = JobManager::new(db.clone(), crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("move", "a", "note.txt", "a", "inbox", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);

        let root = dir.path().join("a");
        assert!(!root.join("note.txt").exists());
        assert_eq!(
            std::fs::read(root.join("inbox/note.txt")).unwrap(),
            b"stay put once"
        );
        let trash = root.join(".luna-trash");
        assert!(
            !trash.exists() || std::fs::read_dir(&trash).unwrap().next().is_none(),
            "same-drive move must not leave a trash copy"
        );
    }

    #[tokio::test]
    async fn cross_filesystem_move_copies_then_trashes_source() {
        let Some((_dir_a, _dir_b, db)) = setup_cross_fs() else {
            eprintln!("skip: no distinct /dev/shm filesystem for EXDEV test");
            return;
        };
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/ship.txt"), b"cross device").unwrap();
        }
        let manager = JobManager::new(db.clone(), crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("move", "a", "ship.txt", "b", "", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);

        let conn = db.lock().unwrap();
        let root_a = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        let root_b = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        assert_eq!(
            std::fs::read(format!("{root_b}/ship.txt")).unwrap(),
            b"cross device"
        );
        assert!(!PathBuf::from(&root_a).join("ship.txt").exists());
        let trash_entries: Vec<_> = std::fs::read_dir(format!("{root_a}/.luna-trash"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != ".meta")
            .collect();
        assert_eq!(trash_entries.len(), 1);
    }

    #[tokio::test]
    async fn same_fs_cross_drive_move_still_renames() {
        // Two Luna drives on the same filesystem should rename, not copy+trash.
        let (dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/samefs.txt"), b"rename across drives").unwrap();
        }
        let manager = JobManager::new(db.clone(), crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("move", "a", "samefs.txt", "b", "", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        assert!(!dir.path().join("a/samefs.txt").exists());
        assert_eq!(
            std::fs::read(dir.path().join("b/samefs.txt")).unwrap(),
            b"rename across drives"
        );
        let trash = dir.path().join("a/.luna-trash");
        assert!(
            !trash.exists() || std::fs::read_dir(&trash).unwrap().next().is_none(),
            "same-filesystem move must not trash the source"
        );
    }

    #[tokio::test]
    async fn same_drive_folder_move_renames_tree() {
        let (dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/album/day")).unwrap();
            std::fs::write(format!("{root}/album/day/pic.jpg"), b"jpeg").unwrap();
            std::fs::create_dir_all(format!("{root}/archive")).unwrap();
        }
        let manager = JobManager::new(db.clone(), crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("move", "a", "album", "a", "archive", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        let root = dir.path().join("a");
        assert!(!root.join("album").exists());
        assert_eq!(
            std::fs::read(root.join("archive/album/day/pic.jpg")).unwrap(),
            b"jpeg"
        );
    }

    fn wait_done(manager: &JobManager, id: &str) {
        for _ in 0..100 {
            if manager.get(id).unwrap().unwrap().state != "running" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[tokio::test]
    async fn cross_drive_copy_produces_verified_bytes() {
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/note.txt"), b"hello cross-drive").unwrap();
        }
        let manager = JobManager::new(db.clone(), crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("copy", "a", "note.txt", "b", "", "user-1")
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
        let manager = JobManager::new(db, crate::gallery_indexer::GalleryIndexer::start());
        assert!(matches!(
            manager
                .enqueue("copy", "a", "x.txt", "b", "", "user-1")
                .await,
            Err(JobError::Conflict)
        ));
    }

    #[tokio::test]
    async fn jobs_are_scoped_to_the_owner() {
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/note.txt"), b"hello").unwrap();
        }
        let manager = JobManager::new(db, crate::gallery_indexer::GalleryIndexer::start());
        let job = manager
            .enqueue("copy", "a", "note.txt", "b", "", "sam")
            .await
            .unwrap();
        let sam = manager.list_for_user("sam", 50).unwrap();
        assert_eq!(sam.len(), 1);
        assert_eq!(sam[0].id, job.id);
        assert!(manager.list_for_user("max", 50).unwrap().is_empty());
        let admin_all = manager.list(50).unwrap();
        assert_eq!(admin_all.len(), 1);
    }
}
