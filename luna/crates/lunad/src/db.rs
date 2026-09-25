use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::params;

/// Open (and initialize) the central metadata database.
///
/// Drive-scoped high-churn metadata (file index, scrub hashes, gallery, trash
/// paths, upload sessions) lives in each drive's `.luna` SQLite microdb.
/// This OS-disk DB keeps users, auth, access members/links, protection rules,
/// jobs, and the thin drives registry.
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Flash-friendly: never auto-relocate pages; checkpoint less often.
    let _ = conn.pragma_update(None, "auto_vacuum", "NONE");
    conn.pragma_update(None, "wal_autocheckpoint", 4000i64)?;
    // Small appliance OS disks: keep the page cache warm without ballooning RAM.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -16384i64)?; // 16 MiB
    conn.pragma_update(None, "mmap_size", 64i64 * 1024 * 1024)?;
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
            updated_at INTEGER NOT NULL,
            user_id TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            token_version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS access_members (
            id TEXT PRIMARY KEY,
            subject_kind TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL DEFAULT '',
            album_id TEXT NOT NULL DEFAULT '',
            user_id TEXT NOT NULL,
            caps INTEGER NOT NULL,
            created_by TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS access_links (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            token TEXT NOT NULL DEFAULT '',
            subject_kind TEXT NOT NULL,
            drive_id TEXT NOT NULL,
            path TEXT NOT NULL DEFAULT '',
            album_id TEXT NOT NULL DEFAULT '',
            caps INTEGER NOT NULL,
            password_hash TEXT NOT NULL DEFAULT '',
            expires_at INTEGER,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS access_members_user ON access_members(user_id);
        CREATE INDEX IF NOT EXISTS access_members_subject
            ON access_members(subject_kind, drive_id, path, album_id);
        CREATE INDEX IF NOT EXISTS access_links_subject
            ON access_links(subject_kind, drive_id, path, album_id);
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
            revoked_at INTEGER,
            expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS device_token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_id TEXT NOT NULL,
            action TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            client TEXT NOT NULL DEFAULT '',
            origin TEXT NOT NULL DEFAULT '',
            used_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            window_start INTEGER NOT NULL,
            locked_until INTEGER NOT NULL DEFAULT 0
        );
        ",
    )?;
    // Thin upgrade path for boxes that already had an older CREATE.
    ensure_column(&conn, "drives", "mount_point", "TEXT NOT NULL DEFAULT ''")?;
    // Legacy eMMC photos table (pre on-drive .lunagallery) — drop if present.
    let _ = conn.execute_batch("DROP TABLE IF EXISTS photos;");
    ensure_column(
        &conn,
        "users",
        "token_version",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&conn, "jobs", "user_id", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "device_tokens", "expires_at", "INTEGER")?;
    // Legacy sharing tables — replaced by access_members/access_links.
    let _ = conn.execute_batch("DROP TABLE IF EXISTS grants; DROP TABLE IF EXISTS shares;");
    // Links minted before raw-token storage can't be re-shown — '' stays empty.
    ensure_column(&conn, "access_links", "token", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(
        &conn,
        "device_token_usage",
        "client",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "device_token_usage",
        "origin",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(conn)
}

/// Compact the OS-disk DB during idle maintenance (not autovacuum).
pub fn vacuum_if_possible(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("VACUUM")?;
    Ok(())
}

/// Passiveive WAL checkpoint — cheap when nothing is writing.
pub fn wal_checkpoint_passive(conn: &Connection) -> anyhow::Result<()> {
    conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))?;
    Ok(())
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

/// Update kernel device name (and optionally mount point) together with state.
/// Used when a stick returns under a new `/dev/sdX` name but the same `.luna` id.
pub fn update_drive_placement(
    conn: &Connection,
    id: &str,
    device: &str,
    mount_point: Option<&str>,
    state: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    if let Some(mp) = mount_point {
        conn.execute(
            "UPDATE drives SET device = ?2, mount_point = ?3, state = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, device, mp, state, now],
        )?;
    } else {
        conn.execute(
            "UPDATE drives SET device = ?2, state = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, device, state, now],
        )?;
    }
    Ok(())
}

