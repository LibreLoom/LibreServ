//! SQLite file index — listings come from the index, not the spinning disk.
//!
//! Freshness has two guards: every Luna write that lands calls
//! [`forget_dir`] on the directories it touched, and any outside change
//! (WebDAV, a computer plugged into the drive) is caught by comparing each
//! directory's mtime — at nanosecond precision — with the indexed stamp.
//! Whole seconds would miss writes that land inside the filesystem's
//! timestamp granularity (one second on most filesystems, two on FAT32),
//! leaving files that exist on disk invisible to listings.
//! Search therefore reads SQLite only, which is the <50ms listing target.

use rusqlite::{Connection, params};

use crate::db;

use crate::files::{FileEntry, FolderTotals};

/// Directory mtime as nanoseconds since the epoch — the freshness stamp the
/// index compares. Never truncate to seconds: a write that lands inside one
/// second of the last fill would otherwise look fresh forever.
pub fn dir_stamp(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Drop the indexed state of one directory so the next listing re-reads it
/// from disk. Every Luna write calls this on the directories it touched —
/// the mtime check alone misses writes inside the filesystem's timestamp
/// granularity.
pub fn forget_dir(conn: &Connection, drive_id: &str, rel: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM indexed_dirs WHERE drive_id = ?1 AND path = ?2",
        params![drive_id, rel],
    )?;
    Ok(())
}

