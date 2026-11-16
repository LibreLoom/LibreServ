//! Multi-job folder backup: watches local folders and uploads to Luna.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::dest::{self, LunaRef};
use crate::luna;
use crate::session;

const FRESH_MTIME_SKIP: Duration = Duration::from_secs(3);

/// The ledger is rewritten whole, so it is saved after this many new entries or
/// this long since the last save, not after every file. Entries lost to a crash
/// only mean those files are uploaded again with overwrite, which is harmless.
const LEDGER_SAVE_EVERY: usize = 64;
const LEDGER_SAVE_INTERVAL: Duration = Duration::from_secs(5);

/// How soon to look again at a file that was still being written.
const FRESH_RECHECK: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupJob {
    pub id: String,
    pub name: String,
    pub sources: Vec<String>,
    pub drive_id: String,
    pub remote_path: String,
    pub running: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BackupProgress {
    pub job_id: String,
    pub phase: String,
    pub uploaded: u64,
    pub bytes: u64,
    pub current: String,
    pub error: String,
    /// Files that could not be copied yet and are waiting to retry.
    pub failed: u64,
    /// Unix time of the most recent successfully copied file (0 = none yet).
    pub last_ok_unix: i64,
    pub running: bool,
}

pub struct BackupHandle {
    stop: Arc<AtomicBool>,
    /// Wakes the worker (`None`) so a stop takes effect without it polling the flag.
    wake: std::sync::mpsc::Sender<Option<PathBuf>>,
    /// Kept alive for the job lifetime; dropped on stop so watches end.
    _watchers: Vec<RecommendedWatcher>,
}

impl BackupHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.wake.send(None);
    }
}

struct Ledger {
    map: HashMap<String, (u64, i64)>,
    /// Entries recorded since the last save.
    unsaved: usize,
    last_save: Instant,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger {
            map: HashMap::new(),
            unsaved: 0,
            last_save: Instant::now(),
        }
    }
}

impl Ledger {
    fn load(path: &Path) -> Ledger {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, (u64, i64)>>(&s).ok())
            .map(|map| Ledger {
                map,
                ..Ledger::default()
            })
            .unwrap_or_default()
    }

    fn is_current(&self, rel: &str, size: u64, mtime: i64) -> bool {
        self.map.get(rel).copied() == Some((size, mtime))
    }

    fn record(&mut self, rel: &str, size: u64, mtime: i64) {
        self.map.insert(rel.to_string(), (size, mtime));
        self.unsaved += 1;
    }

    /// Save once enough entries or time have piled up; see `LEDGER_SAVE_EVERY`.
    fn save_due(&mut self, path: &Path) {
        if self.unsaved >= LEDGER_SAVE_EVERY
            || (self.unsaved > 0 && self.last_save.elapsed() >= LEDGER_SAVE_INTERVAL)
        {
            self.save(path);
        }
    }

    /// Save anything not yet on disk (idle, stop).
    fn flush(&mut self, path: &Path) {
        if self.unsaved > 0 {
            self.save(path);
        }
    }

    fn save(&mut self, path: &Path) {
        self.unsaved = 0;
        self.last_save = Instant::now();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(&self.map) {
            let _ = std::fs::write(path, bytes);
        }
    }
}

/// What `upload_one` did with a file that needs no retry as a failure.
#[derive(Debug, PartialEq)]
enum Uploaded {
    /// Copied, or already current, or not a regular file.
    Done,
    /// Modified in the last few seconds, so probably still being written.
    /// Looked at again shortly; not a failure and no backoff.
    StillWriting,
}

/// Paths waiting for upload, in arrival order, without duplicates.
#[derive(Default)]
struct Queue {
    order: Vec<PathBuf>,
    set: HashSet<PathBuf>,
}

