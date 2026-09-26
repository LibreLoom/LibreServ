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
    #[error("The permission this job was created with is gone.")]
    Denied,
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
    // raw `{prefix}-trash` dir) would hand every member's deletions —
    // including member-home origins — to anyone holding a drive-root
    // grant, and moving it would relocate the whole trash store. Specific
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
    // but an admin's drive-wide grant, leaking member-home deletions.
    if files::is_trash_rel(&from_real) && !files::is_trash_api(from_path) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "trash entries move through the trash API only",
        ))
        .into());
    }
    // A top-level trash entry lands under its original name — the `{nonce}-`
    // prefix is storage noise that must not leak into the destination.
    let name = files::trash_api_leaf(conn, from_drive, from_path)?
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
    // Luna-managed destinations (the members container during a home
    // migration) are blocked user paths — resolve them through the internal
    // variant that creates missing dirs. Only internally enqueued jobs can
    // point there; member submissions reject blocked paths up front.
    let dest_dir = if files::is_internal_temp(&crate::access::normalize_subject_path(to_path)) {
        files::dest_dir_luna(conn, to_drive, to_path)?
    } else {
        files::dest_dir(conn, to_drive, to_path)?
    };
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
            // Luna's `.luna-<uuid>-*` bookkeeping and in-flight `.part` temps
            // are not content — they must not count toward the copy total.
            if entry
                .file_name()
                .to_str()
                .is_none_or(files::is_internal_temp)
            {
                continue;
            }
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
fn recheck_job_caps(db: &Arc<Mutex<Connection>>, row: &JobRow) -> Result<(), JobError> {
    let conn = db
        .lock()
        .map_err(|_| JobError::Db(anyhow::anyhow!("db busy")))?;
    recheck_job_caps_for(&conn, row, &row.from_path)
}

/// [`recheck_job_caps`] evaluated on `from_path` instead of the job's own
/// source, on a connection the caller already holds. The copy traversal
/// calls this per node with the node's own rel path, so a child whose
/// grants differ from the root's (a nested trash origin, a member-home
/// boundary, a grant revoked mid-copy) stops the job at that node rather
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
    // Member-home migration jobs are created internally by the admin-only
    // home-drive switch — admins hold zero caps inside member homes by
    // design, so a job that touches a home path is only legal when it still
    // belongs to an admin.
    if user.role == "admin"
        && (crate::member_home::is_member_home_path(from_path)
            || crate::member_home::is_member_home_path(&row.to_path))
    {
        return Ok(());
    }
    Err(JobError::Denied)
}

