//! Copy/move background jobs.
//!
//! Jobs run on the blocking thread pool so the HTTP server never waits on
//! spinning disks. Progress is persisted to SQLite, and a cancellation flag is
//! checked between chunks.
//!
//! Moves prefer a real same-filesystem rename when the kernel allows it. Only
//! when rename fails with EXDEV (cross-device / different mount) does Luna fall
//! back to copy-then-trash: the source is removed only after every byte is
//! verified at the destination, and even then it goes to the drive's
//! `.luna-<uuid>-trash`, never straight to deletion.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, JobRow};
use crate::files::{self, FilesError};
use crate::gallery::gallery_indexer::GalleryIndexer;

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
    #[error("You no longer have permission to do this.")]
    Denied,
    #[error("This folder holds private items that only their owners can move.")]
    Blocked,
}

impl From<FilesError> for JobError {
    fn from(e: FilesError) -> Self {
        JobError::Files(e)
    }
}

#[derive(Clone)]
pub struct JobManager {
    db: Arc<crate::Db>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    gallery: Arc<GalleryIndexer>,
}

#[derive(Debug, Clone)]
struct PreparedJob {
    row: JobRow,
    src: PathBuf,
    dest: PathBuf,
    total: u64,
    /// Real paths of the source and destination, for private-item rows.
    from_real: String,
    dest_rel: String,
    /// The source is a private item: the copy becomes a private item too,
    /// with this owner and on-disk id.
    private_root: Option<(String, String)>,
}

impl JobManager {
    pub fn new(db: Arc<crate::Db>, gallery: Arc<GalleryIndexer>) -> Self {
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
        lock_cancels(&self.cancels).insert(prepared.row.id.clone(), cancel.clone());

        let db = self.db.clone();
        let gallery = self.gallery.clone();
        let job = prepared.clone();
        let job_id = prepared.row.id.clone();
        let cancels = self.cancels.clone();
        tokio::task::spawn_blocking(move || {
            run_job(db, gallery, job, cancel);
            lock_cancels(&cancels).remove(&job_id);
        });

        Ok(prepared.row)
    }

