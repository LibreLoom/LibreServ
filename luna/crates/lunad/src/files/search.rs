//! File search over the per-drive index.
//!
//! Each drive's `.luna-<uuid>.sqlite3` holds an FTS5 trigram table beside
//! `index_entries`. A search runs in two steps per drive, all drives in
//! parallel:
//!
//! 1. Exact: every word of the query appears in the name.
//! 2. Close: names sharing 3-letter pieces with the query that step 1 did
//!    not already read; keep the ones within a typo or two.
//! 3. Words inside files, then (unless asked not to) passages by meaning.
//!
//! Steps 2 and 3 only run when step 1 doesn't already fill the answer.
//!
//! Candidates are ranked by [`search_rank`](crate::files::search_rank); the
//! caller applies access checks in rank order, so the result limit counts
//! only what the person can actually see.

use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{Connection, params};

use crate::files::search_rank::{self, Query, Rank, Tier};

/// A drive to search: its id and where it is mounted.
#[derive(Debug, Clone)]
pub struct DriveRef {
    pub id: String,
    pub mount: PathBuf,
}

/// Mounted drives that have a file index to search. `readonly` drives are
/// searchable but can't be re-read, so `writable_only` leaves them out.
pub fn indexable_drives(central: &Connection, writable_only: bool) -> Vec<DriveRef> {
    crate::db::list_drives(central)
        .unwrap_or_default()
        .into_iter()
        .filter(|d| {
            !d.mount_point.is_empty()
                && (d.state == "as_is" || (!writable_only && d.state == "readonly"))
        })
        .map(|d| DriveRef {
            id: d.id,
            mount: PathBuf::from(d.mount_point),
        })
        .collect()
}

/// Which kinds of entry to return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KindFilter {
    #[default]
    All,
    Folders,
    Files,
}

impl KindFilter {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("dir") | Some("folder") | Some("folders") => Self::Folders,
            Some("file") | Some("files") => Self::Files,
            _ => Self::All,
        }
    }

    fn clause(self) -> &'static str {
        match self {
            Self::All => "",
            Self::Folders => "AND index_entries.kind = 'dir'",
            Self::Files => "AND index_entries.kind != 'dir'",
        }
    }
}

/// One search hit from the file index (name, folder path, kind, size, etc.).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub drive_id: String,
    pub parent: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub modified: i64,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub hit: SearchHit,
    pub rank: Rank,
    /// The `content_docs` row when the match came from the file's text, so
    /// the snippet can be made once access is checked.
    pub doc: Option<i64>,
    /// For a meaning match: the passage (char start, length) it came from.
    pub passage: Option<(i64, i64)>,
}

/// Most rows the index returns to the ranker per step.
const PAGE_SIZE: i64 = 256;
/// Maximum rows examined per search step and drive. If exceeded the caller
/// must say the answer may be incomplete, including when no visible hit exists.
const ROW_BUDGET: i64 = 8192;

/// Search every drive at once; candidates come back best first.
pub fn search_all(
    drives: &[DriveRef],
    query: &Query,
    kind: KindFilter,
) -> anyhow::Result<(Vec<Candidate>, bool)> {
    search_all_with(drives, query, kind, true, |_| false)
}

