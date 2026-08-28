//! Automatic gallery indexing.
//!
//! Known write paths enqueue events so photos appear in the gallery without a
//! manual scan. A per-mount `notify` watcher plus adopt/startup rescans catch
//! USB copies and anything that slipped past a hook.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::gallery;

const RESCAN_DEBOUNCE: Duration = Duration::from_secs(2);
const WATCH_SETTLE: Duration = Duration::from_millis(750);
const IDLE_POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone)]
pub enum GalleryEvent {
    Upsert {
        drive_id: String,
        rel: String,
    },
    Remove {
        drive_id: String,
        rel: String,
    },
    Rename {
        drive_id: String,
        from: String,
        to: String,
    },
    Rescan {
        drive_id: String,
    },
}

struct MountWatch {
    _watcher: RecommendedWatcher,
}

struct Inner {
    mounts: HashMap<String, PathBuf>,
    watches: HashMap<String, MountWatch>,
}

pub struct GalleryIndexer {
    tx: Sender<GalleryEvent>,
    pending: Arc<AtomicUsize>,
    scanning: Arc<AtomicBool>,
    inner: Arc<Mutex<Inner>>,
}

impl GalleryIndexer {
    pub fn start() -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<GalleryEvent>();
        let pending = Arc::new(AtomicUsize::new(0));
        let scanning = Arc::new(AtomicBool::new(false));
        let inner = Arc::new(Mutex::new(Inner {
            mounts: HashMap::new(),
            watches: HashMap::new(),
        }));
        let indexer = Arc::new(Self {
            tx,
            pending: pending.clone(),
            scanning: scanning.clone(),
            inner: inner.clone(),
        });

        let mounts_for_worker = inner.clone();
        thread::Builder::new()
            .name("luna-gallery-indexer".into())
            .spawn(move || worker_loop(rx, mounts_for_worker, pending, scanning))
            .expect("spawn gallery indexer");

        indexer
    }

    pub fn pending(&self) -> bool {
        self.pending.load(Ordering::Relaxed) > 0 || self.scanning.load(Ordering::Relaxed)
    }

    pub fn status(&self) -> (bool, usize) {
        (
            self.scanning.load(Ordering::Relaxed),
            self.pending.load(Ordering::Relaxed),
        )
    }

    pub fn notify(&self, event: GalleryEvent) {
        if self.tx.send(event).is_ok() {
            self.pending.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn upsert(&self, drive_id: &str, rel: &str) {
        if !should_index_rel(rel) {
            return;
        }
        self.notify(GalleryEvent::Upsert {
            drive_id: drive_id.to_string(),
            rel: normalize_rel(rel),
        });
    }

    pub fn remove(&self, drive_id: &str, rel: &str) {
        if rel.is_empty() {
            return;
        }
        self.notify(GalleryEvent::Remove {
            drive_id: drive_id.to_string(),
            rel: normalize_rel(rel),
        });
    }

    pub fn rename(&self, drive_id: &str, from: &str, to: &str) {
        self.notify(GalleryEvent::Rename {
            drive_id: drive_id.to_string(),
            from: normalize_rel(from),
            to: normalize_rel(to),
        });
    }

    pub fn rescan(&self, drive_id: &str) {
        self.notify(GalleryEvent::Rescan {
            drive_id: drive_id.to_string(),
        });
    }

    /// Register a mounted adopted drive: track its root, start a watcher, and
    /// kick a catch-up rescan.
    pub fn watch_mount(self: &Arc<Self>, drive_id: &str, mount: PathBuf) {
        {
            let mut guard = self.inner.lock().unwrap();
            guard.mounts.insert(drive_id.to_string(), mount.clone());
        }
        self.start_watcher(drive_id, &mount);
        self.rescan(drive_id);
    }

    pub fn unwatch_mount(&self, drive_id: &str) {
        let mut guard = self.inner.lock().unwrap();
        guard.mounts.remove(drive_id);
        guard.watches.remove(drive_id);
    }

    fn start_watcher(self: &Arc<Self>, drive_id: &str, mount: &Path) {
        let drive_id_owned = drive_id.to_string();
        let root = mount.to_path_buf();
        let indexer = Arc::clone(self);
        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else {
                    return;
                };
                handle_watch_event(&indexer, &drive_id_owned, &root, event);
            },
            notify::Config::default(),
        );
        let Ok(mut watcher) = watcher else {
            tracing::warn!(
                drive_id,
                "gallery watcher unavailable; rescans will catch up"
            );
            return;
        };
        if let Err(e) = watcher.watch(mount, RecursiveMode::Recursive) {
            tracing::warn!(drive_id, error = %e, "could not watch drive for gallery updates");
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        guard
            .watches
            .insert(drive_id.to_string(), MountWatch { _watcher: watcher });
    }
}

