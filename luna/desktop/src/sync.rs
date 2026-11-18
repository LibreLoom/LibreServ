//! Two-way sync between a Luna folder (or whole drive) and a local child folder.

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

/// How often to re-check Luna for remote-side changes when nothing changed locally.
const REMOTE_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// A local edit during a full pass's walk of Luna stops the walk so the edit
/// goes up at once (journey K4), then the pass starts over. After this many
/// stops in a row the pass runs to the end, so constant edits can't starve it.
const MAX_WALK_PREEMPTS: u32 = 3;

/// `LUNA_DESKTOP_PERF=1` prints per-phase sync timings (journey K3) to stderr.
fn perf_log() -> bool {
    crate::perf_enabled()
}

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
    /// Full passes (both sides walked) finished so far; lets a bench or the
    /// UI tell a full pass from the quick one-file path.
    pub full_passes: u64,
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
    /// Set by `insert`/`remove`, so an idle pass skips rewriting the whole file.
    dirty: bool,
}

impl Ledger {
    fn load(path: &Path) -> Ledger {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .map(|map| Ledger { map, dirty: false })
            .unwrap_or_default()
    }

    fn insert(&mut self, rel: String, entry: LedgerEntry) {
        self.map.insert(rel, entry);
        self.dirty = true;
    }

    fn remove(&mut self, rel: &str) {
        if self.map.remove(rel).is_some() {
            self.dirty = true;
        }
    }

    /// Write the ledger if anything changed since the last save.
    fn save_if_dirty(&mut self, path: &Path) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
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
    /// Wakes the worker (`None`) so a stop takes effect without it polling the flag.
    wake: std::sync::mpsc::Sender<Option<PathBuf>>,
    /// Kept alive for the pair lifetime; dropped on stop so watches end.
    _watcher: RecommendedWatcher,
}

impl SyncHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.wake.send(None);
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

    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    let tx_notify = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for path in event.paths {
                    let _ = tx_notify.send(Some(path));
                }
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
        // Local paths the watcher reported since they were last looked at.
        let mut changed: HashSet<PathBuf> = HashSet::new();
        // A full pass (walk both sides) runs first, then every 30 s; local
        // edits in between go through the quick path, one file at a time.
        let mut full_due = true;
        let mut last_full = Instant::now();
        // Full passes stopped in a row for local edits.
        let mut preempts = 0;
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                ledger.save_if_dirty(&ledger_file);
                set_running(&thread_progress, &pair_id, false);
                return;
            }
            // Local edits go first, also when a full pass is due (or was just
            // stopped for them): the quick path is safe on its own.
            if !changed.is_empty() {
                set_phase(&thread_progress, &pair_id, "Syncing");
                let paths: Vec<PathBuf> = changed.drain().collect();
                // Anything the quick path can't settle safely (deletes,
                // remote changes, conflicts, errors) goes to a full pass.
                let settled = matches!(
                    sync_changed(
                        &base_url,
                        &token,
                        &remote,
                        &local_root,
                        &paths,
                        &mut ledger,
                        &ledger_file,
                        &pair_id,
                        &thread_progress,
                        &thread_stop,
                    ),
                    Ok(true)
                );
                if settled && !full_due {
                    set_error(&thread_progress, &pair_id, "");
                }
                full_due |= !settled;
            }
            if full_due {
                set_phase(&thread_progress, &pair_id, "Syncing");
                let may_preempt = preempts < MAX_WALK_PREEMPTS;
                let mut edited = || {
                    if !may_preempt {
                        return true;
                    }
                    let mut any = false;
                    while let Ok(path) = rx.try_recv() {
                        any |= path.is_some();
                        changed.extend(path);
                    }
                    !any && !thread_stop.load(Ordering::Relaxed)
                };
                match sync_once(
                    &base_url,
                    &token,
                    &remote,
                    &local_root,
                    &mut ledger,
                    &ledger_file,
                    &pair_id,
                    &thread_progress,
                    &thread_stop,
                    &mut edited,
                ) {
                    Ok(false) => {
                        // Stopped for a local edit (or a stop): nothing changed
                        // yet. Let the edit's burst settle, send it, then start
                        // the full pass over.
                        preempts += 1;
                        std::thread::sleep(Duration::from_millis(400));
                        while let Ok(path) = rx.try_recv() {
                            changed.extend(path);
                        }
                        continue;
                    }
                    Ok(true) => set_error(&thread_progress, &pair_id, ""),
                    Err(e) => set_error(&thread_progress, &pair_id, &e),
                }
                preempts = 0;
                full_due = false;
                crate::trim_heap();
                last_full = Instant::now();
                if let Ok(mut map) = thread_progress.lock()
                    && let Some(p) = map.get_mut(&pair_id)
                {
                    p.full_passes += 1;
                }
            }
            // Always clear the in-flight name so Status drops finished/failed rows.
            clear_current(&thread_progress, &pair_id);
            set_phase(&thread_progress, &pair_id, "Waiting");
            // Events queued during the pass stay queued: most are the pass's
            // own downloads, which the quick path skips with one look at the
            // ledger, and a user edit made mid-pass is picked up right away.
            let wait = REMOTE_POLL_INTERVAL.saturating_sub(last_full.elapsed());
            let first = if changed.is_empty() {
                rx.recv_timeout(wait)
            } else {
                // Already have work: only fold in what is queued.
                rx.try_recv().map_err(|e| match e {
                    std::sync::mpsc::TryRecvError::Empty => {
                        std::sync::mpsc::RecvTimeoutError::Timeout
                    }
                    std::sync::mpsc::TryRecvError::Disconnected => {
                        std::sync::mpsc::RecvTimeoutError::Disconnected
                    }
                })
            };
            match first {
                Ok(path) => {
                    changed.extend(path);
                    if !thread_stop.load(Ordering::Relaxed) {
                        // Debounce a burst of file events into one pass.
                        std::thread::sleep(Duration::from_millis(400));
                        while let Ok(path) = rx.try_recv() {
                            changed.extend(path);
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if last_full.elapsed() >= REMOTE_POLL_INTERVAL {
                        full_due = true;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    ledger.save_if_dirty(&ledger_file);
                    set_running(&thread_progress, &pair_id, false);
                    return;
                }
            }
        }
    });

    Ok(SyncHandle {
        stop,
        wake: tx,
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

/// Mark which file is actively transferring so Status can show it.
fn set_current(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str, current: &str) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.phase = "Syncing".to_string();
        p.current = current.to_string();
    }
}