/// [`search_all`], optionally without the neural passes (what photos show,
/// passages by meaning). Those embed the query with a model, which costs
/// ~1 s per new query on a Wyse 3040; while someone is still typing the web
/// asks without them and fills them in once typing pauses.
///
/// Names holding the query's words are searched first. `names_suffice`
/// sees those candidates, best first; when it says they already fill the
/// answer, the passes that can only rank below them (names a typo away,
/// words inside files, meaning, photos) are skipped. It must only say so
/// when the outcome can't change: the caller counts name matches ranked
/// above [`Tier::Content`] that the person may open. A skipped pass can't
/// mark the answer incomplete, since nothing it finds could be shown.
pub fn search_all_with(
    drives: &[DriveRef],
    query: &Query,
    kind: KindFilter,
    neural: bool,
    names_suffice: impl FnOnce(&[Candidate]) -> bool,
) -> anyhow::Result<(Vec<Candidate>, bool)> {
    let deadline = std::time::Instant::now() + SEARCH_TIMEOUT;
    // Names holding the words, on every drive at once. A drive whose index
    // can't be opened or searched is left out and makes the answer
    // incomplete.
    let mut incomplete = false;
    let mut searched: Vec<(&DriveRef, Connection, Found)> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = drives
            .iter()
            .map(|drive| {
                scope.spawn(move || {
                    let conn = crate::drives::drive_db::open(&drive.mount)?;
                    set_deadline(&conn, Some(deadline));
                    let found = exact_pass(&conn, &drive.id, query, kind, ROW_BUDGET)?;
                    Ok::<_, anyhow::Error>((drive, conn, found))
                })
            })
            .collect();
        for handle in handles {
            match handle.join() {
                Ok(Ok(done)) => searched.push(done),
                Ok(Err(error)) => {
                    tracing::warn!(%error, "drive search failed");
                    incomplete = true;
                }
                Err(_) => {
                    tracing::warn!("drive search worker failed");
                    incomplete = true;
                }
            }
        }
    });
    let mut names: Vec<Candidate> = searched
        .iter_mut()
        .flat_map(|(_, _, found)| std::mem::take(&mut found.out))
        .collect();
    sort_candidates(&mut names);
    if names_suffice(&names) {
        for (_, conn, found) in &searched {
            set_deadline(conn, None);
            incomplete |= found.incomplete;
        }
        return Ok((names, incomplete));
    }

    // What photos show: one text embedding for every drive. Its time doesn't
    // count against the drives' time limit.
    let embedding = std::time::Instant::now();
    let photo_q = if kind == KindFilter::Folders || !neural {
        None
    } else {
        let _neural = crate::perf::Timer::debug("W11", "search.photo_query");
        crate::files::content::photos::query_vector(&query.norm)
    };
    let photo_q = photo_q.as_ref();
    let deadline = deadline + embedding.elapsed();
    let mut all = names;
    std::thread::scope(|scope| {
        let handles: Vec<_> = searched
            .into_iter()
            .map(|(drive, conn, mut found)| {
                scope.spawn(move || {
                    set_deadline(&conn, Some(deadline));
                    // Close names before the text: a file found both ways
                    // keeps its (better) close-name match.
                    if let Err(error) =
                        close_pass(&conn, &drive.id, query, kind, ROW_BUDGET, &mut found)
                    {
                        tracing::warn!(%error, "close name search failed");
                        found.incomplete = true;
                    }
                    later_passes(&conn, &drive.id, query, kind, neural, &mut found);
                    set_deadline(&conn, None);
                    if let Some(q) = photo_q {
                        photo_pass(&conn, &drive.id, q, kind, &mut found);
                    }
                    found
                })
            })
            .collect();
        for handle in handles {
            match handle.join() {
                Ok(found) => {
                    all.extend(found.out);
                    incomplete |= found.incomplete;
                }
                Err(_) => {
                    tracing::warn!("drive search worker failed");
                    incomplete = true;
                }
            }
        }
    });
    sort_candidates(&mut all);
    Ok((all, incomplete))
}

/// How long one search may spend inside SQLite per drive. Past it the
/// answer is labelled incomplete.
const SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Interrupt this connection's queries once `deadline` passes (`None`
/// clears it). SQLite can spend work inside MATCH before yielding a row, so
/// bounding rows alone isn't enough.
fn set_deadline(conn: &Connection, deadline: Option<std::time::Instant>) {
    match deadline {
        Some(deadline) => {
            conn.progress_handler(1000, Some(move || std::time::Instant::now() >= deadline))
        }
        None => conn.progress_handler(0, None::<fn() -> bool>),
    }
}

/// One drive's candidates so far.
#[derive(Default)]
struct Found {
    out: Vec<Candidate>,
    /// Entries already found, so a later pass doesn't add them again.
    seen: HashSet<(String, String)>,
    incomplete: bool,
    /// The exact pass's expression, when it read any rows: the close pass
    /// leaves those rows out.
    exact_read: Option<String>,
}

fn photo_pass(
    conn: &Connection,
    drive_id: &str,
    q: &[f32; crate::files::content::clip::DIM],
    kind: KindFilter,
    found: &mut Found,
) {
    let _neural = crate::perf::Timer::debug("W11", "search.photos");
    match crate::files::content::photos::candidates(conn, drive_id, q, kind) {
        Ok(hits) => {
            for (hit, sim) in hits {
                if found.seen.contains(&(hit.parent.clone(), hit.name.clone())) {
                    continue;
                }
                found.out.push(Candidate {
                    rank: Rank {
                        tier: Tier::Photo,
                        score: ((1.0 - sim).clamp(0.0, 2.0) * 1_000_000.0) as u32,
                        typos: 0,
                        file: 1,
                        len: search_rank::normalize(&hit.name).len(),
                    },
                    hit,
                    doc: None,
                    passage: None,
                });
            }
        }
        Err(e) => tracing::debug!(error = %e, "photo search on a drive failed"),
    }
}

fn sort_candidates(all: &mut [Candidate]) {
    all.sort_by_cached_key(|c| {
        (
            c.rank.clone(),
            c.hit.name.to_lowercase(),
            c.hit.parent.clone(),
            c.hit.drive_id.clone(),
        )
    });
}

