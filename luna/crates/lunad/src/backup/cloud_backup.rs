//! Idle spare-copy sync to Luna Connect (latest file only).

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};

use crate::db::{self, DriveRow};
use crate::net::connect::{self, ConnectError, ConnectService};

const MAX_FILES_PER_TICK: u64 = 50_000;
/// Per-tick upload budget — idle ticks trickle, they don't drain a drive.
const MAX_BYTES_PER_TICK: u64 = 4 * 1024 * 1024 * 1024;
/// One object's ceiling: bodies stream from disk, so RAM isn't the limit —
/// a multi-GiB file still stalls a slow uplink for hours. Skipped (logged),
/// not retried forever.
const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Counts and the last failure for one tick, persisted in the meta table so
/// a status surface can answer "did the last cloud backup run work?".
#[derive(Default)]
struct TickStats {
    uploaded: u64,
    failed: u64,
    unchanged: u64,
    too_large: u64,
    bytes: u64,
    last_error: Option<String>,
}

impl TickStats {
    fn fail(&mut self, err: &ConnectError) {
        self.failed += 1;
        self.last_error = Some(err.to_string());
    }
}

/// What one tick is allowed to do — file count AND bytes, so 50k tiny files
/// and one giant one are both bounded.
struct Budget {
    files: u64,
    bytes: u64,
}

impl Budget {
    fn exhausted(&self) -> bool {
        self.files == 0 || self.bytes == 0
    }
}

pub fn tick(connect: &ConnectService, last_io_unix: i64, now_unix: i64, db: &crate::Db) {
    if !connect.is_connect_active() {
        return;
    }
    if !connect::is_idle(last_io_unix, now_unix) {
        return;
    }
    if !connect.backup_unlocked() {
        return;
    }
    let (drives, sources) = {
        let Ok(conn) = db.lock() else {
            return;
        };
        (
            db::list_drives(&conn).unwrap_or_default(),
            connect.backup_sources(),
        )
    };
    let mut stats = TickStats::default();
    let mut budget = Budget {
        files: MAX_FILES_PER_TICK,
        bytes: MAX_BYTES_PER_TICK,
    };
    for source in sources {
        if budget.exhausted() {
            break;
        }
        let kind = source.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "folder" => {
                if let Some(path) = source.get("path").and_then(|v| v.as_str()) {
                    if !folder_under_adopted_mount(Path::new(path), &drives) {
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
                    let mount = drives
                        .iter()
                        .find(|d| d.id == id)
                        .map(|d| d.mount_point.clone())
                        .unwrap_or_default();
                    let label = drives
                        .iter()
                        .find(|d| d.id == id)
                        .map(|d| d.label.clone())
                        .unwrap_or_default();
                    if mount.is_empty() {
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
    record_run(db, now_unix, &stats);
}

/// Persist the tick's outcome — same meta-table pattern as the scrub/trim
/// stamps, so a status surface can report it later.
fn record_run(db: &crate::Db, now_unix: i64, stats: &TickStats) {
    let Ok(conn) = db.lock() else {
        return;
    };
    let _ = db::set_meta(&conn, "cloud_backup_last_run_at", &now_unix.to_string());
    let _ = db::set_meta(
        &conn,
        "cloud_backup_last_result",
        &json!({
            "uploaded": stats.uploaded,
            "failed": stats.failed,
            "bytes": stats.bytes,
            "unchanged": stats.unchanged,
            "skipped_too_large": stats.too_large,
        })
        .to_string(),
    );
    // ConnectError messages are already written for users.
    let _ = db::set_meta(
        &conn,
        "cloud_backup_last_error",
        stats.last_error.as_deref().unwrap_or(""),
    );
    if stats.failed > 0 {
        tracing::warn!(
            failed = stats.failed,
            uploaded = stats.uploaded,
            "cloud backup tick finished with failures"
        );
    }
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
                Ok(()) => stats.uploaded += 1,
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
            return 0;
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
            stats.unchanged += 1;
            return 0;
        }
        if size > MAX_OBJECT_BYTES {
            stats.too_large += 1;
            tracing::warn!(path = %path.display(), size, "cloud backup skipping oversized file");
            return 0;
        }
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(e) => {
                stats.failed += 1;
                stats.last_error =
                    Some("Luna couldn't read a file for cloud backup. It will try again.".into());
                tracing::warn!(path = %path.display(), error = %e, "cloud backup file open failed");
                return 0;
            }
        };
        match connect.put_backup_object(&rel_s, &file) {
            Ok(()) => {
                stats.uploaded += 1;
                stats.bytes += size;
                if let Ok(conn) = db.lock() {
                    let _ = db::backup_manifest_put(&conn, source_key, &rel_s, size, mtime);
                }
                size
            }
            Err(e) => {
                stats.fail(&e);
                tracing::warn!(key = %rel_s, error = %e, "cloud backup upload failed");
                0
            }
        }
    });
}

/// Walk a tree without following directory or file symlinks. The visitor
/// returns the bytes it consumed; files that don't fit the remaining byte
/// budget are skipped so smaller later files can still go up.
fn for_each_regular_file(
    dir: &Path,
    budget: &mut Budget,
    visit: &mut dyn FnMut(&Path, &std::fs::Metadata) -> u64,
) {
    if budget.exhausted() {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        if budget.exhausted() {
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
        if !meta.is_file() || meta.len() > budget.bytes {
            continue;
        }
        budget.files = budget.files.saturating_sub(1);
        let spent = visit(&path, &meta);
        budget.bytes = budget.bytes.saturating_sub(spent);
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
        let mut budget = Budget {
            files: 100,
            bytes: 1_000,
        };
        let mut files = Vec::new();
        for_each_regular_file(&root, &mut budget, &mut |p, _| {
            files.push(p.to_path_buf());
            0
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
        for_each_regular_file(
            dir.path(),
            &mut Budget {
                files: 3,
                bytes: 1_000,
            },
            &mut |p, _| {
                files.push(p.to_path_buf());
                0
            },
        );
        assert_eq!(files.len(), 3);
        files.clear();
        for_each_regular_file(
            dir.path(),
            &mut Budget {
                files: 100,
                bytes: 0,
            },
            &mut |p, _| {
                files.push(p.to_path_buf());
                0
            },
        );
        assert!(files.is_empty());
        // Bytes the visitor spends drain the budget and end the walk.
        for_each_regular_file(
            dir.path(),
            &mut Budget {
                files: 100,
                bytes: 2,
            },
            &mut |p, _| {
                files.push(p.to_path_buf());
                1
            },
        );
        assert_eq!(files.len(), 2);
        // A file bigger than the remaining budget is skipped, not walked.
        files.clear();
        let big = dir.path().join("big");
        std::fs::write(&big, vec![0u8; 16]).unwrap();
        for_each_regular_file(
            dir.path(),
            &mut Budget {
                files: 100,
                bytes: 2,
            },
            &mut |p, _| {
                files.push(p.to_path_buf());
                0
            },
        );
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
