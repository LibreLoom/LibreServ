//! Protect-a-folder: a local, free second copy on another Luna drive.
//!
//! Copies are append-only syncs — deleting a file from the source never
//! deletes the protected copy, because this feature exists to survive
//! accidents, not to mirror them.
//!
//! Layout on the **target** drive root:
//! `<drive-root>/.luna-<uuid>-protected/<source-drive-id>/<source-path>/...`
//! where `<uuid>` is the target drive's own marker prefix.

use std::io::{Read, Write};
use std::path::Path;

use rusqlite::Connection;
use uuid::Uuid;

use crate::db::{self, ProtectionRow};
use crate::drives::layout::Layout;
use crate::files;

/// True when `rel` is the protected-copy store (or a path inside it) — any
/// drive's `{prefix}-protected` root or a path under it.
pub fn is_protected_store(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    luna_core::marker::extract_prefix(first).is_some_and(|p| first == format!("{p}-protected"))
}

/// Relative path under the target drive for a protected copy of
/// `(source_drive, source_path)`, inside the target's `{prefix}-protected`.
pub fn target_rel_path(target: &Layout, source_drive: &str, source_path: &str) -> String {
    let source_path = source_path.trim_matches('/');
    let dir = target.protected_name();
    if source_path.is_empty() {
        format!("{dir}/{source_drive}")
    } else {
        format!("{dir}/{source_drive}/{source_path}")
    }
}

/// Turn a filesystem-lookup failure into user-facing text: keep the two
/// [`files::FilesError`] variants that already read like sentences a person
/// can act on, and fall back to `generic` for everything else (a raw
/// `io::Error`/`PathError`/db message is never fit to show as-is).
fn keep_known_or(e: files::FilesError, generic: &str) -> anyhow::Error {
    match e {
        files::FilesError::UnknownDrive | files::FilesError::MissingDriveDb => {
            anyhow::Error::new(e)
        }
        _ => anyhow::anyhow!("{generic}"),
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
    let source_path = source_path.trim_matches('/');
    let already = db::list_protections(conn)
        .map_err(|_| {
            anyhow::anyhow!("Luna couldn't check your existing protected folders. Try again.")
        })?
        .into_iter()
        .any(|p| {
            p.source_drive == source_drive
                && p.source_path.trim_matches('/') == source_path
                && p.target_drive == target_drive
        });
    if already {
        anyhow::bail!("This folder is already copying onto that drive.");
    }
    let (_src, src_meta) = files::resolve_any(conn, source_drive, source_path)
        .map_err(|e| keep_known_or(e, "Luna couldn't find that folder to protect."))?;
    if !src_meta.is_dir() {
        anyhow::bail!("Protect a folder, not a single file.");
    }
    let _ = files::dest_dir(conn, target_drive, "")
        .map_err(|e| keep_known_or(e, "Luna couldn't set up the protected copy on that drive."))?;
    let target = {
        let drive = files::drive_root(conn, target_drive).map_err(|e| {
            keep_known_or(e, "Luna couldn't set up the protected copy on that drive.")
        })?;
        Layout::detect(Path::new(&drive.mount_point)).ok_or_else(|| {
            anyhow::anyhow!("Luna couldn't set up the protected copy on that drive.")
        })?
    };
    let target_path = target_rel_path(&target, source_drive, source_path);
    let id = Uuid::new_v4().to_string();
    db::insert_protection(
        conn,
        &id,
        source_drive,
        source_path,
        target_drive,
        &target_path,
    )
    .map_err(|_| anyhow::anyhow!("Luna couldn't save that protected folder. Try again."))?;
    db::get_protection(conn, &id)
        .map_err(|_| anyhow::anyhow!("Luna couldn't confirm that protected folder. Try again."))?
        .ok_or_else(|| anyhow::anyhow!("Luna couldn't confirm that protected folder. Try again."))
}

/// What one pass over the protected folders changed.
#[derive(Debug, Default)]
pub struct SyncAllOutcome {
    pub copied: u64,
    /// A folder went from working to failing or back — the health checks
    /// should be recomputed.
    pub state_changed: bool,
}

/// Copy every protected folder. One folder failing never stops the others;
/// each records its own result on its row.
pub fn sync_all(db: &crate::Db) -> anyhow::Result<SyncAllOutcome> {
    let rows = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        db::list_protections(&conn)?
    };
    let mut outcome = SyncAllOutcome::default();
    for row in rows {
        let was_failing = !row.last_error.is_empty();
        let result = run_one(db, &row);
        outcome.copied += result.as_ref().copied().unwrap_or(0);
        outcome.state_changed |= was_failing != result.is_err();
    }
    Ok(outcome)
}