fn run_job(
    db: Arc<Mutex<Connection>>,
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
    if prepared.row.kind == "move" {
        match files::try_rename_move(&prepared.src, &prepared.dest) {
            Ok(true) => {
                if let Ok(conn) = db.lock() {
                    // Shares follow the file: subject rows point at the new
                    // drive/path before the job reports done.
                    let leaf = prepared
                        .dest
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let new_rel =
                        crate::gallery::gallery_indexer::join_rel(&prepared.row.to_path, &leaf);
                    if let Err(e) = crate::access::repath_subjects_move(
                        &conn,
                        &prepared.row.from_drive,
                        &prepared.row.from_path,
                        &prepared.row.to_drive,
                        &new_rel,
                    ) {
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
                        note_member_home_move(&conn, &prepared.row);
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
            CopyCtx {
                db: &db,
                row: &prepared.row,
                src_root: PathBuf::from(drive.mount_point),
            }
        };
        copy_node(
            &ctx,
            &prepared.src,
            &prepared.row.from_path,
            &prepared.dest,
            &mut st,
        )?;

        if prepared.row.kind == "move" {
            let conn = db.lock().unwrap();
            // Retarget the subject rows to the destination BEFORE trashing
            // the source — delete_to_trash revokes whatever still points at
            // the old path, so shares must already live at the new one.
            let leaf = prepared
                .dest
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let new_rel = crate::gallery::gallery_indexer::join_rel(&prepared.row.to_path, &leaf);
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
                note_member_home_move(&conn, &prepared.row);
                return Err(JobError::from(e));
            }
            note_member_home_move(&conn, &prepared.row);
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

/// A completed move of a home root into the members dir is a member-home
/// migration: point the member at the drive their home now lives on. Runs
/// only after the move's subjects repathed and the source was trashed — a
/// failed copy never flips the pointer.
fn note_member_home_move(conn: &Connection, row: &JobRow) {
    if row.kind != "move" || !crate::member_home::is_members_dir(&row.to_path) {
        return;
    }
    if crate::member_home::is_home_root(&row.from_path)
        && let Some(uid) = crate::member_home::owner_of(conn, &row.from_drive, &row.from_path)
    {
        let _ = db::set_user_home_drive(conn, &uid, &row.to_drive);
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
    db: &'a Arc<Mutex<Connection>>,
    row: &'a JobRow,
    /// `row.from_drive`'s mount point — the jail every node re-resolves in.
    src_root: PathBuf,
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

fn copy_node(
    ctx: &CopyCtx<'_>,
    src: &Path,
    rel: &str,
    dest: &Path,
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
        recheck_job_caps_for(&conn, ctx.row, rel)?;
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
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if files::is_internal_temp(name) {
                continue;
            }
            let child_src = entry.path();
            let child_dest = dest.join(name);
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            copy_node(ctx, &child_src, &child_rel, &child_dest, st)?;
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
        st.done += n as u64;
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
    Ok(st.done)
}

fn plain_job_error(err: &JobError) -> String {
    match err {
        JobError::Conflict => "A file or folder with this name is already there.".into(),
        JobError::Symlink => "Luna can't copy links yet.".into(),
        JobError::Denied => "The permission this job was created with is gone.".into(),
        JobError::Files(FilesError::UnknownDrive) => {
            "Luna doesn't know one of these drives. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.".into()
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
mod tests {
    use super::*;

    /// Write a `.luna-<uuid>` marker so the dir behaves like an adopted drive.
    fn adopt(root: &Path, id: &str) {
        let prefix = luna_core::marker::pick_prefix(root).unwrap();
        crate::drives::drive_db::create(root, &luna_core::marker::Marker::new(id, "t"), &prefix)
            .unwrap();
    }

    /// The drive's real trash dir name (`.luna-<uuid>-trash`).
    fn trash_dir_name(root: &Path) -> String {
        format!(
            "{}-trash",
            crate::drives::drive_db::prefix_for(root).unwrap()
        )
    }

    fn setup() -> (tempfile::TempDir, Arc<Mutex<Connection>>, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("a");
        std::fs::create_dir_all(&root).unwrap();
        adopt(&root, "a");
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
        adopt(&root2, "b");
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
        users(&conn);
        (dir, Arc::new(Mutex::new(conn)), "a".into())
    }

    /// The run-time capability recheck needs a real user row — give tests an
    /// admin so `has_cap` passes the same way it would for a live session.
    fn users(conn: &Connection) {
        for id in ["user-1", "sam"] {
            db::insert_user(conn, id, id, id, "hash", "admin").unwrap();
        }
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
        adopt(&root_a, "a");
        db::upsert_drive(&conn, "a", "A", "as_is", "ext4", "sda", root_a.to_str()?).ok()?;
        let root_b = dir_b.path().join("b");
        std::fs::create_dir_all(&root_b).ok()?;
        adopt(&root_b, "b");
        db::upsert_drive(&conn, "b", "B", "as_is", "ext4", "sdb", root_b.to_str()?).ok()?;
        users(&conn);
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
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
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
        let trash = root.join(trash_dir_name(&root));
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
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
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
        let trash_entries: Vec<_> =
            std::fs::read_dir(PathBuf::from(&root_a).join(trash_dir_name(Path::new(&root_a))))
                .unwrap()
                .filter_map(|e| e.ok())
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
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
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
        let trash = dir
            .path()
            .join("a")
            .join(trash_dir_name(&dir.path().join("a")));
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
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
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

    #[tokio::test]
    async fn move_out_of_trash_lands_under_the_original_name() {
        let (dir, db, _a) = setup();
        let trash_rel = {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
            std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
            files::delete_to_trash(&conn, "a", "note.txt").unwrap()
        };
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        let job = manager
            .enqueue("move", "a", &trash_rel, "a", "inbox", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);

        let root = dir.path().join("a");
        // The destination name is the original name — the `{nonce}-`
        // storage prefix must not leak out of trash.
        assert_eq!(std::fs::read(root.join("inbox/note.txt")).unwrap(), b"back");
        let conn = db.lock().unwrap();
        assert!(
            files::list_trash(&conn, "a").unwrap().is_empty(),
            "moving out removes the trash entry"
        );
    }

    #[tokio::test]
    async fn copy_out_of_trash_keeps_the_trash_entry() {
        let (dir, db, _a) = setup();
        let trash_rel = {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
            std::fs::write(format!("{root}/note.txt"), b"dup").unwrap();
            files::delete_to_trash(&conn, "a", "note.txt").unwrap()
        };
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        let job = manager
            .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        assert_eq!(
            std::fs::read(dir.path().join("a/inbox/note.txt")).unwrap(),
            b"dup"
        );
        let conn = db.lock().unwrap();
        assert_eq!(files::list_trash(&conn, "a").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn moving_into_trash_is_rejected() {
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/note.txt"), b"stay").unwrap();
        }
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        assert!(
            manager
                .enqueue("move", "a", "note.txt", "a", ".luna-trash", "user-1")
                .await
                .is_err(),
            "dropping onto a trash path is not a move destination"
        );
    }

    #[tokio::test]
    async fn the_trash_root_is_never_a_job_source() {
        // Copying `.luna-trash` wholesale would hand every member's
        // deletions — including member-home origins — to whoever holds a
        // drive-root grant; moving it would relocate the whole trash
        // store. Both alias and raw `{prefix}-trash` forms refuse at
        // enqueue, while a specific ENTRY still copies out.
        let (dir, db, _a) = setup();
        let (trash_rel, raw_root) = {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
            std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
            let rel = files::delete_to_trash(&conn, "a", "note.txt").unwrap();
            (rel, trash_dir_name(Path::new(&root)))
        };
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        for kind in ["copy", "move"] {
            for src in [".luna-trash", ".luna-trash/", raw_root.as_str()] {
                assert!(
                    manager
                        .enqueue(kind, "a", src, "a", "inbox", "user-1")
                        .await
                        .is_err(),
                    "{kind} from {src:?} must be refused"
                );
            }
        }

        // The trash root is no job destination either, raw or alias —
        // already covered for the alias by moving_into_trash_is_rejected.
        assert!(
            manager
                .enqueue("copy", "a", "inbox", "a", &raw_root, "user-1")
                .await
                .is_err()
        );

        // A specific entry still lands under its original name.
        let job = manager
            .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        assert_eq!(
            std::fs::read(dir.path().join("a/inbox/note.txt")).unwrap(),
            b"back"
        );
    }

    #[tokio::test]
    async fn copying_a_renamed_trash_item_uses_the_new_name() {
        let (dir, db, _a) = setup();
        let trash_rel = {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/inbox")).unwrap();
            std::fs::write(format!("{root}/note.txt"), b"back").unwrap();
            let rel = files::delete_to_trash(&conn, "a", "note.txt").unwrap();
            files::rename(&conn, "a", &rel, "renamed.txt").unwrap();
            // Rename keeps the nonce but swaps the leaf on disk — the old
            // path no longer resolves, so re-list for the new entry name.
            let name = files::list_trash(&conn, "a").unwrap()[0].name.clone();
            format!("{}/{}", files::TRASH_API_ALIAS, name)
        };
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        let job = manager
            .enqueue("copy", "a", &trash_rel, "a", "inbox", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);

        // The item was retitled while in trash — the copy lands under the
        // new name, not the original or the `{nonce}-` storage name.
        assert_eq!(
            std::fs::read(dir.path().join("a/inbox/renamed.txt")).unwrap(),
            b"back"
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
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
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
        let manager = JobManager::new(db, crate::gallery::gallery_indexer::GalleryIndexer::start());
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
        let manager = JobManager::new(db, crate::gallery::gallery_indexer::GalleryIndexer::start());
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

    /// A non-admin member holding `caps` on `path` on `drive`.
    fn member(conn: &Connection, id: &str, drive: &str, path: &str, caps: crate::access::Caps) {
        if db::get_user(conn, id).unwrap().is_none() {
            db::insert_user(conn, id, id, id, "hash", "member").unwrap();
        }
        db::insert_access_member(
            conn,
            &db::AccessMemberRow {
                id: format!("g-{id}-{drive}"),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: drive.into(),
                path: path.into(),
                album_id: String::new(),
                user_id: id.into(),
                caps,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn job_rechecks_capabilities_when_it_runs() {
        // Enqueue checks nothing by itself — the API gate did — so a job
        // must not execute on stale authorization. A member with no grants
        // reaches the executor and is refused there, not silently copied.
        let (dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::write(format!("{root}/note.txt"), b"nope").unwrap();
            db::insert_user(&conn, "evie", "evie", "evie", "hash", "member").unwrap();
        }
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        let job = manager
            .enqueue("copy", "a", "note.txt", "b", "", "evie")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "error");
        assert_eq!(
            done.error,
            "The permission this job was created with is gone."
        );
        assert!(!dir.path().join("b/note.txt").exists());

        // The same job with live grants runs to completion — the member
        // needs the source read on "a" and the write on "b".
        {
            let conn = db.lock().unwrap();
            member(&conn, "mara", "a", "", crate::access::CAP_ALL);
            member(&conn, "mara", "b", "", crate::access::CAP_ALL);
        }
        let job = manager
            .enqueue("copy", "a", "note.txt", "b", "", "mara")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        assert_eq!(
            std::fs::read(dir.path().join("b/note.txt")).unwrap(),
            b"nope"
        );
    }

    #[tokio::test]
    async fn copy_into_own_subtree_is_rejected() {
        // `a` → `a` or `a` → `a/sub` would copy the destination into itself
        // forever. Rejected at enqueue, on the same drive only.
        let (_dir, db, _a) = setup();
        {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/docs/sub")).unwrap();
        }
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        for (kind, to) in [("copy", "docs"), ("copy", "docs/sub"), ("move", "docs/sub")] {
            assert!(
                manager
                    .enqueue(kind, "a", "docs", "a", to, "user-1")
                    .await
                    .is_err(),
                "{kind} docs -> {to} must be refused"
            );
        }
        // The same nested destination on ANOTHER drive is fine — the trees
        // can't overlap across drives.
        let job = manager
            .enqueue("copy", "a", "docs", "b", "", "user-1")
            .await
            .unwrap();
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
    }

    #[tokio::test]
    async fn copy_skips_luna_internal_entries() {
        // A `.luna-<uuid>-*` name inside user content is bookkeeping, not
        // content: it must neither count toward the total nor be copied.
        let (dir, db, _a) = setup();
        let internal = {
            let conn = db.lock().unwrap();
            let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
            std::fs::create_dir_all(format!("{root}/docs")).unwrap();
            std::fs::write(format!("{root}/docs/real.txt"), b"real").unwrap();
            let prefix = crate::drives::drive_db::prefix_for(Path::new(&root)).unwrap();
            let internal = format!("{prefix}-upload.fake.part");
            std::fs::write(format!("{root}/docs/{internal}"), b"half").unwrap();
            internal
        };
        let manager = JobManager::new(
            db.clone(),
            crate::gallery::gallery_indexer::GalleryIndexer::start(),
        );
        let job = manager
            .enqueue("copy", "a", "docs", "b", "", "user-1")
            .await
            .unwrap();
        assert_eq!(job.total, 4, "only real.txt counts toward the total");
        wait_done(&manager, &job.id);
        let done = manager.get(&job.id).unwrap().unwrap();
        assert_eq!(done.state, "done", "{}", done.error);
        assert_eq!(
            std::fs::read(dir.path().join("b/docs/real.txt")).unwrap(),
            b"real"
        );
        assert!(!dir.path().join("b/docs").join(&internal).exists());
    }

    #[test]
    fn recheck_follows_each_nodes_own_path() {
        // The traversal calls the recheck with the NODE's rel, not the job
        // root's: a grant that dies mid-copy refuses a not-yet-copied child
        // even though the job row still names the granted root.
        let (_dir, db, _a) = setup();
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{root}/docs")).unwrap();
        std::fs::create_dir_all(format!("{root}/out")).unwrap();
        member(&conn, "mara", "a", "docs", crate::access::CAP_VIEW);
        db::insert_access_member(
            &conn,
            &db::AccessMemberRow {
                id: "g-mara-out".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "a".into(),
                path: "out".into(),
                album_id: String::new(),
                user_id: "mara".into(),
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
        db::insert_job(&conn, "j1", "copy", "a", "docs", "a", "out", 10, "mara").unwrap();
        let row = db::get_job(&conn, "j1").unwrap().unwrap();

        assert!(recheck_job_caps_for(&conn, &row, "docs").is_ok());
        assert!(recheck_job_caps_for(&conn, &row, "docs/inner.txt").is_ok());
        db::delete_access_member(&conn, "g-mara-a").unwrap();
        assert!(matches!(
            recheck_job_caps_for(&conn, &row, "docs/inner.txt"),
            Err(JobError::Denied)
        ));
    }

    #[test]
    fn raw_trash_paths_need_edit_not_view() {
        let (_dir, db, _a) = setup();
        let conn = db.lock().unwrap();
        let root = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::write(format!("{root}/gone.txt"), b"x").unwrap();
        let api_rel = files::delete_to_trash(&conn, "a", "gone.txt").unwrap();

        // The alias already requires edit…
        assert_eq!(
            job_source_cap(&conn, "copy", "a", &api_rel),
            crate::access::CAP_EDIT
        );
        // …and so does the raw on-disk trash path, which the alias mapping
        // inside caps_on_path would otherwise miss.
        let raw = format!("{}/x", trash_dir_name(Path::new(&root)));
        assert_eq!(
            job_source_cap(&conn, "copy", "a", &raw),
            crate::access::CAP_EDIT
        );
        // Plain content stays at the expected level.
        assert_eq!(
            job_source_cap(&conn, "copy", "a", "docs"),
            crate::access::CAP_VIEW
        );
        assert_eq!(
            job_source_cap(&conn, "move", "a", "docs"),
            crate::access::CAP_EDIT
        );
    }
}