fn handle_watch_event(indexer: &GalleryIndexer, drive_id: &str, root: &Path, event: notify::Event) {
    let remove_like = matches!(event.kind, EventKind::Remove(_) | EventKind::Any);
    let rename = matches!(
        event.kind,
        EventKind::Modify(notify::event::ModifyKind::Name(_))
    );
    for path in event.paths {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let Some(rel) = rel.to_str() else {
            continue;
        };
        let rel = normalize_rel(rel);
        if !should_index_rel(&rel) && !remove_like && !rename {
            continue;
        }
        if matches!(event.kind, EventKind::Remove(_)) {
            indexer.remove(drive_id, &rel);
            continue;
        }
        if path.is_file() && should_index_rel(&rel) {
            // Settle delay is applied in the worker via watch coalescing —
            // enqueue upsert; worker re-checks the file exists.
            indexer.upsert(drive_id, &rel);
        } else if path.is_dir() {
            indexer.rescan(drive_id);
        } else if rename {
            // Name events often arrive as pairs; a rescan is safest.
            indexer.rescan(drive_id);
        }
    }
}

fn worker_loop(
    rx: mpsc::Receiver<GalleryEvent>,
    mounts: Arc<Mutex<Inner>>,
    pending: Arc<AtomicUsize>,
    scanning: Arc<AtomicBool>,
) {
    let mut upserts: HashSet<(String, String)> = HashSet::new();
    let mut removes: HashSet<(String, String)> = HashSet::new();
    let mut renames: Vec<(String, String, String)> = Vec::new();
    let mut rescans: HashMap<String, Instant> = HashMap::new();
    let mut last_upsert_at = Instant::now();

    loop {
        let timeout = if !upserts.is_empty() && last_upsert_at.elapsed() < WATCH_SETTLE {
            WATCH_SETTLE.saturating_sub(last_upsert_at.elapsed())
        } else if !rescans.is_empty() {
            RESCAN_DEBOUNCE
                .checked_sub(
                    rescans
                        .values()
                        .map(|at| at.elapsed())
                        .min()
                        .unwrap_or(Duration::ZERO),
                )
                .unwrap_or(Duration::ZERO)
                .max(IDLE_POLL)
        } else if upserts.is_empty() && removes.is_empty() && renames.is_empty() {
            Duration::from_secs(30)
        } else {
            IDLE_POLL
        };

        match rx.recv_timeout(timeout.max(Duration::from_millis(50))) {
            Ok(event) => {
                match event {
                    GalleryEvent::Upsert { drive_id, rel } => {
                        removes.remove(&(drive_id.clone(), rel.clone()));
                        if !upserts.insert((drive_id, rel)) {
                            pending.fetch_sub(
                                1.min(pending.load(Ordering::Relaxed)),
                                Ordering::Relaxed,
                            );
                        }
                        last_upsert_at = Instant::now();
                    }
                    GalleryEvent::Remove { drive_id, rel } => {
                        if upserts.remove(&(drive_id.clone(), rel.clone())) {
                            pending.fetch_sub(
                                1.min(pending.load(Ordering::Relaxed)),
                                Ordering::Relaxed,
                            );
                        }
                        if !removes.insert((drive_id, rel)) {
                            pending.fetch_sub(
                                1.min(pending.load(Ordering::Relaxed)),
                                Ordering::Relaxed,
                            );
                        }
                    }
                    GalleryEvent::Rename { drive_id, from, to } => {
                        if upserts.remove(&(drive_id.clone(), from.clone())) {
                            pending.fetch_sub(
                                1.min(pending.load(Ordering::Relaxed)),
                                Ordering::Relaxed,
                            );
                        }
                        removes.remove(&(drive_id.clone(), to.clone()));
                        renames.push((drive_id, from, to));
                    }
                    GalleryEvent::Rescan { drive_id } => {
                        if rescans.insert(drive_id, Instant::now()).is_some() {
                            pending.fetch_sub(
                                1.min(pending.load(Ordering::Relaxed)),
                                Ordering::Relaxed,
                            );
                        }
                    }
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }

        // Apply settled upserts.
        if last_upsert_at.elapsed() >= WATCH_SETTLE && !upserts.is_empty() {
            let batch: Vec<_> = upserts.drain().collect();
            for (drive_id, rel) in batch {
                pending.fetch_sub(1.min(pending.load(Ordering::Relaxed)), Ordering::Relaxed);
                let mount = {
                    let guard = mounts.lock().unwrap();
                    guard.mounts.get(&drive_id).cloned()
                };
                let Some(root) = mount else {
                    continue;
                };
                if let Err(e) = gallery::index_one_meta(&drive_id, &root, &rel) {
                    tracing::debug!(drive_id, rel, error = %e, "gallery meta index skipped");
                    continue;
                }
                if let Err(e) = gallery::finish_thumb(&drive_id, &root, &rel) {
                    tracing::debug!(drive_id, rel, error = %e, "gallery thumb deferred");
                }
            }
        }

        if !removes.is_empty() {
            let batch: Vec<_> = removes.drain().collect();
            for (drive_id, rel) in batch {
                pending.fetch_sub(1.min(pending.load(Ordering::Relaxed)), Ordering::Relaxed);
                let mount = {
                    let guard = mounts.lock().unwrap();
                    guard.mounts.get(&drive_id).cloned()
                };
                let Some(root) = mount else {
                    continue;
                };
                let _ = gallery::remove_indexed_path(&root, &drive_id, &rel);
            }
        }

        if !renames.is_empty() {
            for (drive_id, from, to) in renames.drain(..) {
                pending.fetch_sub(1.min(pending.load(Ordering::Relaxed)), Ordering::Relaxed);
                let mount = {
                    let guard = mounts.lock().unwrap();
                    guard.mounts.get(&drive_id).cloned()
                };
                let Some(root) = mount else {
                    continue;
                };
                let _ = gallery::rename_indexed_path(&root, &drive_id, &from, &to);
                if should_index_rel(&to) {
                    let _ = gallery::index_one_meta(&drive_id, &root, &to);
                    let _ = gallery::finish_thumb(&drive_id, &root, &to);
                }
            }
        }

        let due: Vec<String> = rescans
            .iter()
            .filter(|(_, at)| at.elapsed() >= RESCAN_DEBOUNCE)
            .map(|(id, _)| id.clone())
            .collect();
        for drive_id in due {
            rescans.remove(&drive_id);
            pending.fetch_sub(1.min(pending.load(Ordering::Relaxed)), Ordering::Relaxed);
            let mount = {
                let guard = mounts.lock().unwrap();
                guard.mounts.get(&drive_id).cloned()
            };
            let Some(root) = mount else {
                continue;
            };
            scanning.store(true, Ordering::Relaxed);
            if let Err(e) = gallery::scan_drive(&drive_id, &root) {
                tracing::warn!(drive_id, error = %e, "gallery catch-up scan failed");
            }
            scanning.store(false, Ordering::Relaxed);
        }
    }
}

pub fn normalize_rel(rel: &str) -> String {
    rel.trim_matches('/').replace('\\', "/")
}

pub fn join_rel(dir: &str, name: &str) -> String {
    let dir = normalize_rel(dir);
    let name = name.trim_matches('/');
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

pub fn should_index_rel(rel: &str) -> bool {
    let rel = normalize_rel(rel);
    if rel.is_empty() || crate::files::is_internal_temp(&rel) {
        return false;
    }
    for part in rel.split('/') {
        if gallery::skip_gallery_dir(part) {
            return false;
        }
    }
    let path = Path::new(&rel);
    gallery::is_media(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn tiny_jpeg(path: &Path) {
        // Minimal valid-ish JPEG so is_media + open work; EXIF may fail.
        let jpeg = [
            0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
            0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D,
            0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
            0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28,
            0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
            0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
            0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xFF, 0xC4,
            0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00,
            0x3F, 0x00, 0x7F, 0xFF, 0xD9,
        ];
        let mut f = fs::File::create(path).unwrap();
        f.write_all(&jpeg).unwrap();
    }

    #[test]
    fn should_index_skips_trash_and_temps() {
        assert!(should_index_rel("DCIM/IMG_001.JPG"));
        assert!(!should_index_rel(".luna-trash/foo.jpg"));
        assert!(!should_index_rel(".lunathumbs/abc.jpg"));
        assert!(!should_index_rel("docs/readme.txt"));
        assert!(!should_index_rel(".luna-upload.xyz"));
    }

    #[test]
    fn upsert_indexes_without_manual_scan() {
        let root = tempfile::tempdir().unwrap();
        let photos = root.path().join("Photos");
        fs::create_dir_all(&photos).unwrap();
        tiny_jpeg(&photos.join("a.jpg"));

        let indexer = GalleryIndexer::start();
        indexer.watch_mount("d1", root.path().to_path_buf());
        indexer.upsert("d1", "Photos/a.jpg");
        for _ in 0..100 {
            if !indexer.pending() {
                let conn = gallery::open_drive_db(root.path()).unwrap();
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))
                    .unwrap_or(0);
                if count >= 1 {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        // Final check with clear error context
        let _ = gallery::index_one_meta("d1", root.path(), "Photos/a.jpg");
        let conn = gallery::open_drive_db(root.path()).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))
            .unwrap();
        assert!(count >= 1, "expected photo row after automatic indexing");
    }
}
