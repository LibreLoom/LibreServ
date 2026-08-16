use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::params;

/// Open (and initialize) the metadata database.
///
/// The index lives on the OS disk. Drives only carry their `.luna` marker, so
/// a lost system disk is rebuilt by re-scanning the drives themselves.
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS drives (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            state TEXT NOT NULL,
            fs_type TEXT NOT NULL DEFAULT '',
            device TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    Ok(conn)
}

/// A drive row as stored in the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveRow {
    pub id: String,
    pub label: String,
    pub state: String,
    pub fs_type: String,
    pub device: String,
}

pub fn list_drives(conn: &Connection) -> anyhow::Result<Vec<DriveRow>> {
    let mut stmt =
        conn.prepare("SELECT id, label, state, fs_type, device FROM drives ORDER BY label, id")?;
    let rows = stmt.query_map([], |row| {
        Ok(DriveRow {
            id: row.get(0)?,
            label: row.get(1)?,
            state: row.get(2)?,
            fs_type: row.get(3)?,
            device: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_meta(conn: &Connection, key: &str) -> anyhow::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
        .flatten())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_and_round_trip_meta() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        set_meta(&conn, "device_id", "test-id").unwrap();
        assert_eq!(
            get_meta(&conn, "device_id").unwrap().as_deref(),
            Some("test-id")
        );
        assert!(list_drives(&conn).unwrap().is_empty());
    }
}
