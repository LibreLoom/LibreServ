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
/// Bounds for "everything under `rel/`" as a range scan: `rel/` up to (not
/// including) `rel0`, since `0` is the character after `/`. Binary order, so
/// it rides the table's index — a `LIKE` would not, and would also match a
/// differently-cased sibling.
pub(crate) fn subtree_bounds(rel: &str) -> (String, String) {
    (format!("{rel}/"), format!("{rel}0"))
}

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
    let (from, to) = subtree_bounds(rel);
    conn.execute(
        "DELETE FROM indexed_dirs
         WHERE drive_id = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4))",
        params![drive_id, rel, from, to],
    )?;
    conn.execute(
        "DELETE FROM index_entries
         WHERE drive_id = ?1 AND (parent = ?2 OR (parent >= ?3 AND parent < ?4))",
        params![drive_id, rel, from, to],
    )?;
    Ok(())
}

/// Bring one folder's rows in line with `entries`. Only names that are gone
/// are deleted and only new or changed rows are written: every written row
/// also rewrites its trigram postings in `index_fts`, so rewriting a whole
/// 10k-entry folder after one upload would be wasted work on a USB drive.
///
/// Atomic on its own, and nests inside a caller's batch transaction (see
/// [`scan_tree`]) as a savepoint.
pub fn replace_dir(
    conn: &Connection,
    drive_id: &str,
    parent: &str,
    dir_mtime: i64,
    entries: &[FileEntry],
) -> anyhow::Result<()> {
    // On its own it takes the write lock up front: it reads before it
    // writes, and a deferred transaction that upgrades from a read lock gets
    // SQLITE_BUSY at once (no busy wait) while another connection commits.
    let (begin, commit, rollback) = if conn.is_autocommit() {
        ("BEGIN IMMEDIATE", "COMMIT", "ROLLBACK")
    } else {
        (
            "SAVEPOINT replace_dir",
            "RELEASE replace_dir",
            "ROLLBACK TO replace_dir; RELEASE replace_dir",
        )
    };
    conn.execute_batch(begin)?;
    match replace_dir_rows(conn, drive_id, parent, dir_mtime, entries) {
        Ok(()) => {
            if let Err(e) = conn.execute_batch(commit) {
                let _ = conn.execute_batch(rollback);
                return Err(e.into());
            }
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch(rollback);
            Err(e)
        }
    }
}

