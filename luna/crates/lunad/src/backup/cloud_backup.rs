//! Idle spare-copy sync to Luna Connect (latest file only).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{self, DriveRow};
use crate::net::connect::{self, ConnectError, ConnectService};

const MAX_FILES_PER_TICK: u64 = 50_000;
/// Per-tick upload budget — idle ticks trickle, they don't drain a drive.
const MAX_BYTES_PER_TICK: u64 = 4 * 1024 * 1024 * 1024;
/// One object's ceiling: bodies stream from disk, so RAM isn't the limit —
/// a multi-GiB file still stalls a slow uplink for hours. Skipped (logged),
/// not retried forever.
const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The meta-table key holding [`CloudBackupStatus`] as JSON.
const STATUS_KEY: &str = "cloud_backup_status";

/// What the cloud backup has recorded about its runs — read by the health
/// checks and `GET /api/v1/connect/status`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CloudBackupStatus {
    /// When the backup was turned on (sources saved while none were set) —
    /// the staleness clock before the first success.
    pub since: i64,
    pub last_run_at: i64,
    /// Last run that reached every file with nothing failed and no source
    /// skipped. 0 = never.
    pub last_ok_at: i64,
    /// Last run that copied files without failing but ran out of time
    /// first — a big backup moving along. 0 = never.
    #[serde(default)]
    pub last_progress_at: i64,
    /// When the current run of failures began. 0 while healthy.
    pub failing_since: i64,
    /// Plain-language reason; empty while healthy.
    pub last_error: String,
    /// The problem won't fix itself — see [`super::status::Record::hard`].
    pub hard: bool,
    pub last_result: RunResult,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunResult {
    pub uploaded: u64,
    pub failed: u64,
    pub bytes: u64,
    pub unchanged: u64,
    pub skipped_too_large: u64,
    /// Drives or folders that couldn't be reached this run.
    pub skipped_sources: Vec<String>,
    /// The run stopped at its per-tick limit with files still to copy.
    #[serde(default)]
    pub incomplete: bool,
}

impl CloudBackupStatus {
    pub fn state(&self, now: i64) -> super::status::BackupState {
        super::status::state(
            super::status::Record {
                // A big first backup that keeps moving isn't stale.
                last_ok_at: self.last_ok_at.max(self.last_progress_at),
                failing_since: self.failing_since,
                last_error: &self.last_error,
                hard: self.hard,
                since: self.since,
            },
            now,
        )
    }
}

