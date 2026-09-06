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

/// One search hit from the file index (name, folder path, kind, size, etc.).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub drive_id: String,
    pub parent: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub modified: i64,
}

/// Search files and folders by name, folder path, kind, or drive label.
/// Hidden entries are skipped; callers still enforce access checks.
///
/// Fans out across each mounted drive's `.luna` microdb (index no longer
/// lives in central `luna.db`).
pub fn search(central: &Connection, query: &str) -> anyhow::Result<Vec<SearchHit>> {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let q_lower = query.to_ascii_lowercase();
    let mut all = Vec::new();
    for drive in db::list_drives(central)? {
        if drive.mount_point.is_empty() || drive.state != "as_is" {
            continue;
        }
        let root = std::path::Path::new(&drive.mount_point);
        if !crate::drive_db::path_for(root).is_file() {
            continue;
        }
        let conn = match crate::drive_db::open_migrating(root, central, &drive.id) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let label_hit = drive.label.to_ascii_lowercase().contains(&q_lower);
        let mut stmt = conn.prepare(
            "SELECT drive_id, parent, name, kind, size, modified
             FROM index_entries
             WHERE hidden = 0
               AND drive_id = ?2
               AND (
                 name LIKE ?1 ESCAPE '\\'
                 OR parent LIKE ?1 ESCAPE '\\'
                 OR (CASE WHEN parent = '' THEN name ELSE parent || '/' || name END)
                     LIKE ?1 ESCAPE '\\'
                 OR kind LIKE ?1 ESCAPE '\\'
               )
             ORDER BY name COLLATE NOCASE
             LIMIT 200",
        )?;
        let mut hits: Vec<SearchHit> = stmt
            .query_map(params![pattern, drive.id], |row| {
                Ok(SearchHit {
                    drive_id: row.get(0)?,
                    parent: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    size: row.get(4)?,
                    modified: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if label_hit && hits.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT drive_id, parent, name, kind, size, modified
                 FROM index_entries
                 WHERE hidden = 0 AND drive_id = ?1
                 ORDER BY name COLLATE NOCASE
                 LIMIT 50",
            )?;
            hits = stmt
                .query_map(params![drive.id], |row| {
                    Ok(SearchHit {
                        drive_id: row.get(0)?,
                        parent: row.get(1)?,
                        name: row.get(2)?,
                        kind: row.get(3)?,
                        size: row.get(4)?,
                        modified: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
        }
        all.append(&mut hits);
        if all.len() >= 200 {
            all.truncate(200);
            break;
        }
    }
    all.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    Ok(all)
}

/// Recursively index an adopted drive. Runs in the background; never blocks
/// a request. Directories are read once each, then kept fresh by mtime.
pub fn scan_drive(
    _central: &Connection,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    let conn = crate::drive_db::open(root)?;
    let mut dirs = 0u64;
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let meta = std::fs::metadata(&dir)?;
        let mtime = mtime(&meta);
        let entries = crate::files::read_dir_entries(&dir)?;
        for entry in &entries {
            if entry.kind == "dir" {
                // Luna-managed stores — not user folders. Skip so search/browse
                // index does not walk trash or protected copies.
                if entry.name == ".luna-trash" || entry.name == crate::protect::PROTECTED_DIR {
                    continue;
                }
                let child_rel = if rel.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{rel}/{}", entry.name)
                };
                stack.push((child_rel, dir.join(&entry.name)));
            }
        }
        replace_dir(&conn, drive_id, &rel, mtime, &entries)?;
        dirs += 1;
    }
    Ok(dirs)
}

/// Like [`scan_drive`], but releases the DB mutex between directories so
/// listings and search stay responsive during a full reindex.
pub fn scan_drive_unlocked(
    _db: &std::sync::Mutex<Connection>,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    // Index lives on the drive `.luna` microdb — central lock is unused.
    let unused = Connection::open_in_memory()?;
    scan_drive(&unused, drive_id, root)
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
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drive_db::create(dir.path(), &marker).unwrap();
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
    }

    #[test]
    fn search_matches_parent_path_and_drive_label() {
        let dir = tempfile::tempdir().unwrap();
        let central = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_root = dir.path().join("drive");
        std::fs::create_dir_all(&drive_root).unwrap();
        let marker = luna_core::marker::Marker::new("d1", "Photos Drive");
        let dconn = crate::drive_db::create(&drive_root, &marker).unwrap();
        db::upsert_drive(
            &central,
            "d1",
            "Photos Drive",
            "as_is",
            "ext4",
            "sdz",
            drive_root.to_str().unwrap(),
        )
        .unwrap();
        replace_dir(
            &dconn,
            "d1",
            "album/2024",
            1,
            &[FileEntry {
                name: "beach.jpg".into(),
                kind: "file".into(),
                size: 42,
                modified: 9,
                hidden: false,
            }],
        )
        .unwrap();
        drop(dconn);
        let by_folder = search(&central, "2024").unwrap();
        assert!(
            by_folder.iter().any(|h| h.name == "beach.jpg"),
            "folder path should match"
        );
        let by_label = search(&central, "Photos").unwrap();
        assert!(
            by_label.iter().any(|h| h.name == "beach.jpg"),
            "drive label should match"
        );
        let by_kind = search(&central, "file").unwrap();
        assert!(by_kind.iter().any(|h| h.name == "beach.jpg"));
    }
}
