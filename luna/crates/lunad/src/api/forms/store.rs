//! Per-form answer storage in SQLite.
//!
//! Each `.lunaform` file owns one hidden sidecar next to it:
//! `.name.lunaform.responses.sqlite` (or `{disk}.responses.sqlite` for a
//! private form). The database is the source of truth for answers; the old
//! append-only JSONL family is not read or written anymore.
//!
//! Schema:
//!
//! - `responses(id, edit_hash, sent_at, changed_at, deleted)`
//! - `answers(response_id, question_id, value)` — `value` is the answer as
//!   JSON text (scalar or array), so the existing form validation and the
//!   client keep their value shapes.
//! - `form_meta(id = 1, revision)` — bumped on every write; the editor uses
//!   it to refuse a stale save instead of overwriting answers that arrived
//!   while someone was editing.
//!
//! The file is authoritative, so it is safe to copy only through
//! [`snapshot_db`] (or the SQLite backup API on the caller's side). A raw
//! copy of an open database can catch a hot journal.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value};

use crate::drives::layout::Layout;

/// Current schema version; stored in `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 1;

/// Largest database the browser editor will load. The API can still read a
/// larger form page by page; this limit only protects the whole-file editor.
pub const MAX_EDITOR_BYTES: u64 = 16 * 1024 * 1024;

/// True when the name is Luna's own private-item disk name.
fn is_private_disk_name(name: &str) -> bool {
    Layout::is_luna_name(name)
}

/// The sidecar path for a form at a known on-disk path. No drive root is
/// needed for an ordinary (non-trash) form.
pub fn db_path_for(form_path: &Path) -> Option<PathBuf> {
    let name = form_path.file_name()?.to_str()?;
    if is_private_disk_name(name) {
        return Some(form_path.with_file_name(format!("{name}.responses.sqlite")));
    }
    let dot = name.rfind('.')?;
    if !name[dot..].eq_ignore_ascii_case(crate::api::forms::FORM_FILE_SUFFIX) {
        return None;
    }
    let stem = &name[..dot];
    Some(
        form_path
            .parent()?
            .join(format!(".{stem}.lunaform.responses.sqlite")),
    )
}

/// The sidecar path including the trash-root case. A form at the top of the
/// trash keeps its answers beside its Luna-owned files folder, not as a
/// visible sibling.
pub fn db_path_for_root(root: &Path, form_path: &Path) -> Option<PathBuf> {
    let visible = db_path_for(form_path)?;
    // A private form's sidecar is already named after its Luna-owned disk
    // name and follows the item; the trash-root rewrite below is only for
    // ordinary visible forms.
    if form_path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_private_disk_name)
    {
        return Some(visible);
    }
    let layout = Layout::detect(root)?;
    let in_trash_root = form_path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n.to_str() == Some(layout.trash_name().as_str()));
    if !in_trash_root {
        return Some(visible);
    }
    let dir = crate::api::forms::files_dir_for(root, form_path)?;
    let mut name = dir.file_name()?.to_os_string();
    name.push(".responses.sqlite");
    Some(dir.with_file_name(name))
}

/// Remove the database and every SQLite sidecar it may have left behind.
pub fn remove_db_files(path: &Path) {
    remove_live_db_files(path);
    let mut backup = path.as_os_str().to_os_string();
    backup.push(".bak");
    let _ = std::fs::remove_file(PathBuf::from(backup));
}

/// The live database and its journal files, leaving the editor's `.bak`
/// restore point alone.
fn remove_live_db_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    remove_journal_files(path);
}

fn remove_journal_files(path: &Path) {
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut side = path.as_os_str().to_os_string();
        side.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(side));
    }
}

/// Move the database and any hot journal with it. Used by rename/move/trash.
pub fn move_db_files(from: &Path, to: &Path) {
    for suffix in ["", "-journal", "-wal", "-shm", ".bak"] {
        let mut a = from.as_os_str().to_os_string();
        let mut b = to.as_os_str().to_os_string();
        a.push(suffix);
        b.push(suffix);
        let (a, b) = (PathBuf::from(a), PathBuf::from(b));
        if a != b && std::fs::symlink_metadata(&a).is_ok() {
            if let Err(e) = crate::files::rename_noreplace(&a, &b) {
                tracing::warn!(
                    from = %a.display(),
                    to = %b.display(),
                    error = %e,
                    "form answers did not follow the form"
                );
            }
        }
    }
}

