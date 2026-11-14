//! Where extracted text lives: two tables in each drive's own database.
//!
//! `content_docs` has one row per readable file, keyed by its path (the
//! file index rewrites its own rows on every folder read, so its rowids
//! can't anchor anything). `size` and `modified` say which version of the
//! file the row describes; a mismatch with the file index means "read it
//! again". `content_fts` holds the words, with rowid = `content_docs.id`.
//!
//! Because the tables sit on the drive, an encrypted drive's text stays
//! inside its encryption, and a drive carries its search with it.

use rusqlite::{Connection, OptionalExtension, params};

use super::formats::{self, Format};

/// Bump to re-read every file (new extractor, new OCR settings).
pub const EXTRACT_VERSION: i64 = 1;

/// What happened when Luna last read a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Words found and indexed.
    Text,
    /// Read fine, no words (a blank page, a photo without text).
    Empty,
    /// Password-protected.
    Protected,
    /// Larger than Luna reads for its kind.
    TooBig,
    /// The reader failed; `detail` says how (diagnostics only).
    Failed,
    /// The tool for this kind isn't installed.
    Unavailable,
    /// Not read on purpose: inside a hidden or Luna-owned folder.
    Skipped,
    /// A camera photo waiting for photo search to say whether it shows a
    /// document worth OCR.
    Deferred,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Empty => "empty",
            Self::Protected => "protected",
            Self::TooBig => "too_big",
            Self::Failed => "failed",
            Self::Unavailable => "unavailable",
            Self::Skipped => "skipped",
            Self::Deferred => "deferred",
        }
    }
}

pub fn ensure_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS content_docs (
            id INTEGER PRIMARY KEY,
            drive_id TEXT NOT NULL,
            parent TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            version INTEGER NOT NULL,
            state TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            UNIQUE (drive_id, parent, name)
         );
         CREATE INDEX IF NOT EXISTS content_docs_state ON content_docs(drive_id, state);
         -- Meaning vectors: one per passage of a file's text (see `meaning`).
         CREATE TABLE IF NOT EXISTS content_vecs (
            doc_id INTEGER NOT NULL,
            chunk INTEGER NOT NULL,
            -- Byte range of the passage in the file's text, for snippets.
            start INTEGER NOT NULL,
            len INTEGER NOT NULL,
            vec BLOB NOT NULL,
            PRIMARY KEY (doc_id, chunk)
         ) WITHOUT ROWID;
         CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
            body,
            tokenize = 'porter unicode61 remove_diacritics 2'
         );",
    )?;
    Ok(())
}

/// A file the content indexer still has to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub parent: String,
    pub name: String,
    pub size: i64,
    pub modified: i64,
}

impl Pending {
    pub fn rel(&self) -> String {
        if self.parent.is_empty() {
            self.name.clone()
        } else {
            format!("{}/{}", self.parent, self.name)
        }
    }
}

fn image_case(column: &str) -> String {
    let images: Vec<String> = formats::EXTENSIONS
        .iter()
        .filter(|(_, f)| f.is_ocr())
        .map(|(e, _)| format!("{column} LIKE '%.{e}'"))
        .collect();
    format!("CASE WHEN {} THEN 1 ELSE 0 END", images.join(" OR "))
}

