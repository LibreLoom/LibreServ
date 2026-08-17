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
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            from_drive TEXT NOT NULL DEFAULT '',
            from_path TEXT NOT NULL DEFAULT '',
            to_drive TEXT NOT NULL DEFAULT '',
            to_path TEXT NOT NULL DEFAULT '',
            progress INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grants (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL DEFAULT '',
            permission TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            password_hash TEXT NOT NULL DEFAULT '',
            expires_at INTEGER,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL
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
        CREATE TABLE IF NOT EXISTS file_hashes (
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            hash TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            PRIMARY KEY (drive_id, path)
        );
        CREATE TABLE IF NOT EXISTS protections (
            id TEXT PRIMARY KEY,
            source_drive TEXT NOT NULL,
            source_path TEXT NOT NULL,
            target_drive TEXT NOT NULL,
            target_path TEXT NOT NULL,
            last_run INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL DEFAULT 0,
            revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS photos (
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            thumb TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (drive_id, path)
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRow {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub from_drive: String,
    pub from_path: String,
    pub to_drive: String,
    pub to_path: String,
    pub progress: u64,
    pub total: u64,
    pub error: String,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_job(
    conn: &Connection,
    id: &str,
    kind: &str,
    from_drive: &str,
    from_path: &str,
    to_drive: &str,
    to_path: &str,
    total: u64,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO jobs (id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, created_at, updated_at)
         VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)",
        params![id, kind, from_drive, from_path, to_drive, to_path, total as i64, now],
    )?;
    Ok(())
}

pub fn get_job(conn: &Connection, id: &str) -> anyhow::Result<Option<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error
         FROM jobs WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(JobRow {
            id: row.get(0)?,
            kind: row.get(1)?,
            state: row.get(2)?,
            from_drive: row.get(3)?,
            from_path: row.get(4)?,
            to_drive: row.get(5)?,
            to_path: row.get(6)?,
            progress: row.get::<_, i64>(7)? as u64,
            total: row.get::<_, i64>(8)? as u64,
            error: row.get(9)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn list_jobs(conn: &Connection, limit: i64) -> anyhow::Result<Vec<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error
         FROM jobs ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(JobRow {
            id: row.get(0)?,
            kind: row.get(1)?,
            state: row.get(2)?,
            from_drive: row.get(3)?,
            from_path: row.get(4)?,
            to_drive: row.get(5)?,
            to_path: row.get(6)?,
            progress: row.get::<_, i64>(7)? as u64,
            total: row.get::<_, i64>(8)? as u64,
            error: row.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn update_job_progress(
    conn: &Connection,
    id: &str,
    progress: u64,
    total: u64,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE jobs SET progress = ?2, total = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, progress as i64, total as i64, now_unix()],
    )?;
    Ok(())
}

pub fn set_job_state(conn: &Connection, id: &str, state: &str, error: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE jobs SET state = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, state, error, now_unix()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub role: String,
}

pub fn insert_user(
    conn: &Connection,
    id: &str,
    username: &str,
    display_name: &str,
    password_hash: &str,
    role: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, username, display_name, password_hash, role, now],
    )?;
    Ok(())
}

pub fn get_user_by_username(conn: &Connection, username: &str) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role FROM users WHERE username = ?1",
    )?;
    let mut rows = stmt.query_map(params![username], |row| {
        Ok(UserRow {
            id: row.get(0)?,
            username: row.get(1)?,
            display_name: row.get(2)?,
            password_hash: row.get(3)?,
            role: row.get(4)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn get_user(conn: &Connection, id: &str) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role FROM users WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(UserRow {
            id: row.get(0)?,
            username: row.get(1)?,
            display_name: row.get(2)?,
            password_hash: row.get(3)?,
            role: row.get(4)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn list_users(conn: &Connection) -> anyhow::Result<Vec<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role FROM users ORDER BY username",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UserRow {
            id: row.get(0)?,
            username: row.get(1)?,
            display_name: row.get(2)?,
            password_hash: row.get(3)?,
            role: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn count_users(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)
}

pub fn delete_user(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM grants WHERE user_id = ?1", params![id])?;
    conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantRow {
    pub id: String,
    pub user_id: String,
    pub drive_id: String,
    pub path: String,
    pub permission: String,
}

pub fn insert_grant(
    conn: &Connection,
    id: &str,
    user_id: &str,
    drive_id: &str,
    path: &str,
    permission: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO grants (id, user_id, drive_id, path, permission, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, user_id, drive_id, path, permission, now_unix()],
    )?;
    Ok(())
}

pub fn list_grants_for_user(conn: &Connection, user_id: &str) -> anyhow::Result<Vec<GrantRow>> {
    list_grants_where(conn, "user_id = ?1", params![user_id])
}

pub fn list_all_grants(conn: &Connection) -> anyhow::Result<Vec<GrantRow>> {
    list_grants_where(conn, "1", params![])
}

fn list_grants_where(
    conn: &Connection,
    where_clause: &str,
    args: impl rusqlite::Params,
) -> anyhow::Result<Vec<GrantRow>> {
    let sql = format!(
        "SELECT id, user_id, drive_id, path, permission FROM grants WHERE {where_clause} ORDER BY drive_id, path"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(args, |row| {
        Ok(GrantRow {
            id: row.get(0)?,
            user_id: row.get(1)?,
            drive_id: row.get(2)?,
            path: row.get(3)?,
            permission: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn delete_grant(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM grants WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareRow {
    pub id: String,
    pub token_hash: String,
    pub drive_id: String,
    pub path: String,
    pub password_hash: String,
    pub expires_at: Option<i64>,
    pub created_by: String,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_share(
    conn: &Connection,
    id: &str,
    token_hash: &str,
    drive_id: &str,
    path: &str,
    password_hash: &str,
    expires_at: Option<i64>,
    created_by: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO shares (id, token_hash, drive_id, path, password_hash, expires_at, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, token_hash, drive_id, path, password_hash, expires_at, created_by, now_unix()],
    )?;
    Ok(())
}

pub fn get_share_by_token_hash(
    conn: &Connection,
    token_hash: &str,
) -> anyhow::Result<Option<ShareRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, token_hash, drive_id, path, password_hash, expires_at, created_by FROM shares WHERE token_hash = ?1",
    )?;
    let mut rows = stmt.query_map(params![token_hash], |row| {
        Ok(ShareRow {
            id: row.get(0)?,
            token_hash: row.get(1)?,
            drive_id: row.get(2)?,
            path: row.get(3)?,
            password_hash: row.get(4)?,
            expires_at: row.get(5)?,
            created_by: row.get(6)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn list_shares(conn: &Connection) -> anyhow::Result<Vec<ShareRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, token_hash, drive_id, path, password_hash, expires_at, created_by FROM shares ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ShareRow {
            id: row.get(0)?,
            token_hash: row.get(1)?,
            drive_id: row.get(2)?,
            path: row.get(3)?,
            password_hash: row.get(4)?,
            expires_at: row.get(5)?,
            created_by: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectionRow {
    pub id: String,
    pub source_drive: String,
    pub source_path: String,
    pub target_drive: String,
    pub target_path: String,
    pub last_run: i64,
}

pub fn insert_protection(
    conn: &Connection,
    id: &str,
    source_drive: &str,
    source_path: &str,
    target_drive: &str,
    target_path: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO protections (id, source_drive, source_path, target_drive, target_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, source_drive, source_path, target_drive, target_path, now_unix()],
    )?;
    Ok(())
}

pub fn list_protections(conn: &Connection) -> anyhow::Result<Vec<ProtectionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_drive, source_path, target_drive, target_path, last_run
         FROM protections ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProtectionRow {
            id: row.get(0)?,
            source_drive: row.get(1)?,
            source_path: row.get(2)?,
            target_drive: row.get(3)?,
            target_path: row.get(4)?,
            last_run: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_protection(conn: &Connection, id: &str) -> anyhow::Result<Option<ProtectionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_drive, source_path, target_drive, target_path, last_run
         FROM protections WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(ProtectionRow {
            id: row.get(0)?,
            source_drive: row.get(1)?,
            source_path: row.get(2)?,
            target_drive: row.get(3)?,
            target_path: row.get(4)?,
            last_run: row.get(5)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn delete_protection(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM protections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn touch_protection(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET last_run = ?2 WHERE id = ?1",
        params![id, now_unix()],
    )?;
    Ok(())
}

pub fn delete_share(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM shares WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRow {
    pub id: String,
    pub drive_id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub received: u64,
    pub state: String,
}

pub fn insert_upload(
    conn: &Connection,
    id: &str,
    drive_id: &str,
    path: &str,
    name: &str,
    size: u64,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO uploads (id, drive_id, path, name, size, received, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 'active', ?6, ?6)",
        params![id, drive_id, path, name, size as i64, now],
    )?;
    Ok(())
}

pub fn get_upload(conn: &Connection, id: &str) -> anyhow::Result<Option<UploadRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, drive_id, path, name, size, received, state FROM uploads WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(UploadRow {
            id: row.get(0)?,
            drive_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            size: row.get::<_, i64>(4)? as u64,
            received: row.get::<_, i64>(5)? as u64,
            state: row.get(6)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn update_upload_received(conn: &Connection, id: &str, received: u64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE uploads SET received = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, received as i64, now_unix()],
    )?;
    Ok(())
}

pub fn set_upload_state(
    conn: &Connection,
    id: &str,
    state: &str,
    error: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE uploads SET state = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, state, error, now_unix()],
    )?;
    Ok(())
}

pub fn delete_upload(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM uploads WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceTokenRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: i64,
    pub revoked_at: Option<i64>,
}

pub fn insert_device_token(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    token_hash: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO device_tokens (id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL)",
        params![id, user_id, name, token_hash, now_unix()],
    )?;
    Ok(())
}

pub fn get_device_token_by_hash(
    conn: &Connection,
    token_hash: &str,
) -> anyhow::Result<Option<DeviceTokenRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at
         FROM device_tokens WHERE token_hash = ?1",
    )?;
    let mut rows = stmt.query_map(params![token_hash], |row| {
        Ok(DeviceTokenRow {
            id: row.get(0)?,
            user_id: row.get(1)?,
            name: row.get(2)?,
            token_hash: row.get(3)?,
            created_at: row.get(4)?,
            last_used_at: row.get(5)?,
            revoked_at: row.get::<_, Option<i64>>(6)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn list_device_tokens_for_user(
    conn: &Connection,
    user_id: &str,
) -> anyhow::Result<Vec<DeviceTokenRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at
         FROM device_tokens WHERE user_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![user_id], |row| {
        Ok(DeviceTokenRow {
            id: row.get(0)?,
            user_id: row.get(1)?,
            name: row.get(2)?,
            token_hash: row.get(3)?,
            created_at: row.get(4)?,
            last_used_at: row.get(5)?,
            revoked_at: row.get::<_, Option<i64>>(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn touch_device_token(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE device_tokens SET last_used_at = ?2 WHERE id = ?1",
        params![id, now_unix()],
    )?;
    Ok(())
}

pub fn revoke_device_token(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE device_tokens SET revoked_at = ?2 WHERE id = ?1",
        params![id, now_unix()],
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