impl Queue {
    fn push(&mut self, path: PathBuf) {
        if self.set.insert(path.clone()) {
            self.order.push(path);
        }
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Take every queued path; the caller pushes back the ones to keep.
    fn take(&mut self) -> Vec<PathBuf> {
        self.set.clear();
        std::mem::take(&mut self.order)
    }
}

fn jobs_path() -> PathBuf {
    session::data_dir().join("backup-jobs.json")
}

pub fn load_jobs() -> Vec<BackupJob> {
    std::fs::read(jobs_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_jobs(jobs: &[BackupJob]) -> Result<(), String> {
    let dir = session::data_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|_| "Couldn't save folder upload settings.".to_string())?;
    let bytes = serde_json::to_vec_pretty(jobs)
        .map_err(|_| "Couldn't save folder upload settings.".to_string())?;
    std::fs::write(jobs_path(), bytes)
        .map_err(|_| "Couldn't save folder upload settings.".to_string())
}

fn ledger_path(job: &BackupJob) -> PathBuf {
    let key = format!(
        "{}|{}|{}|{}",
        job.id,
        job.drive_id,
        job.remote_path,
        job.sources.join(";")
    );
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    session::data_dir().join(format!("backup-ledger-{hash}.json"))
}

pub fn start_job(
    base_url: String,
    token: String,
    job: BackupJob,
    progress: Arc<Mutex<HashMap<String, BackupProgress>>>,
) -> Result<BackupHandle, String> {
    let sources = dest::validate_local_dirs(&job.sources)?;
    let dest_ref = dest::validate_luna_folder(&job.drive_id, &job.remote_path)?;
    let stop = Arc::new(AtomicBool::new(false));
    let ledger_path = ledger_path(&job);
    let ledger = Arc::new(Mutex::new(Ledger::load(&ledger_path)));
    let job_id = job.id.clone();

    {
        let mut map = progress.lock().unwrap();
        map.insert(
            job_id.clone(),
            BackupProgress {
                job_id: job_id.clone(),
                running: true,
                ..Default::default()
            },
        );
    }

    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    let mut watchers = Vec::new();
    for root in &sources {
        let tx = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    for path in event.paths {
                        if path.is_file() {
                            let _ = tx.send(Some(path));
                        }
                    }
                }
            },
            notify::Config::default(),
        )
        .map_err(|_| "Couldn't watch that folder for changes.".to_string())?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|_| "Couldn't watch that folder for changes.".to_string())?;
        watchers.push(watcher);
    }

    let thread_stop = stop.clone();
    let thread_progress = progress.clone();
    let thread_ledger = ledger.clone();
    let sources_owned = sources.clone();
    std::thread::spawn(move || {
        let stopped = |ledger: &Arc<Mutex<Ledger>>| {
            if let Ok(mut l) = ledger.lock() {
                l.flush(&ledger_path);
            }
            set_running(&thread_progress, &job_id, false);
        };
        let mut queued = Queue::default();
        // Files that could not be copied stay queued and keep retrying —
        // a file must never be dropped silently just because its first upload
        // attempt failed.
        let mut failed: HashSet<PathBuf> = HashSet::new();
        for root in &sources_owned {
            for path in upload_tree(
                &base_url,
                &token,
                &dest_ref,
                root,
                root,
                &thread_stop,
                &job_id,
                &thread_progress,
                &thread_ledger,
                &ledger_path,
            ) {
                queued.push(path);
            }
        }
        if let Ok(mut l) = thread_ledger.lock() {
            l.flush(&ledger_path);
        }
        set_phase(&thread_progress, &job_id, "Watching");
        let mut consecutive_failures: usize = 0;
        // Earliest time to work the queue again (failure backoff, or a short
        // recheck of files still being written).
        let mut next_attempt = Instant::now();
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                stopped(&thread_ledger);
                return;
            }
            // Sleep until a file event or a stop; with work queued, at most
            // until the next attempt is due.
            let msg = if queued.is_empty() {
                rx.recv()
                    .map_err(|_| std::sync::mpsc::RecvTimeoutError::Disconnected)
            } else {
                let left = next_attempt.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                } else {
                    rx.recv_timeout(left)
                }
            };
            match msg {
                Ok(Some(path)) => queued.push(path),
                Ok(None) => continue, // stop wake-up; the flag is checked above
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    stopped(&thread_ledger);
                    return;
                }
            }
            // Fold in a burst of events before uploading.
            while let Ok(Some(path)) = rx.try_recv() {
                queued.push(path);
            }
            // A new event does not cut a failure backoff short.
            if Instant::now() < next_attempt {
                continue;
            }
            let mut any_failed = false;
            for path in queued.take() {
                if thread_stop.load(Ordering::Relaxed) {
                    stopped(&thread_ledger);
                    return;
                }
                // Deleted between queueing and retry: nothing left to back up.
                // (Other metadata errors still go through upload_one so a real
                // read failure stays reported instead of vanishing quietly.)
                if let Err(e) = std::fs::symlink_metadata(&path)
                    && e.kind() == std::io::ErrorKind::NotFound
                {
                    failed.remove(&path);
                    continue;
                }
                let mut outcome = Ok(Uploaded::Done);
                for root in &sources_owned {
                    if let Ok(rel) = path.strip_prefix(root) {
                        outcome = upload_one(
                            &base_url,
                            &token,
                            &dest_ref,
                            rel,
                            &path,
                            &job_id,
                            &thread_progress,
                            &thread_ledger,
                            &ledger_path,
                        );
                        break;
                    }
                }
                match outcome {
                    Ok(Uploaded::Done) => {
                        failed.remove(&path);
                    }
                    Ok(Uploaded::StillWriting) => queued.push(path),
                    Err(_) => {
                        any_failed = true;
                        failed.insert(path.clone());
                        queued.push(path);
                    }
                }
            }
            if let Ok(mut l) = thread_ledger.lock() {
                l.flush(&ledger_path);
            }
            set_failed(&thread_progress, &job_id, failed.len());
            if any_failed {
                consecutive_failures += 1;
                next_attempt = Instant::now()
                    + Duration::from_secs(2u64.saturating_mul(consecutive_failures as u64).min(60));
            } else {
                consecutive_failures = 0;
                if queued.is_empty() {
                    set_phase(&thread_progress, &job_id, "Watching");
                } else {
                    // Only files still being written are left.
                    next_attempt = Instant::now() + FRESH_RECHECK;
                }
            }
        }
    });

    Ok(BackupHandle {
        stop,
        wake: tx,
        _watchers: watchers,
    })
}

