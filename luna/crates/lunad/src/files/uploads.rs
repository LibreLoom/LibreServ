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

fn drive_db_for(central: &Connection, drive_id: &str) -> Result<Connection, UploadError> {
    let drive = db::get_drive(central, drive_id)
        .map_err(UploadError::Db)?
        .filter(|d| !d.mount_point.is_empty())
        .ok_or_else(|| UploadError::Db(anyhow::anyhow!("drive is not mounted")))?;
    crate::drives::drive_db::open_migrating(Path::new(&drive.mount_point), central, drive_id)
        .map_err(UploadError::Db)
}

/// Locate an upload session by scanning mounted drive microdbs.
fn find_upload(central: &Connection, id: &str) -> Result<(UploadRow, Connection), UploadError> {
    for drive in db::list_drives(central).map_err(UploadError::Db)? {
        if drive.mount_point.is_empty() || drive.state != "as_is" {
            continue;
        }
        let Ok(dconn) = crate::drives::drive_db::open_migrating(
            Path::new(&drive.mount_point),
            central,
            &drive.id,
        ) else {
            continue;
        };
        if let Ok(Some(row)) = db::get_upload(&dconn, id) {
            return Ok((row, dconn));
        }
    }
    Err(UploadError::NotFound)
}

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
    #[error("You don't have permission to finish this upload.")]
    Denied,
}

impl From<FilesError> for UploadError {
    fn from(e: FilesError) -> Self {
        UploadError::Files(e)
    }
}

/// Create an upload session: resolve + jail the destination, create the temp
/// file, and persist the row. The session is unscoped — callers with a real
/// principal should use [`create_scoped`] so the session can only be driven
/// by whoever opened it.
pub fn create(
    conn: &Connection,
    drive_id: &str,
    dest_path: &str,
    name: &str,
    size: u64,
) -> Result<Upload, UploadError> {
    create_scoped(conn, drive_id, dest_path, name, size, "")
}

/// Like [`create`], but stamps the session with its owner — `user:{id}` for
/// members, `link:{id}` for public share uploads. The API layer refuses to
/// drive a session whose principal does not match the caller.
pub fn create_scoped(
    conn: &Connection,
    drive_id: &str,
    dest_path: &str,
    name: &str,
    size: u64,
    principal: &str,
) -> Result<Upload, UploadError> {
    let name = files::safe_name(name).map_err(|_| {
        FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid file name",
        ))
    })?;
    // A `.part`-style or Luna-namespace leaf mints a file no listing can
    // ever show — session names are held to the create-path bar so a
    // stranded invisible file can never be uploaded.
    if files::is_blocked_create_path(&name) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        ))
        .into());
    }
    let dir = files::dest_dir_create(conn, drive_id, dest_path)?;
    let id = Uuid::new_v4().to_string();
    let temp = temp_for(conn, drive_id, &dir, &id)?;

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(UploadError::Io)?;

    let drive_conn = drive_db_for(conn, drive_id)?;
    db::insert_upload(
        &drive_conn,
        &id,
        drive_id,
        dest_path,
        &name,
        size,
        principal,
    )
    .map_err(UploadError::Db)?;
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
    let (row, _dconn) = find_upload(conn, id)?;
    to_upload(conn, &row)
}

pub fn get_row(conn: &Connection, id: &str) -> Result<UploadRow, UploadError> {
    Ok(find_upload(conn, id)?.0)
}

fn to_upload(conn: &Connection, row: &UploadRow) -> Result<Upload, UploadError> {
    let dir = files::dest_dir_create(conn, &row.drive_id, &row.path)?;
    let temp = temp_for(conn, &row.drive_id, &dir, &row.id)?;
    Ok(Upload {
        id: row.id.clone(),
        drive_id: row.drive_id.clone(),
        path: row.path.clone(),
        name: row.name.clone(),
        size: row.size,
        received: row.received,
        temp,
    })
}

/// Temp files are named after the upload id inside the drive's `.luna-<uuid>`
/// namespace, so restart recovery is trivial and collisions impossible.
fn temp_for(
    conn: &Connection,
    drive_id: &str,
    dir: &Path,
    id: &str,
) -> Result<PathBuf, UploadError> {
    let drive = files::drive_root(conn, drive_id).map_err(UploadError::Files)?;
    let layout = crate::drives::layout::Layout::detect(Path::new(&drive.mount_point))
        .ok_or_else(|| UploadError::Db(anyhow::anyhow!("drive is not adopted")))?;
    Ok(dir.join(layout.upload_part_name(id)))
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
        let (_row, dconn) = find_upload(&conn, id)?;
        if upload.state_not_active(&dconn)? {
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
        let (_row, dconn) = find_upload(&conn, id)?;
        flush_pending(&dconn, id)?;
    }
    Ok(received)
}

