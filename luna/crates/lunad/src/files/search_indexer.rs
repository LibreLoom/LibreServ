//! Background search indexing.
//!
//! Search reads each drive's file index, so every folder has to be in it —
//! not just the ones someone happened to open. This worker reads whole drives
//! in the background (shallow folders first, so results appear early), keeps
//! counts for the "still reading" notice, and re-reads single folders when
//! Luna writes into them ([`nudge_dir`]) or someone plugs the drive into
//! another computer (the periodic rescan, which skips folders whose mtime
//! hasn't moved).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::files::index;

/// A written-to folder is re-read this long after its last write, so a burst
/// of uploads costs one read instead of one each.
const DIRTY_DEBOUNCE: Duration = Duration::from_millis(1200);
const IDLE_POLL: Duration = Duration::from_millis(250);
/// How often a running scan re-checks that its drive is still mounted.
const MOUNT_CHECK_EVERY: u64 = 64;

enum Job {
    Scan { drive_id: String, force: bool },
    Dirty { drive_id: String, rel: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriveScan {
    Queued,
    Scanning,
    Ready,
}

#[derive(Debug, Clone, Copy)]
struct Progress {
    state: DriveScan,
    /// Folders visited by the current (or last) pass.
    dirs: u64,
}

/// What `GET /api/v1/search` reports about indexing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanStatus {
    /// Any drive is still being read.
    pub scanning: bool,
    pub drives_total: usize,
    pub drives_done: usize,
    /// Folders read so far across all drives.
    pub dirs_indexed: u64,
}

#[derive(Default)]
struct Shared {
    mounts: Mutex<HashMap<String, PathBuf>>,
    progress: Mutex<HashMap<String, Progress>>,
}

pub struct SearchIndexer {
    tx: Sender<Job>,
    shared: Arc<Shared>,
}

static NUDGE: OnceLock<Sender<Job>> = OnceLock::new();

/// Tell the indexer a folder changed so search catches up within a moment.
/// Called wherever Luna drops a folder's indexed state; a no-op when no
/// indexer is running.
pub fn nudge_dir(drive_id: &str, rel: &str) {
    if let Some(tx) = NUDGE.get() {
        let _ = tx.send(Job::Dirty {
            drive_id: drive_id.to_string(),
            rel: rel.to_string(),
        });
    }
}

impl SearchIndexer {
    pub fn start() -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        thread::Builder::new()
            .name("luna-search-indexer".into())
            .spawn(move || worker(rx, worker_shared))
            .expect("spawn search indexer");
        let _ = NUDGE.set(tx.clone());
        Arc::new(Self { tx, shared })
    }

    /// Start (or restart) reading a mounted drive. Folders that haven't
    /// changed since the last read cost one stat each.
    pub fn watch_mount(&self, drive_id: &str, mount: PathBuf) {
        self.enqueue(drive_id, mount, false);
    }

    /// Forget a drive that was ejected or unplugged.
    pub fn unwatch_mount(&self, drive_id: &str) {
        self.shared.mounts.lock().unwrap().remove(drive_id);
        self.shared.progress.lock().unwrap().remove(drive_id);
    }

    /// Re-read these drives. `force` re-reads every folder instead of
    /// trusting folder timestamps.
    pub fn rescan(&self, drives: Vec<(String, PathBuf)>, force: bool) {
        for (id, mount) in drives {
            self.enqueue(&id, mount, force);
        }
    }

    pub fn mark_dirty(&self, drive_id: &str, rel: &str) {
        let _ = self.tx.send(Job::Dirty {
            drive_id: drive_id.to_string(),
            rel: rel.to_string(),
        });
    }

    pub fn status(&self) -> ScanStatus {
        let progress = self.shared.progress.lock().unwrap();
        ScanStatus {
            scanning: progress.values().any(|p| p.state != DriveScan::Ready),
            drives_total: progress.len(),
            drives_done: progress
                .values()
                .filter(|p| p.state == DriveScan::Ready)
                .count(),
            dirs_indexed: progress.values().map(|p| p.dirs).sum(),
        }
    }

