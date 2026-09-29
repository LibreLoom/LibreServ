//! Per-user recent items tracking in SQLite.
//!
//! When files or folders are visited, they are recorded into `user_recents`.
//! When a file or folder is moved or renamed, its recent entries are updated
//! and deduplicated. When a file is trashed or deleted, its recent entries
//! are removed.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::access::normalize_subject_path;

pub const RECENTS_LIMIT_PER_USER: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentItem {
    pub kind: String,
    #[serde(rename = "driveId", alias = "drive_id")]
    pub drive_id: String,
    pub path: String,
    pub at: i64,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_recents (
            user_id TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL,
            accessed_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, drive_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_user_recents_user_accessed
        ON user_recents (user_id, accessed_at DESC);",
    )
}

fn is_trash(path: &str) -> bool {
    let alias = super::TRASH_API_ALIAS;
    path == alias || path.starts_with(&format!("{alias}/"))
}

/// Record an accessed item for `user_id`.
pub fn record(
    conn: &Connection,
    user_id: &str,
    drive_id: &str,
    path: &str,
    kind: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    let path = normalize_subject_path(path);
    if is_trash(&path) || drive_id.is_empty() || user_id.is_empty() {
        return Ok(());
    }
    let kind = match kind {
        "file" | "folder" | "drive" => kind,
        _ => {
            if path.is_empty() {
                "drive"
            } else {
                "file"
            }
        }
    };

    conn.execute(
        "INSERT INTO user_recents (user_id, drive_id, path, kind, accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, drive_id, path) DO UPDATE SET
            accessed_at = excluded.accessed_at,
            kind = excluded.kind",
        params![user_id, drive_id, path, kind, now_ms],
    )?;

    // Keep table small per user
    conn.execute(
        "DELETE FROM user_recents
         WHERE user_id = ?1
           AND rowid NOT IN (
               SELECT rowid FROM user_recents
               WHERE user_id = ?1
               ORDER BY accessed_at DESC
               LIMIT ?2
           )",
        params![user_id, RECENTS_LIMIT_PER_USER],
    )?;

    Ok(())
}

/// Retarget recents after a move or rename.
/// Merges duplicates if the target path is already recorded for that user,
/// keeping the newer timestamp.
pub fn repath(
    conn: &Connection,
    old_drive: &str,
    old_path: &str,
    new_drive: &str,
    new_path: &str,
) -> anyhow::Result<()> {
    let old_path = normalize_subject_path(old_path);
    let new_path = normalize_subject_path(new_path);
    if old_path.is_empty()
        || new_path.is_empty()
        || is_trash(&old_path)
        || is_trash(&new_path)
        || (old_drive == new_drive && old_path == new_path)
    {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT user_id, path, kind, accessed_at
         FROM user_recents
         WHERE drive_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
    )?;

    let rows: Vec<(String, String, String, i64)> = stmt
        .query_map(params![old_drive, old_path], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for (user_id, current_path, kind, accessed_at) in rows {
        let suffix = &current_path[old_path.len()..];
        let target_path = format!("{new_path}{suffix}");

        // Delete old row
        conn.execute(
            "DELETE FROM user_recents WHERE user_id = ?1 AND drive_id = ?2 AND path = ?3",
            params![user_id, old_drive, current_path],
        )?;

        // Insert or update target with max accessed_at (deduplicating cleanly)
        conn.execute(
            "INSERT INTO user_recents (user_id, drive_id, path, kind, accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, drive_id, path) DO UPDATE SET
                accessed_at = max(user_recents.accessed_at, excluded.accessed_at)",
            params![user_id, new_drive, target_path, kind, accessed_at],
        )?;
    }

    Ok(())
}

/// Delete recents at or under `path` on `drive_id` (e.g. when trashed).
pub fn drop_under(conn: &Connection, drive_id: &str, path: &str) -> anyhow::Result<usize> {
    let path = normalize_subject_path(path);
    if path.is_empty() {
        return Ok(0);
    }
    let count = conn.execute(
        "DELETE FROM user_recents
         WHERE drive_id = ?1
           AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
        params![drive_id, path],
    )?;
    Ok(count)
}

/// Remove a single item from a user's recents.
pub fn remove(
    conn: &Connection,
    user_id: &str,
    drive_id: &str,
    path: &str,
) -> anyhow::Result<usize> {
    let path = normalize_subject_path(path);
    let count = conn.execute(
        "DELETE FROM user_recents
         WHERE user_id = ?1 AND drive_id = ?2 AND path = ?3",
        params![user_id, drive_id, path],
    )?;
    Ok(count)
}

/// Clear all recents for a user.
pub fn clear_user(conn: &Connection, user_id: &str) -> anyhow::Result<usize> {
    let count = conn.execute(
        "DELETE FROM user_recents WHERE user_id = ?1",
        params![user_id],
    )?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn record_and_repath_renamed_file_without_duplicates() {
        let conn = test_conn();
        record(&conn, "user1", "d1", "whiteboard.excalidraw", "file", 1000).unwrap();

        // Also simulate user accessing 67.excalidraw at a later time
        record(&conn, "user1", "d1", "67.excalidraw", "file", 2000).unwrap();

        // Now repath whiteboard.excalidraw -> 67.excalidraw
        repath(&conn, "d1", "whiteboard.excalidraw", "d1", "67.excalidraw").unwrap();

        // There should be only ONE entry for 67.excalidraw and 0 for whiteboard.excalidraw
        let mut stmt = conn
            .prepare("SELECT path, accessed_at FROM user_recents WHERE user_id = 'user1'")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "67.excalidraw");
        assert_eq!(rows[0].1, 2000); // kept maximum timestamp
    }

    #[test]
    fn repath_moves_folder_tree() {
        let conn = test_conn();
        record(&conn, "user1", "d1", "projects/a.txt", "file", 1000).unwrap();
        record(&conn, "user1", "d1", "projects/b.txt", "file", 1500).unwrap();
        record(&conn, "user1", "d1", "other/c.txt", "file", 2000).unwrap();

        repath(&conn, "d1", "projects", "d1", "archive/projects").unwrap();

        let mut stmt = conn
            .prepare("SELECT path FROM user_recents WHERE user_id = 'user1' ORDER BY path")
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(
            paths,
            vec![
                "archive/projects/a.txt".to_string(),
                "archive/projects/b.txt".to_string(),
                "other/c.txt".to_string(),
            ]
        );
    }

    #[test]
    fn drop_under_removes_trashed_items() {
        let conn = test_conn();
        record(&conn, "user1", "d1", "notes/quick.md", "file", 1000).unwrap();
        record(&conn, "user2", "d1", "notes/quick.md", "file", 1050).unwrap();
        record(&conn, "user1", "d1", "docs/keep.md", "file", 2000).unwrap();

        let dropped = drop_under(&conn, "d1", "notes").unwrap();
        assert_eq!(dropped, 2);

        let mut stmt = conn
            .prepare("SELECT path FROM user_recents ORDER BY path")
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(paths, vec!["docs/keep.md".to_string()]);
    }
}
