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

/// Create a fresh `.luna` microdb with identity, then apply the full schema.
pub fn create(root: &Path, marker: &Marker) -> anyhow::Result<Connection> {
    luna_core::marker::write_marker(root, marker)
        .map_err(|e| anyhow::anyhow!("could not create drive database: {e}"))?;
    open(root)
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
}
