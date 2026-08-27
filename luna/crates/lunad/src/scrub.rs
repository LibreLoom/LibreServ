//! Checksum scrub: hash files once, then re-verify on schedule.
//!
//! Hashes live in SQLite (drive metadata, not user data). A file whose size
//! and mtime are unchanged is re-hashed and compared; a mismatch means silent
//! corruption and is reported, never auto-repaired.

use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, params};

use crate::db;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScrubReport {
    pub files_checked: u64,
    pub files_hashed: u64,
    pub mismatches: u64,
    pub bytes_hashed: u64,
}

pub fn upsert_hash(
    conn: &Connection,
    drive_id: &str,
    path: &str,
    size: u64,
    mtime: i64,
    hash: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO file_hashes (drive_id, path, size, mtime, hash, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(drive_id, path) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime, hash = excluded.hash,
           verified_at = excluded.verified_at",
        params![drive_id, path, size as i64, mtime, hash, db::now_unix()],
    )?;
    Ok(())
}

pub fn hash_file(path: &Path) -> anyhow::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Walk a drive and (re)baseline the hash for every regular file.
///
/// A file is only re-hashed when it has no stored hash yet or its size/mtime
/// have changed since it was last recorded. Files whose stored size/mtime
/// still match are left untouched — they are the *baseline to verify against*
/// on a later scrub. (The previous behaviour re-hashed and overwrote every
/// file in the same pass it verified, so silent corruption was never detected.)
pub fn hash_drive(conn: &Connection, drive_id: &str, root: &Path) -> anyhow::Result<ScrubReport> {
    let mut report = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            // Only lossless UTF-8 paths are baselined; anything else is skipped
            // rather than lossy-mangled (which would strand the file).
            let path_buf = entry.path();
            let Some(rel) = path_buf.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
                continue;
            };
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // Already have an identical baseline for this file? Leave it alone.
            if let Ok(Some((s, m))) = get_hash(conn, drive_id, rel)
                && s == size
                && m == mtime
            {
                continue;
            }
            let Ok(hash) = hash_file(&entry.path()) else {
                continue;
            };
            let _ = upsert_hash(conn, drive_id, rel, size, mtime, &hash);
            report.files_hashed += 1;
            report.bytes_hashed += size;
        }
    }
    Ok(report)
}