/// Search one drive's index. Hidden entries are never returned.
#[cfg(test)]
fn search_drive(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
) -> anyhow::Result<Vec<Candidate>> {
    Ok(search_drive_bounded(conn, drive_id, query, kind, true)?.0)
}

/// Every pass on one drive, under the usual row budget and time limit.
#[cfg(test)]
fn search_drive_bounded(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    neural: bool,
) -> anyhow::Result<(Vec<Candidate>, bool)> {
    search_drive_with_limits(
        conn,
        drive_id,
        query,
        kind,
        ROW_BUDGET,
        Some(SEARCH_TIMEOUT),
        neural,
    )
}

#[cfg(test)]
fn search_drive_with_limits(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    row_budget: i64,
    timeout: Option<std::time::Duration>,
    neural: bool,
) -> anyhow::Result<(Vec<Candidate>, bool)> {
    set_deadline(conn, timeout.map(|t| std::time::Instant::now() + t));
    let found = exact_pass(conn, drive_id, query, kind, row_budget).and_then(|mut found| {
        close_pass(conn, drive_id, query, kind, row_budget, &mut found)?;
        later_passes(conn, drive_id, query, kind, neural, &mut found);
        Ok(found)
    });
    set_deadline(conn, None);
    let mut found = found?;
    found.out.sort_by(|a, b| a.rank.cmp(&b.rank));
    Ok((found.out, found.incomplete))
}

/// Read every row `expr` matches (or, with no expression, every name
/// starting with the query) in stable rowid-ordered pages, under a fixed
/// row budget, and keep the names that really match. Returns the rows read.
///
/// Ranking happens after collection; exhausting the budget means neither
/// the order nor the existence of omitted visible matches is known, so the
/// answer is marked incomplete.
fn take(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    expr: Option<&str>,
    row_budget: i64,
    found: &mut Found,
) -> anyhow::Result<usize> {
    let mut after = 0_i64;
    let mut examined = 0_i64;
    loop {
        // One extra row distinguishes an exactly full budget from overflow.
        let size = PAGE_SIZE.min(row_budget + 1 - examined);
        let rows = match candidate_page(conn, drive_id, query, kind, expr, after, size) {
            Err(e) if e.downcast_ref::<rusqlite::Error>().is_some_and(interrupted) => {
                found.incomplete = true;
                return Ok(examined as usize);
            }
            result => result?,
        };
        if rows.is_empty() {
            break;
        }
        let count = rows.len() as i64;
        for (rowid, hit) in rows {
            if examined == row_budget {
                found.incomplete = true;
                return Ok(examined as usize);
            }
            examined += 1;
            after = rowid;
            // Only a name that really matches is "found". The fuzzy pass
            // returns files matching any 3-letter piece; marking those seen
            // would hide them from the text search below.
            let key = (hit.parent.clone(), hit.name.clone());
            if !found.seen.contains(&key)
                && let Some(rank) = search_rank::rank(query, &hit.name, hit.kind == "dir")
            {
                found.seen.insert(key);
                found.out.push(Candidate {
                    hit,
                    rank,
                    doc: None,
                    passage: None,
                });
            }
        }
        if count < size {
            break;
        }
    }
    Ok(examined as usize)
}

/// Names holding every word of the query (or, for a query too short for
/// the index, starting with it). Each step (this one, then
/// [`close_pass`]) has its own row budget, so typo recall survives exact
/// matches filling theirs, including when those matches are inaccessible.
fn exact_pass(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    row_budget: i64,
) -> anyhow::Result<Found> {
    let mut found = Found::default();
    let exact = search_rank::fts_match(query, true);
    let mut names_timer = crate::perf::Timer::debug("W10", "search.names");
    names_timer.field("drive", drive_id);
    let rows = take(
        conn,
        drive_id,
        query,
        kind,
        exact.as_deref(),
        row_budget,
        &mut found,
    )?;
    names_timer.field("rows", rows);
    found.exact_read = exact.filter(|_| rows > 0);
    Ok(found)
}

/// Names a typo or two away. Every one ranks below every name holding the
/// words and below every match inside a file ([`Tier::Close`]), so it only
/// runs when those don't already fill the answer.
fn close_pass(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    row_budget: i64,
    found: &mut Found,
) -> anyhow::Result<()> {
    // Close matching must not depend on the number of inaccessible names.
    // Leaving out rows the exact pass didn't read only costs time.
    let Some(close) = close_expr(query, found.exact_read.as_deref()) else {
        return Ok(());
    };
    let mut close_timer = crate::perf::Timer::debug("W10", "search.close");
    close_timer.field("drive", drive_id);
    close_timer.field(
        "rows",
        take(conn, drive_id, query, kind, Some(&close), row_budget, found)?,
    );
    Ok(())
}

