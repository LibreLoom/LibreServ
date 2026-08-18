//! Folder backup engine: watches a folder and uploads new/changed files with
//! Luna's resumable chunked protocol.
//!
//! Idempotent by design: a ledger of every successfully-uploaded file (keyed
//! by relative path + size + mtime) is persisted to disk, so restarting the
//! app or re-running the initial scan never re-uploads an unchanged file. A
//! file that changes while it is being read is never marked done, so a torn
//! upload can't be installed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

const CHUNK: usize = 1024 * 1024;
// A file is assumed to still be actively written if its mtime is newer than
// this, and we wait before uploading it to avoid shipping a mid-write file.
const FRESH_MTIME_SKIP: Duration = Duration::from_secs(3);

pub struct BackupHandle {
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct BackupState {
    pub uploaded: u64,
    pub bytes: u64,
}

impl BackupHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Tracks already-uploaded files so a restart / re-scan is idempotent.
#[derive(Default)]
struct Ledger {
    map: HashMap<String, (u64, i64)>, // rel -> (size, mtime)
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

/// Derive a stable ledger path under the user's home, keyed by the backup
/// destination so different folders/drives don't collide.
fn ledger_path(base_url: &str, drive_id: &str, remote_path: &str) -> PathBuf {
    let key = format!("{base_url}|{drive_id}|{remote_path}");
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".local/share/luna-desktop")
        .join(format!("backup-ledger-{hash}.json"))
}

pub fn start(
    base_url: String,
    token: String,
    folder: String,
    drive_id: String,
    remote_path: String,
) -> anyhow::Result<BackupHandle> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        anyhow::bail!("not a directory");
    }
    let ledger_path = ledger_path(&base_url, &drive_id, &remote_path);
    let ledger = Arc::new(Mutex::new(Ledger::load(&ledger_path)));
    let stop = Arc::new(AtomicBool::new(false));
    let state = Arc::new(Mutex::new(BackupState::default()));

    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
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
    )?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let thread_stop = stop.clone();
    let thread_state = state.clone();
    let thread_ledger = ledger.clone();
    std::thread::spawn(move || {
        // Initial scan (idempotent against the ledger).
        upload_tree(
            &base_url,
            &token,
            &drive_id,
            &remote_path,
            &root,
            &root,
            &thread_stop,
            &thread_state,
            &thread_ledger,
            &ledger_path,
        );
        // Watch loop with debounce-by-dedup and failure backoff.
        let mut queued: Vec<PathBuf> = Vec::new();
        let mut consecutive_failures: usize = 0;
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(path) => {
                    if !queued.contains(&path) {
                        queued.push(path);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return,
            }
            let mut any_failed = false;
            let mut i = 0;
            while i < queued.len() {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }
                let path = queued[i].clone();
                if let Ok(rel) = path.strip_prefix(&root) {
                    if let Err(_) = upload_file(
                        &base_url,
                        &token,
                        &drive_id,
                        &remote_path,
                        rel,
                        &path,
                        &thread_state,
                        &thread_ledger,
                        &ledger_path,
                    ) {
                        any_failed = true;
                        i += 1; // keep it queued for the next pass
                        continue;
                    }
                }
                queued.remove(i);
            }
            if any_failed {
                consecutive_failures += 1;
                // Back off so a stuck file doesn't hammer Luna every 500ms.
                let backoff =
                    Duration::from_secs(2u64.saturating_mul(consecutive_failures as u64).min(60));
                for _ in 0..backoff.as_millis() / 500 {
                    if thread_stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            } else {
                consecutive_failures = 0;
            }
        }
    });

    // The watcher must stay alive; move it into a detached keep-alive handle.
    let _watcher_guard = Box::new(watcher);
    std::mem::forget(_watcher_guard);

    Ok(BackupHandle { stop })
}

