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
    // Search reads the same rows, so have the background indexer re-read this
    // folder instead of waiting for someone to open it.
    crate::files::search_indexer::nudge_dir(drive_id, rel);
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
            // Upsert, not INSERT OR REPLACE: the search table's triggers
            // only see an update, never a silent replace.
            "INSERT INTO index_entries
             (drive_id, parent, name, kind, size, modified, hidden)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (drive_id, parent, name) DO UPDATE SET
               kind = excluded.kind, size = excluded.size,
               modified = excluded.modified, hidden = excluded.hidden",
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
            })
        })
        .ok()?;
    Some(rows.filter_map(|r| r.ok()).collect())
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
        let current = std::fs::metadata(root.join(&dir_rel))
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
            match kind.as_str() {
                "dir" => {
                    if readable {
                        totals.dirs += 1;
                    }
                    stack.push(if dir_rel.is_empty() {
                        name
                    } else {
                        format!("{dir_rel}/{name}")
                    });
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

/// Bring one directory's index rows in line with the disk and return the
/// directories inside it (as drive-relative paths).
///
/// A directory whose mtime still matches its indexed stamp is trusted unless
/// `force` is set, and answers from the index without reading the disk. When
/// the contents did change, subfolders that vanished take their whole indexed
/// subtree with them. A missing drive root is an error, never "everything was
/// deleted".
pub fn sync_dir(
    conn: &Connection,
    drive_id: &str,
    root: &std::path::Path,
    rel: &str,
    force: bool,
) -> anyhow::Result<Vec<String>> {
    if !root.is_dir() {
        anyhow::bail!("drive is not reachable");
    }
    let join = |name: &str| {
        if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        }
    };
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let meta = match std::fs::metadata(&dir) {
        Ok(meta) if meta.is_dir() => meta,
        _ => {
            if !rel.is_empty() {
                forget_dir_tree(conn, drive_id, rel)?;
            }
            return Ok(Vec::new());
        }
    };
    let mtime = dir_stamp(&meta);
    let indexed: Option<i64> = conn
        .query_row(
            "SELECT dir_mtime FROM indexed_dirs WHERE drive_id = ?1 AND path = ?2",
            params![drive_id, rel],
            |row| row.get(0),
        )
        .ok();
    let indexed_children = |conn: &Connection| -> anyhow::Result<Vec<String>> {
        let mut stmt = conn.prepare_cached(
            "SELECT name FROM index_entries
             WHERE drive_id = ?1 AND parent = ?2 AND kind = 'dir'",
        )?;
        let names = stmt
            .query_map(params![drive_id, rel], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    };
    if !force && indexed == Some(mtime) {
        return Ok(indexed_children(conn)?.iter().map(|n| join(n)).collect());
    }
    let before = if indexed.is_some() {
        indexed_children(conn)?
    } else {
        Vec::new()
    };
    let entries = crate::files::read_dir_entries(&dir)?;
    replace_dir(conn, drive_id, rel, mtime, &entries)?;
    let now: Vec<&str> = entries
        .iter()
        .filter(|e| e.kind == "dir")
        .map(|e| e.name.as_str())
        .collect();
    for gone in before.iter().filter(|n| !now.contains(&n.as_str())) {
        forget_dir_tree(conn, drive_id, &join(gone))?;
    }
    Ok(now.iter().map(|n| join(n)).collect())
}

/// Index `start` and everything under it, shallowest folders first so the
/// top of a drive is searchable early. `tick` runs before each folder and
/// returns `false` to stop. Returns how many folders were visited.
pub fn scan_tree(
    conn: &Connection,
    drive_id: &str,
    root: &std::path::Path,
    start: &str,
    force: bool,
    tick: &mut dyn FnMut() -> bool,
) -> anyhow::Result<u64> {
    let mut queue = std::collections::VecDeque::from([start.to_string()]);
    let mut visited = 0u64;
    while let Some(rel) = queue.pop_front() {
        if !tick() {
            break;
        }
        match sync_dir(conn, drive_id, root, &rel, force) {
            // Hidden folders stay unread: search never shows them, and
            // they're where tools keep huge caches.
            Ok(children) => queue.extend(
                children
                    .into_iter()
                    .filter(|c| !c.rsplit('/').next().unwrap_or(c).starts_with('.')),
            ),
            // The drive going away is a failed scan; one unreadable folder
            // is just skipped.
            Err(e) if !root.is_dir() => return Err(e),
            Err(e) => tracing::debug!(drive_id, rel, error = %e, "search index skipped a folder"),
        }
        visited += 1;
    }
    Ok(visited)
}

/// Recursively re-read an adopted drive in full. The background indexer
/// (`search_indexer`) is the normal path; this is the blocking form.
pub fn scan_drive(
    _central: &Connection,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
    let conn = crate::drives::drive_db::open(root)?;
    scan_tree(&conn, drive_id, root, "", true, &mut || true)
}

/// Like [`scan_drive`] without holding the central DB lock.
pub fn scan_drive_unlocked(
    _db: &crate::Db,
    drive_id: &str,
    root: &std::path::Path,
) -> anyhow::Result<u64> {
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
}