pub fn read_status(conn: &rusqlite::Connection) -> Option<CloudBackupStatus> {
    db::get_meta(conn, STATUS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_status(conn: &rusqlite::Connection, status: &CloudBackupStatus) {
    if let Ok(raw) = serde_json::to_string(status) {
        let _ = db::set_meta(conn, STATUS_KEY, &raw);
    }
}

/// Sources were just saved. Turning backup on (none before) starts a fresh
/// record; changing what's copied keeps the history, including any failure.
pub fn note_sources_saved(conn: &rusqlite::Connection, had_sources: bool, now: i64) {
    if had_sources && read_status(conn).is_some() {
        return;
    }
    write_status(
        conn,
        &CloudBackupStatus {
            since: now,
            ..Default::default()
        },
    );
}

/// Counts and the worst failure for one tick.
#[derive(Default)]
struct TickStats {
    result: RunResult,
    last_error: Option<String>,
    /// Some failure this tick won't fix itself on the next one.
    hard: bool,
    /// Local files Luna couldn't open, and the first one's name.
    unreadable: u64,
    first_unreadable: Option<String>,
}

impl TickStats {
    fn fail(&mut self, err: &ConnectError) {
        self.result.failed += 1;
        let hard = !matches!(
            err,
            ConnectError::Unreachable | ConnectError::GatewayChallenge
        );
        self.problem(err.to_string(), hard);
    }

    /// Keep the first hard problem's message over any soft one.
    fn problem(&mut self, message: String, hard: bool) {
        if self.last_error.is_none() || (hard && !self.hard) {
            self.last_error = Some(message);
        }
        self.hard |= hard;
    }

    fn unreadable(&mut self, path: &Path) {
        self.result.failed += 1;
        self.unreadable += 1;
        if self.first_unreadable.is_none() {
            self.first_unreadable = path.file_name().map(|n| n.to_string_lossy().into_owned());
        }
    }

    /// Name the file a person has to look at.
    fn finish(&mut self) {
        let Some(name) = self.first_unreadable.clone() else {
            return;
        };
        let message = match self.unreadable {
            1 => format!("Luna couldn't read {name}, so it wasn't copied to the cloud."),
            2 => format!(
                "Luna couldn't read {name} and 1 other file, so they weren't copied to the cloud."
            ),
            n => format!(
                "Luna couldn't read {name} and {} other files, so they weren't copied to the cloud.",
                n - 1
            ),
        };
        self.problem(message, true);
    }

    /// A source Luna couldn't reach — won't fix itself until a person
    /// plugs a drive back in.
    fn skip_source(&mut self, name: String, message: String) {
        self.problem(message, true);
        self.result.skipped_sources.push(name);
    }
}

/// What one tick is allowed to do — file count AND bytes, so 50k tiny files
/// and one giant one are both bounded.
struct Budget {
    files: u64,
    bytes: u64,
    /// The tick stopped with files still to look at — this pass made
    /// progress but didn't finish.
    cut_short: bool,
}

impl Budget {
    fn new(files: u64, bytes: u64) -> Self {
        Self {
            files,
            bytes,
            cut_short: false,
        }
    }

    fn exhausted(&self) -> bool {
        self.files == 0 || self.bytes == 0
    }
}

/// One idle-time pass. Returns true when the backup went from working to
/// failing or back, so the caller can refresh the health checks.
pub fn tick(connect: &ConnectService, last_io_unix: i64, now_unix: i64, db: &crate::Db) -> bool {
    if !connect.is_connect_active() {
        return false;
    }
    let sources = connect.backup_sources();
    if sources.is_empty() {
        return false;
    }
    // Start the staleness clock even if Luna is never idle long enough to
    // run — "hasn't finished in over a day" must still show.
    if let Ok(conn) = db.lock()
        && read_status(&conn).is_none()
    {
        note_sources_saved(&conn, false, now_unix);
    }
    if !connect.backup_unlocked() {
        let mut stats = TickStats::default();
        stats.problem(
            "Cloud backup is paused because your Luna Connect account has no payment card. Add one at connect.luna.libreloom.org."
                .into(),
            true,
        );
        return record_run(db, now_unix, stats);
    }
    if !connect::is_idle(last_io_unix, now_unix) {
        return false;
    }
    let drives = {
        let Ok(conn) = db.lock() else {
            return false;
        };
        db::list_drives(&conn).unwrap_or_default()
    };
    let mut stats = TickStats::default();
    let mut budget = Budget::new(MAX_FILES_PER_TICK, MAX_BYTES_PER_TICK);
    for source in sources {
        let kind = source.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "folder" => {
                if let Some(path) = source.get("path").and_then(|v| v.as_str()) {
                    if !folder_under_adopted_mount(Path::new(path), &drives) {
                        let name = folder_name(path);
                        let message = format!(
                            "Luna can't find {name}, so it wasn't copied to the cloud. Check that its drive is plugged in."
                        );
                        stats.skip_source(name, message);
                        continue;
                    }
                    if budget.exhausted() {
                        budget.cut_short = true;
                        continue;
                    }
                    sync_tree(
                        connect,
                        db,
                        &format!("folder:{path}"),
                        Path::new(path),
                        "",
                        &mut budget,
                        &mut stats,
                    );
                    put_private_manifest(connect, Path::new(path), &drives, &mut stats);
                }
            }
            "drive" => {
                if let Some(id) = source.get("drive_id").and_then(|v| v.as_str()) {
                    let drive = drives.iter().find(|d| d.id == id);
                    let label = drive.map(|d| d.label.clone()).unwrap_or_default();
                    let mount = drive.map(|d| d.mount_point.clone()).unwrap_or_default();
                    if mount.is_empty() {
                        let (name, message) = if label.trim().is_empty() {
                            (
                                "Unnamed drive".to_string(),
                                "Luna can't find one of the drives picked for cloud backup, so it wasn't copied.".to_string(),
                            )
                        } else {
                            let message = format!(
                                "Luna can't find the drive {label}, so it wasn't copied to the cloud."
                            );
                            (label, message)
                        };
                        stats.skip_source(name, message);
                        continue;
                    }
                    if budget.exhausted() {
                        budget.cut_short = true;
                        continue;
                    }
                    let prefix = label.replace('/', "_");
                    sync_tree(
                        connect,
                        db,
                        &format!("drive:{id}"),
                        Path::new(&mount),
                        &prefix,
                        &mut budget,
                        &mut stats,
                    );
                }
            }
            _ => {}
        }
    }
    stats.result.incomplete = budget.cut_short;
    stats.finish();
    record_run(db, now_unix, stats)
}

/// A folder source's name for messages: its last path segment.
fn folder_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Persist the tick's outcome. Returns true when the backup went from
/// working to failing or back.
fn record_run(db: &crate::Db, now_unix: i64, stats: TickStats) -> bool {
    let Ok(conn) = db.lock() else {
        return false;
    };
    let mut status = read_status(&conn).unwrap_or(CloudBackupStatus {
        since: now_unix,
        ..Default::default()
    });
    let was_failing = !status.last_error.is_empty();
    status.last_run_at = now_unix;
    status.last_result = stats.result;
    match stats.last_error {
        None => {
            if status.last_result.incomplete {
                status.last_progress_at = now_unix;
            } else {
                status.last_ok_at = now_unix;
            }
            status.failing_since = 0;
            status.last_error.clear();
            status.hard = false;
        }
        Some(message) => {
            if status.failing_since == 0 {
                status.failing_since = now_unix;
            }
            // ConnectError messages are already written for users.
            status.last_error = message;
            status.hard = stats.hard;
            tracing::warn!(
                failed = status.last_result.failed,
                uploaded = status.last_result.uploaded,
                skipped_sources = status.last_result.skipped_sources.len(),
                error = %status.last_error,
                "cloud backup tick finished with problems"
            );
        }
    }
    write_status(&conn, &status);
    was_failing == status.last_error.is_empty()
}

/// Reject `kind: folder` unless the path is inside an adopted drive mount.
pub fn validate_backup_sources(
    sources: Vec<Value>,
    drives: &[DriveRow],
) -> Result<Vec<Value>, ConnectError> {
    let mut out = Vec::new();
    for source in sources {
        let kind = source
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match kind.as_str() {
            "drive" => {
                let id = source
                    .get("drive_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if id.is_empty() || !drives.iter().any(|d| d.id == id) {
                    return Err(ConnectError::Other(
                        "Pick one of your Luna drives to copy to the cloud.".into(),
                    ));
                }
                out.push(source);
            }
            "folder" => {
                let path = source.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path.is_empty() || !folder_under_adopted_mount(Path::new(path), drives) {
                    return Err(ConnectError::Other(
                        "Luna can only copy folders that are already on one of your Luna drives. Pick a folder inside a drive Luna knows."
                            .into(),
                    ));
                }
                out.push(source);
            }
            _ => {
                return Err(ConnectError::Other(
                    "Luna didn't understand that backup choice.".into(),
                ));
            }
        }
    }
    Ok(out)
}

pub fn folder_under_adopted_mount(path: &Path, drives: &[DriveRow]) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    drives.iter().any(|d| {
        if d.mount_point.is_empty() {
            return false;
        }
        let Ok(root) = Path::new(&d.mount_point).canonicalize() else {
            return false;
        };
        canon.starts_with(&root)
    })
}

