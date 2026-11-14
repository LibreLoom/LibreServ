//! Finding files by the words inside them.

use rusqlite::{Connection, params};

use crate::files::search::{KindFilter, SearchHit};
use crate::files::search_rank::Query;

/// The FTS5 expression for a query: every word must appear. The last word
/// may be half-typed, so it also matches as a prefix. Words are quoted, so
/// nothing typed can become FTS syntax.
pub fn fts_expr(query: &Query) -> Option<String> {
    let words: Vec<&str> = query
        .words
        .iter()
        .map(String::as_str)
        .filter(|w| !w.is_empty())
        .collect();
    let (last, rest) = words.split_last()?;
    let quote = |w: &str| format!("\"{}\"", w.replace('"', "\"\""));
    let mut parts: Vec<String> = rest.iter().map(|w| quote(w)).collect();
    if last.chars().count() >= 3 {
        // Whole word (stemmed: "invoices" finds "invoice") or the start of one.
        parts.push(format!("({} OR {}*)", quote(last), quote(last)));
    } else {
        parts.push(quote(last));
    }
    // FTS5 needs an explicit AND before a parenthesized group.
    Some(parts.join(" AND "))
}

/// One content match before access checks: the file and how well it matched
/// (BM25, lower is better).
#[derive(Debug, Clone)]
pub struct ContentHit {
    pub doc: i64,
    pub hit: SearchHit,
    pub bm25: f64,
}