    pub fn cancel(&self, id: &str) -> Result<(), JobError> {
        let flag = lock_cancels(&self.cancels)
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

/// The capability a job's source side must satisfy. Moves destroy the
/// source (edit, not view), and anything sitting in trash — the
/// `.luna-trash` API alias or a raw `{prefix}-trash` name — needs edit on
/// the path it was deleted from.
pub(crate) fn job_source_cap(
    conn: &Connection,
    kind: &str,
    drive_id: &str,
    from_path: &str,
) -> crate::access::Caps {
    if kind == "move" || files::is_trash_api(from_path) {
        return crate::access::CAP_EDIT;
    }
    // Raw trash-dir names don't run through the alias mapping in
    // `caps_on_path` — check the resolved real rel so a `{prefix}-trash/...`
    // source can never slip by on a mere view grant.
    if let Ok(real) = files::real_rel_path(conn, drive_id, from_path)
        && files::is_trash_rel(&real)
    {
        return crate::access::CAP_EDIT;
    }
    crate::access::CAP_VIEW
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
    let (src, meta) = files::resolve_any_including_trash(conn, from_drive, from_path)?;
    if meta.is_dir() && from_path.is_empty() {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot copy a whole drive root",
        ))
        .into());
    }
    // The trash ROOT is never a job source: copying `.luna-trash` (or the
    // raw `{prefix}-trash` dir) would hand every member's deletions to
    // anyone holding a drive-root grant, and moving it would relocate the whole trash store. Specific
    // entries still copy and move out through restore-style jobs.
    let from_real = files::real_rel_path(conn, from_drive, from_path)?;
    if files::is_trash_root(&from_real) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the trash root is not a job source",
        ))
        .into());
    }
    // Individual trash ENTRIES are still valid job sources — but only under
    // the `.luna-trash` alias, where the caps engine maps the entry to its
    // origin's grants. A raw `{prefix}-trash` name would execute on nothing
    // but an admin's drive-wide grant, leaking other people's deletions.
    if files::is_trash_rel(&from_real) && !files::is_trash_api(from_path) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "trash entries move through the trash API only",
        ))
        .into());
    }
    // A top-level trash entry lands under its original name — the `{nonce}-`
    // prefix is storage noise that must not leak into the destination.
    let src_root = PathBuf::from(files::drive_root(conn, from_drive)?.mount_point);
    let src_item = crate::private::item_at(&src_root, &from_real);
    let name = files::trash_api_leaf(conn, from_drive, from_path)?
        .or_else(|| src_item.as_ref().map(|i| i.name().to_string()))
        .or_else(|| src.file_name().map(|s| s.to_string_lossy().into_owned()))
        .ok_or_else(|| {
            FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "no name",
            ))
        })?;

    // Nothing drops INTO trash — items get there by being deleted. Check
    // the resolved real path so the `.luna-trash` alias and a raw
    // `{prefix}-trash` name are refused alike, at the root or beneath it.
    let to_real = files::real_rel_path(conn, to_drive, to_path)?;
    if files::is_trash_rel(&to_real) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot move into trash",
        ))
        .into());
    }
    // `a` → `a` or `a` → `a/sub` would copy the destination into itself
    // forever (the copy lands inside the tree being walked). Only possible
    // on the same drive — cross-drive destinations can't nest in the source.
    if from_drive == to_drive {
        let from = crate::access::normalize_subject_path(from_path);
        let to = crate::access::normalize_subject_path(to_path);
        if crate::access::path_contains(&from, &to) {
            return Err(FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "cannot copy an item into itself",
            ))
            .into());
        }
    }
    let dest_dir = files::dest_dir(conn, to_drive, to_path)?;
    let to_root = PathBuf::from(files::drive_root(conn, to_drive)?.mount_point);
    let dest_rel = crate::gallery::gallery_indexer::join_rel(
        crate::access::normalize_subject_path(&to_real).as_str(),
        &name,
    );
    // A private item stays private wherever it goes. Renamed in place it
    // keeps its disk entry; copied (or moved across drives) it gets a fresh
    // id under the destination drive's prefix.
    let mut private_root = None;
    let dest = match &src_item {
        Some(_) if kind == "move" && from_drive == to_drive => dest_dir
            .join(crate::private::disk_leaf(&src_root, &from_real).unwrap_or_else(|| name.clone())),
        Some(item) => {
            let prefix = crate::private::prefix_of(&to_root).ok_or(JobError::Conflict)?;
            let id = crate::private::new_id();
            // A copy belongs to whoever made it; a move keeps its owner.
            let owner = if kind == "move" {
                item.owner.clone()
            } else {
                user_id.to_string()
            };
            let disk = dest_dir.join(crate::private::disk_name(&prefix, &id));
            private_root = Some((owner, id));
            disk
        }
        None => dest_dir.join(&name),
    };
    // A move carries private items whole — the mover never reads them, the
    // boundary and its owner travel unchanged. Blocking on unreadable
    // nested folders would let a private folder freeze its shared parent
    // in place.
    // The real name must be free of plain and private items alike.
    if dest.exists()
        || crate::private::item_at(&to_root, &dest_rel).is_some()
        || files::name_taken(&dest_dir, &name)
    {
        return Err(JobError::Conflict);
    }
    let user_row = db::get_user(conn, user_id)
        .map_err(JobError::Db)?
        .ok_or(JobError::Denied)?;
    let user = crate::auth::CurrentUser {
        id: user_row.id,
        username: user_row.username,
        role: user_row.role,
    };
    let readable = |path: &Path| {
        path.strip_prefix(&src_root)
            .ok()
            .and_then(|p| p.to_str())
            .is_some_and(|disk| {
                crate::auth::has_cap(
                    &user,
                    conn,
                    from_drive,
                    &crate::private::logical_rel(&src_root, disk),
                    crate::access::CAP_VIEW,
                )
            })
    };
    let total = walk_total(&src_root, &src, meta.is_dir(), &readable)?;
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
        from_real,
        dest_rel,
        private_root,
    })
}

/// Bytes in a form's own files folder (question pictures, attachments) —
/// copied along with the form, unlike other Luna-owned names.
fn form_files_total(root: &Path, form: &Path) -> u64 {
    crate::api::forms::files_dir_for(root, form)
        .filter(|dir| std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()))
        .map(|dir| walk_total_lossy(&dir))
        .unwrap_or(0)
}