/// Count a finished transfer and clear `current` so the Status row drops.
fn bump(progress: &Arc<Mutex<HashMap<String, SyncProgress>>>, id: &str, up: bool, conflict: bool) {
    if let Ok(mut map) = progress.lock()
        && let Some(p) = map.get_mut(id)
    {
        p.phase = "Syncing".to_string();
        p.current.clear();
        if conflict {
            p.conflicts += 1;
        } else if up {
            p.uploaded += 1;
        } else {
            p.downloaded += 1;
        }
    }
}

/// Where remote-deleted local files are set aside. A dot name, so
/// `walk_local` never syncs the trash back up to Luna.
const TRASH_DIR_NAME: &str = ".luna-desktop-trash";

/// Local path for a sync-relative `rel`, or a user-facing error when it
/// would land outside the sync folder. The remote walk already rejects
/// unsafe names; this is the last check before anything touches the disk.
fn local_path(local_root: &Path, rel: &str) -> Result<PathBuf, String> {
    crate::paths::join_under(local_root, rel).ok_or_else(|| {
        "Luna listed a file name this computer can't store. Sync stopped.".to_string()
    })
}

/// Move `path` into the pair's trash instead of deleting it. A remote
/// delete — or a forged listing that simply omits files — must not destroy
/// the local copy: the file lands in `.luna-desktop-trash/<unix seconds>/`
/// under its relative path and can be moved back by hand.
fn quarantine_local(local_root: &Path, path: &Path, rel: &str) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let trash = local_root.join(TRASH_DIR_NAME).join(stamp.to_string());
    let dest = crate::paths::join_under(&trash, rel)
        .ok_or_else(|| "Couldn't move the removed file aside on this computer.".to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Couldn't move the removed file aside on this computer.".to_string())?;
    }
    let dest = free_trash_path(&dest);
    std::fs::rename(path, &dest)
        .map_err(|_| "Couldn't move the removed file aside on this computer.".to_string())
}

