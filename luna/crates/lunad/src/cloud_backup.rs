//! Idle spare-copy sync to Luna Connect (latest file only).

use std::path::Path;

use serde_json::Value;

use crate::connect::{self, ConnectError, ConnectService};
use crate::db::{self, DriveRow};

const MAX_FILES_PER_TICK: u64 = 50_000;

pub fn tick(
    connect: &ConnectService,
    last_io_unix: i64,
    now_unix: i64,
    db: &std::sync::Mutex<rusqlite::Connection>,
) {
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
    for source in sources {
        let kind = source.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "folder" => {
                if let Some(path) = source.get("path").and_then(|v| v.as_str()) {
                    if !folder_under_adopted_mount(Path::new(path), &drives) {
                        continue;
                    }
                    sync_tree(connect, Path::new(path), "");
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
                    sync_tree(connect, Path::new(&mount), &prefix);
                }
            }
            _ => {}
        }
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

fn sync_tree(connect: &ConnectService, root: &Path, prefix: &str) {
    let mut remaining = MAX_FILES_PER_TICK;
    walk_and_put(connect, root, root, prefix, &mut remaining);
}

fn walk_and_put(
    connect: &ConnectService,
    root: &Path,
    dir: &Path,
    prefix: &str,
    remaining: &mut u64,
) {
    for_each_regular_file(dir, remaining, &mut |path| {
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => return,
        };
        let rel_s = if prefix.is_empty() {
            rel.to_string_lossy().replace('\\', "/")
        } else {
            format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
        };
        if let Ok(bytes) = std::fs::read(path) {
            let _ = connect.put_backup_object(&rel_s, &bytes);
        }
    });
}

/// Walk a tree without following directory or file symlinks.
fn for_each_regular_file(dir: &Path, remaining: &mut u64, visit: &mut dyn FnMut(&Path)) {
    if *remaining == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        if *remaining == 0 {
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
            for_each_regular_file(&path, remaining, visit);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        *remaining -= 1;
        visit(&path);
    }
}

#[cfg(test)]
mod tests {
    use crate::connect::is_idle;
    use crate::db;

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
        let mut remaining = 100u64;
        let mut files = Vec::new();
        for_each_regular_file(&root, &mut remaining, &mut |p| files.push(p.to_path_buf()));
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("keep.txt"));
    }
}
