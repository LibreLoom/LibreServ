//! File search over the per-drive index.
//!
//! Each drive's `.luna-<uuid>.sqlite3` holds an FTS5 trigram table beside
//! `index_entries`. A search runs in two steps per drive, all drives in
//! parallel:
//!
//! 1. Exact: every word of the query appears in the name.
//! 2. Close: only when step 1 found few names, look for names sharing
//!    3-letter pieces with the query and keep the ones within a typo or two.
//!
//! Candidates are ranked by [`search_rank`](crate::files::search_rank); the
//! caller applies access checks in rank order, so the result limit counts
//! only what the person can actually see.

use std::collections::HashSet;
use std::path::PathBuf;

use rusqlite::{Connection, params};

use crate::files::search_rank::{self, Query, Rank};

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
}

/// Fewer exact matches than this on a drive and the close-match step runs.
const CLOSE_BELOW: usize = 20;
/// Most rows the index returns to the ranker per step.
const CANDIDATE_LIMIT: i64 = 1500;
/// Most ranked candidates kept per drive.
const PER_DRIVE: usize = 300;

/// Search every drive at once; candidates come back best first.
pub fn search_all(drives: &[DriveRef], query: &Query, kind: KindFilter) -> Vec<Candidate> {
    let mut all: Vec<Candidate> = std::thread::scope(|scope| {
        let handles: Vec<_> = drives
            .iter()
            .map(|drive| {
                scope.spawn(move || {
                    let conn = match crate::drives::drive_db::open(&drive.mount) {
                        Ok(conn) => conn,
                        Err(e) => {
                            tracing::warn!(drive = %drive.id, error = %e, "search skipped a drive");
                            return Vec::new();
                        }
                    };
                    search_drive(&conn, &drive.id, query, kind).unwrap_or_else(|e| {
                        tracing::warn!(drive = %drive.id, error = %e, "search failed on a drive");
                        Vec::new()
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    sort_candidates(&mut all);
    all
}

fn sort_candidates(all: &mut [Candidate]) {
    all.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.hit.name.to_lowercase().cmp(&b.hit.name.to_lowercase()))
            .then_with(|| a.hit.parent.cmp(&b.hit.parent))
            .then_with(|| a.hit.drive_id.cmp(&b.hit.drive_id))
    });
}

/// Search one drive's index. Hidden entries are never returned.
pub fn search_drive(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
) -> anyhow::Result<Vec<Candidate>> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut out: Vec<Candidate> = Vec::new();

    let mut take = |rows: Vec<SearchHit>, out: &mut Vec<Candidate>| {
        for hit in rows {
            if !seen.insert((hit.parent.clone(), hit.name.clone())) {
                continue;
            }
            if let Some(rank) = search_rank::rank(query, &hit.name, hit.kind == "dir") {
                out.push(Candidate { hit, rank });
            }
        }
    };

    let exact_rows = match search_rank::fts_match(query, true) {
        Some(m) => fts_rows(conn, drive_id, &m, kind)?,
        // Every word is under 3 letters, which the index can't look up:
        // fall back to names that start with what was typed.
        None => prefix_rows(conn, drive_id, query, kind)?,
    };
    let saturated = exact_rows.len() as i64 >= CANDIDATE_LIMIT;
    take(exact_rows, &mut out);
    if saturated {
        // A common query can fill the limit with weaker matches; names that
        // start with what was typed must still make it to the ranker.
        take(prefix_rows(conn, drive_id, query, kind)?, &mut out);
    }

    if out.len() < CLOSE_BELOW
        && let Some(m) = search_rank::fts_match(query, false)
    {
        take(fts_rows(conn, drive_id, &m, kind)?, &mut out);
    }

    out.sort_by(|a, b| a.rank.cmp(&b.rank));
    out.truncate(PER_DRIVE);
    Ok(out)
}

fn fts_rows(
    conn: &Connection,
    drive_id: &str,
    match_expr: &str,
    kind: KindFilter,
) -> anyhow::Result<Vec<SearchHit>> {
    let sql = format!(
        "SELECT index_entries.parent, index_entries.name, index_entries.kind,
                index_entries.size, index_entries.modified
         FROM index_fts
         JOIN index_entries ON index_entries.rowid = index_fts.rowid
         WHERE index_fts MATCH ?1
           AND index_entries.hidden = 0
           AND index_entries.drive_id = ?2
           {}
         ORDER BY bm25(index_fts)
         LIMIT ?3",
        kind.clause()
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(params![match_expr, drive_id, CANDIDATE_LIMIT], |row| {
            row_hit(drive_id, row)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn prefix_rows(
    conn: &Connection,
    drive_id: &str,
    query: &Query,
    kind: KindFilter,
) -> anyhow::Result<Vec<SearchHit>> {
    let escaped = query
        .norm
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("{escaped}%");
    let sql = format!(
        "SELECT parent, name, kind, size, modified
         FROM index_entries
         WHERE hidden = 0 AND drive_id = ?2 AND name LIKE ?1 ESCAPE '\\'
           {}
         ORDER BY name COLLATE NOCASE
         LIMIT ?3",
        kind.clause().replace("index_entries.", "")
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt
        .query_map(params![pattern, drive_id, CANDIDATE_LIMIT], |row| {
            row_hit(drive_id, row)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_hit(drive_id: &str, row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchHit> {
    Ok(SearchHit {
        drive_id: drive_id.to_string(),
        parent: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        size: row.get(3)?,
        modified: row.get(4)?,
    })
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
        let got = search_all(&drives, &Query::new("budget"), KindFilter::All);
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
