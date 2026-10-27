use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
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
    // luna.db holds password hashes, sessions, and tokens — owner-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(error = %e, path = %path.display(), "could not restrict database file permissions");
        }
    }
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Flash-friendly: never auto-relocate pages; checkpoint less often.
    let _ = conn.pragma_update(None, "auto_vacuum", "NONE");
    conn.pragma_update(None, "wal_autocheckpoint", 4000i64)?;
    // Small appliance OS disks: keep the page cache warm without ballooning RAM.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -8192i64)?; // 8 MiB
    conn.pragma_update(None, "mmap_size", 32i64 * 1024 * 1024)?;
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
        CREATE TABLE IF NOT EXISTS deleted_users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            deleted_at INTEGER NOT NULL DEFAULT 0
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
        CREATE INDEX IF NOT EXISTS device_token_usage_token
            ON device_token_usage(token_id, used_at);
        CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id);
        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            window_start INTEGER NOT NULL,
            locked_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS protections (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,                 -- 'drive' | 'cloud'
            source_drive TEXT NOT NULL,
            source_path TEXT NOT NULL,          -- drive-relative real path, no leading/trailing slash
            target_drive TEXT NOT NULL DEFAULT '',  -- drive kind only
            private_owner TEXT NOT NULL DEFAULT '', -- user id for a private item's backup
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'stopped' | 'source_gone'
            stop_reason TEXT NOT NULL DEFAULT '',   -- plain-language, shown to people
            access_json TEXT NOT NULL DEFAULT '',   -- last saved AccessList (backup::access_list) as JSON
            last_ok_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            hard INTEGER NOT NULL DEFAULT 0,
            failing_since INTEGER NOT NULL DEFAULT 0,
            last_checked_at INTEGER NOT NULL DEFAULT 0,
            first_done INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',          -- files the last good run couldn't copy as they are, one per line
            UNIQUE (kind, source_drive, source_path, target_drive)
        );
        CREATE TABLE IF NOT EXISTS cloud_identity (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            luna_id TEXT NOT NULL,
            signing_seed BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_keys (
            user_id TEXT PRIMARY KEY,
            seal_public BLOB NOT NULL,
            auth_public BLOB NOT NULL,
            self_sealed BLOB NOT NULL,
            phrase_set_at INTEGER NOT NULL,
            last_checked_at INTEGER NOT NULL DEFAULT 0,
            phrase_words INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS backup_keys (
            protection_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            key BLOB NOT NULL,
            dedup_key BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (protection_id, version)
        );
        CREATE TABLE IF NOT EXISTS cloud_packs (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'live', 'marked', 'deleting')),
            run_id TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            marked_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cloud_packs_scope_state ON cloud_packs (scope, state);
        CREATE TABLE IF NOT EXISTS cloud_chunks (
            scope TEXT NOT NULL,
            chunk_id BLOB NOT NULL,
            pack_id TEXT NOT NULL,
            offset INTEGER NOT NULL,
            len INTEGER NOT NULL,
            PRIMARY KEY (scope, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS cloud_chunks_pack ON cloud_chunks (pack_id);
        CREATE TABLE IF NOT EXISTS cloud_snapshots (
            id TEXT PRIMARY KEY,
            protection_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            key_version INTEGER NOT NULL,
            tree_pack_id TEXT NOT NULL,
            record BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cloud_snapshots_protection ON cloud_snapshots (protection_id);
        CREATE TABLE IF NOT EXISTS cloud_snapshot_packs (
            snapshot_id TEXT NOT NULL,
            pack_id TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, pack_id)
        );
        CREATE INDEX IF NOT EXISTS cloud_snapshot_packs_pack ON cloud_snapshot_packs (pack_id);
        CREATE TABLE IF NOT EXISTS cloud_runs (
            id TEXT PRIMARY KEY,
            protection_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS cloud_private_scopes (
            scope TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            seal_public BLOB NOT NULL,
            scope_public BLOB NOT NULL,
            sealed_scope_secret BLOB NOT NULL,
            dedup_key BLOB NOT NULL,
            state TEXT NOT NULL DEFAULT 'active',
            retire_after INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cloud_private_scopes_owner ON cloud_private_scopes(owner);
        CREATE TABLE IF NOT EXISTS cloud_private_kept (
            scope TEXT PRIMARY KEY,
            seal_public BLOB NOT NULL,
            sealed_scope_secret BLOB NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cloud_private_trees (
            snapshot_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            tree BLOB NOT NULL
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
    ensure_column(&conn, "jobs", "from_private", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "jobs", "to_private", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(
        &conn,
        "deleted_users",
        "username",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "deleted_users",
        "display_name",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "deleted_users",
        "deleted_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&conn, "device_tokens", "expires_at", "INTEGER")?;
    ensure_column(
        &conn,
        "user_keys",
        "phrase_words",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    crate::files::forwarding::migrate(&conn)?;
    crate::files::recents::migrate(&conn)?;
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
    // CAP_SHARE split: members who held "full" were subtree managers under
    // the old model — keep their manage rights. View/upload grants never
    // carried share-management, so they gain nothing.
    conn.execute(
        "UPDATE access_members SET caps = caps | 16 WHERE (caps & 7) = 7 AND (caps & 16) = 0",
        [],
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
    let mut stmt = conn.prepare_cached(
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
    let mut stmt = conn.prepare_cached(
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

/// A drive that is no longer readable must not keep its private-item rows in
/// memory: whatever mounts there next gets read fresh.
fn forget_private_rows(conn: &Connection, id: &str, state: &str) {
    if matches!(state, "as_is" | "readonly") {
        // Back online: rows load fresh on first use. Deleted people's
        // private items stay put — clearing them is an explicit Admin action.
        return;
    }
    if let Ok(Some(drive)) = get_drive(conn, id)
        && !drive.mount_point.is_empty()
    {
        crate::private::forget(std::path::Path::new(&drive.mount_point));
    }
}

pub fn set_drive_state(conn: &Connection, id: &str, state: &str) -> anyhow::Result<()> {
    forget_private_rows(conn, id, state);
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
    forget_private_rows(conn, id, state);
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
/// schema. Clears users/access/device-tokens, protections/jobs, drives,
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
        "cloud_identity",
        "user_keys",
        "backup_keys",
        "cloud_packs",
        "cloud_chunks",
        "cloud_snapshots",
        "cloud_snapshot_packs",
        "cloud_runs",
        "cloud_private_scopes",
        "cloud_private_kept",
        "cloud_private_trees",
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
    pub from_private: bool,
    pub to_private: bool,
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
        "INSERT INTO jobs (id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, created_at, updated_at, user_id, from_private, to_private)
         VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8, ?9, ?10, ?11)",
        params![id, kind, from_drive, from_path, to_drive, to_path, total as i64, now, user_id,
            crate::auth::inside_private(conn, from_drive, from_path),
            crate::auth::inside_private(conn, to_drive, to_path)],
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
        from_private: row.get(11)?,
        to_private: row.get(12)?,
    })
}

pub fn get_job(conn: &Connection, id: &str) -> anyhow::Result<Option<JobRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id, from_private, to_private
         FROM jobs WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], job_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_jobs(conn: &Connection, limit: i64) -> anyhow::Result<Vec<JobRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id, from_private, to_private
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
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, state, from_drive, from_path, to_drive, to_path, progress, total, error, user_id, from_private, to_private
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
    let mut stmt = conn.prepare_cached(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE username = ?1",
    )?;
    let mut rows = stmt.query_map(params![username], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn get_user(conn: &Connection, id: &str) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_users(conn: &Connection) -> anyhow::Result<Vec<UserRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users ORDER BY username",
    )?;
    let rows = stmt.query_map([], user_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn count_users(conn: &Connection) -> anyhow::Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)
}

/// Forget a user and everything that keeps working in their name: member
/// rows, public links they minted, and the account itself. Links are
/// `created_by`-keyed — an expelled member's shared URLs must die with the
/// account, not live on anonymously. One transaction so a partial delete
/// never leaves grants behind for a user who no longer exists.
pub fn delete_user(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM access_members WHERE user_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM access_links WHERE created_by = ?1",
        params![id],
    )?;
    // Remembered so private folders this person owned stay walled off
    // instead of reading as another Luna's — and so the Admin cleanup list
    // can still say whose they were.
    tx.execute(
        "INSERT OR REPLACE INTO deleted_users (id, username, display_name, deleted_at)
         SELECT id, username, display_name, ?2 FROM users WHERE id = ?1",
        params![id, now_unix()],
    )?;
    tx.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    tx.commit()?;
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

pub fn set_user_display_name(
    conn: &Connection,
    id: &str,
    display_name: &str,
) -> anyhow::Result<()> {
    let n = conn.execute(
        "UPDATE users SET display_name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, display_name, now_unix()],
    )?;
    if n == 0 {
        anyhow::bail!("user not found");
    }
    Ok(())
}

/// Rename a user's login handle.
pub fn set_user_username(conn: &Connection, id: &str, username: &str) -> anyhow::Result<()> {
    let n = conn.execute(
        "UPDATE users SET username = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, username, now_unix()],
    )?;
    if n == 0 {
        anyhow::bail!("user not found");
    }
    Ok(())
}

pub fn set_user_role(conn: &Connection, id: &str, role: &str) -> anyhow::Result<()> {
    let n = conn.execute(
        "UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, role, now_unix()],
    )?;
    if n == 0 {
        anyhow::bail!("user not found");
    }
    Ok(())
}

pub fn first_admin(conn: &Connection) -> anyhow::Result<Option<UserRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, username, display_name, password_hash, role, token_version FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1",
    )?;
    let mut rows = stmt.query_map([], user_from_row)?;
    Ok(rows.next().transpose()?)
}

pub fn list_admins(conn: &Connection) -> anyhow::Result<Vec<UserRow>> {
    let mut stmt = conn.prepare_cached(
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

/// Protection kinds: a second drive, or the cloud.
pub const PROTECTION_DRIVE: &str = "drive";
pub const PROTECTION_CLOUD: &str = "cloud";
/// Protection states. `stopped` is set by a person; `source_gone` means the
/// protected item was removed or its drive was unplugged for good.
pub const PROTECTION_ACTIVE: &str = "active";
pub const PROTECTION_STOPPED: &str = "stopped";
pub const PROTECTION_SOURCE_GONE: &str = "source_gone";

const PROTECTION_COLUMNS: &str = "id, kind, source_drive, source_path, target_drive,
    private_owner, created_by, created_at, state, stop_reason, access_json,
    last_ok_at, last_error, hard, failing_since, last_checked_at, first_done, notes";

#[derive(Debug, Clone, PartialEq)]
pub struct ProtectionRow {
    pub id: String,
    pub kind: String,
    pub source_drive: String,
    pub source_path: String,
    pub target_drive: String,
    pub private_owner: String,
    pub created_by: String,
    pub created_at: i64,
    pub state: String,
    pub stop_reason: String,
    /// Last saved access list (JSON). Empty until the first good backup.
    pub access_json: String,
    pub last_ok_at: i64,
    pub last_error: String,
    /// True when the last failure needs a person to act (not just a retry).
    pub hard: bool,
    pub failing_since: i64,
    pub last_checked_at: i64,
    pub first_done: bool,
    /// Files the last good run couldn't copy as they are (case clash, too
    /// big for the target's format), one plain sentence per line. Not a
    /// failure: the rest of the backup is fine.
    pub notes: String,
}

impl ProtectionRow {
    /// A backup that doesn't exist yet, to ask whether another backup would cover it.
    pub fn probe(
        kind: &str,
        source_drive: &str,
        source_path: &str,
        target_drive: &str,
        private_owner: &str,
    ) -> Self {
        Self {
            id: String::new(),
            kind: kind.to_string(),
            source_drive: source_drive.to_string(),
            source_path: source_path.to_string(),
            target_drive: target_drive.to_string(),
            private_owner: private_owner.to_string(),
            created_by: String::new(),
            created_at: 0,
            state: PROTECTION_ACTIVE.to_string(),
            stop_reason: String::new(),
            access_json: String::new(),
            last_ok_at: 0,
            last_error: String::new(),
            hard: false,
            failing_since: 0,
            last_checked_at: 0,
            first_done: false,
            notes: String::new(),
        }
    }
}

pub struct NewProtection<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub source_drive: &'a str,
    pub source_path: &'a str,
    pub target_drive: &'a str,
    pub private_owner: &'a str,
    pub created_by: &'a str,
    pub created_at: i64,
}

fn protection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProtectionRow> {
    Ok(ProtectionRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        source_drive: row.get(2)?,
        source_path: row.get(3)?,
        target_drive: row.get(4)?,
        private_owner: row.get(5)?,
        created_by: row.get(6)?,
        created_at: row.get(7)?,
        state: row.get(8)?,
        stop_reason: row.get(9)?,
        access_json: row.get(10)?,
        last_ok_at: row.get(11)?,
        last_error: row.get(12)?,
        hard: row.get::<_, i64>(13)? != 0,
        failing_since: row.get(14)?,
        last_checked_at: row.get(15)?,
        first_done: row.get::<_, i64>(16)? != 0,
        notes: row.get(17)?,
    })
}

pub fn insert_protection(
    conn: &Connection,
    new: &NewProtection<'_>,
) -> anyhow::Result<ProtectionRow> {
    conn.execute(
        "INSERT INTO protections (id, kind, source_drive, source_path, target_drive,
             private_owner, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            new.id,
            new.kind,
            new.source_drive,
            new.source_path,
            new.target_drive,
            new.private_owner,
            new.created_by,
            new.created_at
        ],
    )?;
    get_protection(conn, new.id)?
        .ok_or_else(|| anyhow::anyhow!("protection {} was not saved", new.id))
}

pub fn find_protection(
    conn: &Connection,
    kind: &str,
    source_drive: &str,
    source_path: &str,
    target_drive: &str,
) -> anyhow::Result<Option<ProtectionRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PROTECTION_COLUMNS} FROM protections
         WHERE kind = ?1 AND source_drive = ?2 AND source_path = ?3 AND target_drive = ?4"
    ))?;
    let mut rows = stmt.query(params![kind, source_drive, source_path, target_drive])?;
    match rows.next()? {
        Some(row) => Ok(Some(protection_from_row(row)?)),
        None => Ok(None),
    }
}

pub fn list_protections(conn: &Connection) -> anyhow::Result<Vec<ProtectionRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PROTECTION_COLUMNS} FROM protections ORDER BY created_at DESC"
    ))?;
    let rows = stmt
        .query_map([], protection_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_protection(conn: &Connection, id: &str) -> anyhow::Result<Option<ProtectionRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PROTECTION_COLUMNS} FROM protections WHERE id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(protection_from_row(row)?)),
        None => Ok(None),
    }
}