/// `dest`, or a never-clobbering `name 2.ext` sibling when it already exists —
/// two files with the same name can land in one timestamped trash folder.
fn free_trash_path(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 2.. {
        let next = dest.with_file_name(format!("{stem} {n}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
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
        // Conflict copies ("x (conflict from this computer).txt") are ordinary
        // files here: including them lets the normal arms upload ours to Luna
        // and download other machines' — skipping them would make their remote
        // copies look locally-deleted next pass and get deleted.
        if name.starts_with('.') {
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

/// What the quick path does with one changed local file.
#[derive(Debug, PartialEq)]
enum QuickStep {
    /// Nothing to send: the file matches the ledger (often the pass's own
    /// download), or it is gone and was never synced.
    Skip,
    /// Ask Luna about this one file, then decide with `quick_upload`.
    AskLuna,
    /// Only a full pass can handle this safely (a delete, a folder).
    Full,
}

/// `local`: the file's size and mtime now, `None` when it is gone.
fn quick_step(local: Option<(u64, i64)>, prev: Option<&LedgerEntry>) -> QuickStep {
    match (local, prev) {
        (Some((size, lm)), Some(p)) if size == p.size && lm == p.local_mtime => QuickStep::Skip,
        (Some(_), _) => QuickStep::AskLuna,
        (None, None) => QuickStep::Skip,
        (None, Some(_)) => QuickStep::Full,
    }
}

/// After asking Luna: `Some(overwrite)` to upload now, `None` for a full pass.
/// Uploads only when Luna's copy is exactly what the ledger last saw (an
/// edit here, nothing changed there), or when neither side ever had it.
fn quick_upload(prev: Option<&LedgerEntry>, remote: Option<&luna::FileEntry>) -> Option<bool> {
    match (prev, remote) {
        (Some(p), Some(r))
            if r.kind == "file" && r.size == p.size && r.modified == p.remote_mtime =>
        {
            Some(true)
        }
        (None, None) => Some(false),
        _ => None,
    }
}

/// Sync rel paths the watcher reported, one file at a time, without walking
/// either side. `Ok(true)`: all settled. `Ok(false)`: something needs a full
/// pass (deletes, remote changes, conflicts, folders that appeared).
#[allow(clippy::too_many_arguments)]
fn sync_changed(
    base_url: &str,
    token: &str,
    remote: &LunaRef,
    local_root: &Path,
    paths: &[PathBuf],
    ledger: &mut Ledger,
    ledger_file: &Path,
    pair_id: &str,
    progress: &Arc<Mutex<HashMap<String, SyncProgress>>>,
    stop: &AtomicBool,
) -> Result<bool, String> {
    let mut settled = true;
    for path in paths {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(rel_path) = path.strip_prefix(local_root) else {
            continue;
        };
        // Same rule as `walk_local`: dot names (and the trash) never sync.
        if rel_path
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let local = match std::fs::symlink_metadata(path) {
            Ok(m) if m.is_file() => Some((m.len(), mtime_secs(&m))),
            Ok(m) if m.is_dir() => {
                // A folder made or moved in: its files only show up in a walk.
                settled = false;
                continue;
            }
            Ok(_) => continue, // symlinks and specials never sync
            Err(_) => {
                // Gone: a folder that held synced files needs the full pass too.
                let prefix = format!("{rel}/");
                if ledger.map.keys().any(|k| k.starts_with(&prefix)) {
                    settled = false;
                    continue;
                }
                None
            }
        };
        let prev = ledger.map.get(&rel).cloned();
        match quick_step(local, prev.as_ref()) {
            QuickStep::Skip => continue,
            QuickStep::Full => {
                settled = false;
                continue;
            }
            QuickStep::AskLuna => {}
        }
        let Some((size, lm)) = local else { continue };
        let remote_abs = join_remote(&remote.path, &rel);
        let remote_e = luna::stat_file(base_url, token, &remote.drive_id, &remote_abs)?;
        let Some(overwrite) = quick_upload(prev.as_ref(), remote_e.as_ref()) else {
            settled = false;
            continue;
        };
        set_current(progress, pair_id, &rel);
        let rm = luna::upload_file(base_url, token, remote, path, &rel, overwrite)?;
        ledger.insert(
            rel.clone(),
            LedgerEntry {
                size,
                local_mtime: lm,
                remote_mtime: rm.unwrap_or(lm),
            },
        );
        bump(progress, pair_id, true, false);
    }
    ledger.save_if_dirty(ledger_file);
    clear_current(progress, pair_id);
    Ok(settled)
}

/// One full pass. `Ok(false)`: `keep_going` said no while Luna was being
/// walked, so the pass stopped before changing anything.
#[allow(clippy::too_many_arguments)]
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
    keep_going: &mut dyn FnMut() -> bool,
) -> Result<bool, String> {
    let remote_start = Instant::now();
    let Some(remote_files) =
        luna::walk_remote_files_until(base_url, token, &remote.drive_id, &remote.path, keep_going)?
    else {
        return Ok(false);
    };
    let remote_map: HashMap<String, luna::FileEntry> = remote_files.into_iter().collect();
    let remote_ms = remote_start.elapsed().as_millis();
    let local_start = Instant::now();
    let local_map = walk_local(local_root);
    let local_ms = local_start.elapsed().as_millis();
    let diff_start = Instant::now();

    let mut all: HashSet<String> = HashSet::new();
    all.extend(remote_map.keys().cloned());
    all.extend(local_map.keys().cloned());
    all.extend(ledger.map.keys().cloned());

    for rel in all {
        if stop.load(Ordering::Relaxed) {
            return Ok(true);
        }
        let local = local_map.get(&rel);
        let remote_e = remote_map.get(&rel);
        let prev = ledger.map.get(&rel).cloned();

        match (local, remote_e, prev) {
            (Some((path, size, lm)), Some(re), Some(prev)) => {
                let local_changed = *size != prev.size || *lm != prev.local_mtime;
                let remote_changed = re.size != prev.size || re.modified != prev.remote_mtime;
                if local_changed && remote_changed {
                    // Conflict: keep both versions, in an order where a failure
                    // never loses a copy — set the local file aside under a
                    // never-overwriting name, then download the remote version
                    // to the canonical name (on failure the local file goes
                    // back where it was). The set-aside copy reaches Luna as an
                    // ordinary new file: uploaded right away, and retried by
                    // the normal (local-only, no-ledger) arm until it lands.
                    let conflict_name = free_conflict_path(path, "this computer");
                    std::fs::rename(path, &conflict_name).map_err(|_| {
                        "Couldn't set aside the changed file on this computer.".to_string()
                    })?;
                    let dest = local_path(local_root, &rel)?;
                    let remote_abs = join_remote(&remote.path, &rel);
                    set_current(progress, pair_id, &rel);
                    if let Err(e) =
                        luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)
                    {
                        let _ = std::fs::rename(&conflict_name, path);
                        return Err(e);
                    }
                    let lm = std::fs::metadata(&dest)
                        .map(|m| mtime_secs(&m))
                        .unwrap_or(re.modified);
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: re.size,
                            local_mtime: lm,
                            remote_mtime: re.modified,
                        },
                    );
                    bump(progress, pair_id, false, true);
                    let conflict_rel = conflict_rel(&rel, &conflict_name);
                    set_current(progress, pair_id, &conflict_rel);
                    // Best-effort immediate upload; on failure the next pass
                    // sees the set-aside copy as a new local file and retries
                    // until it lands. On success record it now, from Luna's
                    // reported mtime, so the next pass doesn't take it for an
                    // unknown remote file and download it back.
                    if let Ok(Some(rm)) = luna::upload_file(
                        base_url,
                        token,
                        remote,
                        &conflict_name,
                        &conflict_rel,
                        false,
                    ) && let Ok(meta) = std::fs::metadata(&conflict_name)
                    {
                        ledger.insert(
                            conflict_rel.clone(),
                            LedgerEntry {
                                size: meta.len(),
                                local_mtime: mtime_secs(&meta),
                                remote_mtime: rm,
                            },
                        );
                    }
                } else if local_changed {
                    set_current(progress, pair_id, &rel);
                    let rm = luna::upload_file(base_url, token, remote, path, &rel, true)?;
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: rm.unwrap_or(*lm),
                        },
                    );
                    bump(progress, pair_id, true, false);
                } else if remote_changed {
                    set_current(progress, pair_id, &rel);
                    let dest = local_path(local_root, &rel)?;
                    let remote_abs = join_remote(&remote.path, &rel);
                    luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                    let meta = std::fs::metadata(&dest)
                        .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: meta.len(),
                            local_mtime: mtime_secs(&meta),
                            remote_mtime: re.modified,
                        },
                    );
                    bump(progress, pair_id, false, false);
                }
            }
            (Some((path, size, lm)), Some(re), None) => {
                // Both exist, no ledger — treat newer mtime as winner; equal → keep both if sizes differ.
                if *size == re.size && (*lm - re.modified).abs() <= 2 {
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: re.modified,
                        },
                    );
                } else if *lm >= re.modified {
                    set_current(progress, pair_id, &rel);
                    let rm = luna::upload_file(base_url, token, remote, path, &rel, true)?;
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: *size,
                            local_mtime: *lm,
                            remote_mtime: rm.unwrap_or(*lm),
                        },
                    );
                    bump(progress, pair_id, true, false);
                } else {
                    set_current(progress, pair_id, &rel);
                    let dest = local_path(local_root, &rel)?;
                    let remote_abs = join_remote(&remote.path, &rel);
                    luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                    let meta = std::fs::metadata(&dest)
                        .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                    ledger.insert(
                        rel.clone(),
                        LedgerEntry {
                            size: meta.len(),
                            local_mtime: mtime_secs(&meta),
                            remote_mtime: re.modified,
                        },
                    );
                    bump(progress, pair_id, false, false);
                }
            }
            (Some((path, size, lm)), None, Some(_)) => {
                // Remote deleted → set the local copy aside in the pair's
                // trash, never hard-delete: a forged listing could claim
                // every file is gone. On failure keep the ledger entry so
                // the move is retried next pass rather than resurrected as
                // a new upload.
                set_current(progress, pair_id, &rel);
                if quarantine_local(local_root, path, &rel).is_ok() {
                    ledger.remove(&rel);
                    bump(progress, pair_id, false, false);
                }
                let _ = size;
                let _ = lm;
            }
            (Some((path, size, lm)), None, None) => {
                // New local file
                set_current(progress, pair_id, &rel);
                let rm = luna::upload_file(base_url, token, remote, path, &rel, false)?;
                ledger.insert(
                    rel.clone(),
                    LedgerEntry {
                        size: *size,
                        local_mtime: *lm,
                        // Luna stamps its own mtime on the stored file; recording it
                        // keeps the next pass from seeing a remote change and
                        // downloading the file straight back.
                        remote_mtime: rm.unwrap_or(*lm),
                    },
                );
                bump(progress, pair_id, true, false);
            }
            (None, Some(re), Some(_)) => {
                // Local deleted → delete remote
                set_current(progress, pair_id, &rel);
                let remote_abs = join_remote(&remote.path, &rel);
                luna::delete_path(base_url, token, &remote.drive_id, &remote_abs)?;
                ledger.remove(&rel);
                bump(progress, pair_id, false, false);
                let _ = re;
            }
            (None, Some(re), None) => {
                // New remote file
                set_current(progress, pair_id, &rel);
                let dest = local_path(local_root, &rel)?;
                let remote_abs = join_remote(&remote.path, &rel);
                luna::download_file(base_url, token, &remote.drive_id, &remote_abs, &dest)?;
                let meta = std::fs::metadata(&dest)
                    .map_err(|_| "Couldn't read the downloaded file.".to_string())?;
                ledger.insert(
                    rel.clone(),
                    LedgerEntry {
                        size: meta.len(),
                        local_mtime: mtime_secs(&meta),
                        remote_mtime: re.modified,
                    },
                );
                bump(progress, pair_id, false, false);
            }
            (None, None, Some(_)) => {
                ledger.remove(&rel);
            }
            (None, None, None) => {}
        }
    }
    let save_start = Instant::now();
    ledger.save_if_dirty(ledger_file);
    if perf_log() {
        eprintln!(
            "luna-desktop: K3 sync pass files={} remote_walk_ms={} local_walk_ms={} diff_ms={} save_ms={}",
            ledger.map.len(),
            remote_ms,
            local_ms,
            save_start.duration_since(diff_start).as_millis(),
            save_start.elapsed().as_millis()
        );
    }
    clear_current(progress, pair_id);
    Ok(true)
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