/// A consistent copy of a form database. `VACUUM INTO` opens the source
/// read-only and writes a complete database, so a hot journal or an active
/// writer cannot leave the copy torn. The destination must not exist.
pub fn snapshot_db(src: &Path, dest: &Path) -> Result<()> {
    if std::fs::symlink_metadata(src)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(anyhow!("form answers database is a symlink"));
    }
    if std::fs::symlink_metadata(dest).is_ok() {
        std::fs::remove_file(dest).with_context(|| format!("remove {}", dest.display()))?;
    }
    // Read-write first so SQLite can recover a hot journal left by a crash.
    // A genuinely read-only drive falls back to a read-only connection; the
    // destination is always a new file.
    let conn = Connection::open_with_flags(
        src,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .or_else(|_| {
        Connection::open_with_flags(
            src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
    })
    .with_context(|| format!("open form answers {}", src.display()))?;
    conn.busy_timeout(Duration::from_secs(10))?;
    let dest = dest.to_string_lossy();
    conn.execute("VACUUM INTO ?1", params![dest.as_ref()])
        .with_context(|| format!("snapshot form answers to {dest}"))?;
    Ok(())
}

/// Bytes of the database file itself, or 0 when it does not exist yet.
pub fn db_bytes(path: &Path) -> u64 {
    std::fs::symlink_metadata(path)
        .map(|m| if m.is_file() { m.len() } else { 0 })
        .unwrap_or(0)
}

/// Bytes in the editor's previous-version restore point, if one exists.
pub fn backup_bytes(path: &Path) -> u64 {
    let mut backup = path.as_os_str().to_os_string();
    backup.push(".bak");
    db_bytes(Path::new(&backup))
}

/// Bytes the database is actually using, not counting pages SQLite has
/// already freed. Deleting answers lowers this, so a form that clears spam
/// can accept new answers again even before the file itself shrinks.
pub fn live_bytes(path: &Path) -> u64 {
    if !path.is_file() {
        return 0;
    }
    let Ok(conn) = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return db_bytes(path);
    };
    let _ = conn.busy_timeout(Duration::from_secs(2));
    let page_count: i64 = conn
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .unwrap_or(0);
    let freelist: i64 = conn
        .pragma_query_value(None, "freelist_count", |row| row.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .unwrap_or(0);
    if page_count <= 0 || page_size <= 0 {
        return db_bytes(path);
    }
    let live_pages = page_count.saturating_sub(freelist).max(0) as u64;
    live_pages.saturating_mul(page_size as u64)
}

/// Read a consistent copy of the database into memory. Used by the browser
/// editor, which is capped at [`MAX_EDITOR_BYTES`].
pub fn read_snapshot(src: &Path) -> Result<Vec<u8>> {
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".luna-{}-answers-snapshot.sqlite",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        snapshot_db(src, &tmp)?;
        std::fs::read(&tmp).context("read form answers snapshot")
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Validate an editor upload, set its revision, and install it over the live
/// database. The old database is kept as `<db>.bak` for a restore action.
/// The caller holds the per-form lock.
pub fn install_upload(dest: &Path, bytes: &[u8], revision: i64) -> Result<()> {
    if std::fs::symlink_metadata(dest)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(anyhow!("form answers database is a symlink"));
    }
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".luna-{}-answers-upload.sqlite",
        uuid::Uuid::new_v4().simple()
    ));
    let mut temp = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .with_context(|| format!("write {}", tmp.display()))?;
    temp.write_all(bytes)
        .with_context(|| format!("write {}", tmp.display()))?;
    temp.sync_all()
        .with_context(|| format!("sync {}", tmp.display()))?;
    let checked = (|| -> Result<()> {
        let conn = Connection::open(&tmp).with_context(|| "open uploaded answers database")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap_or_default();
        if integrity != "ok" {
            return Err(anyhow!("uploaded answers database failed integrity_check"));
        }
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or(0);
        if version > SCHEMA_VERSION {
            return Err(anyhow!("uploaded answers database is newer than this Luna"));
        }
        let orphan: Option<String> = conn
            .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
            .optional()?;
        if orphan.is_some() {
            return Err(anyhow!("uploaded answers database has orphaned answers"));
        }
        for (table, required) in [
            (
                "responses",
                &["id", "edit_hash", "sent_at", "changed_at", "deleted"][..],
            ),
            ("answers", &["response_id", "question_id", "value"][..]),
        ] {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .with_context(|| format!("inspect {table}"))?;
            let cols: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .with_context(|| format!("read {table} columns"))?
                .collect::<std::result::Result<_, _>>()?;
            if cols.is_empty() {
                return Err(anyhow!("uploaded answers database has no {table} table"));
            }
            let kind: Option<String> = conn
                .query_row(
                    "SELECT type FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .optional()?;
            if kind.as_deref() != Some("table") {
                return Err(anyhow!("uploaded answers database has no {table} table"));
            }
            for col in required {
                if !cols.iter().any(|c| c == col) {
                    return Err(anyhow!(
                        "uploaded answers database is missing {table}.{col}"
                    ));
                }
            }
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS form_meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO form_meta (id, revision) VALUES (1, 0);
            PRAGMA user_version = 1;",
        )?;
        conn.execute(
            "UPDATE form_meta SET revision = ?1 WHERE id = 1",
            params![revision],
        )?;
        conn.pragma_update(None, "journal_mode", "DELETE")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    })();
    if let Err(e) = checked {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if dest.is_file() {
        let mut backup = dest.as_os_str().to_os_string();
        backup.push(".bak");
        let backup = PathBuf::from(backup);
        let _ = std::fs::remove_file(&backup);
        if let Err(e) = snapshot_db(dest, &backup) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    // Rename over the old database in one step. Do not unlink it first:
    // a failed rename must leave the previous answers in place.
    remove_journal_files(dest);
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("install {}", dest.display()));
    }
    Ok(())
}