/// Verify length, contiguous coverage, and (optionally) a client-supplied
/// blake3 hash, then install. The caller chooses overwrite semantics.
/// `rename_on_conflict` keeps the upload row because a link holder can't see
/// which names are taken (upload-only drop boxes): instead of failing, the
/// file lands as `name (1).ext` like Nextcloud file requests.
pub fn complete(
    db: &Arc<Mutex<Connection>>,
    id: &str,
    overwrite: bool,
    rename_on_conflict: bool,
    expected_hash: Option<&str>,
) -> Result<FileEntry, UploadError> {
    let conn = db.lock().map_err(|_| UploadError::NotFound)?;
    let (row, dconn) = find_upload(&conn, id)?;
    flush_pending(&dconn, id)?;
    let upload = to_upload(&conn, &row)?;
    if upload.state_not_active(&dconn)? {
        return Err(UploadError::NotActive);
    }

    let meta = std::fs::metadata(&upload.temp).map_err(UploadError::Io)?;
    // The sparse temp file's logical length equals `size` even if only the tail
    // was written, so length alone is not enough — every byte must be covered
    // contiguously from 0, otherwise a resumable client that lost earlier
    // chunks would install a file full of zero holes.
    let covered = db::upload_fully_covered(&dconn, id, upload.size).map_err(UploadError::Db)?;
    if meta.len() != upload.size || !covered {
        db::set_upload_state(&dconn, id, "error", "incomplete").map_err(UploadError::Db)?;
        return Err(UploadError::SizeMismatch);
    }

    if let Some(expected) = expected_hash.filter(|h| !h.is_empty()) {
        let actual = blake3_hash_file(&upload.temp).map_err(UploadError::Io)?;
        if !actual.eq_ignore_ascii_case(expected) {
            db::set_upload_state(&dconn, id, "error", "hash-mismatch").map_err(UploadError::Db)?;
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

    let dir = files::dest_dir_create(&conn, &upload.drive_id, &upload.path)?;
    let mut name = upload.name;
    // Defense in depth on the leaf name — a session row predating the
    // create-time check must not mint an invisible file either.
    if files::is_blocked_create_path(&name) {
        return Err(FilesError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "that name is reserved for Luna",
        ))
        .into());
    }
    // Re-authorize at install time: the API's checks ran before the bytes
    // arrived, and a file may have appeared (or a grant been revoked)
    // since. Only a principal still holding UPLOAD on the folder — and
    // EDIT on the destination file — may install over something existing.
    let may_overwrite = match install_rights(&conn, &row, &dir.join(&name), overwrite) {
        Ok(may) => may,
        Err(e) => {
            if matches!(e, UploadError::Denied) {
                let _ = db::set_upload_state(&dconn, id, "error", "denied");
            }
            return Err(e);
        }
    };
    let dest = dir.join(&name);
    if dest.exists() {
        if may_overwrite {
            // EDIT verified above — the install below may clobber.
        } else if rename_on_conflict {
            name = find_free_name(&dir, &name);
            db::update_upload_name(&dconn, id, &name).map_err(UploadError::Db)?;
        } else if overwrite {
            // Asked to overwrite but the fresh check says this file is not
            // theirs to replace.
            let _ = db::set_upload_state(&dconn, id, "error", "denied");
            return Err(UploadError::Denied);
        } else {
            return Err(UploadError::Files(FilesError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "destination exists",
            ))));
        }
    }
    let dest = dir.join(&name);
    // Effective overwrite comes from the recheck, never the caller's flag:
    // upload-only sessions land on install_temp's atomic no-overwrite path
    // even if a destination raced into existence after the check above.
    if let Err(e) = files::install_temp(&upload.temp, &dest, may_overwrite) {
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
    db::delete_upload(&dconn, id).map_err(UploadError::Db)?;
    db::delete_upload_chunks(&dconn, id).map_err(UploadError::Db)?;

    Ok(FileEntry {
        name,
        kind: "file".into(),
        size: final_meta.len(),
        modified,
        hidden: false,
        saving: false,
        original_name: None,
        original_path: None,
        link_target: None,
        caps: String::new(),
        home: false,
    })
}