/// A folder backed up without its drive's database needs a manifest to put
/// names back on its private items.
fn put_private_manifest(
    connect: &ConnectService,
    folder: &Path,
    drives: &[DriveRow],
    stats: &mut TickStats,
) {
    let Ok(canon) = folder.canonicalize() else {
        return;
    };
    for d in drives {
        let Ok(root) = Path::new(&d.mount_point).canonicalize() else {
            continue;
        };
        let Ok(rel) = canon.strip_prefix(&root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if let (Some(name), Some(json)) = (
            crate::private::manifest_name(&root),
            crate::private::manifest_json(&root, &rel),
        ) {
            match connect.put_backup_object(&name, json.as_bytes()) {
                Ok(()) => stats.result.uploaded += 1,
                Err(e) => stats.fail(&e),
            }
        }
        return;
    }
}

/// Sync one source tree. `source_key` identifies the source in the
/// `backup_manifest` table; `prefix` (a drive label) namespaces object keys.
fn sync_tree(
    connect: &ConnectService,
    db: &crate::Db,
    source_key: &str,
    root: &Path,
    prefix: &str,
    budget: &mut Budget,
    stats: &mut TickStats,
) {
    let manifest: HashMap<String, (u64, i64)> = db
        .lock()
        .ok()
        .and_then(|conn| db::backup_manifest(&conn, source_key).ok())
        .unwrap_or_default();
    for_each_regular_file(root, budget, &mut |path, meta| {
        let Ok(rel) = path.strip_prefix(root) else {
            return None;
        };
        let rel_s = if prefix.is_empty() {
            rel.to_string_lossy().replace('\\', "/")
        } else {
            format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
        };
        let size = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // size+mtime match means the object in the cloud is already current.
        if manifest.get(&rel_s) == Some(&(size, mtime)) {
            stats.result.unchanged += 1;
            return None;
        }
        if size > MAX_OBJECT_BYTES {
            stats.result.skipped_too_large += 1;
            tracing::warn!(path = %path.display(), size, "cloud backup skipping oversized file");
            return None;
        }
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(e) => {
                stats.unreadable(path);
                tracing::warn!(path = %path.display(), error = %e, "cloud backup file open failed");
                return Some(0);
            }
        };
        match connect.put_backup_object(&rel_s, &file) {
            Ok(()) => {
                stats.result.uploaded += 1;
                stats.result.bytes += size;
                if let Ok(conn) = db.lock() {
                    let _ = db::backup_manifest_put(&conn, source_key, &rel_s, size, mtime);
                }
                Some(size)
            }
            Err(e) => {
                stats.fail(&e);
                tracing::warn!(key = %rel_s, error = %e, "cloud backup upload failed");
                Some(0)
            }
        }
    });
}

