//! Idle spare-copy sync to Luna Connect (latest file only).

use std::path::{Path, PathBuf};

use crate::connect::{self, ConnectService};
use crate::db;

pub fn tick(connect: &ConnectService, last_io_unix: i64, now_unix: i64, db: &rusqlite::Connection) {
    if !connect::is_idle(last_io_unix, now_unix) {
        return;
    }
    if !connect.backup_unlocked() {
        return;
    }
    for source in connect.backup_sources() {
        let kind = source.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "folder" => {
                if let Some(path) = source.get("path").and_then(|v| v.as_str()) {
                    sync_tree(connect, Path::new(path), "");
                }
            }
            "drive" => {
                if let Some(id) = source.get("drive_id").and_then(|v| v.as_str()) {
                    if let Ok(Some(drive)) = db::get_drive(db, id) {
                        if !drive.mount_point.is_empty() {
                            let prefix = drive.label.replace('/', "_");
                            sync_tree(connect, Path::new(&drive.mount_point), &prefix);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn sync_tree(connect: &ConnectService, root: &Path, prefix: &str) {
    let walker = walkdir_or_read(root);
    for path in walker {
        if !path.is_file() {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_s = if prefix.is_empty() {
            rel.to_string_lossy().replace('\\', "/")
        } else {
            format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
        };
        if let Ok(bytes) = std::fs::read(&path) {
            let _ = connect.put_backup_object(&rel_s, &bytes);
        }
    }
}

fn walkdir_or_read(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                rec(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    if root.is_file() {
        out.push(root.to_path_buf());
    } else {
        rec(root, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::connect::is_idle;

    #[test]
    fn tick_skips_when_busy() {
        assert!(!is_idle(50, 60));
    }
}
