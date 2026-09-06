//! Per-drive SQLite microdb: the `.luna` file at each drive root.
//!
//! Holds drive identity plus high-churn metadata that must not wear the OS
//! eMMC: file index, scrub hashes, gallery, trash paths, and upload sessions.
//! Uses DELETE journal mode so adopt never leaves `.luna-wal` / `.luna-shm`
//! next to the root marker.
//!
//! Central `luna.db` still owns users, grants, shares, protection *rules*,
//! jobs, and the thin drives registry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use luna_core::marker::{MARKER_FILE_NAME, Marker};
use rusqlite::{Connection, OptionalExtension, params};

/// Open or create `{root}/.luna` and apply the full drive schema.
pub fn open(root: &Path) -> anyhow::Result<Connection> {
    let path = root.join(MARKER_FILE_NAME);
    if path.is_file() {
        if let Ok(bytes) = std::fs::read(&path) {
            if bytes.first() == Some(&b'{') {
                let marker: Marker = serde_json::from_slice(&bytes)
                    .map_err(|e| anyhow::anyhow!("legacy .luna marker: {e}"))?;
                luna_core::marker::write_marker(root, &marker)
                    .map_err(|e| anyhow::anyhow!("upgrade .luna marker: {e}"))?;
            }
        }
    }
    let conn = Connection::open(&path)?;
    configure(&conn)?;
    migrate_schema(&conn)?;
    migrate_legacy_gallery(root, &conn)?;
    migrate_legacy_trash_meta(root, &conn)?;
    Ok(conn)
}

/// Create or claim a `.luna` microdb with identity, then apply the full schema.
///
/// If `.luna` already exists as a SQLite microdb, identity is updated in place
/// and other tables (index, gallery, hashes, uploads, trash) are preserved.
/// When the drive id changes, `drive_id` columns are rewritten to match.
pub fn create(root: &Path, marker: &Marker) -> anyhow::Result<Connection> {
    let path = root.join(MARKER_FILE_NAME);
    if path.is_file() {
        // Open first so JSON stickers upgrade and the full schema exists, then
        // claim identity in place so index/gallery/hash/upload tables survive.
        let conn = open(root)?;
        if let Some(old) = read_identity(&conn)? {
            if old.id != marker.id {
                rewrite_drive_ids(&conn, &old.id, &marker.id)?;
            }
        }
        upsert_identity(&conn, marker)?;
        return Ok(conn);
    }
    luna_core::marker::write_marker(root, marker)
        .map_err(|e| anyhow::anyhow!("could not create drive database: {e}"))?;
    open(root)
}

fn upsert_identity(conn: &Connection, marker: &Marker) -> anyhow::Result<()> {
    conn.execute("DELETE FROM identity", [])?;
    conn.execute(
        "INSERT INTO identity (id, label, format_version) VALUES (?1, ?2, ?3)",
        params![marker.id, marker.label, marker.v as i64],
    )?;
    Ok(())
}

fn rewrite_drive_ids(conn: &Connection, old_id: &str, new_id: &str) -> anyhow::Result<()> {
    for sql in [
        "UPDATE index_entries SET drive_id = ?1 WHERE drive_id = ?2",
        "UPDATE indexed_dirs SET drive_id = ?1 WHERE drive_id = ?2",
        "UPDATE file_hashes SET drive_id = ?1 WHERE drive_id = ?2",
        "UPDATE uploads SET drive_id = ?1 WHERE drive_id = ?2",
        "UPDATE album_items SET drive_id = ?1 WHERE drive_id = ?2",
    ] {
        conn.execute(sql, params![new_id, old_id])?;
    }
    Ok(())
}