/// The backup that has taken over `row`: the nearest backup of a parent folder of the same kind,
/// from the same drive to the same place, with the same privacy (a shared parent never holds a
/// private item inside it). Only a parent that is running and has finished its first copy counts,
/// so until then the child stays the up-to-date copy. When that parent is stopped or deleted the
/// child is no longer covered and runs again.
pub fn covering_protection(
    conn: &Connection,
    row: &ProtectionRow,
) -> anyhow::Result<Option<ProtectionRow>> {
    let child = crate::access::normalize_subject_path(&row.source_path);
    if child.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PROTECTION_COLUMNS} FROM protections
         WHERE kind = ?1 AND source_drive = ?2 AND target_drive = ?3 AND private_owner = ?4
           AND state = 'active' AND first_done = 1 AND id != ?5"
    ))?;
    let parents = stmt
        .query_map(
            params![
                row.kind,
                row.source_drive,
                row.target_drive,
                row.private_owner,
                row.id
            ],
            protection_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(parents
        .into_iter()
        .filter(|p| {
            let parent = crate::access::normalize_subject_path(&p.source_path);
            parent != child && crate::access::path_contains(&parent, &child)
        })
        .max_by_key(|p| crate::access::normalize_subject_path(&p.source_path).len()))
}

/// Returns true when a row was removed.
pub fn delete_protection(conn: &Connection, id: &str) -> anyhow::Result<bool> {
    let n = conn.execute("DELETE FROM protections WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// A backup run succeeded: stamp it, clear the failure, save the access list.
pub fn record_protection_ok(
    conn: &Connection,
    id: &str,
    now: i64,
    access_json: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET last_ok_at = ?2, last_error = '', hard = 0,
             failing_since = 0, first_done = 1, access_json = ?3
         WHERE id = ?1",
        params![id, now, access_json],
    )?;
    Ok(())
}

/// A backup run failed. `failing_since` keeps the time of the first failure
/// in a row, so repeated failures do not move it.
pub fn record_protection_error(
    conn: &Connection,
    id: &str,
    message: &str,
    hard: bool,
    now: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET last_error = ?2, hard = ?3,
             failing_since = CASE WHEN failing_since = 0 THEN ?4 ELSE failing_since END
         WHERE id = ?1",
        params![id, message, hard as i64, now],
    )?;
    Ok(())
}

/// Save what the last good run couldn't copy as it is (empty clears it).
pub fn set_protection_notes(conn: &Connection, id: &str, notes: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET notes = ?2 WHERE id = ?1",
        params![id, notes],
    )?;
    Ok(())
}

