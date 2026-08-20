//! SQLite file index — listings come from the index, not the spinning disk.
//!
//! Correctness is guaranteed by comparing each directory's mtime with the
//! indexed mtime: any change through Luna, WebDAV, or a computer plugged into
//! the drive invalidates the entry and triggers a single fresh `read_dir`.
//! Search therefore reads SQLite only, which is the <50ms listing target.

use rusqlite::{Connection, params};

use crate::db;

use crate::files::FileEntry;

pub fn replace_dir(
    conn: &Connection,
    drive_id: &str,
    parent: &str,
    dir_mtime: i64,
    entries: &[FileEntry],
) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM index_entries WHERE drive_id = ?1 AND parent = ?2",
        params![drive_id, parent],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO index_entries
             (drive_id, parent, name, kind, size, modified, hidden)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for entry in entries {
            stmt.execute(params![
                drive_id,
                parent,
                entry.name,
                entry.kind,
                entry.size as i64,
                entry.modified,
                entry.hidden as i64,
            ])?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO indexed_dirs (drive_id, path, dir_mtime, indexed_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![drive_id, parent, dir_mtime, db::now_unix()],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn fresh_entries(
    conn: &Connection,
    drive_id: &str,
    parent: &str,
    dir_mtime: i64,
) -> Option<Vec<FileEntry>> {
    let indexed_mtime: Option<i64> = conn
        .query_row(
            "SELECT dir_mtime FROM indexed_dirs WHERE drive_id = ?1 AND path = ?2",
            params![drive_id, parent],
            |row| row.get(0),
        )
        .ok();
    if indexed_mtime != Some(dir_mtime) {
        return None;
    }
    let mut stmt = conn
        .prepare(
            "SELECT name, kind, size, modified, hidden FROM index_entries
             WHERE drive_id = ?1 AND parent = ?2 ORDER BY (kind = 'dir') DESC, name COLLATE NOCASE",
        )
        .ok()?;
    let rows = stmt
        .query_map(params![drive_id, parent], |row| {
            Ok(FileEntry {
                name: row.get(0)?,
                kind: row.get(1)?,
                size: row.get::<_, i64>(2)? as u64,
                modified: row.get(3)?,
                hidden: row.get::<_, i64>(4)? != 0,
            })
        })
        .ok()?;
    Some(rows.filter_map(|r| r.ok()).collect())
}

pub fn search(conn: &Connection, query: &str) -> anyhow::Result<Vec<(String, String, String)>> {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let mut stmt = conn.prepare(
        "SELECT drive_id, parent, name FROM index_entries
         WHERE name LIKE ?1 ESCAPE '\\'
         ORDER BY name COLLATE NOCASE LIMIT 200",
    )?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Recursively index an adopted drive. Runs in the background; never blocks
/// a request. Directories are read once each, then kept fresh by mtime.
pub fn scan_drive(
    conn: &Connection,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    let mut dirs = 0u64;
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let meta = std::fs::metadata(&dir)?;
        let mtime = mtime(&meta);
        let entries = crate::files::read_dir_entries(&dir)?;
        for entry in &entries {
            if entry.kind == "dir" {
                let child_rel = if rel.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{rel}/{}", entry.name)
                };
                stack.push((child_rel, dir.join(&entry.name)));
            }
        }
        replace_dir(conn, drive_id, &rel, mtime, &entries)?;
        dirs += 1;
    }
    Ok(dirs)
}

fn mtime(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_and_stale_index_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let entries = vec![
            FileEntry {
                name: "b".into(),
                kind: "file".into(),
                size: 1,
                modified: 1,
                hidden: false,
            },
            FileEntry {
                name: "a".into(),
                kind: "dir".into(),
                size: 0,
                modified: 1,
                hidden: false,
            },
        ];
        replace_dir(&conn, "d1", "sub", 42, &entries).unwrap();
        let got = fresh_entries(&conn, "d1", "sub", 42).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "a");
        assert!(fresh_entries(&conn, "d1", "sub", 43).is_none());
        let found = search(&conn, "a").unwrap();
        assert!(!found.is_empty());
    }
}