/// Words inside files, then passages by meaning. A file already found by
/// its name keeps that (better) match. Errors here never take name search
/// down; they make the answer incomplete.
fn later_passes(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    neural: bool,
    found: &mut Found,
) {
    if let Some(expr) = crate::files::content::query::fts_expr(query) {
        let mut content_timer = crate::perf::Timer::debug("W10", "search.content");
        content_timer.field("drive", drive_id);
        match crate::files::content::query::candidates(conn, drive_id, &expr, kind, CONTENT_LIMIT) {
            Ok(hits) => {
                for hit in hits {
                    if !found
                        .seen
                        .insert((hit.hit.parent.clone(), hit.hit.name.clone()))
                    {
                        continue;
                    }
                    let len = search_rank::normalize(&hit.hit.name).len();
                    found.out.push(Candidate {
                        rank: Rank {
                            tier: Tier::Content,
                            score: bm25_score(hit.bm25),
                            typos: 0,
                            file: 1,
                            len,
                        },
                        hit: hit.hit,
                        doc: Some(hit.doc),
                        passage: None,
                    });
                }
            }
            Err(e) if interrupted(&e) => found.incomplete = true,
            Err(e) => {
                tracing::warn!(error = %e, drive_id, "searching inside files failed");
                found.incomplete = true;
            }
        }
    }
    // Passages about the same thing, in other words. Neural search (W11),
    // timed per drive at debug.
    let mut meaning_timer = crate::perf::Timer::debug("W11", "search.meaning");
    meaning_timer.field("drive", drive_id);
    if neural
        && !found.incomplete
        && let Some(qv) = crate::files::content::meaning::query_vector(&query.words)
    {
        // Without this field no neural pass ran (no model, or name search
        // was already cut short).
        meaning_timer.field("ran", true);
        match crate::files::content::meaning::candidates(conn, drive_id, &qv, kind) {
            Ok(hits) => {
                for hit in hits {
                    if !found
                        .seen
                        .insert((hit.hit.parent.clone(), hit.hit.name.clone()))
                    {
                        continue;
                    }
                    let len = search_rank::normalize(&hit.hit.name).len();
                    found.out.push(Candidate {
                        rank: Rank {
                            tier: Tier::Meaning,
                            score: ((1.0 - hit.similarity).clamp(0.0, 2.0) * 1_000_000.0) as u32,
                            typos: 0,
                            file: 1,
                            len,
                        },
                        hit: hit.hit,
                        doc: Some(hit.doc),
                        passage: Some(hit.passage),
                    });
                }
            }
            Err(e) if interrupted(&e) => found.incomplete = true,
            Err(e) => {
                tracing::warn!(error = %e, drive_id, "searching inside files failed");
                found.incomplete = true;
            }
        }
    }
}

/// The close pass's FTS expression: names sharing pieces with the query,
/// minus the ones the exact pass already read. A name holding every word
/// either ranked there or can't be a close match (each word is in it, so
/// only a short word with no typo slack can be missing), so leaving those
/// rows out changes no result; it keeps the pass from re-reading every
/// exact match and spending its row budget on them.
fn close_expr(query: &Query, exact: Option<&str>) -> Option<String> {
    let close = search_rank::fts_match(query, false)?;
    Some(match exact {
        Some(exact) => format!("({close}) NOT ({exact})"),
        None => close,
    })
}

fn interrupted(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted)
}

/// Content matches per drive, best first. Ranked by the index, so this is a
/// cut of the best matches, not a work limit.
const CONTENT_LIMIT: usize = 200;

/// BM25 (negative; more negative is better) as a sortable integer.
fn bm25_score(bm25: f64) -> u32 {
    (1_000_000_000.0 + bm25 * 1000.0).clamp(0.0, u32::MAX as f64) as u32
}

/// One page of [`candidate_page`]: names matching the FTS expression, or
/// for a query too short for it, names starting with the query.
fn page_sql(kind: KindFilter, fts: bool) -> String {
    if fts {
        format!(
            "SELECT index_entries.rowid, index_entries.parent, index_entries.name, index_entries.kind, index_entries.size, index_entries.modified FROM index_fts JOIN index_entries ON index_entries.rowid = index_fts.rowid WHERE index_fts MATCH ?1 AND index_entries.hidden = 0 AND index_entries.drive_id = ?2 AND index_fts.rowid > ?3 {} ORDER BY index_fts.rowid LIMIT ?4",
            kind.clause()
        )
    } else {
        // Rowid order straight off the table (NOT INDEXED): through an index
        // SQLite would read every matching row and sort them, once per page.
        format!(
            "SELECT index_entries.rowid, index_entries.parent, index_entries.name, index_entries.kind, index_entries.size, index_entries.modified FROM index_entries NOT INDEXED WHERE index_entries.name LIKE ?1 ESCAPE '\\' AND index_entries.hidden = 0 AND index_entries.drive_id = ?2 AND index_entries.rowid > ?3 {} ORDER BY index_entries.rowid LIMIT ?4",
            kind.clause()
        )
    }
}