/// One stored response, latest state.
#[derive(Debug, Clone)]
pub struct StoredResponse {
    pub id: String,
    pub edit_hash: String,
    pub sent_at: i64,
    pub changed_at: i64,
    pub answers: Map<String, Value>,
}

/// A response as the API returns it: no edit hash, `sent_at` kept separate
/// from the last change time.
pub fn response_json(rec: &StoredResponse) -> Value {
    serde_json::json!({
        "v": 1,
        "id": rec.id,
        "at": rec.changed_at,
        "sent_at": rec.sent_at,
        "answers": Value::Object(rec.answers.clone()),
    })
}

/// One value's count in a form summary.
#[derive(Debug, Clone)]
pub struct SummaryValue {
    pub value: Value,
    pub count: u64,
}

/// Per-question summary returned to the Responses tab.
#[derive(Debug, Clone)]
pub struct QuestionSummary {
    pub question_id: String,
    pub answered: u64,
    pub values: Vec<SummaryValue>,
}

pub struct FormStore {
    conn: Connection,
}

impl FormStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        // SQLite follows symlinks. A planted sidecar would otherwise let a
        // writer redirect reads or writes outside the form's folder.
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut side = path.as_os_str().to_os_string();
            side.push(suffix);
            if let Ok(meta) = std::fs::symlink_metadata(PathBuf::from(side))
                && meta.file_type().is_symlink()
            {
                return Err(anyhow!("form answers sidecar is a symlink"));
            }
        }
        let conn = Connection::open(path)
            .with_context(|| format!("open form answers {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        // The journal mode is persistent and set when the database is made
        // or replaced; changing it on every read would take a write lock.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "cache_size", -4096i64)?;
        // Only effective before the first table exists; a database created
        // without it still works, and `clear` falls back to a full VACUUM.
        let _ = conn.pragma_update(None, "auto_vacuum", "INCREMENTAL");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or(0);
        if version > SCHEMA_VERSION {
            return Err(anyhow!(
                "form answers database is newer than this Luna (version {version})"
            ));
        }
        if version < SCHEMA_VERSION {
            init_schema(&conn)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(Self { conn })
    }

    /// Open an existing database for reading only. A read-only drive still
    /// lets people see answers; nothing here changes the file or its journal.
    pub fn open_read(path: &Path) -> Result<Self> {
        if std::fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(anyhow!("form answers database is a symlink"));
        }
        // Read-write first so a hot journal from a crash can recover; a
        // genuinely read-only drive falls back to read-only.
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .or_else(|_| {
            Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
        })
        .with_context(|| format!("open form answers {}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or(0);
        if version > SCHEMA_VERSION {
            return Err(anyhow!(
                "form answers database is newer than this Luna (version {version})"
            ));
        }
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        Ok(Self { conn })
    }

    pub fn revision(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT revision FROM form_meta WHERE id = 1", [], |row| {
                row.get(0)
            })
            .context("read form answers revision")
    }

    pub fn live_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM responses WHERE deleted = 0",
                [],
                |row| row.get(0),
            )
            .context("count form answers")?;
        Ok(n as u64)
    }

    /// The live response a presented edit secret identifies, or `None`.
    pub fn find_by_edit_hash(&self, hash: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT id FROM responses
                 WHERE edit_hash = ?1 AND deleted = 0
                 ORDER BY sent_at, id LIMIT 1",
                params![hash],
                |row| row.get(0),
            )
            .optional()
            .context("find edited form answer")
    }

    /// One live response by id, or `None` when it was deleted.
    pub fn get(&self, id: &str) -> Result<Option<StoredResponse>> {
        let head: Option<(String, String, i64, i64)> = self
            .conn
            .query_row(
                "SELECT id, edit_hash, sent_at, changed_at FROM responses
                 WHERE id = ?1 AND deleted = 0",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .context("read form answer")?;
        let Some((id, edit_hash, sent_at, changed_at)) = head else {
            return Ok(None);
        };
        Ok(Some(StoredResponse {
            answers: self.answers_for(&id)?,
            id,
            edit_hash,
            sent_at,
            changed_at,
        }))
    }

    /// A page of live responses, first sent first. `offset` is a plain row
    /// offset; the response list is append-mostly, so it is stable enough
    /// and keeps the API simple.
    pub fn page(&self, offset: usize, limit: usize) -> Result<Vec<StoredResponse>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, edit_hash, sent_at, changed_at FROM responses
                 WHERE deleted = 0
                 ORDER BY sent_at, id
                 LIMIT ?1 OFFSET ?2",
            )
            .context("prepare form answer page")?;
        let rows = stmt
            .query_map(params![limit as i64, offset as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .context("read form answer page")?;
        let mut out = Vec::new();
        for row in rows {
            let (id, edit_hash, sent_at, changed_at) = row?;
            out.push(StoredResponse {
                answers: self.answers_for(&id)?,
                id,
                edit_hash,
                sent_at,
                changed_at,
            });
        }
        Ok(out)
    }

    fn answers_for(&self, response_id: &str) -> Result<Map<String, Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT question_id, value FROM answers
                 WHERE response_id = ?1 ORDER BY question_id",
            )
            .context("prepare form answers")?;
        let rows = stmt
            .query_map(params![response_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("read form answers")?;
        let mut out = Map::new();
        for row in rows {
            let (question_id, text) = row?;
            let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
            out.insert(question_id, value);
        }
        Ok(out)
    }

    /// Per-question counts for the Responses tab. Only questions whose type
    /// needs value counts (choice and number) are asked for values; a free
    /// text question can have tens of thousands of distinct answers and must
    /// not be grouped just to be thrown away.
    pub fn summary(
        &self,
        include_values: &std::collections::HashSet<String>,
    ) -> Result<Vec<QuestionSummary>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT a.question_id, COUNT(DISTINCT a.response_id)
                 FROM answers a
                 JOIN responses r ON r.id = a.response_id
                 WHERE r.deleted = 0
                 GROUP BY a.question_id
                 ORDER BY a.question_id",
            )
            .context("prepare form summary")?;
        let answered: Vec<(String, u64)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .context("read form summary")?
            .collect::<std::result::Result<_, _>>()?;

        let mut by_question: std::collections::HashMap<String, Vec<SummaryValue>> =
            std::collections::HashMap::new();
        if !include_values.is_empty() {
            let placeholders = (1..=include_values.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT a.question_id, a.value, COUNT(*)
                 FROM answers a
                 JOIN responses r ON r.id = a.response_id
                 WHERE r.deleted = 0 AND a.question_id IN ({placeholders})
                 GROUP BY a.question_id, a.value
                 ORDER BY a.question_id, COUNT(*) DESC, a.value"
            );
            let mut values_stmt = self
                .conn
                .prepare(&sql)
                .context("prepare form summary values")?;
            let rows = values_stmt
                .query_map(params_from_iter(include_values.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                    ))
                })
                .context("read form summary values")?;
            for row in rows {
                let (question_id, text, count) = row?;
                let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
                by_question
                    .entry(question_id)
                    .or_default()
                    .push(SummaryValue { value, count });
            }
        }
        Ok(answered
            .into_iter()
            .map(|(question_id, answered)| QuestionSummary {
                values: by_question.remove(&question_id).unwrap_or_default(),
                question_id,
                answered,
            })
            .collect())
    }

    /// Append a brand-new response. The caller holds the per-form lock and
    /// has already checked the form's response cap.
    pub fn insert(
        &mut self,
        id: &str,
        edit_hash: &str,
        at: i64,
        answers: &Map<String, Value>,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO responses (id, edit_hash, sent_at, changed_at, deleted)
             VALUES (?1, ?2, ?3, ?3, 0)",
            params![id, edit_hash, at],
        )
        .context("insert form response")?;
        insert_answers(&tx, id, answers)?;
        bump(&tx)?;
        tx.commit().context("commit form response")?;
        Ok(())
    }

    /// Replace an existing response's answers and change time.
    pub fn update(&mut self, id: &str, at: i64, answers: &Map<String, Value>) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx
            .execute(
                "UPDATE responses SET changed_at = ?2, deleted = 0
                 WHERE id = ?1",
                params![id, at],
            )
            .context("update form response")?;
        if changed == 0 {
            tx.commit()?;
            return Err(anyhow!("form response is gone"));
        }
        tx.execute("DELETE FROM answers WHERE response_id = ?1", params![id])
            .context("replace form answers")?;
        insert_answers(&tx, id, answers)?;
        bump(&tx)?;
        tx.commit().context("commit form response change")?;
        Ok(())
    }

    /// Remove one response and its answers. Returns false when it was
    /// already gone, so the caller can keep the existing 404.
    pub fn delete(&mut self, id: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM answers WHERE response_id = ?1", params![id])
            .context("delete form answers")?;
        let removed = tx
            .execute("DELETE FROM responses WHERE id = ?1", params![id])
            .context("delete form response")?;
        if removed > 0 {
            bump(&tx)?;
        }
        tx.commit().context("commit form answer delete")?;
        Ok(removed > 0)
    }

    /// Remove every answer. Used by the owner-facing clear action after a
    /// confirmation; the revision still moves so an open editor conflicts.
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM answers", [])
            .context("clear form answers")?;
        tx.execute("DELETE FROM responses", [])
            .context("clear form responses")?;
        bump(&tx)?;
        tx.commit().context("commit form clear")?;
        // Reclaim the pages the deleted rows occupied. Incremental mode is
        // used when the database was created with it; otherwise a full
        // VACUUM is the only way to shrink the file. Clear is rare.
        let mode: i64 = self
            .conn
            .pragma_query_value(None, "auto_vacuum", |row| row.get(0))
            .unwrap_or(0);
        if mode == 2 {
            let _ = self.conn.execute_batch("PRAGMA incremental_vacuum");
        } else {
            let _ = self.conn.execute_batch("VACUUM");
        }
        Ok(())
    }

    /// Write every live response as JSONL, for a backup or an export. The
    /// writer is not buffered here so the caller can stream it.
    pub fn export_jsonl(&self, mut out: impl Write) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, sent_at, changed_at FROM responses
                 WHERE deleted = 0 ORDER BY sent_at, id",
            )
            .context("prepare form export")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .context("read form export")?;
        for row in rows {
            let (id, sent_at, changed_at) = row?;
            let rec = StoredResponse {
                answers: self.answers_for(&id)?,
                id,
                edit_hash: String::new(),
                sent_at,
                changed_at,
            };
            serde_json::to_writer(&mut out, &response_json(&rec))?;
            out.write_all(b"\n")?;
        }
        Ok(())
    }
}

