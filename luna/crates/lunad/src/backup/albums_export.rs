//! Albums in a backup (plan §2). Albums live in the drive's database and
//! can't be rebuilt from files, so a backup saves them as data. Private items
//! are left out, and favorites are not backed up.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::access::{normalize_subject_path, path_contains};

/// Name of the album list a backup writes next to its manifest.
pub const ALBUMS_FILE: &str = "albums.json";

/// One album as stored in a backup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumExport {
    pub name: String,
    pub owner_user_id: String,
    pub created_at: i64,
    /// Item paths relative to the backup source root, `/`-joined.
    pub items: Vec<String>,
}

/// Albums with at least one item under `source_path` on `drive_id`. Items are
/// kept only when they are under the source and not private.
pub fn export(conn: &Connection, drive_id: &str, source_path: &str) -> Result<Vec<AlbumExport>> {
    export_with(conn, drive_id, source_path, |path| {
        crate::auth::inside_private(conn, drive_id, path)
    })
}

/// [`export`] with the private check passed in, so tests need no drive setup.
fn export_with<F>(
    conn: &Connection,
    drive_id: &str,
    source_path: &str,
    is_private: F,
) -> Result<Vec<AlbumExport>>
where
    F: Fn(&str) -> bool,
{
    let source = normalize_subject_path(source_path);
    let source_name = source.rsplit('/').next().unwrap_or_default().to_string();

    let mut albums_stmt = conn.prepare(
        "SELECT id, owner_user_id, name, created_at FROM albums ORDER BY created_at, id",
    )?;
    let albums = albums_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut items_stmt = conn.prepare(
        "SELECT path FROM album_items WHERE album_id = ?1 AND drive_id = ?2 ORDER BY added_at, path",
    )?;

    let mut out = Vec::new();
    for (album_id, owner_user_id, name, created_at) in albums {
        let paths = items_stmt
            .query_map(params![album_id, drive_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut items = Vec::new();
        for raw in paths {
            let path = normalize_subject_path(&raw);
            if path.is_empty() || !path_contains(&source, &path) {
                continue;
            }
            if is_private(&path) {
                continue;
            }
            // A single-file source: the item is the file itself, named by its own name.
            let rel = if path == source {
                source_name.clone()
            } else if source.is_empty() {
                path
            } else {
                path[source.len() + 1..].to_string()
            };
            items.push(rel);
        }

        if items.is_empty() {
            continue;
        }
        out.push(AlbumExport {
            name,
            owner_user_id,
            created_at,
            items,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE albums (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );
             CREATE TABLE album_items (
                album_id TEXT NOT NULL,
                drive_id TEXT NOT NULL,
                path TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                PRIMARY KEY (album_id, drive_id, path)
             );",
        )
        .unwrap();
        conn
    }

    fn add_album(conn: &Connection, id: &str, name: &str, items: &[(&str, &str)]) {
        conn.execute(
            "INSERT INTO albums (id, owner_user_id, name, created_at) VALUES (?1, 'u1', ?2, 100)",
            params![id, name],
        )
        .unwrap();
        for (drive, path) in items {
            conn.execute(
                "INSERT INTO album_items (album_id, drive_id, path, added_at) VALUES (?1, ?2, ?3, 1)",
                params![id, drive, path],
            )
            .unwrap();
        }
    }

    fn no_private(_: &str) -> bool {
        false
    }

    #[test]
    fn album_outside_source_is_excluded_and_items_made_relative() {
        let conn = fixture();
        add_album(
            &conn,
            "inside",
            "Trip",
            &[
                ("d1", "photos/2024/a.jpg"),
                ("d1", "photos/b.jpg"),
                ("d1", "docs/c.jpg"),
                ("d2", "photos/other-drive.jpg"),
            ],
        );
        add_album(&conn, "outside", "Work", &[("d1", "docs/x.jpg")]);

        let got = export_with(&conn, "d1", "photos", no_private).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Trip");
        assert_eq!(got[0].owner_user_id, "u1");
        assert_eq!(got[0].created_at, 100);
        assert_eq!(got[0].items, vec!["2024/a.jpg", "b.jpg"]);
    }

    #[test]
    fn private_item_is_dropped() {
        let conn = fixture();
        add_album(
            &conn,
            "a",
            "Mixed",
            &[("d1", "photos/ok.jpg"), ("d1", "photos/secret/x.jpg")],
        );
        let got = export_with(&conn, "d1", "photos", |p| p.starts_with("photos/secret")).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].items, vec!["ok.jpg"]);
    }

    #[test]
    fn album_left_empty_is_dropped() {
        let conn = fixture();
        add_album(&conn, "a", "All private", &[("d1", "photos/secret/x.jpg")]);
        let got = export_with(&conn, "d1", "photos", |p| p.starts_with("photos/secret")).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn whole_drive_source_keeps_full_paths() {
        let conn = fixture();
        add_album(&conn, "a", "All", &[("d1", "photos/a.jpg")]);
        let got = export_with(&conn, "d1", "", no_private).unwrap();
        assert_eq!(got[0].items, vec!["photos/a.jpg"]);
    }
}