/// Walk a tree without following directory or file symlinks. The visitor
/// returns `Some(bytes)` when it tried an upload — only those count against
/// the file budget, so unchanged files never crowd out later ones — and
/// `None` when there was nothing to send. Files that don't fit the remaining
/// byte budget are skipped so smaller later files can still go up.
fn for_each_regular_file(
    dir: &Path,
    budget: &mut Budget,
    visit: &mut dyn FnMut(&Path, &std::fs::Metadata) -> Option<u64>,
) {
    if budget.exhausted() {
        budget.cut_short = true;
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        if budget.exhausted() {
            budget.cut_short = true;
            return;
        }
        let path = ent.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            for_each_regular_file(&path, budget, visit);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if meta.len() > budget.bytes {
            // Files over the per-object ceiling are never sent; anything
            // else waits for a tick with room.
            if meta.len() <= MAX_OBJECT_BYTES {
                budget.cut_short = true;
            }
            continue;
        }
        if let Some(spent) = visit(&path, &meta) {
            budget.files = budget.files.saturating_sub(1);
            budget.bytes = budget.bytes.saturating_sub(spent);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::db;
    use crate::net::connect::is_idle;

    use super::*;

    #[test]
    fn tick_skips_when_busy() {
        assert!(!is_idle(50, 60));
    }

    /// A linked Luna with these backup settings. Connect itself is never
    /// reached: the tests stop before any upload.
    fn linked(dir: &Path, unlocked: bool, sources: Value) -> ConnectService {
        let svc = ConnectService::new(dir, Some("http://127.0.0.1:9".into()));
        svc.set_oss_code("ABCD-EFGH-JKMN-PQRS-TVWX").unwrap();
        svc.save(&serde_json::json!({
            "backup_unlocked": unlocked,
            "backup_sources": sources,
        }))
        .unwrap();
        svc
    }

    fn test_db(dir: &Path) -> crate::Db {
        crate::Db::new(db::open(&dir.join("luna.db")).unwrap())
    }

    #[test]
    fn locked_backup_with_sources_is_a_hard_problem() {
        let dir = tempfile::tempdir().unwrap();
        let svc = linked(
            dir.path(),
            false,
            serde_json::json!([{"kind": "drive", "drive_id": "d1"}]),
        );
        let db = test_db(dir.path());
        assert!(tick(&svc, 0, 1_000, &db), "healthy → failing is a change");
        let status = read_status(&db.lock().unwrap()).unwrap();
        assert!(status.hard);
        assert!(status.last_error.contains("no payment card"));
        assert_eq!(
            status.state(1_000),
            super::super::status::BackupState::Failing
        );
    }

    #[test]
    fn unplugged_source_drive_is_recorded_not_skipped_silently() {
        let dir = tempfile::tempdir().unwrap();
        let svc = linked(
            dir.path(),
            true,
            serde_json::json!([{"kind": "drive", "drive_id": "d1"}]),
        );
        let db = test_db(dir.path());
        db::upsert_drive(
            &db.lock().unwrap(),
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            "",
        )
        .unwrap();
        tick(&svc, 0, 1_000, &db);
        let status = read_status(&db.lock().unwrap()).unwrap();
        assert_eq!(
            status.last_error,
            "Luna can't find the drive Photos, so it wasn't copied to the cloud."
        );
        assert!(status.hard);
        assert_eq!(status.last_ok_at, 0, "a skipped source is not a success");
        assert_eq!(
            status.last_result.skipped_sources,
            vec!["Photos".to_string()]
        );
    }

    #[test]
    fn a_clean_run_clears_a_failure_and_keeps_the_streak_start_until_then() {
        let dir = tempfile::tempdir().unwrap();
        let db = test_db(dir.path());
        let mut blip = TickStats::default();
        blip.fail(&ConnectError::Unreachable);
        assert!(record_run(&db, 100, blip));
        let mut again = TickStats::default();
        again.fail(&ConnectError::Unreachable);
        assert!(!record_run(&db, 220, again), "still failing is no change");
        let status = read_status(&db.lock().unwrap()).unwrap();
        assert_eq!(status.failing_since, 100);
        assert!(!status.hard, "Connect being unreachable may fix itself");

        assert!(record_run(&db, 340, TickStats::default()));
        let status = read_status(&db.lock().unwrap()).unwrap();
        assert_eq!(status.last_error, "");
        assert_eq!(status.failing_since, 0);
        assert_eq!(status.last_ok_at, 340);
    }

    #[test]
    fn a_run_cut_short_is_progress_not_a_finish() {
        let dir = tempfile::tempdir().unwrap();
        let db = test_db(dir.path());
        let mut partway = TickStats::default();
        partway.result.incomplete = true;
        record_run(&db, 500, partway);
        let status = read_status(&db.lock().unwrap()).unwrap();
        assert_eq!(status.last_ok_at, 0);
        assert_eq!(status.last_progress_at, 500);
        assert_eq!(
            status.state(500 + super::super::status::STALE_SECS - 60),
            super::super::status::BackupState::Ok,
            "moving along is not stale"
        );
    }

    #[test]
    fn unreadable_files_are_named() {
        let mut stats = TickStats::default();
        stats.unreadable(Path::new("/mnt/a/IMG_0042.jpg"));
        stats.unreadable(Path::new("/mnt/a/IMG_0043.jpg"));
        stats.unreadable(Path::new("/mnt/a/IMG_0044.jpg"));
        stats.finish();
        assert_eq!(
            stats.last_error.as_deref(),
            Some(
                "Luna couldn't read IMG_0042.jpg and 2 other files, so they weren't copied to the cloud."
            )
        );
        assert!(stats.hard);
    }

    #[test]
    fn unchanged_files_do_not_use_up_the_file_budget() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}")), b"x").unwrap();
        }
        let mut budget = Budget::new(1, 1_000);
        let mut seen = 0;
        for_each_regular_file(dir.path(), &mut budget, &mut |_, _| {
            seen += 1;
            None
        });
        assert_eq!(seen, 5, "nothing to send never ends the walk");
        assert!(!budget.cut_short);

        let mut budget = Budget::new(2, 1_000);
        for_each_regular_file(dir.path(), &mut budget, &mut |_, _| Some(1));
        assert!(budget.cut_short, "files were left for the next tick");
    }

    #[test]
    fn a_hard_problem_wins_over_a_soft_one_in_the_same_run() {
        let mut stats = TickStats::default();
        stats.fail(&ConnectError::Unreachable);
        stats.fail(&ConnectError::Other(
            "Cloud backup for this account is full.".into(),
        ));
        stats.fail(&ConnectError::Unreachable);
        assert!(stats.hard);
        assert_eq!(
            stats.last_error.as_deref(),
            Some("Cloud backup for this account is full.")
        );
    }

    #[test]
    fn turning_backup_on_starts_a_fresh_record_but_editing_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = test_db(dir.path());
        let conn = db.lock().unwrap();
        note_sources_saved(&conn, false, 50);
        assert_eq!(read_status(&conn).unwrap().since, 50);
        let mut failing = read_status(&conn).unwrap();
        failing.last_error = "Drive missing.".into();
        write_status(&conn, &failing);
        note_sources_saved(&conn, true, 90);
        assert_eq!(read_status(&conn).unwrap().last_error, "Drive missing.");
    }

    #[test]
    fn folder_outside_mount_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let mount = dir.path().join("drive");
        std::fs::create_dir_all(&mount).unwrap();
        db::upsert_drive(
            &conn,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        let drives = db::list_drives(&conn).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let album = mount.join("album");
        std::fs::create_dir_all(&album).unwrap();
        let ok = vec![serde_json::json!({"kind":"folder","path": album.to_str()})];
        assert!(validate_backup_sources(ok, &drives).is_ok());
        let bad = vec![serde_json::json!({"kind":"folder","path": outside.to_str()})];
        assert!(validate_backup_sources(bad, &drives).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn walker_skips_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        symlink(&outside, root.join("link")).unwrap();
        let mut budget = Budget::new(100, 1_000);
        let mut files = Vec::new();
        for_each_regular_file(&root, &mut budget, &mut |p, _| {
            files.push(p.to_path_buf());
            Some(0)
        });
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("keep.txt"));
    }

    #[test]
    fn walker_stops_at_file_and_byte_budgets() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("f{i}")), b"x").unwrap();
        }
        let mut files = Vec::new();
        for_each_regular_file(dir.path(), &mut Budget::new(3, 1_000), &mut |p, _| {
            files.push(p.to_path_buf());
            Some(0)
        });
        assert_eq!(files.len(), 3);
        files.clear();
        for_each_regular_file(dir.path(), &mut Budget::new(100, 0), &mut |p, _| {
            files.push(p.to_path_buf());
            Some(0)
        });
        assert!(files.is_empty());
        // Bytes the visitor spends drain the budget and end the walk.
        for_each_regular_file(dir.path(), &mut Budget::new(100, 2), &mut |p, _| {
            files.push(p.to_path_buf());
            Some(1)
        });
        assert_eq!(files.len(), 2);
        // A file bigger than the remaining budget is skipped, not walked.
        files.clear();
        let big = dir.path().join("big");
        std::fs::write(&big, vec![0u8; 16]).unwrap();
        for_each_regular_file(dir.path(), &mut Budget::new(100, 2), &mut |p, _| {
            files.push(p.to_path_buf());
            Some(0)
        });
        assert_eq!(files.len(), 5);
        assert!(
            files.iter().all(|p| !p.ends_with("big")),
            "a file over the byte budget must be skipped"
        );
    }

    #[test]
    fn manifest_rows_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        assert!(db::backup_manifest(&conn, "drive:d1").unwrap().is_empty());
        db::backup_manifest_put(&conn, "drive:d1", "Photos/a.jpg", 42, 1000).unwrap();
        db::backup_manifest_put(&conn, "drive:d2", "Photos/a.jpg", 99, 2000).unwrap();
        let m = db::backup_manifest(&conn, "drive:d1").unwrap();
        assert_eq!(m.get("Photos/a.jpg"), Some(&(42, 1000)));
        // Re-upload of a changed file overwrites the row.
        db::backup_manifest_put(&conn, "drive:d1", "Photos/a.jpg", 50, 3000).unwrap();
        let m = db::backup_manifest(&conn, "drive:d1").unwrap();
        assert_eq!(m.get("Photos/a.jpg"), Some(&(50, 3000)));
    }
}