/// Re-authorize a finishing upload against its own session principal,
/// evaluated NOW — the API's checks ran before the bytes arrived and the
/// destination may have changed since. `Err(Denied)` when a `user:`
/// principal lost CAP_UPLOAD on the folder entirely; otherwise the
/// returned bool is the *effective* overwrite right — `false` for every
/// principal lacking CAP_EDIT on the destination file, so `install_temp`'s
/// atomic no-overwrite path is the only way their bytes can land.
fn install_rights(
    conn: &Connection,
    row: &UploadRow,
    dest: &Path,
    want_overwrite: bool,
) -> Result<bool, UploadError> {
    let Some(uid) = row.principal.strip_prefix("user:") else {
        // `link:` sessions are upload-only drop boxes, and rows predating
        // principals have no user to re-verify — neither may overwrite.
        return Ok(false);
    };
    let Some(u) = db::get_user(conn, uid).map_err(UploadError::Db)? else {
        return Err(UploadError::Denied);
    };
    let user = crate::auth::CurrentUser {
        id: u.id,
        username: u.username,
        role: u.role,
    };
    if !crate::auth::has_cap(
        &user,
        conn,
        &row.drive_id,
        &row.path,
        crate::access::CAP_UPLOAD,
    ) {
        return Err(UploadError::Denied);
    }
    if !want_overwrite || !dest.exists() {
        return Ok(false);
    }
    let rel = crate::gallery::gallery_indexer::join_rel(&row.path, &row.name);
    Ok(crate::auth::has_cap(
        &user,
        conn,
        &row.drive_id,
        &rel,
        crate::access::CAP_EDIT,
    ))
}

/// Pick the first free name in `dir` by appending ` (n)` before the extension,
/// Nextcloud-style, so a drop box can land `report.pdf` next to a taken
/// `report.pdf` as `report (1).pdf`.
fn find_free_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    };
    let mut candidate = name.to_string();
    let mut n = 1;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem} ({n}){ext}");
        n += 1;
    }
    candidate
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
    let (row, dconn) = find_upload(&conn, id)?;
    let upload = to_upload(&conn, &row)?;
    let _ = std::fs::remove_file(&upload.temp);
    db::delete_upload(&dconn, id).map_err(UploadError::Db)?;
    db::delete_upload_chunks(&dconn, id).map_err(UploadError::Db)?;
    Ok(())
}

/// A session idle this long is orphaned — the client that opened it is gone.
const ORPHAN_IDLE_SECS: i64 = 24 * 60 * 60;