/// `conflict_path`, but never an existing file — earlier conflict copies of
/// the same name must not be clobbered (Windows rename refuses, Unix rename
/// would silently replace).
fn free_conflict_path(path: &Path, from: &str) -> PathBuf {
    let candidate = conflict_path(path, from);
    if !candidate.exists() {
        return candidate;
    }
    let stem = candidate
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = candidate
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 2.. {
        let next = candidate.with_file_name(format!("{stem} {n}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
}

/// Remote-relative path for the conflict copy: same folder as `rel`, with the
/// conflict marker in the file name.
fn conflict_rel(rel: &str, conflict_name: &Path) -> String {
    let file = conflict_name
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("conflict");
    match rel.rfind('/') {
        Some(i) => format!("{}/{file}", &rel[..i]),
        None => file.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_skips_save_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        let mut l = Ledger::default();
        l.save_if_dirty(&path);
        assert!(!path.exists(), "an idle pass must not write the ledger");
        l.insert("a.txt".into(), LedgerEntry::default());
        l.save_if_dirty(&path);
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        l.remove("missing.txt");
        l.save_if_dirty(&path);
        assert!(!path.exists(), "removing nothing is not a change");
        l.remove("a.txt");
        l.save_if_dirty(&path);
        assert!(Ledger::load(&path).map.is_empty());
    }

    fn entry(size: u64, local_mtime: i64, remote_mtime: i64) -> LedgerEntry {
        LedgerEntry {
            size,
            local_mtime,
            remote_mtime,
        }
    }

    fn remote(kind: &str, size: u64, modified: i64) -> luna::FileEntry {
        luna::FileEntry {
            name: "a.txt".into(),
            kind: kind.into(),
            size,
            modified,
            private: false,
        }
    }

    #[test]
    fn quick_step_skips_what_the_ledger_already_has() {
        let prev = entry(10, 100, 200);
        // The pass's own download: same size and mtime as recorded.
        assert_eq!(quick_step(Some((10, 100)), Some(&prev)), QuickStep::Skip);
        // Gone and never synced (a download's temp file, a set-aside move).
        assert_eq!(quick_step(None, None), QuickStep::Skip);
    }

    #[test]
    fn quick_step_leaves_deletes_to_a_full_pass() {
        assert_eq!(
            quick_step(None, Some(&entry(10, 100, 200))),
            QuickStep::Full
        );
    }

    #[test]
    fn quick_step_asks_luna_about_edits_and_new_files() {
        let prev = entry(10, 100, 200);
        assert_eq!(quick_step(Some((11, 100)), Some(&prev)), QuickStep::AskLuna);
        assert_eq!(quick_step(Some((10, 101)), Some(&prev)), QuickStep::AskLuna);
        assert_eq!(quick_step(Some((10, 100)), None), QuickStep::AskLuna);
    }

    #[test]
    fn quick_upload_replaces_only_an_unchanged_luna_copy() {
        let prev = entry(10, 100, 200);
        assert_eq!(
            quick_upload(Some(&prev), Some(&remote("file", 10, 200))),
            Some(true)
        );
        // Changed on Luna too: a conflict, so the full pass keeps both.
        assert_eq!(
            quick_upload(Some(&prev), Some(&remote("file", 12, 200))),
            None
        );
        assert_eq!(
            quick_upload(Some(&prev), Some(&remote("file", 10, 201))),
            None
        );
        // Deleted on Luna, or a folder there now.
        assert_eq!(quick_upload(Some(&prev), None), None);
        assert_eq!(
            quick_upload(Some(&prev), Some(&remote("dir", 10, 200))),
            None
        );
    }

    #[test]
    fn quick_upload_never_overwrites_a_file_it_has_not_seen() {
        // New here and not on Luna: a plain create.
        assert_eq!(quick_upload(None, None), Some(false));
        // New here but Luna has one: the full pass decides (newer wins or both kept).
        assert_eq!(quick_upload(None, Some(&remote("file", 10, 200))), None);
    }

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

    #[test]
    fn free_conflict_path_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("note.txt");
        std::fs::write(&p, b"new").unwrap();
        let first = free_conflict_path(&p, "this computer");
        assert_eq!(
            first.file_name().unwrap(),
            "note (conflict from this computer).txt"
        );
        std::fs::write(&first, b"kept").unwrap();
        let second = free_conflict_path(&p, "this computer");
        assert_eq!(
            second.file_name().unwrap(),
            "note (conflict from this computer) 2.txt"
        );
        // The existing copy is untouched — a conflict must never clobber.
        assert_eq!(std::fs::read(&first).unwrap(), b"kept");
    }

    #[test]
    fn conflict_rel_keeps_the_subdirectory() {
        let name = conflict_path(&PathBuf::from("/local/sub/note.txt"), "this computer");
        assert_eq!(
            conflict_rel("sub/note.txt", &name),
            "sub/note (conflict from this computer).txt"
        );
        assert_eq!(
            conflict_rel("top.txt", &name),
            "note (conflict from this computer).txt"
        );
    }
}