/// Save a new access list after a grant change on a healthy source.
pub fn set_protection_access(conn: &Connection, id: &str, access_json: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET access_json = ?2 WHERE id = ?1",
        params![id, access_json],
    )?;
    Ok(())
}

pub fn set_protection_state(
    conn: &Connection,
    id: &str,
    state: &str,
    stop_reason: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET state = ?2, stop_reason = ?3 WHERE id = ?1",
        params![id, state, stop_reason],
    )?;
    Ok(())
}

pub fn record_protection_checked(conn: &Connection, id: &str, now: i64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE protections SET last_checked_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// A folder or file moved on one drive: point every protection under the old
/// path at the new one, the same way grants follow a move. Moving the drive
/// root (empty old path) changes nothing here. Returns the number moved.
pub fn repath_protections_move(
    conn: &Connection,
    from_drive: &str,
    old_path: &str,
    to_drive: &str,
    new_path: &str,
) -> anyhow::Result<usize> {
    let old = crate::access::normalize_subject_path(old_path);
    if old.is_empty() {
        return Ok(0);
    }
    let new = crate::access::normalize_subject_path(new_path);
    let candidates = {
        let mut stmt =
            conn.prepare_cached("SELECT id, source_path FROM protections WHERE source_drive = ?1")?;
        stmt.query_map(params![from_drive], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut moved = 0;
    for (id, path) in candidates {
        if !crate::access::path_contains(&old, &path) {
            continue;
        }
        let suffix = &path[old.len()..];
        let retargeted = crate::access::normalize_subject_path(&format!("{new}{suffix}"));
        conn.execute(
            "UPDATE protections SET source_drive = ?2, source_path = ?3 WHERE id = ?1",
            params![id, to_drive, retargeted],
        )?;
        moved += 1;
    }
    Ok(moved)
}

/// Protections that read from this drive or write to it.
pub fn protections_on_drive(
    conn: &Connection,
    drive_id: &str,
) -> anyhow::Result<Vec<ProtectionRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PROTECTION_COLUMNS} FROM protections
         WHERE source_drive = ?1 OR target_drive = ?1
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt
        .query_map(params![drive_id], protection_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---- Cloud backup (Protect rebuild) ----
//
// Packs belong to one dedup scope (the shared backup, or one private owner).
// Pack states: pending (uploading) -> live (referenced by a snapshot) ->
// marked (no snapshot uses it; 24 h grace) -> deleting (being removed).

/// This Luna's cloud identity: its id and the seed for its signing key.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudIdentity {
    pub luna_id: String,
    pub signing_seed: Vec<u8>,
    pub created_at: i64,
}

pub fn get_cloud_identity(conn: &Connection) -> anyhow::Result<Option<CloudIdentity>> {
    let row = conn
        .query_row(
            "SELECT luna_id, signing_seed, created_at FROM cloud_identity WHERE id = 1",
            [],
            |r| {
                Ok(CloudIdentity {
                    luna_id: r.get(0)?,
                    signing_seed: r.get(1)?,
                    created_at: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_cloud_identity(
    conn: &Connection,
    luna_id: &str,
    seed: &[u8],
    now: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO cloud_identity (id, luna_id, signing_seed, created_at)
         VALUES (1, ?1, ?2, ?3)",
        params![luna_id, seed, now],
    )?;
    Ok(())
}

/// Public keys and the sealed private key for one user's cloud access.
#[derive(Debug, Clone, PartialEq)]
pub struct UserKeys {
    pub user_id: String,
    pub seal_public: Vec<u8>,
    pub auth_public: Vec<u8>,
    pub self_sealed: Vec<u8>,
    pub phrase_set_at: i64,
    pub last_checked_at: i64,
    /// 12 or 24 words; 0 when unknown (phrases made before this was stored).
    pub phrase_words: i64,
}

const USER_KEYS_COLUMNS: &str = "user_id, seal_public, auth_public, self_sealed, phrase_set_at, \
     last_checked_at, phrase_words";

fn user_keys_from_row(r: &rusqlite::Row) -> rusqlite::Result<UserKeys> {
    Ok(UserKeys {
        user_id: r.get(0)?,
        seal_public: r.get(1)?,
        auth_public: r.get(2)?,
        self_sealed: r.get(3)?,
        phrase_set_at: r.get(4)?,
        last_checked_at: r.get(5)?,
        phrase_words: r.get(6)?,
    })
}

pub fn get_user_keys(conn: &Connection, user_id: &str) -> anyhow::Result<Option<UserKeys>> {
    let row = conn
        .query_row(
            &format!("SELECT {USER_KEYS_COLUMNS} FROM user_keys WHERE user_id = ?1"),
            params![user_id],
            user_keys_from_row,
        )
        .optional()?;
    Ok(row)
}

pub fn set_user_keys(conn: &Connection, keys: &UserKeys) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO user_keys
            (user_id, seal_public, auth_public, self_sealed, phrase_set_at, last_checked_at, phrase_words)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            keys.user_id,
            keys.seal_public,
            keys.auth_public,
            keys.self_sealed,
            keys.phrase_set_at,
            keys.last_checked_at,
            keys.phrase_words
        ],
    )?;
    Ok(())
}

pub fn delete_user_keys(conn: &Connection, user_id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM user_keys WHERE user_id = ?1", params![user_id])?;
    Ok(())
}

pub fn list_user_keys(conn: &Connection) -> anyhow::Result<Vec<UserKeys>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {USER_KEYS_COLUMNS} FROM user_keys ORDER BY user_id"
    ))?;
    let rows = stmt
        .query_map([], user_keys_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// One versioned key for a protection's backups.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupKey {
    pub protection_id: String,
    pub version: i64,
    pub key: Vec<u8>,
    pub dedup_key: Vec<u8>,
    pub created_at: i64,
}

pub fn insert_backup_key(conn: &Connection, k: &BackupKey) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO backup_keys (protection_id, version, key, dedup_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![k.protection_id, k.version, k.key, k.dedup_key, k.created_at],
    )?;
    Ok(())
}

pub fn latest_backup_key(
    conn: &Connection,
    protection_id: &str,
) -> anyhow::Result<Option<BackupKey>> {
    let row = conn
        .query_row(
            "SELECT protection_id, version, key, dedup_key, created_at FROM backup_keys
             WHERE protection_id = ?1 ORDER BY version DESC LIMIT 1",
            params![protection_id],
            backup_key_from_row,
        )
        .optional()?;
    Ok(row)
}

pub fn list_backup_keys(conn: &Connection, protection_id: &str) -> anyhow::Result<Vec<BackupKey>> {
    let mut stmt = conn.prepare(
        "SELECT protection_id, version, key, dedup_key, created_at FROM backup_keys
         WHERE protection_id = ?1 ORDER BY version ASC",
    )?;
    let rows = stmt
        .query_map(params![protection_id], backup_key_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn backup_key_from_row(r: &rusqlite::Row) -> rusqlite::Result<BackupKey> {
    Ok(BackupKey {
        protection_id: r.get(0)?,
        version: r.get(1)?,
        key: r.get(2)?,
        dedup_key: r.get(3)?,
        created_at: r.get(4)?,
    })
}

/// Start a pack upload. It stays `pending` until `set_pack_live` runs at commit.
pub fn insert_pending_pack(
    conn: &Connection,
    id: &str,
    scope: &str,
    run_id: &str,
    now: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
         VALUES (?1, ?2, 'pending', ?3, 0, 0, ?4)",
        params![id, scope, run_id, now],
    )?;
    Ok(())
}

/// Record the real byte size of a pack once it is sealed, so storage totals are not zero.
pub fn record_pack_size(conn: &Connection, id: &str, size: i64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_packs SET size = ?2 WHERE id = ?1",
        params![id, size],
    )?;
    Ok(())
}

pub fn set_pack_live(conn: &Connection, id: &str, size: i64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_packs SET state = 'live', size = ?2 WHERE id = ?1",
        params![id, size],
    )?;
    Ok(())
}