fn walk_total_lossy(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

fn walk_total(
    root: &Path,
    path: &Path,
    is_dir: bool,
    readable: &dyn Fn(&Path) -> bool,
) -> Result<u64, JobError> {
    if !readable(path) {
        return Ok(0);
    }
    if !is_dir {
        let meta = std::fs::symlink_metadata(path).map_err(JobError::Io)?;
        if meta.file_type().is_symlink() {
            return Err(JobError::Symlink);
        }
        return Ok(meta.len() + form_files_total(root, path));
    }
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(JobError::Io)? {
            let entry = entry.map_err(JobError::Io)?;
            // Luna's `.luna-<uuid>-*` bookkeeping and in-flight `.part` temps
            // are not content — they must not count toward the copy total.
            if entry.file_name().to_str().is_none_or(|n| {
                files::is_internal_temp(n) && !crate::private::owns_disk_name(root, n)
            }) {
                continue;
            }
            if !readable(&entry.path()) {
                continue;
            }
            let meta = std::fs::symlink_metadata(entry.path()).map_err(JobError::Io)?;
            if meta.file_type().is_symlink() {
                return Err(JobError::Symlink);
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len() + form_files_total(root, &entry.path());
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
struct CopyState<'a> {
    done: u64,
    owned_dest: bool,
    job_id: &'a str,
    total: u64,
    cancel: &'a AtomicBool,
}

/// Repeat the enqueue-time authorization at execution: a grant revoked
/// while a job sat in the queue — or mid-copy — must still stop the job.
/// The job's owner is re-read from the database; a deleted user fails too.
fn recheck_job_caps(db: &Arc<crate::Db>, row: &JobRow) -> Result<(), JobError> {
    let conn = db
        .lock()
        .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
    recheck_job_caps_for(&conn, row, &row.from_path)
}

/// [`recheck_job_caps`] evaluated on `from_path` instead of the job's own
/// source, on a connection the caller already holds. The copy traversal
/// calls this per node with the node's own rel path, so a child whose
/// grants differ from the root's (a nested trash origin, a grant revoked
/// mid-copy) stops the job at that node rather
/// than after the bytes already left.
fn recheck_job_caps_for(conn: &Connection, row: &JobRow, from_path: &str) -> Result<(), JobError> {
    let Some(user_row) = db::get_user(conn, &row.user_id).map_err(JobError::Db)? else {
        return Err(JobError::Denied);
    };
    let user = crate::auth::CurrentUser {
        id: user_row.id,
        username: user_row.username,
        role: user_row.role,
    };
    let from_cap = job_source_cap(conn, &row.kind, &row.from_drive, from_path);
    let authorized = crate::auth::has_cap(&user, conn, &row.from_drive, from_path, from_cap)
        && crate::auth::has_cap(
            &user,
            conn,
            &row.to_drive,
            &row.to_path,
            crate::access::CAP_UPLOAD,
        );
    if authorized {
        return Ok(());
    }
    Err(JobError::Denied)
}

fn run_job(
    db: Arc<crate::Db>,
    gallery: Arc<GalleryIndexer>,
    prepared: PreparedJob,
    cancel: Arc<AtomicBool>,
) {
    if let Err(e) = recheck_job_caps(&db, &prepared.row) {
        if let Ok(conn) = db.lock() {
            let _ = db::set_job_state(&conn, &prepared.row.id, "error", &plain_job_error(&e));
        }
        return;
    }
    // Same-filesystem moves: rename in place. Never invent a destination we
    // would later roll back — rename either lands the whole tree or fails.
    // A rename keeps private items' rows only within one drive; between two
    // drives the items are copied across so each gets its row on the new one.
    let carries_private = prepared.row.from_drive != prepared.row.to_drive
        && (prepared.private_root.is_some() || {
            let conn = db.lock().ok();
            conn.and_then(|c| files::drive_root(&c, &prepared.row.from_drive).ok())
                .is_some_and(|d| {
                    !crate::private::under(Path::new(&d.mount_point), &prepared.from_real)
                        .is_empty()
                })
        });
    if prepared.row.kind == "move" && !carries_private {
        match files::try_rename_move(&prepared.src, &prepared.dest) {
            Ok(true) => {
                if let Ok(conn) = db.lock() {
                    // A form's files folder and answers file follow it.
                    if let (Ok(from), Ok(to)) = (
                        files::drive_root(&conn, &prepared.row.from_drive),
                        files::drive_root(&conn, &prepared.row.to_drive),
                    ) {
                        crate::api::forms::repath_form_files_named(
                            Path::new(&from.mount_point),
                            &prepared.src,
                            prepared.from_real.rsplit('/').next().unwrap_or(""),
                            Path::new(&to.mount_point),
                            &prepared.dest,
                            prepared.dest_rel.rsplit('/').next().unwrap_or(""),
                        );
                    }
                    // Shares follow the file: subject rows point at the new
                    // drive/path before the job reports done.
                    let new_rel = prepared.dest_rel.clone();
                    if let Err(e) = repath_rows(&conn, &prepared, false).and_then(|()| {
                        crate::access::repath_subjects_move(
                            &conn,
                            &prepared.row.from_drive,
                            &prepared.row.from_path,
                            &prepared.row.to_drive,
                            &new_rel,
                        )
                    }) {
                        let _ = repath_rows(&conn, &prepared, true);
                        // The rename already landed but the share rows
                        // still point at the source — put the tree back so
                        // they stay truthful, then report the failure.
                        let _ = files::try_rename_move(&prepared.dest, &prepared.src);
                        let _ = db::set_job_state(
                            &conn,
                            &prepared.row.id,
                            "error",
                            &plain_job_error(&JobError::Db(e)),
                        );
                    } else {
                        // An item dragged out of trash loses its origin
                        // metadata — it is no longer trashed.
                        files::forget_trash_entry(
                            &conn,
                            &prepared.row.from_drive,
                            &prepared.row.from_path,
                        );
                        files::note_write(&conn, &prepared.row.from_drive, &prepared.row.from_path);
                        files::note_write(&conn, &prepared.row.to_drive, &prepared.row.to_path);
                        let _ = db::update_job_progress(
                            &conn,
                            &prepared.row.id,
                            prepared.total,
                            prepared.total,
                        );
                        let _ = db::set_job_state(&conn, &prepared.row.id, "done", "");
                    }
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
        job_id: &prepared.row.id,
        total: prepared.total,
        cancel: &cancel,
    };
    let mut created_private_root = false;
    let result = (|| -> Result<(), JobError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(JobError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            )));
        }
        let ctx = {
            let conn = db
                .lock()
                .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
            let drive = files::drive_root(&conn, &prepared.row.from_drive)?;
            let to_root =
                PathBuf::from(files::drive_root(&conn, &prepared.row.to_drive)?.mount_point);
            CopyCtx {
                db: &db,
                row: &prepared.row,
                src_root: PathBuf::from(drive.mount_point),
                to_prefix: crate::private::prefix_of(&to_root),
                to_root,
            }
        };
        if let Some((owner, id)) = &prepared.private_root {
            crate::private::create_with_id(&ctx.to_root, &prepared.dest_rel, owner, id)
                .map_err(JobError::Db)?;
            created_private_root = true;
        }
        copy_node(
            &ctx,
            &prepared.src,
            &prepared.row.from_path,
            &prepared.dest,
            &prepared.dest_rel,
            &mut st,
        )?;

        if prepared.row.kind == "move" {
            // Queue behind any other change on the source drive; taken before
            // the database lock, like every other writer.
            let drive_lock = db.drive_lock(&prepared.row.from_drive);
            let _drive_guard = drive_lock.blocking_lock();
            let conn = db.lock().map_err(|_| index_busy())?;
            // Retarget the subject rows to the destination BEFORE trashing
            // the source — delete_to_trash revokes whatever still points at
            // the old path, so shares must already live at the new one.
            let new_rel = prepared.dest_rel.clone();
            crate::access::repath_subjects_move(
                &conn,
                &prepared.row.from_drive,
                &prepared.row.from_path,
                &prepared.row.to_drive,
                &new_rel,
            )
            .map_err(JobError::Db)?;
            let trash_result = if files::is_trash_api(&prepared.row.from_path) {
                // Moving out of trash: the source is already in the trash
                // dir — re-trashing would nest it, so purge it.
                files::purge_trash(&conn, &prepared.row.from_drive, &prepared.row.from_path)
                    .map(|_| ())
            } else {
                files::delete_to_trash(&conn, &prepared.row.from_drive, &prepared.row.from_path)
                    .map(|_| ())
            };
            if let Err(e) = trash_result {
                // Shares already point at the copy — deleting the
                // destination now would orphan every grant. Keep it; the
                // source stays wherever the failed cleanup left it, which
                // the user can remove by hand.
                st.owned_dest = false;
                created_private_root = false;
                return Err(JobError::from(e));
            }
        }
        let conn = db.lock().map_err(|_| index_busy())?;
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
    if (state == "cancelled" || state == "error")
        && (st.owned_dest || created_private_root)
        && let Ok(conn) = db.lock()
        && let Ok(drive) = files::drive_root(&conn, &prepared.row.to_drive)
    {
        let _ = crate::private::remove_under(Path::new(&drive.mount_point), &prepared.dest_rel);
    }
    if state == "done" {
        // The copy landed whole directories the listings never saw land —
        // forget the indexed snapshots so the next read re-reads the dirs
        // (mtime alone misses writes inside the filesystem's timestamp
        // granularity).
        if let Ok(conn) = db.lock() {
            files::note_write(&conn, &prepared.row.from_drive, &prepared.row.from_path);
            files::note_write(&conn, &prepared.row.to_drive, &prepared.row.to_path);
        }
        notify_job_gallery(&gallery, &prepared, prepared.row.kind == "move");
    }
}

/// Re-key private-item rows after a same-drive rename landed (or undo it).
fn repath_rows(conn: &Connection, prepared: &PreparedJob, undo: bool) -> anyhow::Result<()> {
    if prepared.row.from_drive != prepared.row.to_drive {
        return Ok(());
    }
    let root = PathBuf::from(
        files::drive_root(conn, &prepared.row.from_drive)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?
            .mount_point,
    );
    let (from, to) = (&prepared.from_real, &prepared.dest_rel);
    if undo {
        crate::private::repath(&root, to, from)
    } else {
        crate::private::repath(&root, from, to)
    }
}

fn notify_job_gallery(gallery: &GalleryIndexer, prepared: &PreparedJob, moved: bool) {
    gallery.rescan(&prepared.row.to_drive);
    if moved {
        gallery.rescan(&prepared.row.from_drive);
    }
}

/// Per-job copy context: each node the traversal walks is re-authorized
/// against `row` and re-resolved inside `src_root` before it is read.
struct CopyCtx<'a> {
    db: &'a Arc<crate::Db>,
    row: &'a JobRow,
    /// `row.from_drive`'s mount point — the jail every node re-resolves in.
    src_root: PathBuf,
    /// `row.to_drive`'s mount point and prefix, for private items copied in.
    to_root: PathBuf,
    to_prefix: Option<String>,
}

/// Map a path-jail failure onto the job error vocabulary: `NotFound`/`Io`
/// keep the vanished-file message, escapes report as a path error.
fn jail_err(e: luna_core::path::PathError) -> JobError {
    match e {
        luna_core::path::PathError::NotFound(io) | luna_core::path::PathError::Io(io) => {
            JobError::Io(io)
        }
        other => JobError::Files(FilesError::Path(other)),
    }
}

/// May the job's owner still touch this node of the tree, as the job needs?
fn node_allowed(ctx: &CopyCtx<'_>, rel: &str) -> Result<bool, JobError> {
    let conn = ctx
        .db
        .lock()
        .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
    let Some(user_row) = db::get_user(&conn, &ctx.row.user_id).map_err(JobError::Db)? else {
        return Ok(false);
    };
    let user = crate::auth::CurrentUser {
        id: user_row.id,
        username: user_row.username,
        role: user_row.role,
    };
    let cap = crate::access::CAP_VIEW;
    Ok(crate::auth::has_cap(
        &user,
        &conn,
        &ctx.row.from_drive,
        rel,
        cap,
    ))
}

fn copy_node(
    ctx: &CopyCtx<'_>,
    src: &Path,
    rel: &str,
    dest: &Path,
    dest_rel: &str,
    st: &mut CopyState<'_>,
) -> Result<u64, JobError> {
    if st.cancel.load(Ordering::Relaxed) {
        return Err(JobError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled",
        )));
    }
    let meta = std::fs::symlink_metadata(src).map_err(JobError::Io)?;
    if meta.file_type().is_symlink() {
        return Err(JobError::Symlink);
    }
    // Re-authorize THIS node, not just the job's root at start: a grant
    // revoked mid-copy — or a node mapping onto a different trash origin
    // than the entry above it — must stop the job here, not after the
    // bytes already left the drive.
    let real_rel = {
        let conn = ctx
            .db
            .lock()
            .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
        let authorized_path = if ctx.row.kind == "move" {
            &ctx.row.from_path
        } else {
            rel
        };
        recheck_job_caps_for(&conn, ctx.row, authorized_path)?;
        files::real_rel_path(&conn, &ctx.row.from_drive, rel)?
    };
    // Re-resolve the node inside the source drive's jail: the verified
    // canonical path must be exactly the one the parent listing handed us,
    // so a component swapped for a symlink since `read_dir` ran cannot
    // redirect the copy (inside the jail or out of it).
    let verified = luna_core::path::resolve_child(&ctx.src_root, &real_rel).map_err(jail_err)?;
    if verified != src {
        return Err(jail_err(luna_core::path::PathError::Escape));
    }

    if meta.is_dir() {
        // No-replace claim on the destination root: create_dir_all would
        // silently merge into a concurrently-created tree. Child levels are
        // reached only through this root, so plain create_dir is enough.
        if !st.owned_dest {
            files::create_dir_new(dest).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    JobError::Conflict
                } else {
                    JobError::Io(e)
                }
            })?;
            st.owned_dest = true;
        } else {
            files::create_dir_new(dest).map_err(JobError::Io)?;
        }
        let private = crate::private::children_of(&ctx.src_root, &real_rel);
        let mut entries: Vec<_> = std::fs::read_dir(&verified)
            .map_err(JobError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(JobError::Io)?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let file_name = entry.file_name();
            // Skip Luna-internal names (`.luna-<uuid>-*`, `.part` temps) and
            // non-UTF-8 names the API can never address — a copy must not
            // sweep bookkeeping or half-uploaded bytes into the destination.
            let Some(disk) = file_name.to_str() else {
                continue;
            };
            let item = private.get(disk);
            if item.is_none() && files::is_internal_temp(disk) {
                continue;
            }
            let name = item.map_or(disk, |i| i.name());
            let child_src = entry.path();
            let child_rel = crate::gallery::gallery_indexer::join_rel(rel, name);
            let child_dest_rel = crate::gallery::gallery_indexer::join_rel(dest_rel, name);
            // A private item inside the tree lands as a private item. A copy
            // leaves out what the caller can't reach; a move carries the
            // whole boundary with its owner — the mover reads none of it.
            let child_dest = match item {
                Some(item) => {
                    if ctx.row.kind != "move" && !node_allowed(ctx, &child_rel)? {
                        continue;
                    }
                    let prefix = ctx.to_prefix.as_deref().ok_or(JobError::Conflict)?;
                    let id = crate::private::new_id();
                    let owner = if ctx.row.kind == "move" {
                        item.owner.as_str()
                    } else {
                        ctx.row.user_id.as_str()
                    };
                    crate::private::create_with_id(&ctx.to_root, &child_dest_rel, owner, &id)
                        .map_err(JobError::Db)?;
                    dest.join(crate::private::disk_name(prefix, &id))
                }
                None => dest.join(name),
            };
            copy_node(
                ctx,
                &child_src,
                &child_rel,
                &child_dest,
                &child_dest_rel,
                st,
            )?;
        }
        return Ok(st.done);
    }

    // Open against a re-verified descriptor: the fd-level check proves the
    // bytes read are the jailed node's bytes even if the drive swapped a
    // path component between the listing above and this open.
    let (mut input, opened) =
        luna_core::path::open_verified(&ctx.src_root, &real_rel).map_err(jail_err)?;
    if opened != src {
        drop(input);
        return Err(jail_err(luna_core::path::PathError::Escape));
    }
    let tmp = {
        let parent = dest.parent().ok_or_else(|| {
            JobError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "no parent",
            ))
        })?;
        let conn = ctx
            .db
            .lock()
            .map_err(|_| JobError::Io(std::io::Error::other("db lock poisoned")))?;
        files::temp_path(&conn, &ctx.row.to_drive, parent).map_err(JobError::Files)?
    };
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(JobError::Io)?;
    let count_bytes = node_allowed(ctx, rel)?;
    let mut buf = vec![0u8; COPY_BUF];
    loop {
        if st.cancel.load(Ordering::Relaxed) {
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
        if count_bytes {
            st.done += n as u64;
        }
        if (st.done % (COPY_BUF as u64) < (COPY_BUF as u64 / 4) || st.done == st.total)
            && let Ok(conn) = ctx.db.lock()
        {
            let _ = db::update_job_progress(&conn, st.job_id, st.done, st.total);
        }
    }
    output.flush().map_err(JobError::Io)?;
    output.sync_all().map_err(JobError::Io)?;
    drop(output);
    files::install_temp(&tmp, dest, false)?;
    // We own this leaf now; only our cleanup may ever remove it.
    st.owned_dest = true;
    copy_form_files(ctx, src, dest, st, count_bytes)?;
    Ok(st.done)
}