/// Copy one protected folder and record the result on its row. Paths
/// resolve under a short lock; the copy runs without holding it. The error
/// is a sentence for an Admin.
pub fn run_one(db: &crate::Db, row: &ProtectionRow) -> Result<u64, String> {
    let resolved = {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        resolve(&conn, row)
    };
    let result = resolved.and_then(|(names, src, target)| copy(row, &names, &src, &target));
    if let Err(msg) = &result {
        tracing::warn!(protection = %row.id, error = %msg, "protected copy failed");
    }
    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
    record(&conn, row, &result);
    result
}

/// Whether this protected folder needs an Admin's attention. Every protect
/// failure is one that won't fix itself (a drive, folder, or file problem).
pub fn state(row: &ProtectionRow, now: i64) -> super::status::BackupState {
    super::status::state(
        super::status::Record {
            last_ok_at: row.last_ok_at,
            failing_since: row.failing_since,
            last_error: &row.last_error,
            hard: true,
            since: row.created_at,
        },
        now,
    )
}

/// [`run_one`] on a connection the caller already holds.
pub fn sync(conn: &Connection, row: &ProtectionRow) -> Result<u64, String> {
    let result =
        resolve(conn, row).and_then(|(names, src, target)| copy(row, &names, &src, &target));
    record(conn, row, &result);
    result
}

fn record(conn: &Connection, row: &ProtectionRow, result: &Result<u64, String>) {
    let now = crate::db::now_unix();
    let _ = match result {
        Ok(_) => db::record_protection_ok(conn, &row.id, now),
        Err(msg) => db::record_protection_error(conn, &row.id, msg, now),
    };
}

/// The names a person knows this protection by, for messages.
pub struct Names {
    pub folder: String,
    pub source_drive: String,
    pub target_drive: String,
}

pub fn names(conn: &Connection, row: &ProtectionRow) -> Names {
    let label = |id: &str| {
        db::get_drive(conn, id)
            .ok()
            .flatten()
            .map(|d| d.label)
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| "a drive".into())
    };
    let source_drive = label(&row.source_drive);
    let folder = row
        .source_path
        .trim_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| source_drive.clone());
    Names {
        folder,
        source_drive,
        target_drive: label(&row.target_drive),
    }
}

fn resolve(
    conn: &Connection,
    row: &ProtectionRow,
) -> Result<(Names, std::path::PathBuf, std::path::PathBuf), String> {
    let names = names(conn, row);
    let Names {
        folder,
        source_drive,
        target_drive,
    } = &names;
    if files::drive_root(conn, &row.source_drive).is_err() {
        return Err(format!(
            "Luna can't find the drive {source_drive}, so {folder} wasn't copied."
        ));
    }
    let src_root = match files::resolve_any(conn, &row.source_drive, &row.source_path) {
        Ok((path, meta)) if meta.is_dir() => path,
        _ => {
            return Err(format!(
                "Luna can't find {folder} on {source_drive} anymore, so there was nothing to copy."
            ));
        }
    };
    let Ok(drive) = files::drive_root(conn, &row.target_drive) else {
        return Err(format!(
            "Luna can't find the drive {target_drive}, so {folder} wasn't copied."
        ));
    };
    let root = std::path::PathBuf::from(&drive.mount_point);
    let target_root = luna_core::path::resolve_for_create_nofollow(&root, &row.target_path)
        .map_err(|_| format!("Luna couldn't open the copy of {folder} on {target_drive}."))?;
    Ok((names, src_root, target_root))
}