/// The next files to read on this drive: new, changed, or read by an older
/// extractor. Documents before images, newest first within each.
pub fn pending(
    conn: &Connection,
    drive_id: &str,
    include_images: bool,
    limit: usize,
) -> anyhow::Result<Vec<Pending>> {
    let sql = format!(
        "SELECT e.parent, e.name, e.size, e.modified
         FROM index_entries e
         LEFT JOIN content_docs c
           ON c.drive_id = e.drive_id AND c.parent = e.parent AND c.name = e.name
         WHERE e.drive_id = ?1 AND e.kind = 'file' AND e.hidden = 0
           AND {filter}
           AND (c.id IS NULL OR c.size != e.size OR c.modified != e.modified
                OR c.version != ?2)
         ORDER BY {images}, e.modified DESC
         LIMIT ?3",
        filter = formats::sql_name_filter("e.name", include_images),
        images = image_case("e.name"),
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(params![drive_id, EXTRACT_VERSION, limit as i64], |r| {
            Ok(Pending {
                parent: r.get(0)?,
                name: r.get(1)?,
                size: r.get(2)?,
                modified: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// How many files still wait to be read (for the "still reading" notice).
pub fn pending_count(
    conn: &Connection,
    drive_id: &str,
    include_images: bool,
) -> anyhow::Result<u64> {
    let sql = format!(
        "SELECT COUNT(*)
         FROM index_entries e
         LEFT JOIN content_docs c
           ON c.drive_id = e.drive_id AND c.parent = e.parent AND c.name = e.name
         WHERE e.drive_id = ?1 AND e.kind = 'file' AND e.hidden = 0
           AND {filter}
           AND (c.id IS NULL OR c.size != e.size OR c.modified != e.modified
                OR c.version != ?2)",
        filter = formats::sql_name_filter("e.name", include_images),
    );
    let n: i64 = conn.query_row(&sql, params![drive_id, EXTRACT_VERSION], |r| r.get(0))?;
    Ok(n.max(0) as u64)
}

/// Save what reading `file` produced. Replaces any older text for it.
/// Returns the row id.
pub fn record(
    conn: &Connection,
    drive_id: &str,
    file: &Pending,
    state: State,
    detail: &str,
    text: Option<&str>,
) -> anyhow::Result<i64> {
    let tx = conn.unchecked_transaction()?;
    // Upsert keeps the row id stable, so a re-read file keeps its id.
    let id: i64 = tx.query_row(
        "INSERT INTO content_docs
           (drive_id, parent, name, size, modified, version, state, detail, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (drive_id, parent, name) DO UPDATE SET
           size = excluded.size, modified = excluded.modified,
           version = excluded.version, state = excluded.state,
           detail = excluded.detail, updated_at = excluded.updated_at
         RETURNING id",
        params![
            drive_id,
            file.parent,
            file.name,
            file.size,
            file.modified,
            EXTRACT_VERSION,
            state.as_str(),
            detail,
            crate::db::now_unix(),
        ],
        |r| r.get(0),
    )?;
    tx.execute("DELETE FROM content_fts WHERE rowid = ?1", params![id])?;
    if let Some(text) = text.filter(|t| !t.is_empty()) {
        tx.execute(
            "INSERT INTO content_fts (rowid, body) VALUES (?1, ?2)",
            params![id, text],
        )?;
    }
    tx.execute("DELETE FROM content_vecs WHERE doc_id = ?1", params![id])?;
    tx.commit()?;
    Ok(id)
}

/// Drop rows for files that are gone from the file index. Run after a full
/// drive read, when the index is known to be complete.
pub fn sweep_orphans(conn: &Connection, drive_id: &str) -> anyhow::Result<usize> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT c.id FROM content_docs c
             LEFT JOIN index_entries e
               ON e.drive_id = c.drive_id AND e.parent = c.parent AND e.name = c.name
             WHERE c.drive_id = ?1 AND e.name IS NULL",
        )?;
        stmt.query_map(params![drive_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if ids.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    for id in &ids {
        tx.execute("DELETE FROM content_fts WHERE rowid = ?1", params![id])?;
        tx.execute("DELETE FROM content_docs WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM content_vecs WHERE doc_id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(ids.len())
}

/// Let a tool that is now installed have another go at the files it was
/// missing for.
pub fn retry_unavailable(conn: &Connection, drive_id: &str, format: Format) -> anyhow::Result<()> {
    let exts: Vec<String> = formats::EXTENSIONS
        .iter()
        .filter(|(_, f)| *f == format)
        .map(|(e, _)| format!("name LIKE '%.{e}'"))
        .collect();
    if exts.is_empty() {
        return Ok(());
    }
    conn.execute(
        &format!(
            "UPDATE content_docs SET version = 0
             WHERE drive_id = ?1 AND state = 'unavailable' AND ({})",
            exts.join(" OR ")
        ),
        params![drive_id],
    )?;
    Ok(())
}

/// Per-state counts on one drive, for the health check.
pub fn state_counts(conn: &Connection, drive_id: &str) -> anyhow::Result<Vec<(String, u64)>> {
    let mut stmt = conn
        .prepare("SELECT state, COUNT(*) FROM content_docs WHERE drive_id = ?1 GROUP BY state")?;
    let rows = stmt
        .query_map(params![drive_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?.max(0) as u64))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The file a content row describes, if it still matches the file index.
pub fn doc_path(conn: &Connection, id: i64) -> anyhow::Result<Option<(String, String)>> {
    Ok(conn
        .query_row(
            "SELECT parent, name FROM content_docs WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::files::FileEntry;
    use crate::files::index::replace_dir;

    pub(crate) fn drive_conn(dir: &std::path::Path) -> Connection {
        let marker = luna_core::marker::Marker::new("d1", "D");
        crate::drives::drive_db::create(dir, &marker, &luna_core::marker::pick_prefix(dir).unwrap())
            .unwrap()
    }

    pub(crate) fn file(name: &str, size: u64, modified: i64) -> FileEntry {
        FileEntry {
            name: name.into(),
            kind: "file".into(),
            size,
            modified,
            hidden: false,
            saving: false,
            save_failed: false,
            original_name: None,
            original_path: None,
            link_target: None,
            caps: String::new(),
            private: false,
            in_private: false,
        }
    }

    #[test]
    fn pending_lists_readable_files_documents_first_and_forgets_read_ones() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                file("old.pdf", 10, 100),
                file("new.docx", 10, 200),
                file("photo.jpg", 10, 300),
                file("song.mp3", 10, 400),
            ],
        )
        .unwrap();
        let names = |include| -> Vec<String> {
            pending(&conn, "d1", include, 10)
                .unwrap()
                .into_iter()
                .map(|p| p.name)
                .collect()
        };
        assert_eq!(names(true), ["new.docx", "old.pdf", "photo.jpg"]);
        assert_eq!(names(false), ["new.docx", "old.pdf"]);
        assert_eq!(pending_count(&conn, "d1", true).unwrap(), 3);

        let first = pending(&conn, "d1", true, 1).unwrap().remove(0);
        record(&conn, "d1", &first, State::Text, "", Some("hello")).unwrap();
        assert_eq!(names(true), ["old.pdf", "photo.jpg"]);
    }

    #[test]
    fn a_changed_file_is_read_again_and_keeps_its_row_id() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(&conn, "d1", "docs", 1, &[file("a.txt", 5, 1)]).unwrap();
        let p = pending(&conn, "d1", false, 10).unwrap().remove(0);
        let id = record(&conn, "d1", &p, State::Text, "", Some("first words")).unwrap();
        assert!(pending(&conn, "d1", false, 10).unwrap().is_empty());

        replace_dir(&conn, "d1", "docs", 2, &[file("a.txt", 9, 2)]).unwrap();
        let p = pending(&conn, "d1", false, 10).unwrap().remove(0);
        assert_eq!(p.size, 9);
        let again = record(&conn, "d1", &p, State::Text, "", Some("second words")).unwrap();
        assert_eq!(id, again);
        let body: String = conn
            .query_row("SELECT body FROM content_fts WHERE rowid = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(body, "second words");
    }

    #[test]
    fn deleted_files_lose_their_text() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(&conn, "d1", "", 1, &[file("gone.txt", 5, 1)]).unwrap();
        let p = pending(&conn, "d1", false, 10).unwrap().remove(0);
        record(&conn, "d1", &p, State::Text, "", Some("secret plans")).unwrap();
        replace_dir(&conn, "d1", "", 2, &[]).unwrap();
        assert_eq!(sweep_orphans(&conn, "d1").unwrap(), 1);
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM content_fts WHERE content_fts MATCH 'secret'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }
}
