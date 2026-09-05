//! Two-way sync between a Luna folder (or whole drive) and a local child folder.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::dest::{self, LunaRef};
use crate::luna;
use crate::session;

/// How often to re-check Luna for remote-side changes when nothing changed locally.
const REMOTE_POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPair {
    pub id: String,
    pub drive_id: String,
    pub remote_path: String,
    /// Local parent chosen by the user.
    pub local_parent: String,
    /// Resolved child path (parent + Luna folder name).
    pub local_path: String,
    pub running: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncProgress {
    pub pair_id: String,
    pub phase: String,
    pub current: String,
    pub uploaded: u64,
    pub downloaded: u64,
    pub conflicts: u64,
    pub error: String,
    pub running: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct LedgerEntry {
    size: u64,
    local_mtime: i64,
    remote_mtime: i64,
}

#[derive(Default)]
struct Ledger {
    map: HashMap<String, LedgerEntry>,
}

impl Ledger {
    fn load(path: &Path) -> Ledger {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .map(|map| Ledger { map })
            .unwrap_or_default()
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

pub struct SyncHandle {
    stop: Arc<AtomicBool>,
    /// Kept alive for the pair lifetime; dropped on stop so watches end.
    _watcher: RecommendedWatcher,
}

impl SyncHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn pairs_path() -> PathBuf {
    session::data_dir().join("sync-pairs.json")
}

pub fn load_pairs() -> Vec<SyncPair> {
    std::fs::read(pairs_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_pairs(pairs: &[SyncPair]) -> Result<(), String> {
    let dir = session::data_dir();
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't save sync settings.".to_string())?;
    let bytes =
        serde_json::to_vec_pretty(pairs).map_err(|_| "Couldn't save sync settings.".to_string())?;
    std::fs::write(pairs_path(), bytes).map_err(|_| "Couldn't save sync settings.".to_string())
}

fn ledger_path(pair: &SyncPair) -> PathBuf {
    let key = format!(
        "{}|{}|{}|{}",
        pair.id, pair.drive_id, pair.remote_path, pair.local_path
    );
    let hash = blake3::hash(key.as_bytes()).to_hex().to_string();
    session::data_dir().join(format!("sync-ledger-{hash}.json"))
}

pub fn start_pair(
    base_url: String,
    token: String,
    pair: SyncPair,
    progress: Arc<Mutex<HashMap<String, SyncProgress>>>,
) -> Result<SyncHandle, String> {
    let remote = dest::validate_luna_folder(&pair.drive_id, &pair.remote_path)?;
    let local_root = PathBuf::from(&pair.local_path);
    std::fs::create_dir_all(&local_root).map_err(|_| {
        "Couldn't create the sync folder on this computer. Pick a different place.".to_string()
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let pair_id = pair.id.clone();
    let ledger_file = ledger_path(&pair);

    {
        let mut map = progress.lock().unwrap();
        map.insert(
            pair_id.clone(),
            SyncProgress {
                pair_id: pair_id.clone(),
                running: true,
                phase: "Starting".into(),
                ..Default::default()
            },
        );
    }

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let tx_notify = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx_notify.send(());
            }
        },
        notify::Config::default(),
    )
    .map_err(|_| "Couldn't watch the sync folder.".to_string())?;
    watcher
        .watch(&local_root, RecursiveMode::Recursive)
        .map_err(|_| "Couldn't watch the sync folder.".to_string())?;

    let thread_stop = stop.clone();
    let thread_progress = progress.clone();
    std::thread::spawn(move || {
        let mut ledger = Ledger::load(&ledger_file);
        // Kick an immediate sync, then on local changes or every 30s.
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                set_running(&thread_progress, &pair_id, false);
                return;
            }
            set_phase(&thread_progress, &pair_id, "Syncing");
            if let Err(e) = sync_once(
                &base_url,
                &token,
                &remote,
                &local_root,
                &mut ledger,
                &ledger_file,
                &pair_id,
                &thread_progress,
                &thread_stop,
            ) {
                set_error(&thread_progress, &pair_id, &e);
            } else {
                set_error(&thread_progress, &pair_id, "");
                set_phase(&thread_progress, &pair_id, "Up to date");
            }
            set_phase(&thread_progress, &pair_id, "Waiting");
            // Wait for local changes or the next remote poll.
            let deadline = std::time::Instant::now() + REMOTE_POLL_INTERVAL;
            while std::time::Instant::now() < deadline {
                if thread_stop.load(Ordering::Relaxed) {
                    set_running(&thread_progress, &pair_id, false);
                    return;
                }
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(()) => {
                        // debounce
                        while rx.try_recv().is_ok() {}
                        std::thread::sleep(Duration::from_millis(400));
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => {
                        set_running(&thread_progress, &pair_id, false);
                        return;
                    }
                }
            }
        }
    });

    Ok(SyncHandle {
        stop,
        _watcher: watcher,
    })
}

fn set_running(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str, running: bool) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.running = running;
    }
}

fn set_phase(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str, phase: &str) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.phase = phase.to_string();
    }
}

