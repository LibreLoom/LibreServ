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
            mount_point TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )?;
    ensure_column(&conn, "drives", "mount_point", "TEXT NOT NULL DEFAULT ''")?;
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
    pub mount_point: String,
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut found = false;
    for col in cols {
        if col? == column {
            found = true;
            break;
        }
    }
    if !found {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

pub fn list_drives(conn: &Connection) -> anyhow::Result<Vec<DriveRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, state, fs_type, device, mount_point FROM drives ORDER BY label, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(DriveRow {
            id: row.get(0)?,
            label: row.get(1)?,
            state: row.get(2)?,
            fs_type: row.get(3)?,
            device: row.get(4)?,
            mount_point: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_drive(conn: &Connection, id: &str) -> anyhow::Result<Option<DriveRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, state, fs_type, device, mount_point FROM drives WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(DriveRow {
            id: row.get(0)?,
            label: row.get(1)?,
            state: row.get(2)?,
            fs_type: row.get(3)?,
            device: row.get(4)?,
            mount_point: row.get(5)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn upsert_drive(
    conn: &Connection,
    id: &str,
    label: &str,
    state: &str,
    fs_type: &str,
    device: &str,
    mount_point: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO drives (id, label, state, fs_type, device, mount_point, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           state = excluded.state,
           fs_type = excluded.fs_type,
           device = excluded.device,
           mount_point = excluded.mount_point,
           updated_at = excluded.updated_at",
        params![id, label, state, fs_type, device, mount_point, now],
    )?;
    Ok(())
}

pub fn set_drive_state(conn: &Connection, id: &str, state: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE drives SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state, now_unix()],
    )?;
    Ok(())
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