fn copy(
    row: &ProtectionRow,
    names: &Names,
    src_root: &Path,
    target_root: &Path,
) -> Result<u64, String> {
    // The manifest goes down even when the copy stops partway: the
    // `.luna-` entries that did arrive are useless without their names.
    let stats = sync_trees(src_root, target_root);
    write_private_manifest(row, src_root, target_root);
    let Names {
        folder,
        target_drive,
        ..
    } = names;
    if let Some(err) = &stats.stopped {
        return Err(match err.kind() {
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => {
                format!("{target_drive} is full, so the copy of {folder} stopped.")
            }
            _ => format!("Luna can't save to {target_drive}, so the copy of {folder} stopped."),
        });
    }
    match stats.unreadable {
        0 => Ok(stats.copied),
        1 => Err(format!(
            "Luna couldn't read 1 file in {folder}, so it wasn't copied."
        )),
        n => Err(format!(
            "Luna couldn't read {n} files in {folder}, so they weren't copied."
        )),
    }
}

#[derive(Debug, Default)]
struct CopyStats {
    copied: u64,
    /// Source files or folders Luna couldn't read — skipped, the rest go on.
    unreadable: u64,
    /// The target refused a write (full, read-only, gone): nothing more
    /// can land there, so the pass stops.
    stopped: Option<std::io::Error>,
}

fn sync_trees(src_root: &Path, target_root: &Path) -> CopyStats {
    let mut stats = CopyStats::default();
    let mut stack = vec![(src_root.to_path_buf(), target_root.to_path_buf())];
    while let Some((src_dir, dst_dir)) = stack.pop() {
        if let Err(e) = std::fs::create_dir_all(&dst_dir) {
            stats.stopped = Some(e);
            return stats;
        }
        let Ok(entries) = std::fs::read_dir(&src_dir) else {
            stats.unreadable += 1;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                stats.unreadable += 1;
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                stats.unreadable += 1;
                continue;
            };
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
            let Ok(input) = std::fs::File::open(entry.path()) else {
                stats.unreadable += 1;
                continue;
            };
            match copy_atomic(input, &dest) {
                Ok(()) => stats.copied += 1,
                Err(CopyError::Read) => stats.unreadable += 1,
                Err(CopyError::Write(e)) => {
                    stats.stopped = Some(e);
                    return stats;
                }
            }
        }
    }
    stats
}

