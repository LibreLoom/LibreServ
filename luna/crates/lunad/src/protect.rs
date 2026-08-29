//! Protect-a-folder: a local, free second copy on another Luna drive.
//!
//! Copies are append-only syncs — deleting a file from the source never
//! deletes the protected copy, because this feature exists to survive
//! accidents, not to mirror them.
//!
//! Layout on the **target** drive root:
//! `<drive-root>/.lunaprotected/<source-drive-id>/<source-path>/...`

use std::io::{Read, Write};
use std::path::Path;

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, ProtectionRow};
use crate::files;

/// Directory name at the target drive root that holds protected copies.
pub const PROTECTED_DIR: &str = ".lunaprotected";

/// True when `rel` is the protected-copy store (or a path inside it).
pub fn is_protected_store(rel: &str) -> bool {
    rel == PROTECTED_DIR || rel.starts_with(&format!("{PROTECTED_DIR}/"))
}

/// Relative path under the target drive for a protected copy of
/// `(source_drive, source_path)`.
pub fn target_rel_path(source_drive: &str, source_path: &str) -> String {
    let source_path = source_path.trim_matches('/');
    if source_path.is_empty() {
        format!("{PROTECTED_DIR}/{source_drive}")
    } else {
        format!("{PROTECTED_DIR}/{source_drive}/{source_path}")
    }
}

pub fn create(
    conn: &Connection,
    source_drive: &str,
    source_path: &str,
    target_drive: &str,
) -> anyhow::Result<ProtectionRow> {
    if source_drive == target_drive {
        anyhow::bail!("Choose a different drive for the protected copy.");
    }
    let (_src, src_meta) = files::resolve_any(conn, source_drive, source_path)?;
    if !src_meta.is_dir() {
        anyhow::bail!("Protect a folder, not a single file.");
    }
    let _ = files::dest_dir(conn, target_drive, "")?;
    let target_path = target_rel_path(source_drive, source_path);
    let id = Uuid::new_v4().to_string();
    db::insert_protection(
        conn,
        &id,
        source_drive,
        source_path,
        target_drive,
        &target_path,
    )?;
    db::get_protection(conn, &id)?.ok_or_else(|| anyhow::anyhow!("protection not found"))
}

pub fn sync_all(db: &std::sync::Mutex<Connection>) -> anyhow::Result<u64> {
    let rows = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        db::list_protections(&conn)?
    };
    let mut copied = 0;
    for row in rows {
        // Resolve paths under a short lock, then copy without holding it.
        let (src_root, target_root) = {
            let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
            let (src_root, src_meta) =
                files::resolve_any(&conn, &row.source_drive, &row.source_path)?;
            if !src_meta.is_dir() {
                continue;
            }
            let drive = files::drive_root(&conn, &row.target_drive)?;
            let root = std::path::PathBuf::from(&drive.mount_point);
            let target_root = luna_core::path::resolve_for_create_nofollow(&root, &row.target_path)
                .map_err(|e| {
                    anyhow::anyhow!("Luna couldn't open the protected-copy folder: {e}")
                })?;
            (src_root, target_root)
        };
        match sync_trees(&src_root, &target_root) {
            Ok(n) => {
                copied += n;
                if let Ok(conn) = db.lock() {
                    let _ = db::touch_protection(&conn, &row.id);
                }
            }
            Err(_) => continue,
        }
    }
    Ok(copied)
}

