//! The background worker that reads files' words.
//!
//! It follows the name indexer: once a drive has been read (or a folder on
//! it re-read), the files whose text is missing or out of date are read one
//! at a time — documents first, newest first — through the sandboxed
//! extractors. It waits when the box is short on memory, stops a drive's
//! pass the moment the drive goes away, and keeps per-drive counts for the
//! "still reading" notice.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rusqlite::{Connection, params};

use super::formats::{self, Format};
use super::meaning;
use super::photos;
use super::store::{self, Pending, State};
use super::worker::{self, Outcome};

/// Files fetched per query; small so a re-read folder jumps the queue soon.
const BATCH: usize = 32;
/// Below this much free memory the reader waits instead of starting a file.
const MIN_FREE_BYTES: u64 = 320 * 1024 * 1024;
/// How long to wait for memory before giving the pass up until next time.
const MEMORY_WAIT: Duration = Duration::from_secs(5);
const MEMORY_TRIES: u32 = 24;
/// A breath between files, so a slow disk keeps serving people first.
const PACE: Duration = Duration::from_millis(15);
const IDLE_POLL: Duration = Duration::from_millis(500);
/// Files embedded per step of the meaning top-up.
const MEANING_STEP: usize = 16;
/// Photos embedded per step of the photo-search top-up.
const PHOTO_STEP: usize = 8;

enum Msg {
    Kick { drive_id: String, full: bool },
}

#[derive(Debug, Clone, Copy, Default)]
struct DriveProgress {
    reading: bool,
    left: u64,
}

/// What `GET /api/v1/search` reports about reading files' contents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContentStatus {
    /// Some drive still has files whose words aren't searchable yet.
    pub reading: bool,
    /// Files still waiting across all drives.
    pub files_left: u64,
}

#[derive(Default)]
struct Shared {
    mounts: Mutex<HashMap<String, PathBuf>>,
    progress: Mutex<HashMap<String, DriveProgress>>,
}

pub struct ContentIndexer {
    tx: Sender<Msg>,
    shared: Arc<Shared>,
}

static NUDGE: Mutex<Option<Sender<Msg>>> = Mutex::new(None);

/// Ask the content reader to look at a drive again (Photos calls this
/// after making thumbnails, which photo search reads). A no-op when no
/// reader runs.
pub fn nudge_drive(drive_id: &str) {
    if let Some(tx) = NUDGE.lock().unwrap().as_ref() {
        let _ = tx.send(Msg::Kick {
            drive_id: drive_id.to_string(),
            full: false,
        });
    }
}

impl ContentIndexer {
    pub fn start() -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        thread::Builder::new()
            .name("luna-content-indexer".into())
            .spawn(move || run(rx, worker_shared))
            .expect("spawn content indexer");
        *NUDGE.lock().unwrap() = Some(tx.clone());
        Arc::new(Self { tx, shared })
    }

    pub fn watch_mount(&self, drive_id: &str, mount: PathBuf) {
        self.shared
            .mounts
            .lock()
            .unwrap()
            .insert(drive_id.to_string(), mount);
    }

    pub fn unwatch_mount(&self, drive_id: &str) {
        self.shared.mounts.lock().unwrap().remove(drive_id);
        self.shared.progress.lock().unwrap().remove(drive_id);
    }

    /// Look for unread files on a drive. `full` follows a whole-drive read,
    /// when files missing from the index are really gone and their text can
    /// be dropped.
    pub fn kick(&self, drive_id: &str, full: bool) {
        let _ = self.tx.send(Msg::Kick {
            drive_id: drive_id.to_string(),
            full,
        });
    }

    pub fn status(&self) -> ContentStatus {
        let progress = self.shared.progress.lock().unwrap();
        ContentStatus {
            reading: progress.values().any(|p| p.reading && p.left > 0),
            files_left: progress.values().map(|p| p.left).sum(),
        }
    }
}