/// Files on this drive whose words match, best first. Only rows that still
/// describe the indexed file (same size and time, not hidden) count, so a
/// changed or deleted file can't surface stale text.
pub fn candidates(
    conn: &Connection,
    drive_id: &str,
    expr: &str,
    kind: KindFilter,
    limit: usize,
) -> rusqlite::Result<Vec<ContentHit>> {
    if kind == KindFilter::Folders {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare_cached(
        "SELECT c.id, e.parent, e.name, e.kind, e.size, e.modified, content_fts.rank
         FROM content_fts
         JOIN content_docs c ON c.id = content_fts.rowid
         JOIN index_entries e
           ON e.drive_id = c.drive_id AND e.parent = c.parent AND e.name = c.name
          AND e.size = c.size AND e.modified = c.modified
         WHERE content_fts MATCH ?1 AND c.drive_id = ?2 AND e.hidden = 0
         ORDER BY content_fts.rank
         LIMIT ?3",
    )?;
    stmt.query_map(params![expr, drive_id, limit as i64], |r| {
        Ok(ContentHit {
            doc: r.get(0)?,
            hit: SearchHit {
                drive_id: drive_id.to_string(),
                parent: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                size: r.get(4)?,
                modified: r.get(5)?,
            },
            bm25: r.get(6)?,
        })
    })?
    .collect()
}

/// A short piece of a file's text around what matched, split into runs so
/// the page can underline the matched words. Call only for a file the
/// person may open: the text comes straight from the file.
pub fn snippet(conn: &Connection, doc: i64, expr: &str) -> Option<Vec<(String, bool)>> {
    let raw: String = conn
        .query_row(
            "SELECT snippet(content_fts, 0, char(2), char(3), '…', 14)
             FROM content_fts WHERE content_fts MATCH ?1 AND rowid = ?2",
            params![expr, doc],
            |r| r.get(0),
        )
        .ok()?;
    let parts = snippet_parts(&raw);
    (!parts.is_empty()).then_some(parts)
}

/// Split FTS5 snippet output (matches between \x02 and \x03) into
/// (text, matched) runs, with line breaks folded into spaces.
pub fn snippet_parts(raw: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut cur = String::new();
    let mut hit = false;
    let mut last_space = false;
    for ch in raw.chars() {
        match ch {
            '\u{2}' | '\u{3}' => {
                if !cur.is_empty() {
                    out.push((std::mem::take(&mut cur), hit));
                }
                hit = ch == '\u{2}';
            }
            c if c.is_whitespace() => {
                if !last_space {
                    cur.push(' ');
                }
                last_space = true;
                continue;
            }
            c => cur.push(c),
        }
        last_space = false;
    }
    if !cur.is_empty() {
        out.push((cur, hit));
    }
    if let Some(first) = out.first_mut() {
        first.0 = first.0.trim_start().to_string();
    }
    if let Some(last) = out.last_mut() {
        last.0 = last.0.trim_end().to_string();
    }
    out.retain(|(t, _)| !t.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::content::store::{self, State};
    use crate::files::index::replace_dir;

    #[test]
    fn expressions_quote_words_and_let_the_last_one_be_partial() {
        assert_eq!(
            fts_expr(&Query::new("water bill")).unwrap(),
            "\"water\" AND (\"bill\" OR \"bill\"*)"
        );
        assert_eq!(fts_expr(&Query::new("tv")).unwrap(), "\"tv\"");
        // Punctuation is folded away by the query, so no FTS syntax survives.
        assert_eq!(
            fts_expr(&Query::new("a\" OR b*")).unwrap(),
            "\"a\" AND \"or\" AND \"b\""
        );
        assert!(fts_expr(&Query::new("  ")).is_none());
    }

    #[test]
    fn snippet_runs_mark_the_matches() {
        let raw = "…the \u{2}water\u{3}\nbill for \u{2}March\u{3}…";
        assert_eq!(
            snippet_parts(raw),
            vec![
                ("…the ".to_string(), false),
                ("water".to_string(), true),
                (" bill for ".to_string(), false),
                ("March".to_string(), true),
                ("…".to_string(), false),
            ]
        );
    }

    fn index_with(conn: &Connection, files: &[(&str, &str)]) {
        let entries: Vec<_> = files
            .iter()
            .map(|(n, _)| store::tests::file(n, 5, 1))
            .collect();
        replace_dir(conn, "d1", "docs", 1, &entries).unwrap();
        for p in store::pending(conn, "d1", true, 100).unwrap() {
            let text = files.iter().find(|(n, _)| *n == p.name).unwrap().1;
            store::record(conn, "d1", &p, State::Text, "", Some(text)).unwrap();
        }
    }

    #[test]
    fn finds_files_by_words_with_stemming_and_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let conn = store::tests::drive_conn(dir.path());
        index_with(
            &conn,
            &[
                (
                    "lease.docx",
                    "The tenant pays rent on the first of each month.",
                ),
                ("bill.pdf", "Water bills for the flat, paid in March."),
                ("note.txt", "Buy milk."),
            ],
        );
        let names = |q: &str| -> Vec<String> {
            candidates(
                &conn,
                "d1",
                &fts_expr(&Query::new(q)).unwrap(),
                KindFilter::All,
                10,
            )
            .unwrap()
            .into_iter()
            .map(|h| h.hit.name)
            .collect()
        };
        assert_eq!(names("tenant"), ["lease.docx"]);
        assert_eq!(names("water bill"), ["bill.pdf"]);
        assert_eq!(names("ten"), ["lease.docx"]);
        assert_eq!(names("paying"), ["lease.docx"]);
        assert!(names("tenant milk").is_empty());
        assert!(
            candidates(&conn, "d1", "\"tenant\"", KindFilter::Folders, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn stale_text_is_never_returned() {
        let dir = tempfile::tempdir().unwrap();
        let conn = store::tests::drive_conn(dir.path());
        index_with(&conn, &[("plan.txt", "secret garden plan")]);
        // The file changed on disk; its old words must not match any more.
        replace_dir(
            &conn,
            "d1",
            "docs",
            2,
            &[store::tests::file("plan.txt", 6, 2)],
        )
        .unwrap();
        assert!(
            candidates(&conn, "d1", "\"garden\"", KindFilter::All, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn snippet_comes_from_the_matching_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = store::tests::drive_conn(dir.path());
        index_with(
            &conn,
            &[("bill.pdf", "Water bills for the flat, paid in March.")],
        );
        let expr = fts_expr(&Query::new("march")).unwrap();
        let hit = candidates(&conn, "d1", &expr, KindFilter::All, 10)
            .unwrap()
            .remove(0);
        let parts = snippet(&conn, hit.doc, &expr).unwrap();
        assert!(parts.iter().any(|(t, h)| *h && t == "March"));
    }
}