/// Boot-time cleanup: on every mounted drive, upload sessions idle past
/// [`ORPHAN_IDLE_SECS`] lose their `.part` temp file and their microdb row.
/// Runs once at daemon start so a crash or an abandoned upload never leaves
/// a resumable session — or its partial file — behind.
pub fn sweep_orphans(db: &Arc<Mutex<Connection>>) {
    let conn = match db.lock() {
        Ok(conn) => conn,
        Err(_) => return,
    };
    let cutoff = db::now_unix() - ORPHAN_IDLE_SECS;
    for drive in db::list_drives(&conn).unwrap_or_default() {
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            continue;
        }
        let root = Path::new(&drive.mount_point);
        let Ok(dconn) = crate::drives::drive_db::open_migrating(root, &conn, &drive.id) else {
            continue;
        };
        for row in db::list_stale_uploads(&dconn, cutoff).unwrap_or_default() {
            // The `.part` file sits inside the destination folder; when that
            // folder is gone the temp went with it.
            if let Ok(dir) = files::dest_dir(&conn, &row.drive_id, &row.path)
                && let Ok(temp) = temp_for(&conn, &row.drive_id, &dir, &row.id)
            {
                let _ = std::fs::remove_file(&temp);
            }
            let _ = db::delete_upload(&dconn, &row.id);
            let _ = db::delete_upload_chunks(&dconn, &row.id);
        }
    }
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
        let marker = luna_core::marker::Marker::new("d1", "Test");
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        crate::drives::drive_db::create(&root, &marker, &prefix).unwrap();
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

        let entry = complete(&db, &up.id, false, false, None).unwrap();
        assert_eq!(entry.size, 1000);

        let row = find_upload(&db.lock().unwrap(), &up.id).ok();
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
            complete(&db, &up.id, false, false, None),
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
            complete(&db, &up.id, false, false, None),
            Err(UploadError::SizeMismatch)
        ));
    }

    /// A non-admin member holding `caps` on `path` on the test drive.
    fn grant(conn: &Connection, user: &str, path: &str, caps: crate::access::Caps) {
        if db::get_user(conn, user).unwrap().is_none() {
            db::insert_user(conn, user, user, user, "hash", "member").unwrap();
        }
        db::insert_access_member(
            conn,
            &db::AccessMemberRow {
                id: format!("g-{user}-{path}"),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "d1".into(),
                path: path.into(),
                album_id: String::new(),
                user_id: user.into(),
                caps,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    #[test]
    fn session_names_cannot_mint_invisible_files() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        // `.x.part`-style leaves vanish from every listing — session
        // creation holds the same bar as `files::create`.
        assert!(create(&conn, &drive, "", ".x.part", 10).is_err());
        assert!(create_scoped(&conn, &drive, "", ".y.part", 10, "user:x").is_err());
        let luna = format!(
            ".luna-{}-upload.1.2.part",
            "3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f"
        );
        assert!(create(&conn, &drive, "", &luna, 10).is_err());
        assert!(create(&conn, &drive, "", "fine.txt", 10).is_ok());
    }

    #[test]
    fn complete_rechecks_caps_at_install() {
        // An upload-only member may finish into an EMPTY slot, but must not
        // clobber a file that appeared after the session's existence check —
        // and losing the grant mid-upload must stop the install outright.
        let (_dir, db, drive) = setup();
        let root = {
            let conn = db.lock().unwrap();
            grant(&conn, "mara", "", crate::access::CAP_UPLOAD);
            db::get_drive(&conn, &drive).unwrap().unwrap().mount_point
        };
        let up = {
            let conn = db.lock().unwrap();
            create_scoped(&conn, &drive, "", "note.txt", 4, "user:mara").unwrap()
        };
        write_chunk(&db, &up.id, 0, &[1u8; 4]).unwrap();

        // A file lands at the destination after the session opened.
        std::fs::write(Path::new(&root).join("note.txt"), b"taken").unwrap();
        assert!(matches!(
            complete(&db, &up.id, true, false, None),
            Err(UploadError::Denied)
        ));
        assert_eq!(
            std::fs::read(Path::new(&root).join("note.txt")).unwrap(),
            b"taken",
            "upload-only bytes never clobber an existing file"
        );

        // With EDIT on the destination the same overwrite is legitimate.
        {
            let conn = db.lock().unwrap();
            db::insert_access_member(
                &conn,
                &db::AccessMemberRow {
                    id: "g-mara-edit".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: drive.clone(),
                    path: "".into(),
                    album_id: String::new(),
                    user_id: "mara".into(),
                    caps: crate::access::CAP_ALL,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let up = {
            let conn = db.lock().unwrap();
            create_scoped(&conn, &drive, "", "note.txt", 4, "user:mara").unwrap()
        };
        write_chunk(&db, &up.id, 0, &[9u8; 4]).unwrap();
        complete(&db, &up.id, true, false, None).unwrap();
        assert_eq!(
            std::fs::read(Path::new(&root).join("note.txt")).unwrap(),
            vec![9u8; 4]
        );

        // Revoke the write grant mid-upload: completion must refuse even
        // though the session opened while the grant existed.
        let up = {
            let conn = db.lock().unwrap();
            grant(&conn, "evie", "", crate::access::CAP_UPLOAD);
            let up = create_scoped(&conn, &drive, "", "e.bin", 4, "user:evie").unwrap();
            db::delete_access_member(&conn, "g-evie-").unwrap();
            up
        };
        write_chunk(&db, &up.id, 0, &[5u8; 4]).unwrap();
        assert!(matches!(
            complete(&db, &up.id, false, false, None),
            Err(UploadError::Denied)
        ));
        assert!(!Path::new(&root).join("e.bin").exists());
    }

    #[test]
    fn link_sessions_never_overwrite() {
        // Drop-box sessions have no user caps to recheck — they stay
        // upload-only and land under a fresh name instead of clobbering.
        let (_dir, db, drive) = setup();
        let root = {
            let conn = db.lock().unwrap();
            db::get_drive(&conn, &drive).unwrap().unwrap().mount_point
        };
        std::fs::write(Path::new(&root).join("report.pdf"), b"original").unwrap();
        let up = {
            let conn = db.lock().unwrap();
            create_scoped(&conn, &drive, "", "report.pdf", 4, "link:l1").unwrap()
        };
        write_chunk(&db, &up.id, 0, &[7u8; 4]).unwrap();
        let entry = complete(&db, &up.id, true, true, None).unwrap();
        assert_eq!(entry.name, "report (1).pdf");
        assert_eq!(
            std::fs::read(Path::new(&root).join("report.pdf")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn upload_into_missing_subfolders_creates_them() {
        // Regression: a backup/sync subfolder (or a folder dropped on the web
        // UI) used to be rejected with "Luna can't use that destination." —
        // files deeper than the destination root were silently dropped.
        let (dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create(&conn, &drive, "DesktopBackup/subdir", "nested.txt", 5).unwrap();
        drop(conn);
        write_chunk(&db, &up.id, 0, b"hello").unwrap();
        let entry = complete(&db, &up.id, false, false, None).unwrap();
        assert_eq!(entry.name, "nested.txt");
        let root = dir.path().join("drive");
        let file = root.join("DesktopBackup/subdir/nested.txt");
        assert!(file.is_file());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "hello");
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
        assert!(find_upload(&db.lock().unwrap(), &up.id).is_err());
    }

    #[test]
    fn conflict_completes_renamed_when_requested_else_fails() {
        let (dir, db, drive) = setup();
        let root = dir.path().join("drive");

        // Plain complete fails when the name is already taken...
        let conn = db.lock().unwrap();
        let up1 = create(&conn, &drive, "", "clash.txt", 3).unwrap();
        drop(conn);
        write_chunk(&db, &up1.id, 0, b"one").unwrap();
        std::fs::write(root.join("clash.txt"), b"zed").unwrap();
        assert!(matches!(
            complete(&db, &up1.id, false, false, None),
            Err(UploadError::Files(crate::files::FilesError::Io(e)))
                if e.kind() == std::io::ErrorKind::AlreadyExists
        ));

        // ...and rename_on_conflict lands it as `clash (1).txt` instead.
        let conn = db.lock().unwrap();
        let up2 = create(&conn, &drive, "", "clash.txt", 3).unwrap();
        drop(conn);
        write_chunk(&db, &up2.id, 0, b"two").unwrap();
        let entry = complete(&db, &up2.id, false, true, None).unwrap();
        assert_eq!(entry.name, "clash (1).txt");
        assert_eq!(
            std::fs::read_to_string(root.join("clash (1).txt")).unwrap(),
            "two"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("clash.txt")).unwrap(),
            "zed"
        );
    }

    #[test]
    fn scoped_upload_remembers_its_principal() {
        let (_dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let up = create_scoped(&conn, &drive, "", "x.bin", 10, "user:u1").unwrap();
        let row = get_row(&conn, &up.id).unwrap();
        assert_eq!(row.principal, "user:u1");
        // The unscoped constructor leaves the principal empty — the API
        // layer must refuse anyone but an admin driving such a session.
        let legacy = create(&conn, &drive, "", "y.bin", 10).unwrap();
        assert_eq!(get_row(&conn, &legacy.id).unwrap().principal, "");
    }

    #[test]
    fn boot_sweep_removes_only_idle_sessions() {
        let (dir, db, drive) = setup();
        let conn = db.lock().unwrap();
        let stale = create_scoped(&conn, &drive, "", "old.bin", 10, "user:u1").unwrap();
        let fresh = create_scoped(&conn, &drive, "", "new.bin", 10, "user:u2").unwrap();
        drop(conn);
        assert!(stale.temp.exists() && fresh.temp.exists());

        // Age the stale row past the idle bound.
        let root = dir.path().join("drive");
        let dconn = crate::drives::drive_db::open(&root).unwrap();
        dconn
            .execute(
                "UPDATE uploads SET updated_at = ?2 WHERE id = ?1",
                rusqlite::params![stale.id, db::now_unix() - ORPHAN_IDLE_SECS - 60],
            )
            .unwrap();
        drop(dconn);

        sweep_orphans(&db);

        let conn = db.lock().unwrap();
        assert!(get_row(&conn, &stale.id).is_err());
        assert!(!stale.temp.exists(), "stale .part file is removed");
        assert!(get_row(&conn, &fresh.id).is_ok());
        assert!(fresh.temp.exists(), "fresh sessions are untouched");
    }
}