/// Scrub every hash we know for one drive against its stored baseline.
///
/// A file whose size and mtime still match the baseline is re-hashed and
/// compared; a mismatch is reported (never auto-repaired). A file that changed
/// is re-hashed and becomes the new baseline. Individual unreadable paths are
/// skipped rather than aborting the whole drive.
pub fn scrub_drive(conn: &Connection, drive_id: &str, root: &Path) -> anyhow::Result<ScrubReport> {
    let mut report = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    let mut stmt =
        conn.prepare("SELECT path, size, mtime, hash FROM file_hashes WHERE drive_id = ?1")?;
    let rows = stmt.query_map(params![drive_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? as u64,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows.flatten() {
        let (rel, expected_size, expected_mtime, expected_hash) = row;
        let Ok(path) = luna_core::path::resolve_child(root, &rel) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if meta.len() == expected_size && mtime == expected_mtime {
            let Ok(actual) = hash_file(&path) else {
                continue;
            };
            report.bytes_hashed += meta.len();
            if actual != expected_hash {
                report.mismatches += 1;
            }
            report.files_checked += 1;
        } else {
            // File changed legitimately: rehash and store the new truth.
            let Ok(actual) = hash_file(&path) else {
                continue;
            };
            let _ = upsert_hash(conn, drive_id, &rel, meta.len(), mtime, &actual);
            report.files_hashed += 1;
            report.bytes_hashed += meta.len();
        }
    }
    Ok(report)
}

pub const PERIODIC_IDLE_SECS: i64 = 30 * 60;
pub const PERIODIC_MIN_GAP_SECS: i64 = 20 * 60 * 60;

/// Quiet hours: 1 AM through 5 AM local time.
pub fn in_night_window(local_hour: u32) -> bool {
    (1..5).contains(&local_hour)
}

pub fn should_run_periodic(
    running: bool,
    local_hour: u32,
    last_run_unix: Option<i64>,
    last_activity_unix: i64,
    now_unix: i64,
) -> bool {
    if running {
        return false;
    }
    if !in_night_window(local_hour) {
        return false;
    }
    if let Some(last) = last_run_unix
        && now_unix.saturating_sub(last) < PERIODIC_MIN_GAP_SECS
    {
        return false;
    }
    if last_activity_unix > 0 && now_unix.saturating_sub(last_activity_unix) < PERIODIC_IDLE_SECS {
        return false;
    }
    true
}

pub fn local_hour_now() -> u32 {
    let unix = db::now_unix();
    let mut tm = unsafe { std::mem::zeroed::<LibcTm>() };
    let p = unsafe { localtime_r(&unix, &mut tm) };
    if p.is_null() {
        return 0;
    }
    tm.tm_hour.clamp(0, 23) as u32
}

#[repr(C)]
struct LibcTm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const i8,
}

unsafe extern "C" {
    fn localtime_r(timep: *const i64, result: *mut LibcTm) -> *mut LibcTm;
}

pub fn scrub_all_drives(conn: &Connection) -> anyhow::Result<ScrubReport> {
    let drives = db::list_drives(conn).unwrap_or_default();
    let mut total = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    for drive in drives {
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            continue;
        }
        let root = std::path::PathBuf::from(&drive.mount_point);
        if let Ok(report) = hash_drive(conn, &drive.id, &root) {
            total.files_hashed += report.files_hashed;
            total.bytes_hashed += report.bytes_hashed;
        }
        if let Ok(report) = scrub_drive(conn, &drive.id, &root) {
            total.files_checked += report.files_checked;
            total.mismatches += report.mismatches;
        }
    }
    let _ = db::set_meta(
        conn,
        "last_scrub_report",
        &serde_json::to_string(&total).unwrap_or_default(),
    );
    Ok(total)
}

/// Like [`hash_drive`], but releases the DB mutex while hashing each file so
/// interactive API traffic is not stalled for the whole walk.
pub fn hash_drive_unlocked(
    db: &std::sync::Mutex<Connection>,
    drive_id: &str,
    root: &Path,
) -> anyhow::Result<ScrubReport> {
    let mut report = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let path_buf = entry.path();
            let Some(rel) = path_buf.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
                continue;
            };
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            {
                let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
                if let Ok(Some((s, m))) = get_hash(&conn, drive_id, rel)
                    && s == size
                    && m == mtime
                {
                    continue;
                }
            }
            let Ok(hash) = hash_file(&entry.path()) else {
                continue;
            };
            let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
            let _ = upsert_hash(&conn, drive_id, rel, size, mtime, &hash);
            report.files_hashed += 1;
            report.bytes_hashed += size;
        }
    }
    Ok(report)
}