fn sync_trees(src_root: &Path, target_root: &Path) -> anyhow::Result<u64> {
    let mut copied = 0u64;
    let mut stack = vec![(src_root.to_path_buf(), target_root.to_path_buf())];
    while let Some((src_dir, dst_dir)) = stack.pop() {
        std::fs::create_dir_all(&dst_dir)?;
        for entry in std::fs::read_dir(&src_dir)? {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if meta.is_dir() {
                stack.push((entry.path(), dst_dir.join(&name)));
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let dest = dst_dir.join(&name);
            if is_current(&dest, &meta) {
                continue;
            }
            copy_atomic(&entry.path(), &dest)?;
            copied += 1;
        }
    }
    Ok(copied)
}

pub fn sync(conn: &Connection, row: &ProtectionRow) -> anyhow::Result<u64> {
    let (src_root, src_meta) = files::resolve_any(conn, &row.source_drive, &row.source_path)?;
    if !src_meta.is_dir() {
        anyhow::bail!("The protected folder is missing.");
    }
    let target_root = {
        let drive = files::drive_root(conn, &row.target_drive)?;
        let root = std::path::PathBuf::from(&drive.mount_point);
        luna_core::path::resolve_for_create_nofollow(&root, &row.target_path)
            .map_err(|e| anyhow::anyhow!("Luna couldn't open the protected-copy folder: {e}"))?
    };
    let copied = sync_trees(&src_root, &target_root)?;
    db::touch_protection(conn, &row.id)?;
    Ok(copied)
}

fn is_current(dest: &Path, src_meta: &std::fs::Metadata) -> bool {
    let Ok(dest_meta) = std::fs::metadata(dest) else {
        return false;
    };
    if dest_meta.len() != src_meta.len() {
        return false;
    }
    let src_mtime = mtime(src_meta);
    let dest_mtime = dest_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    src_mtime == dest_mtime
}

fn mtime(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn copy_atomic(src: &Path, dest: &Path) -> anyhow::Result<()> {
    let mut input = std::fs::File::open(src)?;
    let tmp = {
        let mut s = dest.as_os_str().to_owned();
        s.push(".part");
        std::path::PathBuf::from(s)
    };
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n])?;
    }
    output.flush()?;
    output.sync_all()?;
    drop(output);
    std::fs::rename(&tmp, dest)?;
    if let Some(parent) = dest.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        for (id, name) in [("a", "A"), ("b", "B")] {
            let root = dir.path().join(name);
            std::fs::create_dir_all(&root).unwrap();
            db::upsert_drive(&conn, id, name, "as_is", "ext4", id, root.to_str().unwrap()).unwrap();
        }
        (dir, conn)
    }

    #[test]
    fn target_path_lives_under_lunaprotected_on_drive_root() {
        assert_eq!(
            target_rel_path("drv-a", "family/photos"),
            ".lunaprotected/drv-a/family/photos"
        );
        assert_eq!(
            target_rel_path("drv-a", "family"),
            ".lunaprotected/drv-a/family"
        );
        assert_eq!(
            target_rel_path("drv-a", "/family/"),
            ".lunaprotected/drv-a/family"
        );
        assert_eq!(target_rel_path("drv-a", ""), ".lunaprotected/drv-a");
        assert!(is_protected_store(".lunaprotected"));
        assert!(is_protected_store(".lunaprotected/drv-a/family"));
        assert!(!is_protected_store("family"));
        assert!(!is_protected_store(".luna-trash"));
    }

    #[test]
    fn protects_folder_and_keeps_deleted_files() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        std::fs::write(format!("{src}/family/photo.txt"), b"original").unwrap();

        let row = create(&conn, "a", "family", "b").unwrap();
        assert_eq!(
            row.target_path, ".lunaprotected/a/family",
            "protected copies must live under .lunaprotected on the target drive"
        );
        assert_eq!(sync(&conn, &row).unwrap(), 1);

        let dst = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        let on_disk = Path::new(&dst).join(&row.target_path).join("photo.txt");
        assert!(
            on_disk.starts_with(Path::new(&dst).join(PROTECTED_DIR)),
            "synced file must be under <drive-root>/.lunaprotected/"
        );
        assert_eq!(std::fs::read(&on_disk).unwrap(), b"original");

        std::fs::write(format!("{src}/family/photo.txt"), b"changed").unwrap();
        assert_eq!(sync(&conn, &row).unwrap(), 1);

        std::fs::remove_file(format!("{src}/family/photo.txt")).unwrap();
        assert_eq!(
            sync(&conn, &row).unwrap(),
            0,
            "append-only protection never deletes"
        );
        assert!(on_disk.exists());
    }

    #[cfg(unix)]
    #[test]
    fn dest_symlink_is_refused() {
        use std::os::unix::fs::symlink;
        let (dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        std::fs::write(format!("{src}/family/photo.txt"), b"x").unwrap();
        let row = create(&conn, "a", "family", "b").unwrap();
        let dst = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let dest = std::path::Path::new(&dst).join(&row.target_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dest);
        symlink(&outside, &dest).unwrap();
        assert!(sync(&conn, &row).is_err());
    }
}
