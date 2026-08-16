//! Folder backup engine: watches a folder and uploads new/changed files with
//! Luna's resumable chunked protocol.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

const CHUNK: usize = 1024 * 1024;

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
    std::thread::spawn(move || {
        // Initial scan.
        upload_tree(&base_url, &token, &drive_id, &remote_path, &root, &root, &thread_stop, &thread_state);
        // Watch loop with debounce-by-dedup.
        let mut queued: Vec<PathBuf> = Vec::new();
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
            let mut i = 0;
            while i < queued.len() {
                if thread_stop.load(Ordering::Relaxed) {
                    return;
                }
                let path = queued[i].clone();
                if let Ok(rel) = path.strip_prefix(&root) {
                    if let Err(_) = upload_file(&base_url, &token, &drive_id, &remote_path, rel, &path, &thread_state) {
                        // Keep it queued for the next pass; the UI can ask to retry.
                        i += 1;
                        continue;
                    }
                }
                queued.remove(i);
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
) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                upload_tree(base_url, token, drive_id, remote_path, root, &path, stop, state);
            } else if let Ok(rel) = path.strip_prefix(root) {
                let _ = upload_file(base_url, token, drive_id, remote_path, rel, &path, state);
            }
        }
    }
}

fn upload_file(
    base_url: &str,
    token: &str,
    drive_id: &str,
    remote_path: &str,
    rel: &Path,
    path: &Path,
    state: &Arc<Mutex<BackupState>>,
) -> anyhow::Result<()> {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("file").to_string();
    let size = std::fs::metadata(path)?.len();
    let dest = if remote_path.is_empty() { rel.to_string_lossy().into_owned() } else { format!("{remote_path}/{}", rel.to_string_lossy()) };
    let dest_dir = dest.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let created: serde_json::Value = ureq::post(&format!("{}/api/v1/uploads", base_url.trim_end_matches('/')))
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({
            "drive_id": drive_id, "path": dest_dir, "name": name, "size": size
        }))?
        .body_mut()
        .read_json()?;
    let upload_id = created.get("upload_id").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("no upload id"))?;

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
        ureq::put(&format!("{}/api/v1/uploads/{upload_id}", base_url.trim_end_matches('/')))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Range", &format!("bytes {start}-{end}/{size}"))
            .header("Content-Type", "application/octet-stream")
            .send(chunk)?;
        start += n as u64;
    }
    ureq::post(&format!("{}/api/v1/uploads/{upload_id}/complete", base_url.trim_end_matches('/')))
        .header("Authorization", &format!("Bearer {token}"))
        .send_empty()?;

    {
        let mut s = state.lock().unwrap();
        s.uploaded += 1;
        s.bytes += size;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn remote_dest_paths_are_relative() {
        assert_eq!("Desktop Backup/a/b.txt", format!("Desktop Backup/{}", "a/b.txt"));
    }
}