pub fn delete_drive(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM drives WHERE id = ?1", params![id])?;
    Ok(())
}

/// Forget a drive and every row that points at it (access rows, index, …).
/// Does not touch files on the drive itself. All deletes run in one transaction
/// so a mid-cascade failure cannot leave related rows gone while the drive remains.
pub fn delete_drive_cascade(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let statements = [
        "DELETE FROM access_members WHERE drive_id = ?1",
        "DELETE FROM access_links WHERE drive_id = ?1",
        "DELETE FROM jobs WHERE from_drive = ?1 OR to_drive = ?1",
        "DELETE FROM protections WHERE source_drive = ?1 OR target_drive = ?1",
    ];
    for sql in statements {
        match tx.execute(sql, params![id]) {
            Ok(_) => {}
            Err(e) if e.to_string().contains("no such") => {}
            Err(e) => return Err(e.into()),
        }
    }
    // Upload sessions and file index/hashes live in the drive `.luna` microdb.
    tx.execute("DELETE FROM drives WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// Wipe all user data and return the box to first-run state, keeping the
/// schema. Clears users/access/device-tokens, jobs/protections, drives,
/// and resets setup + the JWT and BLE setup secrets. Per-drive `.luna`
/// microdbs (index, hashes, gallery, uploads, trash meta) are not part of
/// `luna.db` and are left on the sticks.
pub fn factory_reset(conn: &Connection) -> anyhow::Result<()> {
    for table in [
        "users",
        "access_members",
        "access_links",
        "device_tokens",
        "jobs",
        "protections",
        "drives",
        "device_token_usage",
        "rate_limit_buckets",
    ] {
        conn.execute(&format!("DELETE FROM {table}"), [])?;
    }
    conn.execute("DELETE FROM meta", [])?;
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
    pub user_id: String,
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
    user_id: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO jobs (id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, created_at, updated_at, user_id)
         VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8, ?9)",
        params![id, kind, from_drive, from_path, to_drive, to_path, total as i64, now, user_id],
    )?;
    Ok(())
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRow> {
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
        user_id: row.get::<_, String>(10).unwrap_or_default(),
    })
}

pub fn get_job(conn: &Connection, id: &str) -> anyhow::Result<Option<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id
         FROM jobs WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], job_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_jobs(conn: &Connection, limit: i64) -> anyhow::Result<Vec<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id
         FROM jobs ORDER BY created_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], job_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn list_jobs_for_user(
    conn: &Connection,
    user_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<JobRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id
         FROM jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![user_id, limit], job_from_row)?;
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
    pub token_version: i64,
}

fn user_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        password_hash: row.get(3)?,
        role: row.get(4)?,
        token_version: row.get(5)?,
    })
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
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE username = ?1",
    )?;
    let mut rows = stmt.query_map(params![username], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn get_user(conn: &Connection, id: &str) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_users(conn: &Connection) -> anyhow::Result<Vec<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users ORDER BY username",
    )?;
    let rows = stmt.query_map([], user_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn count_users(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)
}

pub fn delete_user(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM access_members WHERE user_id = ?1", params![id])?;
    conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_user_password_hash(
    conn: &Connection,
    id: &str,
    password_hash: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    let n = conn.execute(
        "UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3",
        params![password_hash, now, id],
    )?;
    if n == 0 {
        anyhow::bail!("user not found");
    }
    Ok(())
}

pub fn first_admin(conn: &Connection) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1",
    )?;
    let mut rows = stmt.query_map([], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_admins(conn: &Connection) -> anyhow::Result<Vec<UserRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE role = 'admin' ORDER BY username ASC",
    )?;
    let rows = stmt.query_map([], user_from_row)?;
    let mut admins = Vec::new();
    for r in rows {
        admins.push(r?);
    }
    Ok(admins)
}

/// Invalidate every browser session JWT for this person. Device tokens are
/// unchanged (those have their own revoke path).
pub fn bump_user_token_version(conn: &Connection, user_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE users SET token_version = token_version + 1, updated_at = ?2 WHERE id = ?1",
        params![user_id, now_unix()],
    )?;
    Ok(())
}