    fn enqueue(&self, drive_id: &str, mount: PathBuf, force: bool) {
        self.shared
            .mounts
            .lock()
            .unwrap()
            .insert(drive_id.to_string(), mount);
        self.shared.progress.lock().unwrap().insert(
            drive_id.to_string(),
            Progress {
                state: DriveScan::Queued,
                dirs: 0,
            },
        );
        let _ = self.tx.send(Job::Scan {
            drive_id: drive_id.to_string(),
            force,
        });
    }
}

fn worker(rx: mpsc::Receiver<Job>, shared: Arc<Shared>) {
    // (drive, force), oldest first; a drive appears once.
    let mut scans: VecDeque<(String, bool)> = VecDeque::new();
    let mut dirty: HashMap<(String, String), Instant> = HashMap::new();
    loop {
        match rx.recv_timeout(IDLE_POLL) {
            Ok(job) => queue_job(job, &mut scans, &mut dirty),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(job) = rx.try_recv() {
            queue_job(job, &mut scans, &mut dirty);
        }

        if let Some((drive_id, force)) = scans.pop_front() {
            run_scan(&shared, &drive_id, force);
            continue;
        }

        let due: Vec<(String, String)> = dirty
            .iter()
            .filter(|(_, at)| at.elapsed() >= DIRTY_DEBOUNCE)
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            dirty.remove(&key);
            let mount = shared.mounts.lock().unwrap().get(&key.0).cloned();
            if let Some(root) = mount
                && let Err(e) = refresh_dir(&key.0, &root, &key.1)
            {
                tracing::debug!(drive = %key.0, rel = %key.1, error = %e, "search index refresh failed");
            }
        }
    }
}

fn queue_job(
    job: Job,
    scans: &mut VecDeque<(String, bool)>,
    dirty: &mut HashMap<(String, String), Instant>,
) {
    match job {
        Job::Scan { drive_id, force } => match scans.iter_mut().find(|(id, _)| *id == drive_id) {
            Some((_, queued_force)) => *queued_force |= force,
            None => scans.push_back((drive_id, force)),
        },
        Job::Dirty { drive_id, rel } => {
            dirty.insert((drive_id, rel), Instant::now());
        }
    }
}

fn set_progress(shared: &Shared, drive_id: &str, state: DriveScan, dirs: Option<u64>) {
    let mut progress = shared.progress.lock().unwrap();
    // A drive that was unwatched mid-scan must not reappear.
    if let Some(p) = progress.get_mut(drive_id) {
        p.state = state;
        if let Some(dirs) = dirs {
            p.dirs = dirs;
        }
    }
}

fn run_scan(shared: &Shared, drive_id: &str, force: bool) {
    let Some(root) = shared.mounts.lock().unwrap().get(drive_id).cloned() else {
        return;
    };
    set_progress(shared, drive_id, DriveScan::Scanning, Some(0));
    let conn = match crate::drives::drive_db::open(&root) {
        Ok(conn) => conn,
        Err(e) => {
            tracing::warn!(drive_id, error = %e, "search index could not open the drive");
            set_progress(shared, drive_id, DriveScan::Ready, None);
            return;
        }
    };
    let mut visited = 0u64;
    let mut tick = || {
        visited += 1;
        if visited % MOUNT_CHECK_EVERY == 0 {
            let still = shared.mounts.lock().unwrap().get(drive_id) == Some(&root);
            if !still {
                return false;
            }
        }
        if visited % 16 == 0 {
            set_progress(shared, drive_id, DriveScan::Scanning, Some(visited));
        }
        true
    };
    let result = index::scan_tree(&conn, drive_id, &root, "", force, &mut tick);
    if let Err(e) = &result {
        tracing::warn!(drive_id, error = %e, "search index scan stopped");
    }
    set_progress(shared, drive_id, DriveScan::Ready, Some(visited));
}