/// Ids of packs in one scope with the given state.
pub fn list_packs(conn: &Connection, scope: &str, state: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM cloud_packs WHERE scope = ?1 AND state = ?2 ORDER BY id")?;
    let rows = stmt
        .query_map(params![scope, state], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Remove a pack and its chunk index entries (after the file is gone from the cloud).
pub fn delete_pack_row(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM cloud_chunks WHERE pack_id = ?1", params![id])?;
    tx.execute("DELETE FROM cloud_packs WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// Find where a chunk is stored. Chunks in marked or deleting packs don't count,
/// so a new backup uploads them again instead of depending on a pack that may go away.
pub fn find_chunk(
    conn: &Connection,
    scope: &str,
    chunk_id: &[u8],
) -> anyhow::Result<Option<(String, i64, i64)>> {
    let row = conn
        .query_row(
            "SELECT c.pack_id, c.offset, c.len FROM cloud_chunks c
             JOIN cloud_packs p ON p.id = c.pack_id
             WHERE c.scope = ?1 AND c.chunk_id = ?2
               AND p.state NOT IN ('marked', 'deleting')",
            params![scope, chunk_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row)
}

pub fn insert_chunk(
    conn: &Connection,
    scope: &str,
    chunk_id: &[u8],
    pack_id: &str,
    offset: i64,
    len: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO cloud_chunks (scope, chunk_id, pack_id, offset, len)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![scope, chunk_id, pack_id, offset, len],
    )?;
    Ok(())
}

/// One saved backup snapshot. `record` is the encrypted snapshot record.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotInsert {
    pub id: String,
    pub protection_id: String,
    pub created_at: i64,
    pub key_version: i64,
    pub tree_pack_id: String,
    pub record: Vec<u8>,
}

fn snapshot_from_row(r: &rusqlite::Row) -> rusqlite::Result<SnapshotInsert> {
    Ok(SnapshotInsert {
        id: r.get(0)?,
        protection_id: r.get(1)?,
        created_at: r.get(2)?,
        key_version: r.get(3)?,
        tree_pack_id: r.get(4)?,
        record: r.get(5)?,
    })
}

pub fn insert_cloud_snapshot(conn: &Connection, s: &SnapshotInsert) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO cloud_snapshots
            (id, protection_id, created_at, key_version, tree_pack_id, record)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            s.id,
            s.protection_id,
            s.created_at,
            s.key_version,
            s.tree_pack_id,
            s.record
        ],
    )?;
    Ok(())
}

/// Snapshots of one protection, newest first.
pub fn list_cloud_snapshots(
    conn: &Connection,
    protection_id: &str,
) -> anyhow::Result<Vec<SnapshotInsert>> {
    let mut stmt = conn.prepare(
        "SELECT id, protection_id, created_at, key_version, tree_pack_id, record
         FROM cloud_snapshots WHERE protection_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map(params![protection_id], snapshot_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Delete a snapshot and its pack links. Packs it used are not removed here;
/// `mark_unused_packs_tx` finds the ones nothing uses anymore.
pub fn delete_cloud_snapshot(conn: &Connection, id: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM cloud_snapshot_packs WHERE snapshot_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM cloud_snapshots WHERE id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM cloud_private_trees WHERE snapshot_id = ?1",
        params![id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn start_run(
    conn: &Connection,
    id: &str,
    protection_id: &str,
    scope: &str,
    now: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO cloud_runs (id, protection_id, scope, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, 0)",
        params![id, protection_id, scope, now],
    )?;
    Ok(())
}

pub fn end_run(conn: &Connection, id: &str, now: i64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_runs SET ended_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Ids of runs in one scope that have not ended yet.
pub fn open_runs(conn: &Connection, scope: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM cloud_runs WHERE scope = ?1 AND ended_at = 0 ORDER BY id")?;
    let rows = stmt
        .query_map(params![scope], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Save a snapshot and link the packs it uses, in one transaction.
/// Those packs become `live`; a `marked` pack goes back to `live`.
pub fn commit_snapshot_tx(
    conn: &mut Connection,
    snap: &SnapshotInsert,
    pack_ids: &[String],
) -> anyhow::Result<()> {
    let tx = conn.transaction()?;
    commit_snapshot_in(&tx, snap, pack_ids)?;
    tx.commit()?;
    Ok(())
}

/// The body of `commit_snapshot_tx`, inside a transaction the caller owns.
fn commit_snapshot_in(
    tx: &rusqlite::Transaction,
    snap: &SnapshotInsert,
    pack_ids: &[String],
) -> anyhow::Result<()> {
    insert_cloud_snapshot(tx, snap)?;
    for pack_id in pack_ids {
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM cloud_packs WHERE id = ?1",
                params![pack_id],
                |r| r.get(0),
            )
            .optional()?;
        match state.as_deref() {
            None => anyhow::bail!("Backup pack {pack_id} is missing from the database."),
            Some("deleting") => anyhow::bail!(
                "Backup pack {pack_id} is being removed, so this backup cannot use it."
            ),
            _ => {}
        }
        tx.execute(
            "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
            params![snap.id, pack_id],
        )?;
        tx.execute(
            "UPDATE cloud_packs SET state = 'live', marked_at = 0 WHERE id = ?1",
            params![pack_id],
        )?;
    }
    Ok(())
}

/// Mark live packs in one scope that no snapshot uses. Returns their ids.
/// Marking starts the 24 h wait before `deletable_packs` returns them.
pub fn mark_unused_packs_tx(
    conn: &mut Connection,
    scope: &str,
    now: i64,
) -> anyhow::Result<Vec<String>> {
    let tx = conn.transaction()?;
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM cloud_packs
             WHERE scope = ?1 AND state = 'live'
               AND id NOT IN (SELECT pack_id FROM cloud_snapshot_packs)
             ORDER BY id",
        )?;
        stmt.query_map(params![scope], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in &ids {
        tx.execute(
            "UPDATE cloud_packs SET state = 'marked', marked_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
    }
    tx.commit()?;
    Ok(ids)
}

/// Startup cleanup after a crash or restart: no cloud run can still be going, so every run
/// without an end time is over. Packs those runs uploaded but never committed are marked
/// for the normal cleanup (after its 24 h wait), and their chunk index rows are dropped so
/// no later run reuses them. Returns how many runs were ended.
pub fn recover_interrupted_runs(conn: &Connection, now: i64) -> anyhow::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let ended = tx.execute(
        "UPDATE cloud_runs SET ended_at = ?1 WHERE ended_at = 0",
        params![now],
    )?;
    tx.execute(
        "DELETE FROM cloud_chunks WHERE pack_id IN (
             SELECT p.id FROM cloud_packs p
             WHERE p.state = 'pending'
               AND p.run_id IN (SELECT id FROM cloud_runs WHERE ended_at = ?1)
               AND p.id NOT IN (SELECT pack_id FROM cloud_snapshot_packs))",
        params![now],
    )?;
    tx.execute(
        "UPDATE cloud_packs SET state = 'marked', marked_at = ?1
         WHERE state = 'pending'
           AND run_id IN (SELECT id FROM cloud_runs WHERE ended_at = ?1)
           AND id NOT IN (SELECT pack_id FROM cloud_snapshot_packs)",
        params![now],
    )?;
    tx.commit()?;
    Ok(ended)
}

/// Marked packs in one scope that are safe to delete now: marked at least 24 h ago,
/// and no unfinished run in the scope started before the mark (it might still use them).
pub fn deletable_packs(conn: &Connection, scope: &str, now: i64) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT p.id FROM cloud_packs p
         WHERE p.scope = ?1 AND p.state = 'marked' AND ?2 - p.marked_at >= 86400
           AND NOT EXISTS (
               SELECT 1 FROM cloud_runs r
               WHERE r.scope = ?1 AND r.started_at <= p.marked_at AND r.ended_at = 0)
         ORDER BY p.id",
    )?;
    let rows = stmt
        .query_map(params![scope, now], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// A private scope: one owner's private items. Its items are sealed to `scope_public`, and its
/// secret key is kept only sealed to the owner (`sealed_scope_secret`). `seal_public` is the owner's
/// key at the time it was last sealed to, and changes when the owner's phrase is replaced.
#[derive(Debug, Clone, PartialEq)]
pub struct PrivateScope {
    pub scope: String,
    pub owner: String,
    pub seal_public: Vec<u8>,
    pub scope_public: Vec<u8>,
    pub sealed_scope_secret: Vec<u8>,
    pub dedup_key: Vec<u8>,
    pub state: String,
    pub retire_after: i64,
    pub created_at: i64,
}

const PRIVATE_SCOPE_COLUMNS: &str = "scope, owner, seal_public, scope_public, sealed_scope_secret, dedup_key, state, retire_after, created_at";

fn private_scope_from_row(r: &rusqlite::Row) -> rusqlite::Result<PrivateScope> {
    Ok(PrivateScope {
        scope: r.get(0)?,
        owner: r.get(1)?,
        seal_public: r.get(2)?,
        scope_public: r.get(3)?,
        sealed_scope_secret: r.get(4)?,
        dedup_key: r.get(5)?,
        state: r.get(6)?,
        retire_after: r.get(7)?,
        created_at: r.get(8)?,
    })
}

pub fn insert_private_scope(conn: &Connection, s: &PrivateScope) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO cloud_private_scopes (scope, owner, seal_public, scope_public, sealed_scope_secret, dedup_key, state, retire_after, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            s.scope,
            s.owner,
            s.seal_public,
            s.scope_public,
            s.sealed_scope_secret,
            s.dedup_key,
            s.state,
            s.retire_after,
            s.created_at
        ],
    )?;
    Ok(())
}

/// Re-seals a scope's secret key to the owner's new sealing key. The scope's own key pair and its
/// data stay as they are.
pub fn set_private_scope_seal(
    conn: &Connection,
    scope: &str,
    owner_public: &[u8],
    sealed_scope_secret: &[u8],
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_private_scopes SET seal_public = ?2, sealed_scope_secret = ?3 WHERE scope = ?1",
        params![scope, owner_public, sealed_scope_secret],
    )?;
    Ok(())
}

pub fn get_private_scope(conn: &Connection, scope: &str) -> anyhow::Result<Option<PrivateScope>> {
    let sql = format!("SELECT {PRIVATE_SCOPE_COLUMNS} FROM cloud_private_scopes WHERE scope = ?1");
    Ok(conn
        .query_row(&sql, params![scope], private_scope_from_row)
        .optional()?)
}

/// The owner's newest scope that is still `active`.
pub fn active_private_scope(
    conn: &Connection,
    owner: &str,
) -> anyhow::Result<Option<PrivateScope>> {
    let sql = format!(
        "SELECT {PRIVATE_SCOPE_COLUMNS} FROM cloud_private_scopes
         WHERE owner = ?1 AND state = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![owner], private_scope_from_row)
        .optional()?)
}

/// All scopes, or one owner's scopes, oldest first.
pub fn list_private_scopes(
    conn: &Connection,
    owner: Option<&str>,
) -> anyhow::Result<Vec<PrivateScope>> {
    let rows = match owner {
        Some(owner) => {
            let sql = format!(
                "SELECT {PRIVATE_SCOPE_COLUMNS} FROM cloud_private_scopes
                 WHERE owner = ?1 ORDER BY created_at, scope"
            );
            let mut stmt = conn.prepare(&sql)?;
            stmt.query_map(params![owner], private_scope_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        }
        None => {
            let sql = format!(
                "SELECT {PRIVATE_SCOPE_COLUMNS} FROM cloud_private_scopes ORDER BY created_at, scope"
            );
            let mut stmt = conn.prepare(&sql)?;
            stmt.query_map([], private_scope_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    Ok(rows)
}

pub fn set_private_scope_state(
    conn: &Connection,
    scope: &str,
    state: &str,
    retire_after: i64,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE cloud_private_scopes SET state = ?2, retire_after = ?3 WHERE scope = ?1",
        params![scope, state, retire_after],
    )?;
    Ok(())
}

/// Removes a scope row and the plain trees of its snapshots, in one transaction.
pub fn delete_private_scope(conn: &Connection, scope: &str) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM cloud_private_trees WHERE scope = ?1",
        params![scope],
    )?;
    tx.execute(
        "DELETE FROM cloud_private_kept WHERE scope = ?1",
        params![scope],
    )?;
    tx.execute(
        "DELETE FROM cloud_private_scopes WHERE scope = ?1",
        params![scope],
    )?;
    tx.commit()?;
    Ok(())
}

/// The previous copy of a scope's secret key, kept until `expires_at` so the old phrase can still
/// open the scope. Replaces any copy already kept for the scope.
#[derive(Debug, Clone, PartialEq)]
pub struct KeptScopeSecret {
    pub scope: String,
    pub seal_public: Vec<u8>,
    pub sealed_scope_secret: Vec<u8>,
    pub expires_at: i64,
}

pub fn keep_scope_secret(conn: &Connection, kept: &KeptScopeSecret) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO cloud_private_kept (scope, seal_public, sealed_scope_secret, expires_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            kept.scope,
            kept.seal_public,
            kept.sealed_scope_secret,
            kept.expires_at
        ],
    )?;
    Ok(())
}