fn candidate_page(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
    expr: Option<&str>,
    after: i64,
    limit: i64,
) -> anyhow::Result<Vec<(i64, SearchHit)>> {
    let escaped = query
        .norm
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("{escaped}%");
    let mut stmt = conn.prepare_cached(&page_sql(kind, expr.is_some()))?;
    let rows = stmt
        .query_map(
            params![expr.unwrap_or(&pattern), drive_id, after, limit],
            |row| {
                Ok((
                    row.get(0)?,
                    SearchHit {
                        drive_id: drive_id.into(),
                        parent: row.get(1)?,
                        name: row.get(2)?,
                        kind: row.get(3)?,
                        size: row.get(4)?,
                        modified: row.get(5)?,
                    },
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileEntry;
    use crate::files::index::{forget_dir_tree, replace_dir};
    use crate::files::search_rank::Tier;

    fn entry(name: &str, kind: &str, hidden: bool) -> FileEntry {
        FileEntry {
            name: name.into(),
            kind: kind.into(),
            size: 7,
            modified: 3,
            hidden,
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

    fn drive_conn(dir: &std::path::Path) -> Connection {
        let marker = luna_core::marker::Marker::new("d1", "D");
        crate::drives::drive_db::create(dir, &marker, &luna_core::marker::pick_prefix(dir).unwrap())
            .unwrap()
    }

    fn names(conn: &Connection, q: &str, kind: KindFilter) -> Vec<String> {
        search_drive(conn, "d1", &Query::new(q), kind)
            .unwrap()
            .into_iter()
            .map(|c| c.hit.name)
            .collect()
    }

    #[test]
    fn finds_files_and_folders_by_their_own_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                entry("Taxes", "dir", false),
                entry("notes.txt", "file", false),
            ],
        )
        .unwrap();
        replace_dir(
            &conn,
            "d1",
            "Taxes",
            1,
            &[entry("return 2024.pdf", "file", false)],
        )
        .unwrap();

        // A folder's name finds the folder, not everything inside it.
        assert_eq!(names(&conn, "taxes", KindFilter::All), ["Taxes"]);
        assert_eq!(names(&conn, "taxes", KindFilter::Folders), ["Taxes"]);
        assert!(names(&conn, "taxes", KindFilter::Files).is_empty());
        assert_eq!(
            names(&conn, "return 2024", KindFilter::All),
            ["return 2024.pdf"]
        );
    }

    #[test]
    fn a_name_matching_only_some_words_does_not_hide_the_files_text() {
        use crate::files::content::store::{self, State};
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "docs",
            1,
            &[store::tests::file("invoice-4417.txt", 5, 1)],
        )
        .unwrap();
        for p in store::pending(&conn, "d1", true, 100).unwrap() {
            store::record(
                &conn,
                "d1",
                &p,
                State::Text,
                "",
                Some("Plumbing invoice: kitchen sink repair"),
            )
            .unwrap();
        }

        // "invoice" is in the name, "plumbing" only in the text: the fuzzy
        // name pass returns the file but it isn't a name match, so the text
        // search must still get to report it.
        assert_eq!(
            names(&conn, "plumbing invoice", KindFilter::All),
            ["invoice-4417.txt"]
        );
    }

    #[test]
    fn names_that_fill_the_answer_skip_the_search_inside_files() {
        use crate::files::content::store::{self, State};
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "docs",
            1,
            &[
                store::tests::file("invoice march.txt", 5, 1),
                store::tests::file("notes.txt", 5, 1),
            ],
        )
        .unwrap();
        for p in store::pending(&conn, "d1", true, 100).unwrap() {
            store::record(
                &conn,
                "d1",
                &p,
                State::Text,
                "",
                Some("the invoice for march"),
            )
            .unwrap();
        }
        drop(conn);
        let drives = [DriveRef {
            id: "d1".into(),
            mount: dir.path().to_path_buf(),
        }];
        let query = Query::new("invoice");
        let search = |suffice: bool| {
            let mut seen = Vec::new();
            let (got, incomplete) =
                search_all_with(&drives, &query, KindFilter::All, false, |names| {
                    seen = names.iter().map(|c| c.hit.name.clone()).collect();
                    suffice
                })
                .unwrap();
            assert!(!incomplete);
            let got: Vec<String> = got.into_iter().map(|c| c.hit.name).collect();
            (seen, got)
        };
        // The check sees only name matches.
        let (seen, got) = search(false);
        assert_eq!(seen, ["invoice march.txt"]);
        assert_eq!(got, ["invoice march.txt", "notes.txt"]);
        let (seen, got) = search(true);
        assert_eq!(seen, ["invoice march.txt"]);
        assert_eq!(got, ["invoice march.txt"]);
    }

    #[test]
    fn names_that_fill_the_answer_skip_the_close_pass() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        insert_names(
            &conn,
            ["holiday 1.pdf", "holiday 2.pdf", "holidya.pdf"].map(String::from),
        );
        drop(conn);
        let drives = [DriveRef {
            id: "d1".into(),
            mount: dir.path().to_path_buf(),
        }];
        let query = Query::new("holiday");
        let search = |suffice: bool| {
            let mut seen = Vec::new();
            let (got, incomplete) =
                search_all_with(&drives, &query, KindFilter::All, false, |names| {
                    seen = names.iter().map(|c| c.hit.name.clone()).collect();
                    suffice
                })
                .unwrap();
            assert!(!incomplete);
            let got: Vec<String> = got.into_iter().map(|c| c.hit.name).collect();
            (seen, got)
        };
        // The check sees only names holding the words, never the typo.
        let (seen, got) = search(false);
        assert_eq!(seen, ["holiday 1.pdf", "holiday 2.pdf"]);
        assert_eq!(got, ["holiday 1.pdf", "holiday 2.pdf", "holidya.pdf"]);
        let (seen, got) = search(true);
        assert_eq!(seen, ["holiday 1.pdf", "holiday 2.pdf"]);
        assert_eq!(got, ["holiday 1.pdf", "holiday 2.pdf"]);
    }

    #[test]
    fn folders_show_up_and_rank_ahead_of_same_tier_files() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                entry("holiday.txt", "file", false),
                entry("holiday photos", "dir", false),
            ],
        )
        .unwrap();
        let got = search_drive(&conn, "d1", &Query::new("holiday"), KindFilter::All).unwrap();
        assert_eq!(got[0].hit.name, "holiday photos");
        assert_eq!(got[0].hit.kind, "dir");
        assert_eq!(got[0].rank.tier, Tier::Prefix);
    }

    #[test]
    fn hidden_entries_are_never_found() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(&conn, "d1", "", 1, &[entry(".secret-notes", "file", true)]).unwrap();
        assert!(names(&conn, "secret", KindFilter::All).is_empty());
    }

    #[test]
    fn kind_words_do_not_match_everything() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(&conn, "d1", "", 1, &[entry("beach.jpg", "file", false)]).unwrap();
        assert!(names(&conn, "file", KindFilter::All).is_empty());
        assert!(names(&conn, "dir", KindFilter::All).is_empty());
    }

    #[test]
    fn typos_find_close_names_but_rank_below_real_matches() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                entry("passport.pdf", "file", false),
                entry("my pasport scan.pdf", "file", false),
                entry("unrelated.txt", "file", false),
            ],
        )
        .unwrap();
        let got = search_drive(&conn, "d1", &Query::new("pasport"), KindFilter::All).unwrap();
        let order: Vec<&str> = got.iter().map(|c| c.hit.name.as_str()).collect();
        assert_eq!(order, ["my pasport scan.pdf", "passport.pdf"]);
        assert_eq!(got[1].rank.tier, Tier::Close);
    }

    #[test]
    fn short_queries_match_name_starts() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                entry("ab notes", "file", false),
                entry("cab", "file", false),
            ],
        )
        .unwrap();
        assert_eq!(names(&conn, "ab", KindFilter::All), ["ab notes"]);
    }

    #[test]
    fn separators_and_accents_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "",
            1,
            &[
                entry("IMG_0019.jpg", "file", false),
                entry("Café menu.pdf", "file", false),
            ],
        )
        .unwrap();
        assert_eq!(names(&conn, "img 0019", KindFilter::All), ["IMG_0019.jpg"]);
        assert_eq!(names(&conn, "cafe", KindFilter::All), ["Café menu.pdf"]);
    }

    #[test]
    fn the_search_table_follows_replaced_and_forgotten_rows() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        replace_dir(
            &conn,
            "d1",
            "docs",
            1,
            &[entry("old name.txt", "file", false)],
        )
        .unwrap();
        assert_eq!(names(&conn, "old name", KindFilter::All), ["old name.txt"]);

        replace_dir(
            &conn,
            "d1",
            "docs",
            2,
            &[entry("new name.txt", "file", false)],
        )
        .unwrap();
        assert!(names(&conn, "old name", KindFilter::All).is_empty());
        assert_eq!(names(&conn, "new name", KindFilter::All), ["new name.txt"]);

        // Re-listing the same name updates in place rather than duplicating it.
        replace_dir(
            &conn,
            "d1",
            "docs",
            3,
            &[entry("new name.txt", "file", false)],
        )
        .unwrap();
        assert_eq!(names(&conn, "new name", KindFilter::All).len(), 1);

        forget_dir_tree(&conn, "d1", "docs").unwrap();
        assert!(names(&conn, "new name", KindFilter::All).is_empty());
    }

    #[test]
    fn fts_page_uses_fts_rowid_order_without_a_sort() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        let mut stmt = conn.prepare("EXPLAIN QUERY PLAN SELECT index_entries.rowid FROM index_fts JOIN index_entries ON index_entries.rowid=index_fts.rowid WHERE index_fts MATCH ?1 AND index_entries.hidden=0 AND index_entries.drive_id=?2 AND index_fts.rowid>?3 ORDER BY index_fts.rowid LIMIT ?4").unwrap();
        let plan = stmt
            .query_map(params!["\"bud\"", "d1", 0, 256], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            !plan.iter().any(|line| line.contains("TEMP B-TREE")),
            "{plan:?}"
        );
    }

    #[test]
    fn short_query_page_uses_rowid_order_without_a_sort() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        let sql = format!("EXPLAIN QUERY PLAN {}", page_sql(KindFilter::All, false));
        let mut stmt = conn.prepare(&sql).unwrap();
        let plan = stmt
            .query_map(params!["re%", "d1", 0, 256], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            !plan
                .iter()
                .any(|line| line.contains("TEMP B-TREE") || line.contains("INDEX")),
            "{plan:?}"
        );
    }

    fn insert_names(conn: &Connection, names: impl IntoIterator<Item = String>) {
        for name in names {
            conn.execute("INSERT INTO index_entries (drive_id,parent,name,kind,size,modified,hidden) VALUES ('d1','',?1,'file',1,1,0)", params![name]).unwrap();
        }
    }

    #[test]
    fn the_close_pass_does_not_reread_exact_matches() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        insert_names(&conn, (0..20).map(|i| format!("report {i:02}.pdf")));
        insert_names(&conn, ["reprot.pdf".to_string()]);
        // The exact pass reads exactly its budget; the close pass only has
        // the typo left to read, so nothing was cut short.
        let (got, incomplete) = search_drive_with_limits(
            &conn,
            "d1",
            &Query::new("repor"),
            KindFilter::All,
            20,
            None,
            false,
        )
        .unwrap();
        assert!(!incomplete);
        assert_eq!(got.len(), 21);
        assert_eq!(got.last().unwrap().hit.name, "reprot.pdf");
        assert_eq!(got.last().unwrap().rank.tier, Tier::Close);
    }

    #[test]
    fn a_long_phrase_finds_its_close_name_past_names_sharing_pieces() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        // Plenty of names share pieces with the phrase without being close
        // to every word of it.
        insert_names(
            &conn,
            (0..100).map(|i| format!("summer receipts from {i:03}.pdf")),
        );
        insert_names(&conn, ["Receipts from the sumer holiday.pdf".to_string()]);
        let (got, incomplete) = search_drive_with_limits(
            &conn,
            "d1",
            &Query::new("receipts from the summer holiday"),
            KindFilter::All,
            20,
            None,
            false,
        )
        .unwrap();
        assert!(!incomplete);
        let names: Vec<&str> = got.iter().map(|c| c.hit.name.as_str()).collect();
        assert_eq!(names, ["Receipts from the sumer holiday.pdf"]);
        assert_eq!(got[0].rank.tier, Tier::Close);
    }

    #[test]
    fn work_budget_reports_incomplete_even_when_matches_are_omitted() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        for i in 0..=ROW_BUDGET {
            conn.execute("INSERT INTO index_entries (drive_id,parent,name,kind,size,modified,hidden) VALUES ('d1','',?1,'file',1,1,0)", params![format!("budget {i:05}.txt")]).unwrap();
        }
        let (_, incomplete) =
            search_drive_bounded(&conn, "d1", &Query::new("budget"), KindFilter::All, true)
                .unwrap();
        assert!(incomplete);
    }

    #[test]
    fn row_budget_distinguishes_exact_limit_from_an_omitted_match() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        for i in 0..3 {
            conn.execute("INSERT INTO index_entries (drive_id,parent,name,kind,size,modified,hidden) VALUES ('d1','',?1,'file',1,1,0)", params![format!("budget {i}.txt")]).unwrap();
        }
        let query = Query::new("budget");
        let (exact, incomplete) =
            search_drive_with_limits(&conn, "d1", &query, KindFilter::All, 3, None, true).unwrap();
        assert_eq!(exact.len(), 3);
        assert!(!incomplete);
        conn.execute("INSERT INTO index_entries (drive_id,parent,name,kind,size,modified,hidden) VALUES ('d1','',?1,'file',1,1,0)", params!["budget visible.txt"]).unwrap();
        let (limited, incomplete) =
            search_drive_with_limits(&conn, "d1", &query, KindFilter::All, 3, None, true).unwrap();
        assert_eq!(limited.len(), 3);
        assert!(
            limited
                .iter()
                .all(|candidate| candidate.hit.name != "budget visible.txt")
        );
        assert!(incomplete);
    }

    #[test]
    fn search_all_marks_an_unreadable_index_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good");
        std::fs::create_dir_all(&good).unwrap();
        let conn = drive_conn(&good);
        replace_dir(&conn, "good", "", 1, &[entry("budget.txt", "file", false)]).unwrap();
        let drives = [
            DriveRef {
                id: "missing".into(),
                mount: dir.path().join("missing"),
            },
            DriveRef {
                id: "good".into(),
                mount: good,
            },
        ];
        let (hits, incomplete) =
            search_all(&drives, &Query::new("budget"), KindFilter::All).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.name, "budget.txt");
        assert!(incomplete);
    }

    #[test]
    fn search_all_merges_drives_in_rank_order() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let marker_a = luna_core::marker::Marker::new("da", "A");
        let conn_a = crate::drives::drive_db::create(
            &a,
            &marker_a,
            &luna_core::marker::pick_prefix(&a).unwrap(),
        )
        .unwrap();
        let marker_b = luna_core::marker::Marker::new("db", "B");
        let conn_b = crate::drives::drive_db::create(
            &b,
            &marker_b,
            &luna_core::marker::pick_prefix(&b).unwrap(),
        )
        .unwrap();
        replace_dir(
            &conn_a,
            "da",
            "",
            1,
            &[entry("budget notes.txt", "file", false)],
        )
        .unwrap();
        replace_dir(&conn_b, "db", "", 1, &[entry("budget", "dir", false)]).unwrap();
        drop((conn_a, conn_b));
        let drives = [
            DriveRef {
                id: "da".into(),
                mount: a,
            },
            DriveRef {
                id: "db".into(),
                mount: b,
            },
        ];
        let (got, _) = search_all(&drives, &Query::new("budget"), KindFilter::All).unwrap();
        let order: Vec<(&str, &str)> = got
            .iter()
            .map(|c| (c.hit.drive_id.as_str(), c.hit.name.as_str()))
            .collect();
        assert_eq!(order, [("db", "budget"), ("da", "budget notes.txt")]);
    }

    #[test]
    #[ignore = "benchmark; run with cargo test --release -- --ignored search_benchmark --nocapture"]
    fn search_benchmark_300k_entries() {
        let dir = tempfile::tempdir().unwrap();
        let conn = drive_conn(dir.path());
        let words = [
            "report", "invoice", "holiday", "photos", "budget", "passport", "resume", "lease",
            "taxes", "backup", "project", "notes", "draft", "final", "scan", "receipt",
        ];
        conn.execute_batch("BEGIN").unwrap();
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO index_entries (drive_id, parent, name, kind, size, modified, hidden)
                     VALUES ('d1', ?1, ?2, ?3, 1, 1, 0)",
                )
                .unwrap();
            for d in 0..30_000u32 {
                let parent = format!(
                    "{}/{}/dir {d}",
                    words[(d % 16) as usize],
                    words[((d / 16) % 16) as usize]
                );
                stmt.execute(params![
                    parent,
                    format!("{} folder {d}", words[(d % 7) as usize]),
                    "dir"
                ])
                .unwrap();
                for f in 0..9u32 {
                    let name = format!(
                        "{} {} {d}-{f}.pdf",
                        words[((d + f) % 16) as usize],
                        words[((d * 3 + f) % 16) as usize]
                    );
                    stmt.execute(params![parent, name, "file"]).unwrap();
                }
            }
        }
        conn.execute_batch("COMMIT").unwrap();
        for q in [
            "passport",
            "pasport 2024",
            "invoice holiday",
            "re",
            "zzzzqq",
            "taxes final 77",
        ] {
            let start = std::time::Instant::now();
            let got = search_drive(&conn, "d1", &Query::new(q), KindFilter::All).unwrap();
            println!("{q:>16}: {:>4} hits in {:?}", got.len(), start.elapsed());
        }
    }
}