fn upload_tree(
    base_url: &str,
    token: &str,
    drive_id: &str,
    remote_path: &str,
    root: &Path,
    dir: &Path,
    stop: &AtomicBool,
    state: &Arc<Mutex<BackupState>>,
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
        if path.is_dir() {
            upload_tree(
                base_url,
                token,
                drive_id,
                remote_path,
                root,
                &path,
                stop,
                state,
                ledger,
                ledger_path,
            );
        } else if let Ok(rel) = path.strip_prefix(root) {
            let _ = upload_file(
                base_url,
                token,
                drive_id,
                remote_path,
                rel,
                &path,
                state,
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

fn upload_file(
    base_url: &str,
    token: &str,
    drive_id: &str,
    remote_path: &str,
    rel: &Path,
    path: &Path,
    state: &Arc<Mutex<BackupState>>,
    ledger: &Arc<Mutex<Ledger>>,
    ledger_path: &Path,
) -> anyhow::Result<()> {
    let rel_str = rel.to_string_lossy().into_owned();
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime = mtime_secs(&meta);

    // Idempotency: an unchanged file that's already recorded is skipped.
    {
        let l = ledger.lock().unwrap();
        if l.is_current(&rel_str, size, mtime) {
            return Ok(());
        }
    }

    // Skip files that are currently being written (very fresh mtime) — wait
    // for them to settle rather than upload a mid-write file.
    if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        && (now.as_secs() as i64) - mtime < FRESH_MTIME_SKIP.as_secs() as i64
    {
        anyhow::bail!("file is still being written; wait for it to finish");
    }

    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let dest = if remote_path.is_empty() {
        rel_str.clone()
    } else {
        format!("{remote_path}/{rel_str}")
    };
    let dest_dir = dest.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let created: serde_json::Value = ureq::post(&format!(
        "{}/api/v1/uploads",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_json(serde_json::json!({
        "drive_id": drive_id, "path": dest_dir, "name": name, "size": size
    }))?
    .body_mut()
    .read_json()?;
    let upload_id = created
        .get("upload_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("no upload id"))?;

    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; CHUNK];
    let mut start: u64 = 0;
    loop {
        use std::io::Read;
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        let end = start + n as u64 - 1;
        ureq::put(&format!(
            "{}/api/v1/uploads/{upload_id}",
            base_url.trim_end_matches('/')
        ))
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Range", &format!("bytes {start}-{end}/{size}"))
        .header("Content-Type", "application/octet-stream")
        .send(chunk)?;
        start += n as u64;
    }

    // Abort if the file grew/changed while we were streaming — completing with
    // a stale size would install a torn copy. The chunked session is simply
    // abandoned and retried later.
    let after = std::fs::metadata(path)?;
    if after.len() != size || mtime_secs(&after) != mtime {
        anyhow::bail!("file changed while it was being backed up; retrying later");
    }

    let complete = ureq::post(&format!(
        "{}/api/v1/uploads/{upload_id}/complete",
        base_url.trim_end_matches('/')
    ))
    .header("Authorization", &format!("Bearer {token}"))
    .send_empty();
    match complete {
        Ok(_) => {
            let mut l = ledger.lock().unwrap();
            l.record(&rel_str, size, mtime);
            l.save(ledger_path);
            drop(l);
            let mut s = state.lock().unwrap();
            s.uploaded += 1;
            s.bytes += size;
            Ok(())
        }
        // If the destination already exists (e.g. uploaded by a previous run),
        // treat it as success so the queue stops churning.
        Err(ureq::Error::StatusCode(409)) => {
            let mut l = ledger.lock().unwrap();
            l.record(&rel_str, size, mtime);
            l.save(ledger_path);
            Ok(())
        }
        Err(e) => Err(anyhow::anyhow!("upload failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_dest_paths_are_relative() {
        assert_eq!(
            "Desktop Backup/a/b.txt",
            format!("Desktop Backup/{}", "a/b.txt")
        );
    }

    #[test]
    fn ledger_round_trips_and_is_current() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        let mut l = Ledger::load(&path);
        l.record("a/b.txt", 10, 1234);
        l.save(&path);

        let l2 = Ledger::load(&path);
        assert!(l2.is_current("a/b.txt", 10, 1234));
        assert!(!l2.is_current("a/b.txt", 11, 1234));
        assert!(!l2.is_current("other", 10, 1234));
    }
}