fn set_running(
    progress: &Arc<Mutex<HashMap<String, BackupProgress>>>,
    job_id: &str,
    running: bool,
) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
        p.running = running;
    }
}

fn set_phase(progress: &Arc<Mutex<HashMap<String, BackupProgress>>>, job_id: &str, phase: &str) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
        p.phase = phase.to_string();
    }
}

fn set_current(
    progress: &Arc<Mutex<HashMap<String, BackupProgress>>>,
    job_id: &str,
    current: &str,
    error: &str,
) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
        p.phase = "Copying".to_string();
        p.current = current.to_string();
        p.error = error.to_string();
    }
}

fn bump(progress: &Arc<Mutex<HashMap<String, BackupProgress>>>, job_id: &str, size: u64) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
        p.uploaded += 1;
        p.bytes += size;
        p.current.clear();
        p.phase = "Watching".to_string();
        p.last_ok_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // Note: p.error is left alone — another file's failure must stay
        // visible until the whole queue drains cleanly (set_failed).
    }
}

fn set_failed(progress: &Arc<Mutex<HashMap<String, BackupProgress>>>, job_id: &str, failed: usize) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
        p.failed = failed as u64;
        if failed == 0 {
            p.error.clear();
        }
    }
}

/// Initial walk of one source folder. Returns the files that could not be
/// uploaded yet (failed, or still being written) so the caller can queue them
/// for retry — no file is dropped silently.
fn upload_tree(
    base_url: &str,
    token: &str,
    dest: &LunaRef,
    root: &Path,
    dir: &Path,
    stop: &AtomicBool,
    job_id: &str,
    progress: &Arc<Mutex<HashMap<String, BackupProgress>>>,
    ledger: &Arc<Mutex<Ledger>>,
    ledger_path: &Path,
) -> Vec<PathBuf> {
    let mut missed = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return missed;
    };
    for entry in entries.flatten() {
        if stop.load(Ordering::Relaxed) {
            return missed;
        }
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            missed.extend(upload_tree(
                base_url,
                token,
                dest,
                root,
                &path,
                stop,
                job_id,
                progress,
                ledger,
                ledger_path,
            ));
        } else if meta.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            match upload_one(
                base_url,
                token,
                dest,
                rel,
                &path,
                job_id,
                progress,
                ledger,
                ledger_path,
            ) {
                Ok(Uploaded::Done) => {}
                Ok(Uploaded::StillWriting) | Err(_) => missed.push(path),
            }
        }
    }
    missed
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn upload_one(
    base_url: &str,
    token: &str,
    dest: &LunaRef,
    rel: &Path,
    path: &Path,
    job_id: &str,
    progress: &Arc<Mutex<HashMap<String, BackupProgress>>>,
    ledger: &Arc<Mutex<Ledger>>,
    ledger_path: &Path,
) -> Result<Uploaded, String> {
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| "Couldn't read that file on this computer.".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(Uploaded::Done);
    }
    let size = meta.len();
    let mtime = mtime_secs(&meta);
    {
        let l = ledger.lock().unwrap();
        if l.is_current(&rel_str, size, mtime) {
            return Ok(Uploaded::Done);
        }
    }
    if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        && (now.as_secs() as i64) - mtime < FRESH_MTIME_SKIP.as_secs() as i64
    {
        return Ok(Uploaded::StillWriting);
    }
    set_current(progress, job_id, &rel_str, "");
    // Backup always places the file at this path (create or replace).
    match luna::upload_file(base_url, token, dest, path, &rel_str, true) {
        Ok(_) => {
            let mut l = ledger.lock().unwrap();
            l.record(&rel_str, size, mtime);
            l.save_due(ledger_path);
            bump(progress, job_id, size);
            Ok(Uploaded::Done)
        }
        Err(e) => {
            // Keep the error for Sync/Backup icons, but clear `current` so Status
            // does not keep showing a finished/failed file forever.
            if let Ok(mut map) = progress.lock()
                && let Some(p) = map.get_mut(job_id)
            {
                p.error = e.clone();
                p.current.clear();
                p.phase = "Watching".to_string();
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_keeps_order_and_drops_duplicates() {
        let mut q = Queue::default();
        q.push("a".into());
        q.push("b".into());
        q.push("a".into());
        assert_eq!(q.take(), vec![PathBuf::from("a"), PathBuf::from("b")]);
        assert!(q.is_empty());
        // Taken paths can be queued again.
        q.push("a".into());
        assert_eq!(q.take(), vec![PathBuf::from("a")]);
    }

    #[test]
    fn ledger_saves_in_batches_and_on_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        let mut l = Ledger::default();
        l.record("one", 1, 1);
        l.save_due(&path);
        assert!(!path.exists(), "one new entry must not rewrite the ledger");
        for i in 0..LEDGER_SAVE_EVERY {
            l.record(&format!("f{i}"), 1, 1);
        }
        l.save_due(&path);
        assert!(path.exists());
        l.record("last", 2, 2);
        l.flush(&path);
        assert!(Ledger::load(&path).is_current("last", 2, 2));
    }

    #[test]
    fn jobs_round_trip() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };
        let jobs = vec![BackupJob {
            id: "1".into(),
            name: "Docs".into(),
            sources: vec!["/tmp/a".into()],
            drive_id: "d1".into(),
            remote_path: "Desktop Backup".into(),
            running: false,
        }];
        save_jobs(&jobs).unwrap();
        let loaded = load_jobs();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Docs");
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }
}