fn run(rx: mpsc::Receiver<Msg>, shared: Arc<Shared>) {
    let mut queued: Vec<(String, bool)> = Vec::new();
    // Drives whose "tool was missing" rows got a retry since start.
    let mut retried: HashSet<String> = HashSet::new();
    loop {
        match rx.recv_timeout(IDLE_POLL) {
            Ok(msg) => queue(msg, &mut queued),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(msg) = rx.try_recv() {
            queue(msg, &mut queued);
        }
        if queued.is_empty() {
            continue;
        }
        let (drive_id, full) = queued.remove(0);
        let Some(root) = shared.mounts.lock().unwrap().get(&drive_id).cloned() else {
            continue;
        };
        if let Err(e) = pass(
            &shared,
            &drive_id,
            &root,
            full,
            &mut retried,
            &rx,
            &mut queued,
        ) {
            tracing::debug!(drive_id, error = %e, "content reading stopped");
        }
        if let Some(p) = shared.progress.lock().unwrap().get_mut(&drive_id) {
            p.reading = false;
        }
    }
}

fn queue(msg: Msg, queued: &mut Vec<(String, bool)>) {
    let Msg::Kick { drive_id, full } = msg;
    match queued.iter_mut().find(|(id, _)| *id == drive_id) {
        Some((_, f)) => *f |= full,
        None => queued.push((drive_id, full)),
    }
}

fn still_mounted(shared: &Shared, drive_id: &str, root: &Path) -> bool {
    shared
        .mounts
        .lock()
        .unwrap()
        .get(drive_id)
        .map(PathBuf::as_path)
        == Some(root)
}

fn set_progress(shared: &Shared, drive_id: &str, f: impl FnOnce(&mut DriveProgress)) {
    let mut progress = shared.progress.lock().unwrap();
    f(progress.entry(drive_id.to_string()).or_default());
}

/// Read every pending file on one drive.
fn pass(
    shared: &Shared,
    drive_id: &str,
    root: &Path,
    full: bool,
    retried: &mut HashSet<String>,
    rx: &mpsc::Receiver<Msg>,
    queued: &mut Vec<(String, bool)>,
) -> anyhow::Result<()> {
    let conn = crate::drives::drive_db::open(root)?;
    let ocr = super::ocr::available();
    if retried.insert(drive_id.to_string()) {
        if crate::sandbox::which("pdftotext").is_some() {
            store::retry_unavailable(&conn, drive_id, Format::Pdf)?;
        }
        if ocr {
            store::retry_unavailable(&conn, drive_id, Format::Image)?;
        }
    }
    // Photo search can release camera photos to OCR, so a second round
    // reads those.
    for _round in 0..2 {
        requeue_photos_deferred(&conn, drive_id)?;
        let left = store::pending_count(&conn, drive_id, ocr)?
            + meaning::backfill_left(&conn, drive_id)?
            + photos::pending_count(&conn);
        set_progress(shared, drive_id, |p| {
            p.reading = true;
            p.left = left;
        });
        loop {
            let batch = store::pending(&conn, drive_id, ocr, BATCH)?;
            if batch.is_empty() {
                break;
            }
            for file in batch {
                if !still_mounted(shared, drive_id, root) {
                    return Ok(());
                }
                // Other drives' kicks wait; this drive's re-kicks are absorbed.
                while let Ok(msg) = rx.try_recv() {
                    queue(msg, queued);
                }
                if !wait_for_memory() {
                    anyhow::bail!("not enough free memory to read files");
                }
                read_one(&conn, drive_id, root, &file)?;
                set_progress(shared, drive_id, |p| p.left = p.left.saturating_sub(1));
                thread::sleep(PACE);
            }
        }
        // Meaning vectors for the text read so far (and for text read before
        // the model was installed). In small steps, so an unplug stops it soon.
        loop {
            if !still_mounted(shared, drive_id, root) {
                return Ok(());
            }
            let done = meaning::backfill(&conn, drive_id, MEANING_STEP)?;
            if done == 0 {
                break;
            }
            set_progress(shared, drive_id, |p| {
                p.left = p.left.saturating_sub(done as u64)
            });
            thread::sleep(PACE);
        }
        // What Photos' thumbnails show.
        loop {
            if !wait_for_memory() {
                anyhow::bail!("not enough free memory for photo search");
            }
            let mounted = || still_mounted(shared, drive_id, root);
            let done = photos::backfill(&conn, drive_id, root, PHOTO_STEP, &mounted)?;
            if done == 0 || !mounted() {
                break;
            }
            set_progress(shared, drive_id, |p| {
                p.left = p.left.saturating_sub(done as u64)
            });
        }
        // Camera photos that photo search just judged to be documents are
        // pending again now; read them in a second round.
        requeue_photos_deferred(&conn, drive_id)?;
        if store::pending_count(&conn, drive_id, ocr)? == 0 {
            break;
        }
    }
    if full {
        photos::sweep(&conn)?;
        let gone = store::sweep_orphans(&conn, drive_id)?;
        if gone > 0 {
            tracing::debug!(drive_id, gone, "dropped text of deleted files");
        }
    }
    set_progress(shared, drive_id, |p| p.left = 0);
    Ok(())
}

fn wait_for_memory() -> bool {
    for _ in 0..MEMORY_TRIES {
        if crate::budget::meminfo().available_bytes >= MIN_FREE_BYTES {
            return true;
        }
        thread::sleep(MEMORY_WAIT);
    }
    false
}

/// Read one file and save the result.
fn read_one(conn: &Connection, drive_id: &str, root: &Path, file: &Pending) -> anyhow::Result<()> {
    let rel = file.rel();
    let save = |state: State, detail: &str, text: Option<&str>| -> anyhow::Result<()> {
        store::record(conn, drive_id, file, state, detail, text)?;
        Ok(())
    };
    // Hidden folders and Luna's own bookkeeping are never searched, so
    // their files are never read.
    if rel.split('/').any(|seg| seg.starts_with('.')) || crate::files::is_internal_temp(&rel) {
        return save(State::Skipped, "", None);
    }
    let Some(format) = formats::format_for(&file.name) else {
        return save(State::Skipped, "", None);
    };
    if format == Format::Image
        && let Some(why) = ocr_wait(conn, &rel, &file.name)
    {
        return save(State::Deferred, why, None);
    }
    let path = match luna_core::path::resolve_child_nofollow(root, &rel) {
        Ok(p) => p,
        Err(e) => return save(State::Failed, &format!("open: {e}"), None),
    };
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() => {}
        _ => return save(State::Skipped, "not a regular file", None),
    }
    let outcome = worker::extract_file(&path, format, file.size.max(0) as u64);
    match outcome {
        Outcome::Text(text) if text.trim().is_empty() => save(State::Empty, "", None),
        Outcome::Text(text) => save(State::Text, "", Some(&text)),
        Outcome::Protected => save(State::Protected, "", None),
        Outcome::TooBig => save(State::TooBig, "", None),
        Outcome::Unavailable => save(State::Unavailable, "", None),
        Outcome::Failed(why) => {
            tracing::debug!(drive_id, path = %rel, why, "could not read file contents");
            save(State::Failed, &why, None)
        }
    }
}