/// Re-read one folder, plus any subfolder that isn't indexed yet (a folder
/// that was just copied or renamed in).
fn refresh_dir(drive_id: &str, root: &Path, rel: &str) -> anyhow::Result<()> {
    let conn = crate::drives::drive_db::open(root)?;
    let children = index::sync_dir(&conn, drive_id, root, rel, true)?;
    for child in children {
        let known: bool = conn
            .query_row(
                "SELECT 1 FROM indexed_dirs WHERE drive_id = ?1 AND path = ?2",
                rusqlite::params![drive_id, child],
                |_| Ok(()),
            )
            .is_ok();
        if !known {
            index::scan_tree(&conn, drive_id, root, &child, false, &mut || true)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::search::{self, DriveRef, KindFilter};
    use crate::files::search_rank::Query;

    fn make_drive(dir: &Path) -> PathBuf {
        let root = dir.join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            &root,
            &marker,
            &luna_core::marker::pick_prefix(&root).unwrap(),
        )
        .unwrap();
        drop(conn);
        root
    }

    fn found(root: &Path, q: &str) -> Vec<String> {
        let drives = [DriveRef {
            id: "d1".into(),
            mount: root.to_path_buf(),
        }];
        search::search_all(&drives, &Query::new(q), KindFilter::All)
            .into_iter()
            .map(|c| c.hit.name)
            .collect()
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if ok() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for {what}");
    }

    #[test]
    fn scans_whole_drive_so_unvisited_folders_are_searchable() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::create_dir_all(root.join("a/b/deep folder")).unwrap();
        std::fs::write(root.join("a/b/deep folder/tax return.pdf"), b"x").unwrap();

        let indexer = SearchIndexer::start();
        indexer.watch_mount("d1", root.clone());
        wait_for("the first scan", || {
            let s = indexer.status();
            !s.scanning && s.drives_done == 1
        });

        assert_eq!(found(&root, "tax return"), ["tax return.pdf"]);
        assert_eq!(found(&root, "deep folder"), ["deep folder", "tax return.pdf"]);
        assert!(indexer.status().dirs_indexed >= 4);
    }

    #[test]
    fn a_nudged_folder_catches_new_and_removed_files_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/old.txt"), b"x").unwrap();
        let indexer = SearchIndexer::start();
        indexer.watch_mount("d1", root.clone());
        wait_for("the first scan", || !indexer.status().scanning);
        assert_eq!(found(&root, "old"), ["old.txt"]);

        std::fs::remove_file(root.join("docs/old.txt")).unwrap();
        std::fs::create_dir_all(root.join("docs/fresh dir/inner")).unwrap();
        std::fs::write(root.join("docs/fresh dir/inner/brand new.txt"), b"x").unwrap();
        indexer.mark_dirty("d1", "docs");
        wait_for("the refresh", || !found(&root, "brand new").is_empty());
        assert!(found(&root, "old").is_empty());
        assert_eq!(found(&root, "fresh dir"), ["fresh dir", "inner", "brand new.txt"]);
    }

    #[test]
    fn a_rescan_drops_folders_deleted_behind_luna() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::create_dir_all(root.join("gone/sub")).unwrap();
        std::fs::write(root.join("gone/sub/ghost.txt"), b"x").unwrap();
        let indexer = SearchIndexer::start();
        indexer.watch_mount("d1", root.clone());
        wait_for("the first scan", || !indexer.status().scanning);
        assert_eq!(found(&root, "ghost"), ["ghost.txt"]);

        std::fs::remove_dir_all(root.join("gone")).unwrap();
        indexer.rescan(vec![("d1".into(), root.clone())], false);
        wait_for("the rescan", || found(&root, "ghost").is_empty());
    }

    #[test]
    fn hidden_folders_are_not_searched_even_when_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        std::fs::write(root.join(".cache/blob.bin"), b"x").unwrap();
        let indexer = SearchIndexer::start();
        indexer.watch_mount("d1", root.clone());
        wait_for("the first scan", || !indexer.status().scanning);
        assert!(found(&root, "blob").is_empty());
    }

    #[test]
    fn a_missing_drive_keeps_its_index() {
        let dir = tempfile::tempdir().unwrap();
        let root = make_drive(dir.path());
        std::fs::write(root.join("keep me.txt"), b"x").unwrap();
        let indexer = SearchIndexer::start();
        indexer.watch_mount("d1", root.clone());
        wait_for("the first scan", || !indexer.status().scanning);

        let conn = crate::drives::drive_db::open(&root).unwrap();
        let moved = dir.path().join("moved");
        std::fs::rename(&root, &moved).unwrap();
        assert!(index::sync_dir(&conn, "d1", &root, "", true).is_err());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM index_entries", [], |r| r.get(0))
            .unwrap();
        assert!(n >= 1, "unplugging a drive must not wipe its index");
    }
}