fn replace_dir_rows(
    conn: &Connection,
    drive_id: &str,
    parent: &str,
    dir_mtime: i64,
    entries: &[FileEntry],
) -> anyhow::Result<()> {
    // Names compare exactly (binary), like the primary key does.
    let mut gone: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare_cached("SELECT name FROM index_entries WHERE drive_id = ?1 AND parent = ?2")?;
        stmt.query_map(params![drive_id, parent], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };
    for entry in entries {
        gone.remove(&entry.name);
    }
    {
        let mut stmt = conn.prepare_cached(
            "DELETE FROM index_entries WHERE drive_id = ?1 AND parent = ?2 AND name = ?3",
        )?;
        for name in &gone {
            stmt.execute(params![drive_id, parent, name])?;
        }
    }
    {
        let mut stmt = conn.prepare_cached(
            // Upsert, not INSERT OR REPLACE: the search table's triggers
            // only see an update, never a silent replace. The WHERE skips
            // unchanged rows, so they keep their FTS postings untouched.
            "INSERT INTO index_entries
             (drive_id, parent, name, kind, size, modified, hidden)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (drive_id, parent, name) DO UPDATE SET
               kind = excluded.kind, size = excluded.size,
               modified = excluded.modified, hidden = excluded.hidden
             WHERE kind IS NOT excluded.kind OR size IS NOT excluded.size
               OR modified IS NOT excluded.modified OR hidden IS NOT excluded.hidden",
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
    conn.execute(
        "INSERT OR REPLACE INTO indexed_dirs (drive_id, path, dir_mtime, indexed_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![drive_id, parent, dir_mtime, db::now_unix()],
    )?;
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
            .prepare_cached(
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
    let read = read_dir_state(conn, drive_id, root, rel, force)?;
    let children = read.children(rel);
    apply_dir(conn, drive_id, rel, read)?;
    Ok(children)
}

/// What [`read_dir_state`] found for one folder, before anything is written.
enum DirRead {
    /// Still matches its indexed stamp: these are its subfolder names.
    Fresh(Vec<String>),
    /// No longer a folder on disk.
    Gone,
    /// Read from disk; `before` lists the subfolders the index had.
    Changed {
        mtime: i64,
        entries: Vec<FileEntry>,
        before: Vec<String>,
    },
}

impl DirRead {
    /// The folder's subfolders, as drive-relative paths.
    fn children(&self, rel: &str) -> Vec<String> {
        let names: Vec<&str> = match self {
            DirRead::Fresh(names) => names.iter().map(String::as_str).collect(),
            DirRead::Gone => Vec::new(),
            DirRead::Changed { entries, .. } => entries
                .iter()
                .filter(|e| e.kind == "dir")
                .map(|e| e.name.as_str())
                .collect(),
        };
        names.into_iter().map(|n| join_child(rel, n)).collect()
    }

    /// Rough count of rows this folder will write, to bound a batch.
    fn weight(&self) -> usize {
        match self {
            DirRead::Changed { entries, .. } => entries.len() + 1,
            _ => 1,
        }
    }
}

fn join_child(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// The read half of [`sync_dir`]: DB reads and the disk listing, no writes,
/// so [`scan_tree`] can read folders without holding the write lock.
fn read_dir_state(
    conn: &Connection,
    drive_id: &str,
    root: &std::path::Path,
    rel: &str,
    force: bool,
) -> anyhow::Result<DirRead> {
    if !root.is_dir() {
        anyhow::bail!("drive is not reachable");
    }
    // Private folders sit on disk under their `.luna-` names, so the folder
    // is found there and its private children are listed under real names;
    // reading the real path or skipping the rows would index a listing
    // without them.
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(crate::private::disk_rel(root, rel))
    };
    let meta = match std::fs::metadata(&dir) {
        Ok(meta) if meta.is_dir() => meta,
        _ => return Ok(DirRead::Gone),
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
        return Ok(DirRead::Fresh(indexed_children(conn)?));
    }
    let before = if indexed.is_some() {
        indexed_children(conn)?
    } else {
        Vec::new()
    };
    let entries = crate::files::read_dir_entries_in(
        &dir,
        &crate::private::children_of(root, rel),
        crate::private::boundary_for(root, rel).is_some(),
    )?;
    Ok(DirRead::Changed {
        mtime,
        entries,
        before,
    })
}

/// The write half of [`sync_dir`]. When the contents changed, subfolders
/// that vanished take their whole indexed subtree with them.
fn apply_dir(conn: &Connection, drive_id: &str, rel: &str, read: DirRead) -> anyhow::Result<()> {
    match read {
        DirRead::Fresh(_) => Ok(()),
        DirRead::Gone => {
            if !rel.is_empty() {
                forget_dir_tree(conn, drive_id, rel)?;
            }
            Ok(())
        }
        DirRead::Changed {
            mtime,
            entries,
            before,
        } => {
            replace_dir(conn, drive_id, rel, mtime, &entries)?;
            let now: Vec<&str> = entries
                .iter()
                .filter(|e| e.kind == "dir")
                .map(|e| e.name.as_str())
                .collect();
            for gone in before.iter().filter(|n| !now.contains(&n.as_str())) {
                forget_dir_tree(conn, drive_id, &join_child(rel, gone))?;
            }
            Ok(())
        }
    }
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
    // Folders are read with no lock held, then their rows are written in one
    // short transaction per batch: the drive DB uses a rollback journal, so
    // each commit costs a journal create, fsync and unlink on USB, which
    // would dominate a first scan of thousands of folders. The batch is
    // bounded by rows as well as folders so the write lock is held briefly.
    const BATCH_DIRS: usize = 200;
    const BATCH_ROWS: usize = 20_000;
    const BATCH_TIME: std::time::Duration = std::time::Duration::from_millis(500);
    let mut pending: Vec<(String, DirRead)> = Vec::new();
    let mut rows = 0usize;
    let mut since = std::time::Instant::now();
    let mut queue = std::collections::VecDeque::from([start.to_string()]);
    let mut visited = 0u64;
    while let Some(rel) = queue.pop_front() {
        if !tick() {
            break;
        }
        match read_dir_state(conn, drive_id, root, &rel, force) {
            Ok(read) => {
                // Hidden folders stay unread: search never shows them, and
                // they're where tools keep huge caches.
                queue.extend(
                    read.children(&rel)
                        .into_iter()
                        .filter(|c| !c.rsplit('/').next().unwrap_or(c).starts_with('.')),
                );
                if !matches!(read, DirRead::Fresh(_)) {
                    if pending.is_empty() {
                        since = std::time::Instant::now();
                    }
                    rows += read.weight();
                    pending.push((rel, read));
                }
            }
            // The drive going away is a failed scan; one unreadable folder
            // is just skipped.
            Err(e) if !root.is_dir() => return Err(e),
            Err(e) => tracing::debug!(drive_id, rel, error = %e, "search index skipped a folder"),
        }
        visited += 1;
        if pending.len() >= BATCH_DIRS || rows >= BATCH_ROWS || since.elapsed() >= BATCH_TIME {
            apply_batch(conn, drive_id, &mut pending);
            rows = 0;
        }
    }
    apply_batch(conn, drive_id, &mut pending);
    Ok(visited)
}

/// Write a batch of folder reads in one transaction. A folder that fails to
/// write is skipped, as is a whole batch whose commit fails; either is read
/// again on a later scan because its freshness stamp was not stored.
fn apply_batch(conn: &Connection, drive_id: &str, pending: &mut Vec<(String, DirRead)>) {
    if pending.is_empty() {
        return;
    }
    // Immediate: replace_dir reads rows before writing them, and a read lock
    // upgraded later fails at once if another connection is committing. If
    // the lock can't be had, each folder writes on its own.
    let batched = conn.is_autocommit() && conn.execute_batch("BEGIN IMMEDIATE").is_ok();
    for (rel, read) in pending.drain(..) {
        if let Err(e) = apply_dir(conn, drive_id, &rel, read) {
            tracing::debug!(drive_id, rel, error = %e, "search index skipped a folder");
        }
    }
    if batched && let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        tracing::debug!(drive_id, error = %e, "search index batch was not saved");
    }
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
    fn reindexing_keeps_private_folders_listed() {
        let dir = tempfile::tempdir().unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            dir.path(),
            &marker,
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("secret")).unwrap();
        crate::private::privatize(dir.path(), "secret", "u1").unwrap();
        std::fs::write(
            dir.path()
                .join(crate::private::disk_rel(dir.path(), "secret"))
                .join("note.txt"),
            "hi",
        )
        .unwrap();
        // Root and the private folder itself, as a write inside it triggers.
        for rel in ["", "secret"] {
            sync_dir(&conn, "d1", dir.path(), rel, true).unwrap();
        }
        let names = |parent: &str| -> Vec<String> {
            let stamp: i64 = conn
                .query_row(
                    "SELECT dir_mtime FROM indexed_dirs WHERE drive_id = 'd1' AND path = ?1",
                    [parent],
                    |r| r.get(0),
                )
                .unwrap();
            fresh_entries(&conn, "d1", parent, stamp)
                .unwrap()
                .into_iter()
                .map(|e| e.name)
                .collect()
        };
        assert!(names("").contains(&"secret".to_string()));
        assert!(names("secret").contains(&"note.txt".to_string()));
    }

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
    fn forget_dir_tree_drops_only_that_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            dir.path(),
            &marker,
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        // The folder, its subtree, and look-alikes that must survive: a
        // sibling sharing the prefix, a differently-cased one, `%`/`_` names.
        for path in ["a", "a/deep", "ab", "a0", "A", "a_b", "50%", "50%/x"] {
            replace_dir(&conn, "d1", path, 1, &[]).unwrap();
        }
        replace_dir(&conn, "d2", "a", 1, &[]).unwrap();

        forget_dir_tree(&conn, "d1", "a").unwrap();
        let left: Vec<String> = conn
            .prepare("SELECT path FROM indexed_dirs WHERE drive_id = 'd1' ORDER BY path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(left, ["50%", "50%/x", "A", "a0", "a_b", "ab"]);
        // Another drive is untouched.
        assert!(fresh_entries(&conn, "d2", "a", 1).is_some());

        forget_dir_tree(&conn, "d1", "50%").unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM indexed_dirs WHERE drive_id = 'd1' AND path LIKE '50%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    fn file(name: &str, size: u64, modified: i64) -> FileEntry {
        FileEntry {
            name: name.into(),
            kind: "file".into(),
            size,
            modified,
            hidden: false,
            saving: false,
            save_failed: false,
            original_name: None,
            original_path: None,
            link_target: None,
            caps: String::new(),
            private: false,
            in_private: false,
        }
    }

    #[test]
    fn replace_dir_writes_only_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            dir.path(),
            &marker,
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        let rowid = |name: &str| -> Option<i64> {
            conn.query_row(
                "SELECT rowid FROM index_entries WHERE drive_id = 'd1' AND parent = 'p' AND name = ?1",
                [name],
                |r| r.get(0),
            )
            .ok()
        };
        let fts = |q: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM index_fts WHERE index_fts MATCH ?1",
                [q],
                |r| r.get(0),
            )
            .unwrap()
        };
        replace_dir(
            &conn,
            "d1",
            "p",
            1,
            &[
                file("same.txt", 1, 1),
                file("grows.txt", 1, 1),
                file("gone.txt", 1, 1),
            ],
        )
        .unwrap();
        let same = rowid("same.txt").unwrap();
        let grows = rowid("grows.txt").unwrap();
        let changes_before = conn.total_changes();

        replace_dir(
            &conn,
            "d1",
            "p",
            2,
            &[
                file("same.txt", 1, 1),
                file("grows.txt", 9, 2),
                file("renamed.txt", 1, 1),
            ],
        )
        .unwrap();
        assert_eq!(rowid("same.txt"), Some(same));
        assert_eq!(rowid("grows.txt"), Some(grows));
        assert!(rowid("gone.txt").is_none());
        let size: i64 = conn
            .query_row(
                "SELECT size FROM index_entries WHERE rowid = ?1",
                [grows],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(size, 9);
        assert!(fresh_entries(&conn, "d1", "p", 2).is_some());
        assert_eq!(fts("renamed"), 1);
        assert_eq!(fts("gone"), 0);
        assert_eq!(fts("same"), 1);

        // A repeat of the same listing writes no entry rows at all; only the
        // folder's own freshness stamp changes.
        let changes = conn.total_changes();
        assert!(changes > changes_before);
        replace_dir(
            &conn,
            "d1",
            "p",
            3,
            &[
                file("same.txt", 1, 1),
                file("grows.txt", 9, 2),
                file("renamed.txt", 1, 1),
            ],
        )
        .unwrap();
        assert_eq!(conn.total_changes() - changes, 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn replace_dir_nests_inside_a_batch_and_rolls_back_alone() {
        let dir = tempfile::tempdir().unwrap();
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            dir.path(),
            &marker,
            &luna_core::marker::pick_prefix(dir.path()).unwrap(),
        )
        .unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        replace_dir(&conn, "d1", "a", 1, &[file("x.txt", 1, 1)]).unwrap();
        assert!(!conn.is_autocommit());
        conn.execute_batch("COMMIT").unwrap();
        assert!(fresh_entries(&conn, "d1", "a", 1).is_some());
    }

    #[test]
    fn scan_tree_indexes_more_folders_than_one_batch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        for i in 0..250 {
            std::fs::create_dir_all(root.join(format!("f{i}"))).unwrap();
            std::fs::write(root.join(format!("f{i}/n{i}.txt")), b"x").unwrap();
        }
        let marker = luna_core::marker::Marker::new("d1", "D");
        let conn = crate::drives::drive_db::create(
            &root,
            &marker,
            &luna_core::marker::pick_prefix(&root).unwrap(),
        )
        .unwrap();
        let visited = scan_tree(&conn, "d1", &root, "", true, &mut || true).unwrap();
        assert_eq!(visited, 251);
        assert!(conn.is_autocommit());
        let files: i64 = conn
            .query_row(
                "SELECT count(*) FROM index_entries
                 WHERE drive_id = 'd1' AND parent != '' AND kind = 'file'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(files, 250);
    }
}