pub fn revoke_device_tokens_for_user(conn: &Connection, user_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE device_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
        params![user_id, now_unix()],
    )?;
    Ok(())
}

/// A member row: a Luna user holding capabilities on a subject.
/// `subject_kind` is "path" (file/folder/drive, `path` set) or "album"
/// (`album_id` set, `drive_id` is the album's home drive).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessMemberRow {
    pub id: String,
    pub subject_kind: String,
    pub drive_id: String,
    pub path: String,
    pub album_id: String,
    pub user_id: String,
    pub caps: i64,
    pub created_by: String,
}

pub fn insert_access_member(conn: &Connection, row: &AccessMemberRow) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO access_members (id, subject_kind, drive_id, path, album_id, user_id, caps, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            row.id,
            row.subject_kind,
            row.drive_id,
            row.path,
            row.album_id,
            row.user_id,
            row.caps,
            row.created_by,
            now_unix()
        ],
    )?;
    Ok(())
}

fn member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccessMemberRow> {
    Ok(AccessMemberRow {
        id: row.get(0)?,
        subject_kind: row.get(1)?,
        drive_id: row.get(2)?,
        path: row.get(3)?,
        album_id: row.get(4)?,
        user_id: row.get(5)?,
        caps: row.get(6)?,
        created_by: row.get(7)?,
    })
}

const MEMBER_COLS: &str = "id, subject_kind, drive_id, path, album_id, user_id, caps, created_by";

pub fn get_access_member(conn: &Connection, id: &str) -> anyhow::Result<Option<AccessMemberRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMBER_COLS} FROM access_members WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![id], member_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_access_members_for_user(
    conn: &Connection,
    user_id: &str,
) -> anyhow::Result<Vec<AccessMemberRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMBER_COLS} FROM access_members WHERE user_id = ?1 ORDER BY drive_id, path"
    ))?;
    let rows = stmt.query_map(params![user_id], member_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn list_all_access_members(conn: &Connection) -> anyhow::Result<Vec<AccessMemberRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMBER_COLS} FROM access_members ORDER BY drive_id, path, user_id"
    ))?;
    let rows = stmt.query_map([], member_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn list_access_members_for_subject(
    conn: &Connection,
    subject_kind: &str,
    drive_id: &str,
    path: &str,
    album_id: &str,
) -> anyhow::Result<Vec<AccessMemberRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMBER_COLS} FROM access_members
         WHERE subject_kind = ?1 AND drive_id = ?2 AND path = ?3 AND album_id = ?4
         ORDER BY created_at"
    ))?;
    let rows = stmt.query_map(
        params![subject_kind, drive_id, path, album_id],
        member_from_row,
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn update_access_member_caps(conn: &Connection, id: &str, caps: i64) -> anyhow::Result<bool> {
    let n = conn.execute(
        "UPDATE access_members SET caps = ?1 WHERE id = ?2",
        params![caps, id],
    )?;
    Ok(n > 0)
}

pub fn delete_access_member(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM access_members WHERE id = ?1", params![id])?;
    Ok(())
}

/// Every member row on one subject (used when the subject is deleted).
pub fn delete_access_members_for_subject(
    conn: &Connection,
    subject_kind: &str,
    drive_id: &str,
    path: &str,
    album_id: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM access_members
         WHERE subject_kind = ?1 AND drive_id = ?2 AND path = ?3 AND album_id = ?4",
        params![subject_kind, drive_id, path, album_id],
    )?;
    Ok(())
}