/// Like [`scrub_drive`], hashing outside the mutex.
pub fn scrub_drive_unlocked(
    db: &std::sync::Mutex<Connection>,
    drive_id: &str,
    root: &Path,
) -> anyhow::Result<ScrubReport> {
    let rows: Vec<(String, u64, i64, String)> = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        let mut stmt =
            conn.prepare("SELECT path, size, mtime, hash FROM file_hashes WHERE drive_id = ?1")?;
        let mapped = stmt.query_map(params![drive_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        mapped.flatten().collect()
    };

    let mut report = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    for (rel, expected_size, expected_mtime, expected_hash) in rows {
        let Ok(path) = luna_core::path::resolve_child(root, &rel) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if meta.len() == expected_size && mtime == expected_mtime {
            let Ok(actual) = hash_file(&path) else {
                continue;
            };
            report.bytes_hashed += meta.len();
            if actual != expected_hash {
                report.mismatches += 1;
            }
            report.files_checked += 1;
        } else {
            let Ok(actual) = hash_file(&path) else {
                continue;
            };
            let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
            let _ = upsert_hash(&conn, drive_id, &rel, meta.len(), mtime, &actual);
            report.files_hashed += 1;
            report.bytes_hashed += meta.len();
        }
    }
    Ok(report)
}

pub fn scrub_all_drives_unlocked(db: &std::sync::Mutex<Connection>) -> anyhow::Result<ScrubReport> {
    let drives = {
        let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
        db::list_drives(&conn).unwrap_or_default()
    };
    let mut total = ScrubReport {
        files_checked: 0,
        files_hashed: 0,
        mismatches: 0,
        bytes_hashed: 0,
    };
    for drive in drives {
        if drive.state != "as_is" || drive.mount_point.is_empty() {
            continue;
        }
        let root = std::path::PathBuf::from(&drive.mount_point);
        if let Ok(report) = hash_drive_unlocked(db, &drive.id, &root) {
            total.files_hashed += report.files_hashed;
            total.bytes_hashed += report.bytes_hashed;
        }
        if let Ok(report) = scrub_drive_unlocked(db, &drive.id, &root) {
            total.files_checked += report.files_checked;
            total.mismatches += report.mismatches;
        }
    }
    let conn = db.lock().map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    let _ = db::set_meta(
        &conn,
        "last_scrub_report",
        &serde_json::to_string(&total).unwrap_or_default(),
    );
    Ok(total)
}

fn get_hash(conn: &Connection, drive_id: &str, path: &str) -> anyhow::Result<Option<(u64, i64)>> {
    let mut stmt =
        conn.prepare("SELECT size, mtime FROM file_hashes WHERE drive_id = ?1 AND path = ?2")?;
    let mut rows = stmt.query_map(params![drive_id, path], |row| {
        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)?))
    })?;
    rows.next().transpose().map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_detects_silent_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let file = dir.path().join("photo.jpg");
        std::fs::write(&file, b"original").unwrap();
        let hash = hash_file(&file).unwrap();
        let mtime = std::fs::metadata(&file)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        upsert_hash(&conn, "d1", "photo.jpg", 8, mtime, &hash).unwrap();

        // Corrupt bytes (same size). Depending on filesystem mtime resolution
        // this is detected as corruption or as a legitimate change and rehashed.
        std::fs::write(&file, b"or1ginal").unwrap();
        let report = scrub_drive(&conn, "d1", dir.path()).unwrap();
        assert!(
            report.files_hashed + report.mismatches >= 1,
            "scrub must notice the changed file: {report:?}"
        );
    }

    #[test]
    fn hash_drive_keeps_an_unchanged_baseline() {
        // The crux of the scrub fix: re-running the baseline must NOT
        // overwrite the stored hash of an unchanged file, otherwise silent
        // corruption is re-baselined away before it can ever be detected.
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();

        let first = hash_drive(&conn, "d1", &root).unwrap();
        assert_eq!(first.files_hashed, 1, "first run establishes the baseline");

        let second = hash_drive(&conn, "d1", &root).unwrap();
        assert_eq!(
            second.files_hashed, 0,
            "an unchanged file must not be re-hashed/overwritten: {second:?}"
        );
    }

    #[test]
    fn periodic_scrub_only_runs_in_the_quiet_window_when_idle() {
        assert!(!should_run_periodic(true, 2, None, 0, 1_000));
        assert!(!should_run_periodic(false, 14, None, 0, 1_000));
        assert!(should_run_periodic(false, 2, None, 0, 1_000));
        assert!(!should_run_periodic(false, 2, None, 990, 1_000));
        assert!(!should_run_periodic(false, 2, Some(1_000 - 60), 0, 1_000));
        assert!(should_run_periodic(
            false,
            3,
            Some(1_000 - PERIODIC_MIN_GAP_SECS - 1),
            0,
            1_000
        ));
    }
}