/// Copy drive-scoped rows left in central `luna.db` (pre-microdb) into `.luna`.
///
/// Safe to call repeatedly: uses `INSERT OR IGNORE`, then deletes the migrated
/// central rows for this drive. When every legacy table is empty, drops them.
pub fn migrate_from_central(
    central: &Connection,
    drive_id: &str,
    dest: &Connection,
) -> anyhow::Result<()> {
    if !central_has_legacy_drive_tables(central) {
        return Ok(());
    }

    if table_exists(central, "index_entries") {
        let mut stmt = central.prepare(
            "SELECT drive_id, parent, name, kind, size, modified, hidden
             FROM index_entries WHERE drive_id = ?1",
        )?;
        let rows = stmt.query_map(params![drive_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        {
            let mut insert = dest.prepare(
                "INSERT OR IGNORE INTO index_entries
                 (drive_id, parent, name, kind, size, modified, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for row in rows.flatten() {
                let (d, parent, name, kind, size, modified, hidden) = row;
                insert.execute(params![d, parent, name, kind, size, modified, hidden])?;
            }
        }
        let _ = central.execute(
            "DELETE FROM index_entries WHERE drive_id = ?1",
            params![drive_id],
        );
    }

    if table_exists(central, "indexed_dirs") {
        let mut stmt = central.prepare(
            "SELECT drive_id, path, dir_mtime, indexed_at FROM indexed_dirs WHERE drive_id = ?1",
        )?;
        let rows = stmt.query_map(params![drive_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        {
            let mut insert = dest.prepare(
                "INSERT OR IGNORE INTO indexed_dirs (drive_id, path, dir_mtime, indexed_at)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for row in rows.flatten() {
                let (d, path, dir_mtime, indexed_at) = row;
                insert.execute(params![d, path, dir_mtime, indexed_at])?;
            }
        }
        let _ = central.execute(
            "DELETE FROM indexed_dirs WHERE drive_id = ?1",
            params![drive_id],
        );
    }

    if table_exists(central, "file_hashes") {
        let mut stmt = central.prepare(
            "SELECT drive_id, path, size, mtime, hash, verified_at
             FROM file_hashes WHERE drive_id = ?1",
        )?;
        let rows = stmt.query_map(params![drive_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        {
            let mut insert = dest.prepare(
                "INSERT OR IGNORE INTO file_hashes
                 (drive_id, path, size, mtime, hash, verified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for row in rows.flatten() {
                let (d, path, size, mtime, hash, verified_at) = row;
                insert.execute(params![d, path, size, mtime, hash, verified_at])?;
            }
        }
        let _ = central.execute(
            "DELETE FROM file_hashes WHERE drive_id = ?1",
            params![drive_id],
        );
    }

    if table_exists(central, "uploads") {
        let mut stmt = central.prepare(
            "SELECT id, drive_id, path, name, size, received, state, error, created_at, updated_at
             FROM uploads WHERE drive_id = ?1",
        )?;
        let rows = stmt.query_map(params![drive_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7).unwrap_or_default(),
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
            ))
        })?;
        let mut upload_ids = Vec::new();
        {
            let mut insert = dest.prepare(
                "INSERT OR IGNORE INTO uploads
                 (id, drive_id, path, name, size, received, state, error, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for row in rows.flatten() {
                let (id, d, path, name, size, received, state, error, created_at, updated_at) = row;
                insert.execute(params![
                    id, d, path, name, size, received, state, error, created_at, updated_at
                ])?;
                upload_ids.push(id);
            }
        }
        if table_exists(central, "upload_chunks") {
            let mut insert_chunk = dest.prepare(
                "INSERT OR IGNORE INTO upload_chunks (upload_id, start, end) VALUES (?1, ?2, ?3)",
            )?;
            for upload_id in &upload_ids {
                let mut chunk_stmt = central.prepare(
                    "SELECT upload_id, start, end FROM upload_chunks WHERE upload_id = ?1",
                )?;
                let chunks = chunk_stmt.query_map(params![upload_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?;
                for chunk in chunks.flatten() {
                    let (uid, start, end) = chunk;
                    insert_chunk.execute(params![uid, start, end])?;
                }
                let _ = central.execute(
                    "DELETE FROM upload_chunks WHERE upload_id = ?1",
                    params![upload_id],
                );
            }
        }
        let _ = central.execute("DELETE FROM uploads WHERE drive_id = ?1", params![drive_id]);
    }

    drop_legacy_drive_tables_if_empty(central);
    Ok(())
}

fn central_has_legacy_drive_tables(central: &Connection) -> bool {
    ["index_entries", "indexed_dirs", "file_hashes", "uploads"]
        .iter()
        .any(|t| table_exists(central, t))
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |_| Ok(()),
    )
    .is_ok()
}

fn drop_legacy_drive_tables_if_empty(central: &Connection) {
    for table in [
        "index_entries",
        "indexed_dirs",
        "file_hashes",
        "upload_chunks",
        "uploads",
    ] {
        if !table_exists(central, table) {
            continue;
        }
        let count: i64 = central
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap_or(1);
        if count == 0 {
            let _ = central.execute_batch(&format!("DROP TABLE IF EXISTS {table};"));
        }
    }
}

/// Open a drive microdb and pull any leftover central rows for this drive.
pub fn open_migrating(
    root: &Path,
    central: &Connection,
    drive_id: &str,
) -> anyhow::Result<Connection> {
    let conn = open(root)?;
    migrate_from_central(central, drive_id, &conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    // Root-file hygiene: never leave -wal/-shm siblings beside `.luna`.
    conn.pragma_update(None, "journal_mode", "DELETE")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -8192i64)?;
    Ok(())
}

pub fn migrate_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS identity (
            id TEXT PRIMARY KEY NOT NULL,
            label TEXT NOT NULL,
            format_version INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS index_entries (
            drive_id TEXT NOT NULL,
            parent TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            hidden INTEGER NOT NULL,
            PRIMARY KEY (drive_id, parent, name)
         );
         CREATE TABLE IF NOT EXISTS indexed_dirs (
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            dir_mtime INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL,
            PRIMARY KEY (drive_id, path)
         );
         CREATE INDEX IF NOT EXISTS index_entries_name
            ON index_entries(name COLLATE NOCASE);
         CREATE TABLE IF NOT EXISTS file_hashes (
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            hash TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            PRIMARY KEY (drive_id, path)
         );
         CREATE TABLE IF NOT EXISTS photos (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            taken_at INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'image',
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            lat REAL,
            lon REAL,
            place_label TEXT NOT NULL DEFAULT '',
            has_thumb INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS photos_timeline
            ON photos(taken_at DESC, mtime DESC, path);
         CREATE INDEX IF NOT EXISTS photos_place
            ON photos(lat, lon);
         CREATE TABLE IF NOT EXISTS favorites (
            user_id TEXT NOT NULL,
            path TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, path)
         );
         CREATE TABLE IF NOT EXISTS albums (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            cover_path TEXT NOT NULL DEFAULT '',
            shared INTEGER NOT NULL DEFAULT 0,
            allow_uploads INTEGER NOT NULL DEFAULT 0,
            contrib_path TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS album_items (
            album_id TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (album_id, drive_id, path)
         );
         CREATE TABLE IF NOT EXISTS album_members (
            album_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (album_id, user_id)
         );
         CREATE TABLE IF NOT EXISTS album_invites (
            id TEXT PRIMARY KEY,
            album_id TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            expires_at INTEGER,
            password_hash TEXT,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS album_invites_token ON album_invites(token);
         CREATE TABLE IF NOT EXISTS trash_meta (
            entry_name TEXT PRIMARY KEY NOT NULL,
            original_path TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS uploads (
            id TEXT PRIMARY KEY,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            received INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS upload_chunks (
            upload_id TEXT NOT NULL,
            start INTEGER NOT NULL,
            end INTEGER NOT NULL,
            PRIMARY KEY (upload_id, start)
         );",
    )?;
    Ok(())
}

/// Copy rows from a legacy `{root}/.lunagallery/gallery.sqlite` into `.luna`.
fn migrate_legacy_gallery(root: &Path, dest: &Connection) -> anyhow::Result<()> {
    let legacy = root.join(".lunagallery").join("gallery.sqlite");
    if !legacy.is_file() {
        return Ok(());
    }
    let photos: i64 = dest
        .query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))
        .unwrap_or(0);
    if photos > 0 {
        return Ok(());
    }
    let path_str = legacy.to_string_lossy().replace('\'', "''");
    dest.execute_batch(&format!("ATTACH DATABASE '{path_str}' AS legacy_gallery;"))?;
    let copy = dest.execute_batch(
        "INSERT OR IGNORE INTO photos SELECT * FROM legacy_gallery.photos;
         INSERT OR IGNORE INTO favorites SELECT * FROM legacy_gallery.favorites;
         INSERT OR IGNORE INTO albums SELECT * FROM legacy_gallery.albums;
         INSERT OR IGNORE INTO album_items SELECT * FROM legacy_gallery.album_items;
         INSERT OR IGNORE INTO album_members SELECT * FROM legacy_gallery.album_members;
         INSERT OR IGNORE INTO album_invites SELECT * FROM legacy_gallery.album_invites;",
    );
    let _ = dest.execute_batch("DETACH DATABASE legacy_gallery;");
    copy?;
    // Best-effort cleanup of the old gallery DB directory.
    let _ = std::fs::remove_file(&legacy);
    let _ = std::fs::remove_file(root.join(".lunagallery/gallery.sqlite-wal"));
    let _ = std::fs::remove_file(root.join(".lunagallery/gallery.sqlite-shm"));
    let gallery_dir = root.join(".lunagallery");
    let _ = std::fs::remove_dir(&gallery_dir);
    Ok(())
}

/// Import `.luna-trash/.meta/*.json` sidecars into `trash_meta`, then delete them.
fn migrate_legacy_trash_meta(root: &Path, conn: &Connection) -> anyhow::Result<()> {
    let meta_dir = root.join(".luna-trash").join(".meta");
    if !meta_dir.is_dir() {
        return Ok(());
    }
    let rd = match std::fs::read_dir(&meta_dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let Some(original) = v.get("original_path").and_then(|x| x.as_str()) else {
            continue;
        };
        let _ = conn.execute(
            "INSERT OR REPLACE INTO trash_meta (entry_name, original_path) VALUES (?1, ?2)",
            params![stem, original],
        );
        let _ = std::fs::remove_file(&path);
    }
    let _ = std::fs::remove_dir(&meta_dir);
    Ok(())
}

pub fn read_identity(conn: &Connection) -> anyhow::Result<Option<Marker>> {
    let row = conn
        .query_row(
            "SELECT id, label, format_version FROM identity LIMIT 1",
            [],
            |r| {
                Ok(Marker {
                    v: r.get::<_, i64>(2)? as u32,
                    id: r.get(0)?,
                    label: r.get(1)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_label(conn: &Connection, label: &str) -> anyhow::Result<()> {
    conn.execute("UPDATE identity SET label = ?1", params![label])?;
    Ok(())
}

pub fn path_for(root: &Path) -> PathBuf {
    root.join(MARKER_FILE_NAME)
}

/// In-memory pool of open per-drive connections, keyed by drive id.
#[derive(Default)]
pub struct DriveDbPool {
    inner: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl DriveDbPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, drive_id: &str, root: &Path) -> anyhow::Result<Arc<Mutex<Connection>>> {
        let mut map = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("drive db pool poisoned"))?;
        if let Some(existing) = map.get(drive_id) {
            return Ok(existing.clone());
        }
        let conn = open(root)?;
        let arc = Arc::new(Mutex::new(conn));
        map.insert(drive_id.to_string(), arc.clone());
        Ok(arc)
    }

    pub fn get(&self, drive_id: &str) -> Option<Arc<Mutex<Connection>>> {
        self.inner.lock().ok()?.get(drive_id).cloned()
    }

    pub fn close(&self, drive_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            if let Some(arc) = map.remove(drive_id) {
                // Checkpoint/close by dropping the last Arc when callers release.
                drop(arc);
            }
        }
    }

    pub fn with_drive<F, T>(&self, drive_id: &str, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        let arc = self
            .get(drive_id)
            .ok_or_else(|| anyhow::anyhow!("drive database is not open"))?;
        let conn = arc
            .lock()
            .map_err(|_| anyhow::anyhow!("drive database lock poisoned"))?;
        f(&conn)
    }

    /// Fan-out helper: run `f` on every currently open drive DB.
    pub fn for_each_open<F>(&self, mut f: F) -> anyhow::Result<()>
    where
        F: FnMut(&str, &Connection) -> anyhow::Result<()>,
    {
        let snapshot: Vec<(String, Arc<Mutex<Connection>>)> = {
            let map = self
                .inner
                .lock()
                .map_err(|_| anyhow::anyhow!("drive db pool poisoned"))?;
            map.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        for (id, arc) in snapshot {
            let conn = arc
                .lock()
                .map_err(|_| anyhow::anyhow!("drive database lock poisoned"))?;
            f(&id, &conn)?;
        }
        Ok(())
    }

    pub fn find_upload(
        &self,
        upload_id: &str,
    ) -> anyhow::Result<Option<(String, crate::db::UploadRow)>> {
        let snapshot: Vec<(String, Arc<Mutex<Connection>>)> = {
            let map = self
                .inner
                .lock()
                .map_err(|_| anyhow::anyhow!("drive db pool poisoned"))?;
            map.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        for (drive_id, arc) in snapshot {
            let conn = arc
                .lock()
                .map_err(|_| anyhow::anyhow!("drive database lock poisoned"))?;
            if let Some(row) = crate::db::get_upload(&conn, upload_id)? {
                return Ok(Some((drive_id, row)));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_open_round_trip_identity_and_no_wal_sidecars() {
        let dir = tempdir().unwrap();
        let marker = Marker::new("drive-1", "Photos");
        create(dir.path(), &marker).unwrap();
        let conn = open(dir.path()).unwrap();
        let id = read_identity(&conn).unwrap().unwrap();
        assert_eq!(id.id, "drive-1");
        assert_eq!(id.label, "Photos");
        drop(conn);
        assert!(dir.path().join(".luna").is_file());
        assert!(!dir.path().join(".luna-wal").exists());
        assert!(!dir.path().join(".luna-shm").exists());
    }

    #[test]
    fn migrates_legacy_trash_meta_json() {
        let dir = tempdir().unwrap();
        let marker = Marker::new("d1", "D");
        create(dir.path(), &marker).unwrap();
        let meta = dir.path().join(".luna-trash/.meta");
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("123-photo.jpg.json"),
            br#"{"original_path":"album/photo.jpg"}"#,
        )
        .unwrap();
        let conn = open(dir.path()).unwrap();
        let path: String = conn
            .query_row(
                "SELECT original_path FROM trash_meta WHERE entry_name = ?1",
                params!["123-photo.jpg"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(path, "album/photo.jpg");
        assert!(!meta.join("123-photo.jpg.json").exists());
    }

    #[test]
    fn create_preserves_existing_microdb_tables() {
        let dir = tempdir().unwrap();
        let first = Marker::new("old-id", "Old");
        let conn = create(dir.path(), &first).unwrap();
        conn.execute(
            "INSERT INTO photos (path, name, size, mtime, taken_at, kind)
             VALUES ('a.jpg', 'a.jpg', 10, 1, 1, 'image')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO index_entries (drive_id, parent, name, kind, size, modified, hidden)
             VALUES ('old-id', '', 'a.jpg', 'file', 10, 1, 0)",
            [],
        )
        .unwrap();
        drop(conn);

        let second = Marker::new("new-id", "New Label");
        let conn = create(dir.path(), &second).unwrap();
        let id = read_identity(&conn).unwrap().unwrap();
        assert_eq!(id.id, "new-id");
        assert_eq!(id.label, "New Label");
        let photos: i64 = conn
            .query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(photos, 1, "gallery rows must survive re-claim");
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE drive_id = 'new-id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1, "drive_id columns must be rewritten");
        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE drive_id = 'old-id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0);
    }

    #[test]
    fn migrates_central_index_hashes_and_uploads() {
        let dir = tempdir().unwrap();
        let central_path = dir.path().join("luna.db");
        let central = Connection::open(&central_path).unwrap();
        central
            .execute_batch(
                "CREATE TABLE index_entries (
                    drive_id TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL,
                    kind TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL,
                    hidden INTEGER NOT NULL, PRIMARY KEY (drive_id, parent, name));
                 CREATE TABLE indexed_dirs (
                    drive_id TEXT NOT NULL, path TEXT NOT NULL, dir_mtime INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL, PRIMARY KEY (drive_id, path));
                 CREATE TABLE file_hashes (
                    drive_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
                    mtime INTEGER NOT NULL, hash TEXT NOT NULL, verified_at INTEGER NOT NULL,
                    PRIMARY KEY (drive_id, path));
                 CREATE TABLE uploads (
                    id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, path TEXT NOT NULL,
                    name TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL,
                    state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE upload_chunks (
                    upload_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
                    PRIMARY KEY (upload_id, start));",
            )
            .unwrap();
        central
            .execute(
                "INSERT INTO index_entries VALUES ('d1', '', 'x.txt', 'file', 3, 1, 0)",
                [],
            )
            .unwrap();
        central
            .execute(
                "INSERT INTO indexed_dirs VALUES ('d1', '', 1, 2)",
                [],
            )
            .unwrap();
        central
            .execute(
                "INSERT INTO file_hashes VALUES ('d1', 'x.txt', 3, 1, 'abc', 2)",
                [],
            )
            .unwrap();
        central
            .execute(
                "INSERT INTO uploads VALUES ('u1', 'd1', '', 'x.txt', 3, 1, 'active', '', 1, 1)",
                [],
            )
            .unwrap();
        central
            .execute("INSERT INTO upload_chunks VALUES ('u1', 0, 1)", [])
            .unwrap();
        // Other drive stays until its own migrate.
        central
            .execute(
                "INSERT INTO index_entries VALUES ('d2', '', 'y.txt', 'file', 1, 1, 0)",
                [],
            )
            .unwrap();

        let root = dir.path().join("drive");
        std::fs::create_dir_all(&root).unwrap();
        let dest = create(&root, &Marker::new("d1", "D")).unwrap();
        migrate_from_central(&central, "d1", &dest).unwrap();

        let n: i64 = dest
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE drive_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        let hash: String = dest
            .query_row(
                "SELECT hash FROM file_hashes WHERE path = 'x.txt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hash, "abc");
        let upload: String = dest
            .query_row("SELECT id FROM uploads WHERE id = 'u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(upload, "u1");
        let chunk: i64 = dest
            .query_row(
                "SELECT end FROM upload_chunks WHERE upload_id = 'u1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chunk, 1);

        let left: i64 = central
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE drive_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
        let other: i64 = central
            .query_row(
                "SELECT COUNT(*) FROM index_entries WHERE drive_id = 'd2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(other, 1);
        assert!(
            table_exists(&central, "index_entries"),
            "legacy tables remain until every drive is migrated"
        );
    }
}