/// A link row: "anyone with this URL" holds capabilities on a subject.
/// The bearer token is never stored — only its blake3 hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessLinkRow {
    pub id: String,
    pub token_hash: String,
    /// Raw token, kept so the owner can re-copy the address later. Empty for
    /// links minted before this column existed — those stay unrecoverable.
    pub token: String,
    pub subject_kind: String,
    pub drive_id: String,
    pub path: String,
    pub album_id: String,
    pub caps: i64,
    pub password_hash: String,
    pub expires_at: Option<i64>,
    pub created_by: String,
    pub created_at: i64,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_access_link(conn: &Connection, row: &AccessLinkRow) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO access_links (id, token_hash, token, subject_kind, drive_id, path, album_id, caps, password_hash, expires_at, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.id,
            row.token_hash,
            row.token,
            row.subject_kind,
            row.drive_id,
            row.path,
            row.album_id,
            row.caps,
            row.password_hash,
            row.expires_at,
            row.created_by,
            now_unix()
        ],
    )?;
    Ok(())
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccessLinkRow> {
    Ok(AccessLinkRow {
        id: row.get(0)?,
        token_hash: row.get(1)?,
        token: row.get(2)?,
        subject_kind: row.get(3)?,
        drive_id: row.get(4)?,
        path: row.get(5)?,
        album_id: row.get(6)?,
        caps: row.get(7)?,
        password_hash: row.get(8)?,
        expires_at: row.get(9)?,
        created_by: row.get(10)?,
        created_at: row.get(11)?,
    })
}

const LINK_COLS: &str = "id, token_hash, token, subject_kind, drive_id, path, album_id, caps, password_hash, expires_at, created_by, created_at";

pub fn get_access_link_by_token_hash(
    conn: &Connection,
    token_hash: &str,
) -> anyhow::Result<Option<AccessLinkRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LINK_COLS} FROM access_links WHERE token_hash = ?1"
    ))?;
    let mut rows = stmt.query_map(params![token_hash], link_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn get_access_link(conn: &Connection, id: &str) -> anyhow::Result<Option<AccessLinkRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LINK_COLS} FROM access_links WHERE id = ?1"
    ))?;
    let mut rows = stmt.query_map(params![id], link_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_access_links(conn: &Connection) -> anyhow::Result<Vec<AccessLinkRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LINK_COLS} FROM access_links ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], link_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn list_access_links_for_subject(
    conn: &Connection,
    subject_kind: &str,
    drive_id: &str,
    path: &str,
    album_id: &str,
) -> anyhow::Result<Vec<AccessLinkRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LINK_COLS} FROM access_links
         WHERE subject_kind = ?1 AND drive_id = ?2 AND path = ?3 AND album_id = ?4
         ORDER BY created_at"
    ))?;
    let rows = stmt.query_map(
        params![subject_kind, drive_id, path, album_id],
        link_from_row,
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Persist mutable fields on a link row (caps, password, expiry). Token hash,
/// subject, and creator are immutable.
pub fn update_access_link(conn: &Connection, row: &AccessLinkRow) -> anyhow::Result<bool> {
    let n = conn.execute(
        "UPDATE access_links SET caps = ?2, password_hash = ?3, expires_at = ?4 WHERE id = ?1",
        params![row.id, row.caps, row.password_hash, row.expires_at],
    )?;
    Ok(n > 0)
}

pub fn delete_access_link(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM access_links WHERE id = ?1", params![id])?;
    Ok(())
}

/// Every member and link row on one subject (subject deleted → all access dies).
pub fn delete_access_for_subject(
    conn: &Connection,
    subject_kind: &str,
    drive_id: &str,
    path: &str,
    album_id: &str,
) -> anyhow::Result<()> {
    delete_access_members_for_subject(conn, subject_kind, drive_id, path, album_id)?;
    conn.execute(
        "DELETE FROM access_links
         WHERE subject_kind = ?1 AND drive_id = ?2 AND path = ?3 AND album_id = ?4",
        params![subject_kind, drive_id, path, album_id],
    )?;
    Ok(())
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

/// Rename an upload session (used when a drop box auto-renames a duplicate).
pub fn update_upload_name(conn: &Connection, id: &str, name: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE uploads SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now_unix()],
    )?;
    Ok(())
}