fn bump(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute(
        "UPDATE form_meta SET revision = revision + 1 WHERE id = 1",
        [],
    )
    .context("bump form answers revision")?;
    Ok(())
}

fn insert_answers(
    tx: &rusqlite::Transaction<'_>,
    response_id: &str,
    answers: &Map<String, Value>,
) -> Result<()> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO answers (response_id, question_id, value)
             VALUES (?1, ?2, ?3)",
        )
        .context("prepare form answer insert")?;
    for (question_id, value) in answers {
        let text = serde_json::to_string(value)?;
        stmt.execute(params![response_id, question_id, text])
            .context("insert form answer")?;
    }
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS responses (
            id TEXT PRIMARY KEY,
            edit_hash TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            changed_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS responses_edit ON responses(edit_hash);
        CREATE INDEX IF NOT EXISTS responses_live ON responses(deleted, sent_at, id);
        CREATE TABLE IF NOT EXISTS answers (
            response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
            question_id TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (response_id, question_id)
        );
        CREATE INDEX IF NOT EXISTS answers_question ON answers(question_id, value);
        CREATE TABLE IF NOT EXISTS form_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO form_meta (id, revision) VALUES (1, 0);",
    )
    .context("initialize form answers database")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn form_path(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"{}").unwrap();
        path
    }

    fn answers(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn sidecar_name_is_hidden_and_keeps_the_form_stem() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "Rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        assert_eq!(
            db.file_name().unwrap().to_str().unwrap(),
            ".Rsvp.lunaform.responses.sqlite"
        );
        let private = dir
            .path()
            .join(".luna-123e4567-e89b-12d3-a456-426614174000-rsvp");
        assert_eq!(
            db_path_for(&private)
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            ".luna-123e4567-e89b-12d3-a456-426614174000-rsvp.responses.sqlite"
        );
    }

    #[test]
    fn insert_edit_delete_and_summary_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        let mut store = FormStore::open(&db).unwrap();
        assert_eq!(store.live_count().unwrap(), 0);
        assert_eq!(store.revision().unwrap(), 0);

        store
            .insert("r1", "hash-1", 10, &answers(&[("q1", json!("yes"))]))
            .unwrap();
        store
            .insert("r2", "hash-2", 20, &answers(&[("q1", json!("no"))]))
            .unwrap();
        assert_eq!(store.live_count().unwrap(), 2);
        assert_eq!(store.revision().unwrap(), 2);
        assert_eq!(
            store.find_by_edit_hash("hash-2").unwrap().as_deref(),
            Some("r2")
        );

        let page = store.page(0, 1).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, "r1");
        assert_eq!(page[0].answers["q1"], json!("yes"));

        let summary = store
            .summary(&std::collections::HashSet::from(["q1".to_string()]))
            .unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].answered, 2);
        assert_eq!(summary[0].values.len(), 2);

        store
            .update("r1", 30, &answers(&[("q1", json!("maybe"))]))
            .unwrap();
        let r1 = store.get("r1").unwrap().unwrap();
        assert_eq!(r1.answers["q1"], json!("maybe"));
        assert_eq!(r1.sent_at, 10);
        assert_eq!(r1.changed_at, 30);

        assert!(store.delete("r2").unwrap());
        assert!(!store.delete("r2").unwrap());
        assert_eq!(store.live_count().unwrap(), 1);

        let before = store.revision().unwrap();
        store.clear().unwrap();
        assert_eq!(store.live_count().unwrap(), 0);
        assert!(
            store.revision().unwrap() > before,
            "a clear moves the revision"
        );
    }

    #[test]
    fn reopen_keeps_data_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        {
            let mut store = FormStore::open(&db).unwrap();
            store
                .insert("r1", "hash", 1, &answers(&[("q1", json!("yes"))]))
                .unwrap();
        }
        let store = FormStore::open(&db).unwrap();
        assert_eq!(store.live_count().unwrap(), 1);
        assert_eq!(store.revision().unwrap(), 1);
        assert_eq!(
            store.get("r1").unwrap().unwrap().answers["q1"],
            json!("yes")
        );
    }

    #[test]
    fn snapshot_is_a_complete_database() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        let mut store = FormStore::open(&db).unwrap();
        store
            .insert("r1", "hash", 1, &answers(&[("q1", json!("yes"))]))
            .unwrap();
        drop(store);
        let copy = dir.path().join("copy.sqlite");
        snapshot_db(&db, &copy).unwrap();
        let store = FormStore::open(&copy).unwrap();
        assert_eq!(store.live_count().unwrap(), 1);
    }

    #[test]
    fn read_open_refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        drop(FormStore::open(&db).unwrap());
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(FormStore::open_read(&db).is_err());
    }

    #[test]
    fn export_is_latest_live_records_only() {
        let dir = tempfile::tempdir().unwrap();
        let form = form_path(dir.path(), "rsvp.lunaform");
        let db = db_path_for(&form).unwrap();
        let mut store = FormStore::open(&db).unwrap();
        store
            .insert("r1", "hash", 1, &answers(&[("q1", json!("yes"))]))
            .unwrap();
        store
            .update("r1", 2, &answers(&[("q1", json!("no"))]))
            .unwrap();
        let mut out = Vec::new();
        store.export_jsonl(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("\"no\""));
    }
}
