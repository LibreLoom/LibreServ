//! Multi-job folder backup: watches local folders and uploads to Luna.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::dest::{self, LunaRef};
use crate::luna;
use crate::session;

const FRESH_MTIME_SKIP: Duration = Duration::from_secs(3);

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
    pub uploaded: u64,
    pub bytes: u64,
    pub current: String,
    pub error: String,
    pub running: bool,
}

pub struct BackupHandle {
    stop: Arc<AtomicBool>,
    /// Kept alive for the job lifetime; dropped on stop so watches end.
    _watchers: Vec<RecommendedWatcher>,
}

impl BackupHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Ledger {
    map: HashMap<String, (u64, i64)>,
}

impl Ledger {
    fn load(path: &Path) -> Ledger {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, (u64, i64)>>(&s).ok())
            .map(|map| Ledger { map })
            .unwrap_or_default()
    }

    fn is_current(&self, rel: &str, size: u64, mtime: i64) -> bool {
        self.map.get(rel).copied() == Some((size, mtime))
    }

    fn record(&mut self, rel: &str, size: u64, mtime: i64) {
        self.map.insert(rel.to_string(), (size, mtime));
    }

    fn save(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec(&self.map) {
            let _ = std::fs::write(path, bytes);
        }
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
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't save backup settings.".to_string())?;
    let bytes = serde_json::to_vec_pretty(jobs)
        .map_err(|_| "Couldn't save backup settings.".to_string())?;
    std::fs::write(jobs_path(), bytes).map_err(|_| "Couldn't save backup settings.".to_string())
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

    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watchers = Vec::new();
    for root in &sources {
        let tx = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    for path in event.paths {
                        if path.is_file() {
                            let _ = tx.send(path);
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
        for root in &sources_owned {
            upload_tree(
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
            );
        }
        let mut queued: Vec<PathBuf> = Vec::new();
        let mut consecutive_failures: usize = 0;
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                set_running(&thread_progress, &job_id, false);
                return;
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(path) => {
                    if !queued.contains(&path) {
                        queued.push(path);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => {
                    set_running(&thread_progress, &job_id, false);
                    return;
                }
            }
            let mut any_failed = false;
            let mut i = 0;
            while i < queued.len() {
                if thread_stop.load(Ordering::Relaxed) {
                    set_running(&thread_progress, &job_id, false);
                    return;
                }
                let path = queued[i].clone();
                let mut handled = false;
                for root in &sources_owned {
                    if let Ok(rel) = path.strip_prefix(root) {
                        match upload_one(
                            &base_url,
                            &token,
                            &dest_ref,
                            rel,
                            &path,
                            &job_id,
                            &thread_progress,
                            &thread_ledger,
                            &ledger_path,
                        ) {
                            Ok(()) => handled = true,
                            Err(_) => {
                                any_failed = true;
                                handled = false;
                            }
                        }
                        break;
                    }
                }
                if handled || !any_failed {
                    if handled {
                        queued.remove(i);
                        continue;
                    }
                }
                if any_failed {
                    i += 1;
                } else {
                    queued.remove(i);
                }
            }
            if any_failed {
                consecutive_failures += 1;
                let backoff =
                    Duration::from_secs(2u64.saturating_mul(consecutive_failures as u64).min(60));
                for _ in 0..backoff.as_millis() / 500 {
                    if thread_stop.load(Ordering::Relaxed) {
                        set_running(&thread_progress, &job_id, false);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            } else {
                consecutive_failures = 0;
            }
        }
    });

    Ok(BackupHandle {
        stop,
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

fn set_current(
    progress: &Arc<Mutex<HashMap<String, BackupProgress>>>,
    job_id: &str,
    current: &str,
    error: &str,
) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(job_id)
    {
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
        p.error.clear();
    }
}

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
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if stop.load(Ordering::Relaxed) {
            return;
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
            upload_tree(
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
            );
        } else if meta.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            let _ = upload_one(
                base_url,
                token,
                dest,
                rel,
                &path,
                job_id,
                progress,
                ledger,
                ledger_path,
            );
        }
    }
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
) -> Result<(), String> {
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| "Couldn't read that file on this computer.".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Ok(());
    }
    let size = meta.len();
    let mtime = mtime_secs(&meta);
    {
        let l = ledger.lock().unwrap();
        if l.is_current(&rel_str, size, mtime) {
            return Ok(());
        }
    }
    if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        && (now.as_secs() as i64) - mtime < FRESH_MTIME_SKIP.as_secs() as i64
    {
        return Err("file still writing".into());
    }
    set_current(progress, job_id, &rel_str, "");
    match luna::upload_file(base_url, token, dest, path, &rel_str) {
        Ok(()) => {
            let mut l = ledger.lock().unwrap();
            l.record(&rel_str, size, mtime);
            l.save(ledger_path);
            bump(progress, job_id, size);
            Ok(())
        }
        Err(e) => {
            set_current(progress, job_id, &rel_str, &e);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_round_trip() {
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