/// One owner's kept copies that have not expired. Only ever called with the signed-in owner.
pub fn list_kept_scope_secrets(
    conn: &Connection,
    owner: &str,
    now: i64,
) -> anyhow::Result<Vec<KeptScopeSecret>> {
    let mut stmt = conn.prepare(
        "SELECT k.scope, k.seal_public, k.sealed_scope_secret, k.expires_at
         FROM cloud_private_kept k JOIN cloud_private_scopes s ON s.scope = k.scope
         WHERE s.owner = ?1 AND k.expires_at > ?2 ORDER BY k.scope",
    )?;
    let rows = stmt
        .query_map(params![owner, now], |r| {
            Ok(KeptScopeSecret {
                scope: r.get(0)?,
                seal_public: r.get(1)?,
                sealed_scope_secret: r.get(2)?,
                expires_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Drops every kept copy for one owner's scopes.
pub fn clear_kept_scope_secrets(conn: &Connection, owner: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM cloud_private_kept WHERE scope IN (SELECT scope FROM cloud_private_scopes WHERE owner = ?1)",
        params![owner],
    )?;
    Ok(())
}

/// Drops kept copies whose 30 days are over.
pub fn clear_expired_kept_scope_secrets(conn: &Connection, now: i64) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM cloud_private_kept WHERE expires_at <= ?1",
        params![now],
    )?;
    Ok(())
}

pub fn get_private_tree(conn: &Connection, snapshot_id: &str) -> anyhow::Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT tree FROM cloud_private_trees WHERE snapshot_id = ?1",
            params![snapshot_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn private_snapshot_ids(conn: &Connection, scope: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT snapshot_id FROM cloud_private_trees WHERE scope = ?1 ORDER BY snapshot_id",
    )?;
    let rows = stmt
        .query_map(params![scope], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn private_scope_of_snapshot(
    conn: &Connection,
    snapshot_id: &str,
) -> anyhow::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT scope FROM cloud_private_trees WHERE snapshot_id = ?1",
            params![snapshot_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// IDs of Luna's indexed shared snapshots. Private snapshots live in the same table but
/// Connect lists them under a separate, scope-protected record kind.
pub fn list_shared_cloud_snapshot_ids(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM cloud_snapshots
         WHERE id NOT IN (SELECT snapshot_id FROM cloud_private_trees)",
    )?;
    Ok(stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `commit_snapshot_tx` for a private snapshot, plus its plain tree, in one transaction.
pub fn commit_private_snapshot_tx(
    conn: &mut Connection,
    snap: &SnapshotInsert,
    pack_ids: &[String],
    scope: &str,
    tree_json: &[u8],
) -> anyhow::Result<()> {
    let tx = conn.transaction()?;
    commit_snapshot_in(&tx, snap, pack_ids)?;
    tx.execute(
        "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
        params![snap.id, scope, tree_json],
    )?;
    tx.commit()?;
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
    /// Who opened this session — `user:{id}` for members, `link:{id}` for
    /// public share uploads, empty for rows that predate the column.
    /// Sessions belong to their creator; nobody else may drive them.
    pub principal: String,
}

fn upload_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UploadRow> {
    Ok(UploadRow {
        id: row.get(0)?,
        drive_id: row.get(1)?,
        path: row.get(2)?,
        name: row.get(3)?,
        size: row.get::<_, i64>(4)? as u64,
        received: row.get::<_, i64>(5)? as u64,
        state: row.get(6)?,
        principal: row.get(7)?,
    })
}

pub fn insert_upload(
    conn: &Connection,
    id: &str,
    drive_id: &str,
    path: &str,
    name: &str,
    size: u64,
    principal: &str,
) -> anyhow::Result<()> {
    let now = now_unix();
    conn.execute(
        "INSERT INTO uploads (id, drive_id, path, name, size, received, state, principal, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 'active', ?6, ?7, ?7)",
        params![id, drive_id, path, name, size as i64, principal, now],
    )?;
    Ok(())
}

pub fn get_upload(conn: &Connection, id: &str) -> anyhow::Result<Option<UploadRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, drive_id, path, name, size, received, state, principal FROM uploads WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], upload_from_row)?;
    Ok(rows.next().transpose()?)
}

/// Upload sessions whose last activity is older than `idle_before` (unix
/// seconds) — the candidates for the boot-time orphan sweep.
pub fn list_stale_uploads(conn: &Connection, idle_before: i64) -> anyhow::Result<Vec<UploadRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, drive_id, path, name, size, received, state, principal FROM uploads
         WHERE updated_at < ?1",
    )?;
    let rows = stmt.query_map(params![idle_before], upload_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
    let mut stmt = conn.prepare_cached(
        "SELECT start, end FROM upload_chunks WHERE upload_id = ?1 ORDER BY start",
    )?;
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
    let mut stmt = conn.prepare_cached(
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
    let mut stmt = conn.prepare_cached(
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
    let mut stmt = conn.prepare_cached(
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

/// Lock the OS database and run `f` on the connection. `lock_err` builds the
/// caller's error for a poisoned mutex so each module keeps its own mapping.
pub fn with_db<T, E>(
    db: &crate::Db,
    lock_err: impl FnOnce() -> E,
    f: impl FnOnce(&Connection) -> Result<T, E>,
) -> Result<T, E> {
    let conn = db.lock().map_err(|_| lock_err())?;
    f(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_runs_are_ended_and_their_uncommitted_packs_marked() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        start_run(&conn, "run-crashed", "p1", "s", 100).unwrap();
        insert_pending_pack(&conn, "orphan", "s", "run-crashed", 100).unwrap();
        insert_chunk(&conn, "s", b"chunk-a", "orphan", 0, 10).unwrap();
        insert_pending_pack(&conn, "committed", "s", "run-crashed", 100).unwrap();
        set_pack_live(&conn, "committed", 10).unwrap();
        insert_chunk(&conn, "s", b"chunk-b", "committed", 0, 10).unwrap();

        assert_eq!(recover_interrupted_runs(&conn, 500).unwrap(), 1);
        assert_eq!(open_runs(&conn, "s").unwrap(), Vec::<String>::new());
        let (state, marked_at): (String, i64) = conn
            .query_row(
                "SELECT state, marked_at FROM cloud_packs WHERE id = 'orphan'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), marked_at), ("marked", 500));
        assert!(find_chunk(&conn, "s", b"chunk-a").unwrap().is_none());
        let live: String = conn
            .query_row(
                "SELECT state FROM cloud_packs WHERE id = 'committed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(live, "live", "committed packs are left alone");
        assert_eq!(
            recover_interrupted_runs(&conn, 600).unwrap(),
            0,
            "nothing left to end"
        );
    }

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
    fn delete_user_takes_their_links_and_grants_down() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_user(&conn, "u1", "jamie", "Jamie", "hash", "user").unwrap();
        insert_user(&conn, "u2", "kim", "Kim", "hash", "user").unwrap();
        insert_access_member(
            &conn,
            &AccessMemberRow {
                id: "m1".into(),
                subject_kind: "path".into(),
                drive_id: "d1".into(),
                path: "docs".into(),
                album_id: String::new(),
                user_id: "u1".into(),
                caps: 1,
                created_by: "u2".into(),
            },
        )
        .unwrap();
        let link = |id: &str, by: &str| AccessLinkRow {
            id: id.into(),
            token_hash: format!("hash-{id}"),
            token: String::new(),
            subject_kind: "path".into(),
            drive_id: "d1".into(),
            path: "docs".into(),
            album_id: String::new(),
            caps: 1,
            password_hash: String::new(),
            expires_at: None,
            created_by: by.into(),
            created_at: now_unix(),
        };
        insert_access_link(&conn, &link("l-mine", "u1")).unwrap();
        insert_access_link(&conn, &link("l-theirs", "u2")).unwrap();

        delete_user(&conn, "u1").unwrap();

        assert!(get_user(&conn, "u1").unwrap().is_none());
        assert!(
            list_access_members_for_user(&conn, "u1")
                .unwrap()
                .is_empty()
        );
        // The expelled member's public link is gone — links they made
        // must not keep working after the account is deleted.
        assert!(get_access_link(&conn, "l-mine").unwrap().is_none());
        // Other people's access is untouched.
        assert!(get_access_link(&conn, "l-theirs").unwrap().is_some());
        assert!(get_user(&conn, "u2").unwrap().is_some());
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

    fn new_protection<'a>(id: &'a str, drive: &'a str, path: &'a str) -> NewProtection<'a> {
        NewProtection {
            id,
            kind: PROTECTION_DRIVE,
            source_drive: drive,
            source_path: path,
            target_drive: "backup1",
            private_owner: "",
            created_by: "u1",
            created_at: 100,
        }
    }

    #[test]
    fn a_parent_backup_covers_only_the_same_kind_place_and_privacy() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        let add = |id: &str, kind: &str, path: &str, target: &str, owner: &str| {
            insert_protection(
                &conn,
                &NewProtection {
                    kind,
                    target_drive: target,
                    private_owner: owner,
                    ..new_protection(id, "d1", path)
                },
            )
            .unwrap();
        };
        add("parent", PROTECTION_DRIVE, "docs", "b1", "");
        add("child", PROTECTION_DRIVE, "docs/sub", "b1", "");
        add("other-target", PROTECTION_DRIVE, "docs/sub", "b2", "");
        add("cloud-child", PROTECTION_CLOUD, "docs/sub", "", "");
        add("private-child", PROTECTION_DRIVE, "docs/vault", "b1", "ann");
        add("sibling", PROTECTION_DRIVE, "docsy", "b1", "");
        let row = |id: &str| get_protection(&conn, id).unwrap().unwrap();
        let covered = |id: &str| covering_protection(&conn, &row(id)).unwrap().map(|p| p.id);

        // Until the parent finishes its first copy, nothing is covered.
        assert_eq!(covered("child"), None);
        record_protection_ok(&conn, "parent", 5, "{}").unwrap();
        assert_eq!(covered("child"), Some("parent".to_string()));
        // Another backup drive, the cloud, a private item and a name that only
        // starts the same way are all separate.
        assert_eq!(covered("other-target"), None);
        assert_eq!(covered("cloud-child"), None);
        assert_eq!(covered("private-child"), None);
        assert_eq!(covered("sibling"), None);
        // The parent itself is never covered by itself.
        assert_eq!(covered("parent"), None);

        // A stopped parent gives the child back; so does a deleted one.
        set_protection_state(
            &conn,
            "parent",
            PROTECTION_STOPPED,
            "You stopped this backup.",
        )
        .unwrap();
        assert_eq!(covered("child"), None);
        set_protection_state(&conn, "parent", PROTECTION_ACTIVE, "").unwrap();
        assert_eq!(covered("child"), Some("parent".to_string()));
        delete_protection(&conn, "parent").unwrap();
        assert_eq!(covered("child"), None);
    }

    #[test]
    fn the_nearest_parent_backup_is_the_one_that_covers() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        for (id, path) in [("root", ""), ("mid", "a"), ("leaf", "a/b/c")] {
            insert_protection(
                &conn,
                &NewProtection {
                    target_drive: "b1",
                    ..new_protection(id, "d1", path)
                },
            )
            .unwrap();
        }
        record_protection_ok(&conn, "root", 5, "{}").unwrap();
        record_protection_ok(&conn, "mid", 5, "{}").unwrap();
        let leaf = get_protection(&conn, "leaf").unwrap().unwrap();
        assert_eq!(
            covering_protection(&conn, &leaf).unwrap().unwrap().id,
            "mid"
        );
        // The whole-drive backup has no parent.
        let root = get_protection(&conn, "root").unwrap().unwrap();
        assert!(covering_protection(&conn, &root).unwrap().is_none());
    }

    #[test]
    fn protection_insert_get_list_delete() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        let row = insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();
        assert_eq!(row.state, PROTECTION_ACTIVE);
        assert!(!row.first_done);
        assert_eq!(row.access_json, "");
        assert_eq!(get_protection(&conn, "p1").unwrap(), Some(row.clone()));
        assert_eq!(
            find_protection(&conn, PROTECTION_DRIVE, "d1", "docs", "backup1").unwrap(),
            Some(row)
        );
        assert!(
            find_protection(&conn, PROTECTION_CLOUD, "d1", "docs", "")
                .unwrap()
                .is_none()
        );

        insert_protection(
            &conn,
            &NewProtection {
                created_at: 200,
                ..new_protection("p2", "d1", "pics")
            },
        )
        .unwrap();
        let ids: Vec<String> = list_protections(&conn)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["p2", "p1"]);

        assert!(delete_protection(&conn, "p1").unwrap());
        assert!(!delete_protection(&conn, "p1").unwrap());
        assert!(get_protection(&conn, "p1").unwrap().is_none());
    }

    #[test]
    fn protection_unique_clash_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();
        assert!(insert_protection(&conn, &new_protection("p2", "d1", "docs")).is_err());
    }

    #[test]
    fn protection_ok_and_error_bookkeeping() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();

        record_protection_error(&conn, "p1", "Drive not found", false, 500).unwrap();
        record_protection_error(&conn, "p1", "Drive still not found", true, 600).unwrap();
        let failing = get_protection(&conn, "p1").unwrap().unwrap();
        assert_eq!(failing.failing_since, 500);
        assert_eq!(failing.last_error, "Drive still not found");
        assert!(failing.hard);
        assert!(!failing.first_done);

        record_protection_ok(&conn, "p1", 700, "{\"grants\":[]}").unwrap();
        let ok = get_protection(&conn, "p1").unwrap().unwrap();
        assert_eq!(ok.last_ok_at, 700);
        assert_eq!(ok.last_error, "");
        assert!(!ok.hard);
        assert_eq!(ok.failing_since, 0);
        assert!(ok.first_done);
        assert_eq!(ok.access_json, "{\"grants\":[]}");

        set_protection_access(&conn, "p1", "{}").unwrap();
        record_protection_checked(&conn, "p1", 800).unwrap();
        set_protection_state(&conn, "p1", PROTECTION_STOPPED, "You stopped this backup.").unwrap();
        let later = get_protection(&conn, "p1").unwrap().unwrap();
        assert_eq!(later.access_json, "{}");
        assert_eq!(later.last_checked_at, 800);
        assert_eq!(later.state, PROTECTION_STOPPED);
        assert_eq!(later.stop_reason, "You stopped this backup.");
    }

    #[test]
    fn repath_protections_move_follows_subtree_only() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("exact", "d1", "docs")).unwrap();
        insert_protection(&conn, &new_protection("nested", "d1", "docs/2024/jan")).unwrap();
        insert_protection(&conn, &new_protection("sibling", "d1", "docs2")).unwrap();
        insert_protection(&conn, &new_protection("other", "d2", "docs")).unwrap();

        let moved = repath_protections_move(&conn, "d1", "/docs/", "d1", "archive").unwrap();
        assert_eq!(moved, 2);
        assert_eq!(
            get_protection(&conn, "exact").unwrap().unwrap().source_path,
            "archive"
        );
        assert_eq!(
            get_protection(&conn, "nested")
                .unwrap()
                .unwrap()
                .source_path,
            "archive/2024/jan"
        );
        assert_eq!(
            get_protection(&conn, "sibling")
                .unwrap()
                .unwrap()
                .source_path,
            "docs2"
        );
        assert_eq!(
            get_protection(&conn, "other")
                .unwrap()
                .unwrap()
                .source_drive,
            "d2"
        );
    }

    #[test]
    fn repath_protections_move_across_drives() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "photos/trip")).unwrap();

        let moved = repath_protections_move(&conn, "d1", "photos", "d2", "").unwrap();
        assert_eq!(moved, 1);
        let row = get_protection(&conn, "p1").unwrap().unwrap();
        assert_eq!(row.source_drive, "d2");
        assert_eq!(row.source_path, "trip");

        assert_eq!(
            repath_protections_move(&conn, "d2", "", "d3", "x").unwrap(),
            0
        );
    }

    #[test]
    fn protections_on_drive_matches_source_or_target() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();
        insert_protection(
            &conn,
            &NewProtection {
                target_drive: "d9",
                ..new_protection("p2", "d2", "docs")
            },
        )
        .unwrap();
        insert_protection(&conn, &new_protection("p3", "d3", "docs")).unwrap();

        let mut ids: Vec<String> = protections_on_drive(&conn, "d9")
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["p2"]);
        assert_eq!(protections_on_drive(&conn, "d1").unwrap().len(), 1);
    }

    #[test]
    fn delete_drive_cascade_leaves_protections_intact() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();
        delete_drive_cascade(&conn, "d1").unwrap();
        assert!(get_protection(&conn, "p1").unwrap().is_some());
    }

    #[test]
    fn factory_reset_clears_protections() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("p1", "d1", "docs")).unwrap();
        factory_reset(&conn).unwrap();
        assert!(list_protections(&conn).unwrap().is_empty());
    }

    fn cloud_snap(id: &str, protection: &str, created_at: i64) -> SnapshotInsert {
        SnapshotInsert {
            id: id.into(),
            protection_id: protection.into(),
            created_at,
            key_version: 1,
            tree_pack_id: "tree".into(),
            record: vec![1, 2, 3],
        }
    }

    fn live_pack(conn: &Connection, id: &str, scope: &str) {
        insert_pending_pack(conn, id, scope, "run", 1).unwrap();
        set_pack_live(conn, id, 10).unwrap();
    }

    fn pack_state(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT state FROM cloud_packs WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn cloud_identity_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        assert!(get_cloud_identity(&conn).unwrap().is_none());
        set_cloud_identity(&conn, "luna-1", &[7; 32], 42).unwrap();
        let id = get_cloud_identity(&conn).unwrap().unwrap();
        assert_eq!(id.luna_id, "luna-1");
        assert_eq!(id.signing_seed, vec![7; 32]);
        assert_eq!(id.created_at, 42);
    }

    #[test]
    fn user_keys_crud() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        let keys = UserKeys {
            user_id: "u1".into(),
            seal_public: vec![1; 32],
            auth_public: vec![2; 32],
            self_sealed: vec![3; 48],
            phrase_set_at: 5,
            last_checked_at: 0,
            phrase_words: 12,
        };
        set_user_keys(&conn, &keys).unwrap();
        assert_eq!(get_user_keys(&conn, "u1").unwrap(), Some(keys.clone()));
        assert_eq!(list_user_keys(&conn).unwrap(), vec![keys.clone()]);
        // A 24-word phrase round-trips too.
        let keys24 = UserKeys {
            phrase_words: 24,
            ..keys.clone()
        };
        set_user_keys(&conn, &keys24).unwrap();
        assert_eq!(get_user_keys(&conn, "u1").unwrap(), Some(keys24));
        delete_user_keys(&conn, "u1").unwrap();
        assert!(get_user_keys(&conn, "u1").unwrap().is_none());
        assert!(list_user_keys(&conn).unwrap().is_empty());
    }

    #[test]
    fn backup_keys_latest_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        assert!(latest_backup_key(&conn, "p1").unwrap().is_none());
        let key = |v: i64| BackupKey {
            protection_id: "p1".into(),
            version: v,
            key: vec![v as u8; 32],
            dedup_key: vec![9; 32],
            created_at: v,
        };
        insert_backup_key(&conn, &key(1)).unwrap();
        insert_backup_key(&conn, &key(2)).unwrap();
        assert!(insert_backup_key(&conn, &key(2)).is_err());
        assert_eq!(latest_backup_key(&conn, "p1").unwrap(), Some(key(2)));
        let versions: Vec<i64> = list_backup_keys(&conn, "p1")
            .unwrap()
            .iter()
            .map(|k| k.version)
            .collect();
        assert_eq!(versions, vec![1, 2]);
    }

    #[test]
    fn pack_states_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_pending_pack(&conn, "p1", "s", "run1", 1).unwrap();
        assert_eq!(list_packs(&conn, "s", "pending").unwrap(), vec!["p1"]);
        set_pack_live(&conn, "p1", 99).unwrap();
        assert!(list_packs(&conn, "s", "pending").unwrap().is_empty());
        assert_eq!(list_packs(&conn, "s", "live").unwrap(), vec!["p1"]);
        assert!(list_packs(&conn, "other", "live").unwrap().is_empty());
        insert_chunk(&conn, "s", &[1], "p1", 0, 5).unwrap();
        delete_pack_row(&conn, "p1").unwrap();
        assert!(list_packs(&conn, "s", "live").unwrap().is_empty());
        assert!(find_chunk(&conn, "s", &[1]).unwrap().is_none());
    }

    #[test]
    fn find_chunk_returns_live_and_skips_marked() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        insert_chunk(&conn, "s", &[1], "p1", 16, 100).unwrap();
        assert_eq!(
            find_chunk(&conn, "s", &[1]).unwrap(),
            Some(("p1".into(), 16, 100))
        );
        assert!(find_chunk(&conn, "other", &[1]).unwrap().is_none());
        // No snapshot uses p1, so marking it hides its chunks from dedup.
        assert_eq!(
            mark_unused_packs_tx(&mut conn, "s", 1000).unwrap(),
            vec!["p1"]
        );
        assert!(find_chunk(&conn, "s", &[1]).unwrap().is_none());
        // A deleting pack is hidden too.
        commit_snapshot_tx(&mut conn, &cloud_snap("snap1", "prot", 1), &["p1".into()]).unwrap();
        conn.execute(
            "UPDATE cloud_packs SET state = 'deleting' WHERE id = 'p1'",
            [],
        )
        .unwrap();
        assert!(find_chunk(&conn, "s", &[1]).unwrap().is_none());
    }

    #[test]
    fn commit_snapshot_links_packs_and_unmarks() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        live_pack(&conn, "p2", "s");
        commit_snapshot_tx(&mut conn, &cloud_snap("snap1", "prot", 1), &["p1".into()]).unwrap();
        assert_eq!(
            mark_unused_packs_tx(&mut conn, "s", 1000).unwrap(),
            vec!["p2"]
        );
        assert_eq!(pack_state(&conn, "p2"), "marked");

        // A new snapshot that uses marked p2 brings it back to live.
        commit_snapshot_tx(
            &mut conn,
            &cloud_snap("snap2", "prot", 2),
            &["p1".into(), "p2".into()],
        )
        .unwrap();
        assert_eq!(pack_state(&conn, "p2"), "live");
        assert!(
            mark_unused_packs_tx(&mut conn, "s", 2000)
                .unwrap()
                .is_empty()
        );
        assert!(deletable_packs(&conn, "s", 1_000_000).unwrap().is_empty());
        assert_eq!(list_cloud_snapshots(&conn, "prot").unwrap().len(), 2);
    }

    #[test]
    fn commit_snapshot_rejects_deleting_pack_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        conn.execute(
            "UPDATE cloud_packs SET state = 'deleting' WHERE id = 'p1'",
            [],
        )
        .unwrap();
        let err = commit_snapshot_tx(&mut conn, &cloud_snap("snap1", "prot", 1), &["p1".into()]);
        assert!(err.is_err());
        assert!(list_cloud_snapshots(&conn, "prot").unwrap().is_empty());
    }

    #[test]
    fn mark_unused_packs_only_marks_unreferenced_live_packs_in_scope() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "used", "s");
        live_pack(&conn, "unused", "s");
        live_pack(&conn, "elsewhere", "other");
        insert_pending_pack(&conn, "uploading", "s", "run", 1).unwrap();
        commit_snapshot_tx(&mut conn, &cloud_snap("snap1", "prot", 1), &["used".into()]).unwrap();
        assert_eq!(
            mark_unused_packs_tx(&mut conn, "s", 500).unwrap(),
            vec!["unused"]
        );
        assert_eq!(pack_state(&conn, "elsewhere"), "live");
        assert_eq!(pack_state(&conn, "uploading"), "pending");
        assert_eq!(pack_state(&conn, "used"), "live");
    }

    #[test]
    fn deletable_packs_waits_24_hours() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        mark_unused_packs_tx(&mut conn, "s", 1000).unwrap();
        assert!(
            deletable_packs(&conn, "s", 1000 + 86399)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            deletable_packs(&conn, "s", 1000 + 86400).unwrap(),
            vec!["p1"]
        );
        assert!(
            deletable_packs(&conn, "other", 1000 + 86400)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn deletable_packs_blocked_by_open_run_started_before_mark() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        start_run(&conn, "old", "prot", "s", 500).unwrap();
        mark_unused_packs_tx(&mut conn, "s", 1000).unwrap();
        // The run started before the mark and is still open, so it may still use p1.
        assert!(
            deletable_packs(&conn, "s", 1000 + 86400)
                .unwrap()
                .is_empty()
        );
        end_run(&conn, "old", 1500).unwrap();
        assert_eq!(
            deletable_packs(&conn, "s", 1000 + 86400).unwrap(),
            vec!["p1"]
        );
    }

    #[test]
    fn deletable_packs_ignores_runs_started_after_mark_or_in_other_scope() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        live_pack(&conn, "p1", "s");
        mark_unused_packs_tx(&mut conn, "s", 1000).unwrap();
        start_run(&conn, "later", "prot", "s", 2000).unwrap();
        start_run(&conn, "elsewhere", "prot2", "other", 500).unwrap();
        assert_eq!(
            deletable_packs(&conn, "s", 1000 + 86400).unwrap(),
            vec!["p1"]
        );
    }

    #[test]
    fn cloud_snapshot_list_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_cloud_snapshot(&conn, &cloud_snap("a", "prot", 1)).unwrap();
        insert_cloud_snapshot(&conn, &cloud_snap("b", "prot", 2)).unwrap();
        insert_cloud_snapshot(&conn, &cloud_snap("c", "other", 3)).unwrap();
        let ids: Vec<String> = list_cloud_snapshots(&conn, "prot")
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["b", "a"]);
        delete_cloud_snapshot(&conn, "a").unwrap();
        assert_eq!(list_cloud_snapshots(&conn, "prot").unwrap().len(), 1);
    }

    #[test]
    fn cloud_runs_open_and_end() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        start_run(&conn, "r1", "prot", "s", 10).unwrap();
        assert_eq!(open_runs(&conn, "s").unwrap(), vec!["r1"]);
        assert!(open_runs(&conn, "other").unwrap().is_empty());
        end_run(&conn, "r1", 20).unwrap();
        assert!(open_runs(&conn, "s").unwrap().is_empty());
    }

    #[test]
    fn factory_reset_clears_cloud_tables() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        set_cloud_identity(&conn, "luna-1", &[1; 32], 1).unwrap();
        insert_cloud_snapshot(&conn, &cloud_snap("a", "prot", 1)).unwrap();
        start_run(&conn, "r1", "prot", "s", 1).unwrap();
        factory_reset(&conn).unwrap();
        assert!(get_cloud_identity(&conn).unwrap().is_none());
        assert!(list_cloud_snapshots(&conn, "prot").unwrap().is_empty());
        assert!(open_runs(&conn, "s").unwrap().is_empty());
    }

    fn private_scope(scope: &str, owner: &str, created_at: i64) -> PrivateScope {
        PrivateScope {
            scope: scope.into(),
            owner: owner.into(),
            seal_public: vec![7; 32],
            scope_public: vec![5; 32],
            sealed_scope_secret: vec![6; 16],
            dedup_key: vec![9; 32],
            state: "active".into(),
            retire_after: 0,
            created_at,
        }
    }

    #[test]
    fn private_scope_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("luna.db")).unwrap();
        insert_private_scope(&conn, &private_scope("older", "u1", 10)).unwrap();
        insert_private_scope(&conn, &private_scope("newer", "u1", 20)).unwrap();

        assert_eq!(
            active_private_scope(&conn, "u1").unwrap().unwrap().scope,
            "newer"
        );
        set_private_scope_state(&conn, "newer", "old_phrase", 99).unwrap();
        let old = get_private_scope(&conn, "newer").unwrap().unwrap();
        assert_eq!((old.state.as_str(), old.retire_after), ("old_phrase", 99));
        assert_eq!(
            active_private_scope(&conn, "u1").unwrap().unwrap().scope,
            "older"
        );
        let listed: Vec<String> = list_private_scopes(&conn, Some("u1"))
            .unwrap()
            .into_iter()
            .map(|s| s.scope)
            .collect();
        assert_eq!(listed, vec!["older", "newer"]);
    }

    #[test]
    fn private_snapshot_commit_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("prot", "d1", "docs")).unwrap();
        live_pack(&conn, "pk1", "scope-a");
        live_pack(&conn, "pk2", "scope-a");
        let snap = cloud_snap("ps1", "prot", 5);
        commit_private_snapshot_tx(
            &mut conn,
            &snap,
            &["pk1".to_string(), "pk2".to_string()],
            "scope-a",
            b"{\"entries\":[]}",
        )
        .unwrap();

        assert_eq!(
            get_private_tree(&conn, "ps1").unwrap().unwrap(),
            b"{\"entries\":[]}".to_vec()
        );
        assert_eq!(private_snapshot_ids(&conn, "scope-a").unwrap(), vec!["ps1"]);
        assert_eq!(
            private_scope_of_snapshot(&conn, "ps1").unwrap(),
            Some("scope-a".to_string())
        );
        delete_cloud_snapshot(&conn, "ps1").unwrap();
        assert!(get_private_tree(&conn, "ps1").unwrap().is_none());
    }

    #[test]
    fn shared_snapshot_ids_ignore_private_ones() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("prot", "d1", "docs")).unwrap();
        live_pack(&conn, "pk1", "scope-a");
        commit_private_snapshot_tx(
            &mut conn,
            &cloud_snap("ps1", "prot", 5),
            &["pk1".to_string()],
            "scope-a",
            b"{}",
        )
        .unwrap();
        assert!(list_shared_cloud_snapshot_ids(&conn).unwrap().is_empty());
        insert_cloud_snapshot(&conn, &cloud_snap("shared-1", "prot", 6)).unwrap();
        assert_eq!(
            list_shared_cloud_snapshot_ids(&conn).unwrap(),
            vec!["shared-1"]
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM cloud_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn delete_private_scope_drops_its_trees() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open(&dir.path().join("luna.db")).unwrap();
        insert_protection(&conn, &new_protection("prot", "d1", "docs")).unwrap();
        insert_private_scope(&conn, &private_scope("scope-a", "u1", 1)).unwrap();
        live_pack(&conn, "pk1", "scope-a");
        commit_private_snapshot_tx(
            &mut conn,
            &cloud_snap("ps1", "prot", 5),
            &["pk1".to_string()],
            "scope-a",
            b"{}",
        )
        .unwrap();

        delete_private_scope(&conn, "scope-a").unwrap();
        assert!(get_private_scope(&conn, "scope-a").unwrap().is_none());
        assert!(private_snapshot_ids(&conn, "scope-a").unwrap().is_empty());
    }
}