/// Record a covered byte range `[start, end)` for an upload. Overlapping or
/// duplicate chunks are last-write-wins, matching the sparse-file write path.
pub fn upsert_upload_chunk(
    conn: &Connection,
    upload_id: &str,
    start: u64,
    end: u64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO upload_chunks (upload_id, start, end) VALUES (?1, ?2, ?3)
         ON CONFLICT(upload_id, start) DO UPDATE SET end = excluded.end",
        params![upload_id, start as i64, end as i64],
    )?;
    Ok(())
}

/// All recorded covered ranges for an upload, sorted by start.
pub fn list_upload_chunks(conn: &Connection, upload_id: &str) -> anyhow::Result<Vec<(u64, u64)>> {
    let mut stmt =
        conn.prepare("SELECT start, end FROM upload_chunks WHERE upload_id = ?1 ORDER BY start")?;
    let rows = stmt.query_map(params![upload_id], |row| {
        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// True when the recorded ranges fully cover `[0, size)` with no holes.
pub fn upload_fully_covered(conn: &Connection, upload_id: &str, size: u64) -> anyhow::Result<bool> {
    if size == 0 {
        return Ok(true);
    }
    let mut covered_end: u64 = 0;
    for (start, end) in list_upload_chunks(conn, upload_id)? {
        if start > covered_end {
            return Ok(false); // gap
        }
        covered_end = covered_end.max(end);
        if covered_end >= size {
            return Ok(true);
        }
    }
    Ok(covered_end >= size)
}

pub fn delete_upload_chunks(conn: &Connection, upload_id: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM upload_chunks WHERE upload_id = ?1",
        params![upload_id],
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
    pub expires_at: Option<i64>,
}

pub fn insert_device_token(
    conn: &Connection,
    id: &str,
    user_id: &str,
    name: &str,
    token_hash: &str,
    expires_at: Option<i64>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO device_tokens (id, user_id, name, token_hash, created_at, last_used_at, revoked_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6)",
        params![id, user_id, name, token_hash, now_unix(), expires_at],
    )?;
    Ok(())
}

pub fn get_device_token_by_hash(
    conn: &Connection,
    token_hash: &str,
) -> anyhow::Result<Option<DeviceTokenRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at, expires_at
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
            expires_at: row.get::<_, Option<i64>>(7)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn list_device_tokens_for_user(
    conn: &Connection,
    user_id: &str,
) -> anyhow::Result<Vec<DeviceTokenRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at, expires_at
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
            expires_at: row.get::<_, Option<i64>>(7)?,
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

/// Throttle last_used writes so chatty API clients do not hammer eMMC.
pub const DEVICE_TOKEN_TOUCH_MIN_SECS: i64 = 10 * 60;
/// Merge activity with the same action/client/origin within 15 minutes.
pub const DEVICE_TOKEN_USAGE_MERGE_WINDOW_SECS: i64 = 15 * 60;
pub const DEVICE_TOKEN_USAGE_KEEP: i64 = 50;

pub fn note_device_token_activity(
    conn: &Connection,
    token_id: &str,
    last_used_at: i64,
) -> anyhow::Result<()> {
    note_device_token_activity_rich(conn, token_id, last_used_at, "API access", "", "", "")
}

pub fn note_device_token_activity_rich(
    conn: &Connection,
    token_id: &str,
    last_used_at: i64,
    action: &str,
    detail: &str,
    client: &str,
    origin: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    if now.saturating_sub(last_used_at) >= DEVICE_TOKEN_TOUCH_MIN_SECS {
        touch_device_token(conn, token_id)?;
    }
    let latest: Option<(i64, String, String, String, i64)> = conn
        .query_row(
            "SELECT id, action, client, origin, used_at FROM device_token_usage
             WHERE token_id = ?1
             ORDER BY used_at DESC, id DESC LIMIT 1",
            params![token_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .ok();

    if let Some((id, prev_action, prev_client, prev_origin, prev_used_at)) = latest
        && prev_action == action
        && prev_client == client
        && prev_origin == origin
        && now.saturating_sub(prev_used_at) < DEVICE_TOKEN_USAGE_MERGE_WINDOW_SECS
    {
        if !detail.is_empty() {
            conn.execute(
                "UPDATE device_token_usage SET used_at = ?2, detail = ?3 WHERE id = ?1",
                params![id, now, detail],
            )?;
        } else {
            conn.execute(
                "UPDATE device_token_usage SET used_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
        }
        return Ok(());
    }

    insert_device_token_usage(conn, token_id, action, detail, client, origin)?;
    prune_device_token_usage(conn, token_id, DEVICE_TOKEN_USAGE_KEEP)?;
    Ok(())
}

pub fn revoke_device_token(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE device_tokens SET revoked_at = ?2 WHERE id = ?1",
        params![id, now_unix()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceTokenUsageRow {
    pub action: String,
    pub detail: String,
    pub client: String,
    pub origin: String,
    pub used_at: i64,
}

pub fn insert_device_token_usage(
    conn: &Connection,
    token_id: &str,
    action: &str,
    detail: &str,
    client: &str,
    origin: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO device_token_usage (token_id, action, detail, client, origin, used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![token_id, action, detail, client, origin, now_unix()],
    )?;
    Ok(())
}

pub fn prune_device_token_usage(
    conn: &Connection,
    token_id: &str,
    keep: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM device_token_usage WHERE token_id = ?1 AND id NOT IN (
            SELECT id FROM device_token_usage WHERE token_id = ?1
            ORDER BY used_at DESC LIMIT ?2
         )",
        params![token_id, keep],
    )?;
    Ok(())
}

pub fn list_device_token_usage(
    conn: &Connection,
    token_id: &str,
    limit: i64,
) -> anyhow::Result<Vec<DeviceTokenUsageRow>> {
    let mut stmt = conn.prepare(
        "SELECT action, detail, client, origin, used_at FROM device_token_usage
         WHERE token_id = ?1 ORDER BY used_at DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![token_id, limit], |row| {
        Ok(DeviceTokenUsageRow {
            action: row.get(0)?,
            detail: row.get(1)?,
            client: row.get(2)?,
            origin: row.get(3)?,
            used_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn rate_limit_allow(
    conn: &Connection,
    key: &str,
    window_secs: i64,
    max: i64,
) -> anyhow::Result<bool> {
    let now = now_unix();
    let tx = conn.unchecked_transaction()?;
    let mut count: i64 = 0;
    let mut window_start: i64 = now;
    let locked_until: i64 = tx
        .query_row(
            "SELECT count, window_start, locked_until FROM rate_limit_buckets WHERE key = ?1",
            params![key],
            |row| {
                count = row.get(0)?;
                window_start = row.get(1)?;
                row.get(2)
            },
        )
        .unwrap_or(0);
    if locked_until > now {
        tx.commit()?;
        return Ok(false);
    }
    if count == 0 || now - window_start >= window_secs {
        tx.execute(
            "INSERT INTO rate_limit_buckets (key, count, window_start, locked_until)
             VALUES (?1, 1, ?2, 0)
             ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start, locked_until = 0",
            params![key, now],
        )?;
        tx.commit()?;
        return Ok(true);
    }
    if count >= max {
        tx.commit()?;
        return Ok(false);
    }
    tx.execute(
        "UPDATE rate_limit_buckets SET count = count + 1 WHERE key = ?1",
        params![key],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn share_auth_locked(conn: &Connection, key: &str) -> anyhow::Result<bool> {
    let now = now_unix();
    let locked: i64 = conn
        .query_row(
            "SELECT locked_until FROM rate_limit_buckets WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(locked > now)
}

pub fn share_auth_failure(conn: &Connection, key: &str, max_failures: u32) -> anyhow::Result<bool> {
    let now = now_unix();
    let tx = conn.unchecked_transaction()?;
    let mut count: i64 = 0;
    let existing: Option<(i64, i64)> = tx
        .query_row(
            "SELECT count, locked_until FROM rate_limit_buckets WHERE key = ?1",
            params![key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((_, locked_until)) = existing
        && locked_until > now
    {
        tx.commit()?;
        return Ok(true);
    }
    if let Some((c, _)) = existing {
        count = c;
    }
    count += 1;
    let locked_until = if count >= max_failures as i64 {
        let exponent = (count - max_failures as i64).min(10);
        now + 60 * (1_i64 << exponent)
    } else {
        0
    };
    tx.execute(
        "INSERT INTO rate_limit_buckets (key, count, window_start, locked_until)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until",
        params![key, count, now, locked_until],
    )?;
    tx.commit()?;
    Ok(locked_until > now)
}

pub fn share_auth_clear(conn: &Connection, key: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM rate_limit_buckets WHERE key = ?1",
        params![key],
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

    #[test]
    fn delete_drive_cascade_removes_related_rows_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO drives (id, label, state, fs_type, device, mount_point, created_at, updated_at)
             VALUES ('d1', 'Photos', 'as_is', 'ext4', 'sdz', '/mnt', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO access_members (id, subject_kind, drive_id, path, album_id, user_id, caps, created_by, created_at)
             VALUES ('m1', 'path', 'd1', '', '', 'u1', 7, 'a', ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO access_links (id, token_hash, subject_kind, drive_id, path, album_id, caps, password_hash, expires_at, created_by, created_at)
             VALUES ('l1', 'tok', 'path', 'd1', '', '', 1, '', NULL, 'u1', ?1)",
            params![now],
        )
        .unwrap();

        delete_drive_cascade(&conn, "d1").unwrap();

        assert!(get_drive(&conn, "d1").unwrap().is_none());
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM access_members WHERE drive_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM access_links WHERE drive_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0);
        assert_eq!(links, 0);
    }

    #[test]
    fn access_member_caps_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_access_member(
            &conn,
            &AccessMemberRow {
                id: "m1".into(),
                subject_kind: "path".into(),
                drive_id: "d1".into(),
                path: "photos".into(),
                album_id: String::new(),
                user_id: "u1".into(),
                caps: 1,
                created_by: "a".into(),
            },
        )
        .unwrap();

        assert!(update_access_member_caps(&conn, "m1", 3).unwrap());
        let rows = list_access_members_for_user(&conn, "u1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].caps, 3);

        assert!(!update_access_member_caps(&conn, "missing", 7).unwrap());
        delete_access_member(&conn, "m1").unwrap();
        assert!(
            list_access_members_for_user(&conn, "u1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rich_device_token_activity_records_and_merges_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_user(&conn, "u1", "admin", "Admin", "hash", "admin").unwrap();
        insert_device_token(&conn, "dt1", "u1", "MacBook", "hash1", None).unwrap();

        // First event
        note_device_token_activity_rich(
            &conn,
            "dt1",
            0,
            "WebDAV folder",
            "Browsed folder",
            "macOS Finder",
            "Home network (192.168.1.50)",
        )
        .unwrap();

        let usage = list_device_token_usage(&conn, "dt1", 10).unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].action, "WebDAV folder");
        assert_eq!(usage[0].detail, "Browsed folder");
        assert_eq!(usage[0].client, "macOS Finder");
        assert_eq!(usage[0].origin, "Home network (192.168.1.50)");

        // Repeat same action/client/origin within 15 min window -> merged into 1 row
        note_device_token_activity_rich(
            &conn,
            "dt1",
            now_unix(),
            "WebDAV folder",
            "Modified files",
            "macOS Finder",
            "Home network (192.168.1.50)",
        )
        .unwrap();

        let usage_after = list_device_token_usage(&conn, "dt1", 10).unwrap();
        assert_eq!(usage_after.len(), 1);
        assert_eq!(usage_after[0].detail, "Modified files");

        // Different action -> new row
        note_device_token_activity_rich(
            &conn,
            "dt1",
            now_unix(),
            "File upload",
            "Uploaded 2 files",
            "macOS Finder",
            "Home network (192.168.1.50)",
        )
        .unwrap();

        let usage_multi = list_device_token_usage(&conn, "dt1", 10).unwrap();
        assert_eq!(usage_multi.len(), 2);
        assert_eq!(usage_multi[0].action, "File upload");
        assert_eq!(usage_multi[1].action, "WebDAV folder");
    }
}