fn set_error(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str, error: &str) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.error = error.to_string();
    }
}

fn clear_current(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.current.clear();
    }
}

fn bump(
    progress: &Arc<Mutex<HashMap<String, SyncProgress>>>,
    id: &str,
    up: bool,
    conflict: bool,
    current: &str,
) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.phase = "Syncing".to_string();
        p.current = current.to_string();
        if conflict {
            p.conflicts += 1;
        } else if up {
            p.uploaded += 1;
        } else {
            p.downloaded += 1;
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

fn walk_local(root: &Path) -> HashMap<String, (PathBuf, u64, i64)> {
    let mut out = HashMap::new();
    walk_local_rec(root, root, &mut out);
    out
}

fn walk_local_rec(root: &Path, dir: &Path, out: &mut HashMap<String, (PathBuf, u64, i64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.contains("(conflict from ") {
            continue;
        }
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk_local_rec(root, &path, out);
        } else if meta.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            out.insert(rel_str, (path, meta.len(), mtime_secs(&meta)));
        }
    }
}

fn sync_once(
    base_url: &str,
    token: &str,
    remote: &LunaRef,
    local_root: &Path,
    ledger: &mut Ledger,
    ledger_file: &Path,
    pair_id: &str,
    progress: &Arc<Mutex<HashMap<String, SyncProgress>>>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let remote_files = luna::walk_remote_files(base_url, token, &remote.drive_id, &remote.path)?;
    let remote_map: HashMap<String, luna::FileEntry> = remote_files.into_iter().collect();
    let local_map = walk_local(local_root);

    let mut all: HashSet<String> = HashSet::new();
    all.extend(remote_map.keys().cloned());
    all.extend(local_map.keys().cloned());
    all.extend(ledger.map.keys().cloned());

    for rel in all {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let local = local_map.get(&rel);
        let remote_e = remote_map.get(&rel);
        let prev = ledger.map.get(&rel).cloned();

        match (local, remote_e, prev) {
            (Some((path, size, lm)), Some(re), Some(prev)) => {
                let local_changed = *size != prev.size || *lm != prev.local_mtime;
                let remote_changed = re.size != prev.size || re.modified != prev.remote_mtime;
                if local_changed && remote_changed {
                    // Conflict: keep both.
                    let conflict_name = conflict_path(path, "this computer");
                    let _ = std::fs::rename(path, &conflict_name);
                    let dest = local_root.join(&rel);
                    let remote_abs = join_remote(&remote.path, &rel);
                    luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                    bump(progress, pair_id, false, true, &rel);
                    // Upload the conflict copy under a conflict name on Luna too.
                    let remote_conflict =
                        format!("{} (conflict from this computer)", strip_ext_name(&rel));
                    // Keep local conflict file; upload original content already renamed.
                    let _ = luna::upload_file(
                        base_url,
                        token,
                        remote,
                        &conflict_name,
                        &format!("{remote_conflict}{}", ext_of(&rel)),
                    );
                    let lm = std::fs::metadata(&dest)
                        .map(|m| mtime_secs(&m))
                        .unwrap_or(re.modified);
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: re.size,
                            local_mtime: lm,
                            remote_mtime: re.modified,
                        },
                    );
                } else if local_changed {
                    luna::upload_file(base_url, token, remote, path, &rel)?;
                    // Refresh remote mtime via re-list would be ideal; store local as authority.
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: *lm,
                        },
                    );
                    bump(progress, pair_id, true, false, &rel);
                } else if remote_changed {
                    let dest = local_root.join(&rel);
                    let remote_abs = join_remote(&remote.path, &rel);
                    luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                    let meta = std::fs::metadata(&dest)
                        .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: meta.len(),
                            local_mtime: mtime_secs(&meta),
                            remote_mtime: re.modified,
                        },
                    );
                    bump(progress, pair_id, false, false, &rel);
                }
            }
            (Some((path, size, lm)), Some(re), None) => {
                // Both exist, no ledger — treat newer mtime as winner; equal → keep both if sizes differ.
                if *size == re.size && (*lm - re.modified).abs() <= 2 {
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: re.modified,
                        },
                    );
                } else if *lm >= re.modified {
                    luna::upload_file(base_url, token, remote, path, &rel)?;
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: *lm,
                        },
                    );
                    bump(progress, pair_id, true, false, &rel);
                } else {
                    let dest = local_root.join(&rel);
                    let remote_abs = join_remote(&remote.path, &rel);
                    luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                    let meta = std::fs::metadata(&dest)
                        .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                    ledger.map.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: meta.len(),
                            local_mtime: mtime_secs(&meta),
                            remote_mtime: re.modified,
                        },
                    );
                    bump(progress, pair_id, false, false, &rel);
                }
            }
            (Some((path, size, lm)), None, Some(_)) => {
                // Remote deleted → delete local
                let _ = std::fs::remove_file(path);
                ledger.map.remove(&rel);
                bump(progress, pair_id, false, false, &rel);
                let _ = size;
                let _ = lm;
            }
            (Some((path, size, lm)), None, None) => {
                // New local file
                luna::upload_file(base_url, token, remote, path, &rel)?;
                ledger.map.insert(
                    rel.clone(),
                    LedgerEntry {
                        size: *size,
                        local_mtime: *lm,
                        remote_mtime: *lm,
                    },
                );
                bump(progress, pair_id, true, false, &rel);
            }
            (None, Some(re), Some(_)) => {
                // Local deleted → delete remote
                let remote_abs = join_remote(&remote.path, &rel);
                luna::delete_path(base_url, token, &remote.drive_id, &remote_abs)?;
                ledger.map.remove(&rel);
                let _ = re;
            }
            (None, Some(re), None) => {
                // New remote file
                let dest = local_root.join(&rel);
                let remote_abs = join_remote(&remote.path, &rel);
                luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                let meta = std::fs::metadata(&dest)
                    .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                ledger.map.insert(
                    rel.clone(),
                    LedgerEntry {
                        size: meta.len(),
                        local_mtime: mtime_secs(&meta),
                        remote_mtime: re.modified,
                    },
                );
                bump(progress, pair_id, false, false, &rel);
            }
            (None, None, Some(_)) => {
                ledger.map.remove(&rel);
            }
            (None, None, None) => {}
        }
    }
    ledger.save(ledger_file);
    clear_current(progress, pair_id);
    Ok(())
}

fn join_remote(root: &str, rel: &str) -> String {
    if root.is_empty() {
        rel.to_string()
    } else if rel.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{rel}")
    }
}

fn conflict_path(path: &Path, from: &str) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    path.with_file_name(format!("{stem} (conflict from {from}){ext}"))
}

fn strip_ext_name(rel: &str) -> String {
    Path::new(rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(rel)
        .to_string()
}

fn ext_of(rel: &str) -> String {
    Path::new(rel)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_round_trip() {
        let _g = crate::session::test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };
        let pairs = vec![SyncPair {
            id: "1".into(),
            drive_id: "d".into(),
            remote_path: "Photos/Family".into(),
            local_parent: "/tmp".into(),
            local_path: "/tmp/Family".into(),
            running: false,
        }];
        save_pairs(&pairs).unwrap();
        assert_eq!(load_pairs()[0].remote_path, "Photos/Family");
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }

    #[test]
    fn conflict_naming() {
        let p = PathBuf::from("/tmp/photo.jpg");
        let c = conflict_path(&p, "Luna");
        assert!(
            c.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("conflict from Luna")
        );
    }
}