/// A copied form takes its own hidden files folder along (question pictures,
/// attachments). Other Luna-owned names stay behind. The folder is named
/// after each drive's prefix and the form's file name, so the destination
/// name is worked out fresh. Only the form's own sibling folder is read, and
/// links inside it are skipped.
fn copy_form_files(
    ctx: &CopyCtx<'_>,
    src: &Path,
    dest: &Path,
    st: &mut CopyState<'_>,
    count_bytes: bool,
) -> Result<(), JobError> {
    if !crate::api::forms::is_form_file(dest) {
        return Ok(());
    }
    let Some(from_dir) = crate::api::forms::files_dir_for(&ctx.src_root, src) else {
        return Ok(());
    };
    if !std::fs::symlink_metadata(&from_dir).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    let to_root = {
        let conn = ctx
            .db
            .lock()
            .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
        PathBuf::from(files::drive_root(&conn, &ctx.row.to_drive)?.mount_point)
    };
    let Some(to_dir) = crate::api::forms::files_dir_for(&to_root, dest) else {
        return Ok(());
    };
    let result = copy_plain_tree(&from_dir, &to_dir, st, count_bytes);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&to_dir);
    }
    result
}

fn copy_plain_tree(
    src: &Path,
    dest: &Path,
    st: &mut CopyState<'_>,
    count_bytes: bool,
) -> Result<(), JobError> {
    if st.cancel.load(Ordering::Relaxed) {
        return Err(JobError::Io(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "cancelled",
        )));
    }
    files::create_dir_new(dest).map_err(JobError::Io)?;
    for entry in std::fs::read_dir(src).map_err(JobError::Io)? {
        let entry = entry.map_err(JobError::Io)?;
        let meta = std::fs::symlink_metadata(entry.path()).map_err(JobError::Io)?;
        let target = dest.join(entry.file_name());
        if meta.is_dir() {
            copy_plain_tree(&entry.path(), &target, st, count_bytes)?;
        } else if meta.is_file() {
            let bytes = std::fs::copy(entry.path(), &target).map_err(JobError::Io)?;
            if count_bytes {
                st.done += bytes;
            }
        }
    }
    Ok(())
}

/// The cancel flags are plain bools; a panic elsewhere must not wedge them.
fn lock_cancels(
    cancels: &Mutex<HashMap<String, Arc<AtomicBool>>>,
) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    cancels
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn index_busy() -> JobError {
    JobError::Db(anyhow::anyhow!("Luna's index is busy"))
}

fn plain_job_error(err: &JobError) -> String {
    match err {
        JobError::Conflict => "A file or folder with this name is already there.".into(),
        JobError::Symlink => "Luna can't copy links yet.".into(),
        JobError::Denied => "You no longer have permission to do this.".into(),
        JobError::Blocked => {
            "This folder holds private items that only their owners can move.".into()
        }
        JobError::Files(FilesError::UnknownDrive) => {
            "Luna doesn't know one of these drives. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.".into()
        }
        JobError::Files(FilesError::MissingDriveDb) => files::MISSING_DRIVE_DB_MSG.into(),
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
mod tests;