/// Camera photos are mostly people and places, and OCR on each one would
/// keep a small box busy for days. Screenshots and scans (PNG, TIFF, or no
/// camera in their EXIF) are read straight away; a camera photo waits until
/// photo search has looked at it and says it shows a document. Returns why
/// a photo waits, or `None` to read it now.
fn ocr_wait(conn: &Connection, rel: &str, name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    if matches!(
        ext.as_deref(),
        Some("png" | "tif" | "tiff" | "bmp" | "webp")
    ) {
        return None;
    }
    let camera: Option<String> = conn
        .query_row(
            "SELECT camera_make FROM photos WHERE path = ?1",
            params![rel],
            |r| r.get(0),
        )
        .ok();
    match camera {
        // Photos hasn't looked at it yet; ask again once it has.
        None => Some("photos"),
        Some(make) if make.trim().is_empty() => None,
        Some(_) => match super::photos::shows_document(conn, rel) {
            Some(true) => None,
            Some(false) => Some("not a document"),
            None => Some("photo search"),
        },
    }
}

/// Photos that waited for Photos (or for photo search) get another
/// look once that has caught up.
fn requeue_photos_deferred(conn: &Connection, drive_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE content_docs SET version = 0
         WHERE drive_id = ?1 AND state = 'deferred' AND detail = 'photos'
           AND EXISTS (SELECT 1 FROM photos p
                       WHERE p.path = CASE WHEN content_docs.parent = '' THEN content_docs.name
                                      ELSE content_docs.parent || '/' || content_docs.name END)",
        params![drive_id],
    )?;
    super::photos::requeue_ocr_deferred(conn, drive_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn make_drive(dir: &Path) -> PathBuf {
        let root = dir.join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        crate::drives::drive_db::create(
            &root,
            &marker,
            &luna_core::marker::pick_prefix(&root).unwrap(),
        )
        .unwrap();
        root
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(20) {
            if ok() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for {what}");
    }

    fn content_names(root: &Path, q: &str) -> Vec<String> {
        let conn = crate::drives::drive_db::open(root).unwrap();
        let expr =
            super::super::query::fts_expr(&crate::files::search_rank::Query::new(q)).unwrap();
        super::super::query::candidates(
            &conn,
            "d1",
            &expr,
            crate::files::search::KindFilter::All,
            50,
        )
        .unwrap()
        .into_iter()
        .map(|h| h.hit.name)
        .collect()
    }

    #[test]
    fn reads_new_files_after_the_name_scan_and_forgets_deleted_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::create_dir_all(root.join("letters")).unwrap();
        std::fs::write(
            root.join("letters/landlord.txt"),
            "Dear landlord, the boiler is broken.",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".secret")).unwrap();
        std::fs::write(root.join(".secret/diary.txt"), "boiler thoughts").unwrap();

        let names = crate::files::search_indexer::SearchIndexer::start();
        names.watch_mount("d1", root.clone());
        wait_for("contents", || {
            content_names(&root, "boiler") == ["landlord.txt"]
        });
        wait_for("idle", || !names.content_status().reading);

        std::fs::remove_file(root.join("letters/landlord.txt")).unwrap();
        names.rescan(vec![("d1".into(), root.clone())], false);
        wait_for("forgetting", || content_names(&root, "boiler").is_empty());
    }

    #[test]
    fn a_rewritten_file_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::write(root.join("todo.md"), "paint the fence").unwrap();
        let names = crate::files::search_indexer::SearchIndexer::start();
        names.watch_mount("d1", root.clone());
        wait_for("first read", || {
            content_names(&root, "fence") == ["todo.md"]
        });

        // A different length guarantees the index sees a change even
        // inside one timestamp tick.
        std::fs::write(root.join("todo.md"), "water the garden plants").unwrap();
        names.mark_dirty("d1", "");
        wait_for("second read", || {
            content_names(&root, "garden") == ["todo.md"]
        });
        assert!(content_names(&root, "fence").is_empty());
    }
}