/// Drop every indexed row under `rel` — the directory itself and its whole
/// subtree. Renames, deletes, and moves of a folder leave the old rows
/// unreachable by path, but forgetting them keeps `search` honest.
pub fn forget_dir_tree(conn: &Connection, drive_id: &str, rel: &str) -> anyhow::Result<()> {
    if rel.is_empty() {
        conn.execute(
            "DELETE FROM indexed_dirs WHERE drive_id = ?1",
            params![drive_id],
        )?;
        conn.execute(
            "DELETE FROM index_entries WHERE drive_id = ?1",
            params![drive_id],
        )?;
        return Ok(());
    }
    // Escape LIKE metachars in the rel — a folder named `50%` or `a_b` must
    // forget only its own subtree.
    let escaped = rel
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let prefix = format!("{escaped}/%");
    conn.execute(
        "DELETE FROM indexed_dirs
         WHERE drive_id = ?1 AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')",
        params![drive_id, rel, prefix],
    )?;
    conn.execute(
        "DELETE FROM index_entries
         WHERE drive_id = ?1 AND (parent = ?2 OR parent LIKE ?3 ESCAPE '\\')",
        params![drive_id, rel, prefix],
    )?;
    Ok(())
}

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
                saving: false,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                private: false,
                in_private: false,
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
/// Fans out across each mounted drive's `.luna-<uuid>.sqlite3` microdb (index
/// no longer lives in central `luna.db`).
///
/// `keep` runs on every match before it counts toward the 200-hit cap, so
/// hits the caller may not see (someone else's private items) never crowd
/// out hits they may.
pub fn search(
    central: &Connection,
    query: &str,
    keep: &mut dyn FnMut(&SearchHit) -> bool,
) -> anyhow::Result<Vec<SearchHit>> {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let q_lower = query.to_ascii_lowercase();
    let mut all = Vec::new();
    for drive in db::list_drives(central)? {
        if drive.mount_point.is_empty() || (drive.state != "as_is" && drive.state != "readonly") {
            continue;
        }
        let root = std::path::Path::new(&drive.mount_point);
        if crate::drives::drive_db::find_db_file(root).is_none() {
            continue;
        }
        let conn = match crate::drives::drive_db::open_migrating(root, central, &drive.id) {
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
             ORDER BY name COLLATE NOCASE",
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
            .filter(|hit| match hit {
                Ok(h) => keep(h),
                Err(_) => true,
            })
            .take(200)
            .collect::<Result<Vec<_>, _>>()?;
        if label_hit && hits.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT drive_id, parent, name, kind, size, modified
                 FROM index_entries
                 WHERE hidden = 0 AND drive_id = ?1
                 ORDER BY name COLLATE NOCASE",
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
                .filter(|hit| match hit {
                    Ok(h) => keep(h),
                    Err(_) => true,
                })
                .take(50)
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

/// Recursive folder totals served entirely from fresh index rows — no
/// directory scans. Every directory in the subtree must be indexed AND
/// still mtime-fresh; the first stale or missing directory returns `None`
/// and the caller falls back to a filesystem walk.
///
/// `include(dir_rel)` gates which directories contribute their entries, the
/// same lens [`crate::files::folder_totals`] uses — unreadable parents are
/// still descended so a deeper grant is not hidden by its ancestor.
pub fn folder_totals_indexed(
    conn: &Connection,
    root: &std::path::Path,
    drive_id: &str,
    rel: &str,
    include: &mut impl FnMut(&str) -> bool,
) -> Option<FolderTotals> {
    // Bounded like the filesystem walk: a huge dir count costs stats and
    // queries, so cap it and let the caller decide to walk instead.
    const MAX_DIRS: usize = 20_000;
    let mut totals = FolderTotals::default();
    let mut stack = vec![rel.trim_end_matches('/').to_string()];
    let mut seen_dirs = 0usize;
    while let Some(dir_rel) = stack.pop() {
        seen_dirs += 1;
        if seen_dirs > MAX_DIRS {
            return None;
        }
        // Fresh means the indexed mtime still matches the filesystem: a dir
        // whose mtime moved has entries the index cannot vouch for.
        let indexed: i64 = conn
            .query_row(
                "SELECT dir_mtime FROM indexed_dirs WHERE drive_id = ?1 AND path = ?2",
                params![drive_id, dir_rel],
                |row| row.get(0),
            )
            .ok()?;
        let current = std::fs::metadata(root.join(crate::private::disk_rel(root, &dir_rel)))
            .map(|m| dir_stamp(&m))
            .unwrap_or(0);
        if indexed != current {
            return None;
        }
        let readable = include(&dir_rel);
        let mut stmt = conn
            .prepare(
                "SELECT name, kind, size FROM index_entries WHERE drive_id = ?1 AND parent = ?2",
            )
            .ok()?;
        let rows = stmt
            .query_map(params![drive_id, dir_rel], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .ok()?
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        for (name, kind, size) in rows {
            if crate::files::is_internal_temp(&name) {
                continue;
            }
            let child = if dir_rel.is_empty() {
                name
            } else {
                format!("{dir_rel}/{name}")
            };
            // A private item counts only for people who may read it.
            let readable =
                readable && (crate::private::item_at(root, &child).is_none() || include(&child));
            match kind.as_str() {
                "dir" => {
                    if readable {
                        totals.dirs += 1;
                    }
                    stack.push(child);
                }
                "file" if readable => {
                    totals.files += 1;
                    totals.bytes += size.max(0) as u64;
                }
                _ if readable => totals.other += 1,
                _ => {}
            }
        }
    }
    // Every subdir checked out fresh — the count is final.
    totals.complete = true;
    Some(totals)
}

/// Recursively index an adopted drive. Runs in the background; never blocks
/// a request. Directories are read once each, then kept fresh by mtime.
pub fn scan_drive(
    _central: &Connection,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    let conn = crate::drives::drive_db::open(root)?;
    let mut dirs = 0u64;
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let meta = std::fs::metadata(&dir)?;
        let mtime = dir_stamp(&meta);
        let private = crate::private::children_of(root, &rel);
        let entries = crate::files::read_dir_entries_in(
            &dir,
            &private,
            crate::private::boundary_for(root, &rel).is_some(),
        )?;
        for entry in &entries {
            // read_dir_entries already filtered out Luna's `.luna-<uuid>`
            // bookkeeping (trash, protected copies, thumbs, marker).
            if entry.kind == "dir" {
                let child_rel = if rel.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{rel}/{}", entry.name)
                };
                // A private folder sits on disk under its `.luna-` name.
                let on_disk = private
                    .iter()
                    .find(|(_, i)| i.name() == entry.name)
                    .map_or(entry.name.as_str(), |(disk, _)| disk.as_str());
                stack.push((child_rel, dir.join(on_disk)));
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
    _db: &crate::Db,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    // Index lives on the drive `.luna-<uuid>.sqlite3` microdb — central lock is unused.
    let unused = Connection::open_in_memory()?;
    scan_drive(&unused, drive_id, root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_and_stale_index_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            dir.path(),
            &marker,
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        let entries = vec![
            FileEntry {
                name: "b".into(),
                kind: "file".into(),
                size: 1,
                modified: 1,
                hidden: false,
                saving: false,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                private: false,
                in_private: false,
            },
            FileEntry {
                name: "a".into(),
                kind: "dir".into(),
                size: 0,
                modified: 1,
                hidden: false,
                saving: false,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                private: false,
                in_private: false,
            },
        ];
        replace_dir(&conn, "d1", "sub", 42, &entries).unwrap();
        let got = fresh_entries(&conn, "d1", "sub", 42).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "a");
        assert!(fresh_entries(&conn, "d1", "sub", 43).is_none());
    }

    #[test]
    fn folder_totals_indexed_sums_a_fresh_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/one.txt"), b"12345").unwrap();
        std::fs::write(root.join("a/b/two.txt"), b"xy").unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            &root,
            &marker,
            &luna_core::marker::pick_prefix(&root).unwrap(),
        )
        .unwrap();
        scan_drive(&conn, "d1", &root).unwrap();

        let mut all = |_: &str| true;
        let totals = folder_totals_indexed(&conn, &root, "d1", "a", &mut all).unwrap();
        assert_eq!(totals.bytes, 7);
        assert_eq!(totals.files, 2);
        assert_eq!(totals.dirs, 1);
        assert!(totals.complete);

        // The lens gates each directory's own entries, same as the walk.
        let mut only_b = |p: &str| p == "a/b";
        let scoped = folder_totals_indexed(&conn, &root, "d1", "a", &mut only_b).unwrap();
        assert_eq!(scoped.bytes, 2);
        assert_eq!(scoped.files, 1);
        assert_eq!(scoped.dirs, 0);
    }

    #[test]
    fn folder_totals_indexed_refuses_a_stale_or_missing_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/one.txt"), b"1").unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            &root,
            &marker,
            &luna_core::marker::pick_prefix(&root).unwrap(),
        )
        .unwrap();
        scan_drive(&conn, "d1", &root).unwrap();

        let mut all = |_: &str| true;
        // Never-indexed path → None (caller walks instead).
        assert!(folder_totals_indexed(&conn, &root, "d1", "missing", &mut all).is_none());
        // A stale dir mtime anywhere in the subtree → None.
        conn.execute(
            "UPDATE indexed_dirs SET dir_mtime = -1 WHERE path = 'a'",
            [],
        )
        .unwrap();
        assert!(folder_totals_indexed(&conn, &root, "d1", "", &mut all).is_none());
    }

    #[test]
    fn search_matches_parent_path_and_drive_label() {
        let dir = tempfile::tempdir().unwrap();
        let central = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_root = dir.path().join("drive");
        std::fs::create_dir_all(&drive_root).unwrap();
        let marker = luna_core::marker::Marker::new("d1", "Photos Drive");
        let dconn = crate::drives::drive_db::create(
            &drive_root,
            &marker,
            &luna_core::marker::pick_prefix(&drive_root).unwrap(),
        )
        .unwrap();
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
                saving: false,
                save_failed: false,
                original_name: None,
                original_path: None,
                link_target: None,
                caps: String::new(),
                private: false,
                in_private: false,
            }],
        )
        .unwrap();
        drop(dconn);
        let by_folder = search(&central, "2024", &mut |_| true).unwrap();
        assert!(
            by_folder.iter().any(|h| h.name == "beach.jpg"),
            "folder path should match"
        );
        let by_label = search(&central, "Photos", &mut |_| true).unwrap();
        assert!(
            by_label.iter().any(|h| h.name == "beach.jpg"),
            "drive label should match"
        );
        let by_kind = search(&central, "file", &mut |_| true).unwrap();
        assert!(by_kind.iter().any(|h| h.name == "beach.jpg"));
    }
}