/// Private items are copied under their `.luna-` names, so the copy also
/// carries a manifest saying what each one is called and who owns it.
fn write_private_manifest(row: &ProtectionRow, src_dir: &Path, target_root: &Path) {
    // The source drive's mount is the ancestor of the folder being copied.
    let Ok(canon) = src_dir.canonicalize() else {
        return;
    };
    let rel = row.source_path.trim_matches('/');
    let mut root = canon.clone();
    for _ in rel.split('/').filter(|s| !s.is_empty()) {
        if !root.pop() {
            return;
        }
    }
    let (Some(name), Some(json)) = (
        crate::private::manifest_name(&root),
        crate::private::manifest_json(&root, rel),
    ) else {
        return;
    };
    // Protected copies only ever add, so the manifest keeps every item it has
    // seen for as long as its bytes may still be there.
    let path = target_root.join(name);
    let merged = match (
        std::fs::read_to_string(&path),
        serde_json::from_str::<Vec<serde_json::Value>>(&json),
    ) {
        (Ok(old), Ok(mut now)) => {
            let mut all: Vec<serde_json::Value> = serde_json::from_str(&old).unwrap_or_default();
            all.retain(|o| {
                let id = o.get("id");
                !now.iter().any(|n| n.get("id") == id)
            });
            all.append(&mut now);
            serde_json::to_string_pretty(&all).unwrap_or(json)
        }
        _ => json,
    };
    let _ = std::fs::write(path, merged);
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

enum CopyError {
    Read,
    Write(std::io::Error),
}

fn copy_atomic(mut input: std::fs::File, dest: &Path) -> Result<(), CopyError> {
    let tmp = {
        let mut s = dest.as_os_str().to_owned();
        s.push(".part");
        std::path::PathBuf::from(s)
    };
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(CopyError::Write)?;
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = match input.read(&mut buf) {
            Ok(n) => n,
            Err(_) => {
                drop(output);
                let _ = std::fs::remove_file(&tmp);
                return Err(CopyError::Read);
            }
        };
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(CopyError::Write)?;
    }
    output.flush().map_err(CopyError::Write)?;
    output.sync_all().map_err(CopyError::Write)?;
    drop(output);
    std::fs::rename(&tmp, dest).map_err(CopyError::Write)?;
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
            let prefix = luna_core::marker::pick_prefix(&root).unwrap();
            crate::drives::drive_db::create(
                &root,
                &luna_core::marker::Marker::new(id, name),
                &prefix,
            )
            .unwrap();
            db::upsert_drive(&conn, id, name, "as_is", "ext4", id, root.to_str().unwrap()).unwrap();
        }
        (dir, conn)
    }

    #[test]
    fn target_path_lives_under_protected_dir_on_drive_root() {
        let layout = Layout::from_prefix(".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f");
        assert_eq!(
            target_rel_path(&layout, "drv-a", "family/photos"),
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-protected/drv-a/family/photos"
        );
        assert_eq!(
            target_rel_path(&layout, "drv-a", "/family/"),
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-protected/drv-a/family"
        );
        assert_eq!(
            target_rel_path(&layout, "drv-a", ""),
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-protected/drv-a"
        );
        assert!(is_protected_store(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-protected"
        ));
        assert!(is_protected_store(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-protected/drv-a/family"
        ));
        assert!(!is_protected_store("family"));
        assert!(!is_protected_store(".luna-trash"));
        assert!(!is_protected_store(
            ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-trash"
        ));
    }

    #[test]
    fn allows_copies_onto_multiple_target_drives() {
        let (dir, conn) = setup();
        let c_root = dir.path().join("C");
        std::fs::create_dir_all(&c_root).unwrap();
        crate::drives::drive_db::create(
            &c_root,
            &luna_core::marker::Marker::new("c", "C"),
            &luna_core::marker::pick_prefix(&c_root).unwrap(),
        )
        .unwrap();
        db::upsert_drive(
            &conn,
            "c",
            "C",
            "as_is",
            "ext4",
            "c",
            c_root.to_str().unwrap(),
        )
        .unwrap();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();

        let first = create(&conn, "a", "family", "b").unwrap();
        let second = create(&conn, "a", "family", "c").unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(first.target_drive, "b");
        assert_eq!(second.target_drive, "c");
        assert_eq!(db::list_protections(&conn).unwrap().len(), 2);
    }

    #[test]
    fn refuses_duplicate_target_drive() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        create(&conn, "a", "family", "b").unwrap();
        let err = create(&conn, "a", "family", "b").unwrap_err().to_string();
        assert!(
            err.contains("already copying onto that drive"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn protects_folder_and_keeps_deleted_files() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        std::fs::write(format!("{src}/family/photo.txt"), b"original").unwrap();

        let row = create(&conn, "a", "family", "b").unwrap();
        let dst = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        let protected = format!(
            "{}-protected",
            crate::drives::drive_db::prefix_for(Path::new(&dst)).unwrap()
        );
        assert_eq!(
            row.target_path,
            format!("{protected}/a/family"),
            "protected copies must live under the target drive's protected dir"
        );
        assert_eq!(sync(&conn, &row).unwrap(), 1);

        let on_disk = Path::new(&dst).join(&row.target_path).join("photo.txt");
        assert!(
            on_disk.starts_with(Path::new(&dst).join(&protected)),
            "synced file must be under <drive-root>/{protected}/"
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

    #[cfg(unix)]
    #[test]
    fn manifest_is_written_when_the_copy_stops_partway() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family/secret")).unwrap();
        std::fs::write(format!("{src}/family/secret/note.txt"), b"x").unwrap();
        crate::private::privatize(Path::new(&src), "family/secret", "alice").unwrap();
        let blocked = format!("{src}/family/blocked.txt");
        std::fs::write(&blocked, b"x").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&blocked).is_ok() {
            return; // root ignores file modes, so the copy can't be made to fail
        }

        let row = create(&conn, "a", "family", "b").unwrap();
        assert!(sync(&conn, &row).is_err());

        let dst = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        let name = crate::private::manifest_name(Path::new(&src)).unwrap();
        let manifest = Path::new(&dst).join(&row.target_path).join(name);
        let json = std::fs::read_to_string(manifest).expect("manifest written despite the failure");
        assert!(json.contains("\"owner\": \"alice\""), "{json}");
    }

    #[test]
    fn one_missing_drive_does_not_stop_the_other_folders() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        std::fs::create_dir_all(format!("{src}/work")).unwrap();
        std::fs::write(format!("{src}/work/plan.txt"), b"x").unwrap();
        let broken = create(&conn, "a", "family", "b").unwrap();
        let fine = create(&conn, "a", "work", "b").unwrap();
        std::fs::remove_dir_all(format!("{src}/family")).unwrap();

        let db = crate::Db::new(conn);
        let outcome = sync_all(&db).unwrap();
        assert_eq!(outcome.copied, 1);
        assert!(outcome.state_changed);

        let conn = db.lock().unwrap();
        let broken = db::get_protection(&conn, &broken.id).unwrap().unwrap();
        assert!(
            broken.last_error.contains("can't find family on A"),
            "{}",
            broken.last_error
        );
        assert!(broken.failing_since > 0);
        assert_eq!(broken.last_ok_at, 0);
        let fine = db::get_protection(&conn, &fine.id).unwrap().unwrap();
        assert_eq!(fine.last_error, "");
        assert!(fine.last_ok_at > 0);
    }

    #[test]
    fn a_success_clears_the_recorded_error() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        let row = create(&conn, "a", "family", "b").unwrap();
        db::record_protection_error(&conn, &row.id, "Earlier problem.", 5).unwrap();
        db::record_protection_error(&conn, &row.id, "Later problem.", 9).unwrap();
        let failing = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(failing.failing_since, 5, "streak start is kept");
        assert_eq!(failing.last_error, "Later problem.");

        sync(&conn, &row).unwrap();
        let ok = db::get_protection(&conn, &row.id).unwrap().unwrap();
        assert_eq!(ok.last_error, "");
        assert_eq!(ok.failing_since, 0);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_files_are_counted_and_the_rest_still_copy() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        std::fs::write(format!("{src}/family/good.txt"), b"x").unwrap();
        let blocked = format!("{src}/family/blocked.txt");
        std::fs::write(&blocked, b"x").unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&blocked).is_ok() {
            return; // root ignores file modes
        }
        let row = create(&conn, "a", "family", "b").unwrap();
        let err = sync(&conn, &row).unwrap_err();
        assert_eq!(
            err,
            "Luna couldn't read 1 file in family, so it wasn't copied."
        );
        let dst = db::get_drive(&conn, "b").unwrap().unwrap().mount_point;
        assert!(
            Path::new(&dst)
                .join(&row.target_path)
                .join("good.txt")
                .exists()
        );
    }

    #[test]
    fn missing_target_drive_names_it() {
        let (_dir, conn) = setup();
        let src = db::get_drive(&conn, "a").unwrap().unwrap().mount_point;
        std::fs::create_dir_all(format!("{src}/family")).unwrap();
        let row = create(&conn, "a", "family", "b").unwrap();
        conn.execute("UPDATE drives SET mount_point = '' WHERE id = 'b'", [])
            .unwrap();
        assert_eq!(
            sync(&conn, &row).unwrap_err(),
            "Luna can't find the drive B, so family wasn't copied."
        );
    }
}
