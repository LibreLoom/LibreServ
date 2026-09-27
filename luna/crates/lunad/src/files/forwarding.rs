//! Forwarding addresses for moved and renamed files.
//!
//! In-app links name a file by path (`/drives/<id>?path=…&file=…`), so a
//! move or rename would strand every bookmark, recent and copied URL that
//! pointed at it. Every move Luna performs already funnels through
//! `access::repath_subjects_move` (API rename/move, move jobs, WebDAV,
//! member-home renames); that function records `old → new` here, and the
//! resolve endpoint follows the trail when a link lands on a missing path.
//!
//! Rules:
//! - A real file at a path always wins: resolution is only asked for paths
//!   that no longer exist, and it stops at the first hop that does.
//! - A folder move forwards everything under it (longest prefix wins).
//! - Trash is not a destination: trashing a file ends its trail.
//! - Entries expire after [`FORWARD_TTL_SECS`] so the table stays small.

use rusqlite::{Connection, OptionalExtension, params};

use crate::access::normalize_subject_path;

/// How long a forwarding address is kept.
pub const FORWARD_TTL_SECS: i64 = 365 * 24 * 60 * 60;

/// Hops followed before giving up (guards against cycles like A→B→A).
const MAX_HOPS: usize = 16;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS path_moves (
            drive_id TEXT NOT NULL,
            old_path TEXT NOT NULL,
            new_drive TEXT NOT NULL,
            new_path TEXT NOT NULL,
            moved_at INTEGER NOT NULL,
            PRIMARY KEY (drive_id, old_path)
        );",
    )
}

fn is_trash(path: &str) -> bool {
    let alias = super::TRASH_API_ALIAS;
    path == alias || path.starts_with(&format!("{alias}/"))
}

/// Remember that `(old_drive, old_path)` now lives at `(new_drive, new_path)`.
/// Moves into or out of trash are not forwarded. A later move away from the
/// same path replaces the earlier entry.
pub fn record(
    conn: &Connection,
    old_drive: &str,
    old_path: &str,
    new_drive: &str,
    new_path: &str,
) -> anyhow::Result<()> {
    let old_path = normalize_subject_path(old_path);
    let new_path = normalize_subject_path(new_path);
    if old_path.is_empty()
        || new_path.is_empty()
        || is_trash(&old_path)
        || is_trash(&new_path)
        || (old_drive == new_drive && old_path == new_path)
    {
        return Ok(());
    }
    let now = crate::db::now_unix();
    conn.execute(
        "INSERT INTO path_moves (drive_id, old_path, new_drive, new_path, moved_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(drive_id, old_path) DO UPDATE SET
            new_drive = excluded.new_drive,
            new_path = excluded.new_path,
            moved_at = excluded.moved_at",
        params![old_drive, old_path, new_drive, new_path, now],
    )?;
    conn.execute(
        "DELETE FROM path_moves WHERE moved_at < ?1",
        params![now - FORWARD_TTL_SECS],
    )?;
    Ok(())
}

/// One hop: the newest forwarding entry covering `path` (the path itself or
/// its closest moved ancestor), with the remainder carried over.
fn next_hop(
    conn: &Connection,
    drive_id: &str,
    path: &str,
) -> anyhow::Result<Option<(String, String)>> {
    let row = conn
        .query_row(
            "SELECT old_path, new_drive, new_path FROM path_moves
             WHERE drive_id = ?1
               AND (old_path = ?2 OR substr(?2, 1, length(old_path) + 1) = old_path || '/')
             ORDER BY length(old_path) DESC
             LIMIT 1",
            params![drive_id, path],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(old, new_drive, new_path)| {
        let suffix = &path[old.len()..];
        (new_drive, format!("{new_path}{suffix}"))
    }))
}

/// Follow the trail from a missing `(drive_id, path)` to the first hop where
/// `exists` says something is really there. `None` when there is no trail,
/// it ends somewhere empty (trashed, deleted, drive gone) or it loops.
pub fn resolve(
    conn: &Connection,
    drive_id: &str,
    path: &str,
    mut exists: impl FnMut(&str, &str) -> bool,
) -> anyhow::Result<Option<(String, String)>> {
    let mut drive = drive_id.to_string();
    let mut path = normalize_subject_path(path);
    if path.is_empty() {
        return Ok(None);
    }
    let mut seen = std::collections::HashSet::new();
    seen.insert((drive.clone(), path.clone()));
    for _ in 0..MAX_HOPS {
        let Some((next_drive, next_path)) = next_hop(conn, &drive, &path)? else {
            return Ok(None);
        };
        if !seen.insert((next_drive.clone(), next_path.clone())) {
            return Ok(None);
        }
        if exists(&next_drive, &next_path) {
            return Ok(Some((next_drive, next_path)));
        }
        drive = next_drive;
        path = next_path;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    fn at<'a>(live: &'a [(&'a str, &'a str)]) -> impl FnMut(&str, &str) -> bool + 'a {
        move |d, p| live.iter().any(|(ld, lp)| *ld == d && *lp == p)
    }

    #[test]
    fn a_renamed_file_forwards_to_its_new_name() {
        let c = conn();
        record(&c, "d", "docs/report.pdf", "d", "docs/final.pdf").unwrap();
        let hit = resolve(&c, "d", "docs/report.pdf", at(&[("d", "docs/final.pdf")])).unwrap();
        assert_eq!(hit, Some(("d".into(), "docs/final.pdf".into())));
    }

    #[test]
    fn a_moved_folder_forwards_everything_under_it() {
        let c = conn();
        record(&c, "d", "Taxes", "d", "Archive/Taxes").unwrap();
        let hit = resolve(
            &c,
            "d",
            "Taxes/2024/w2.pdf",
            at(&[("d", "Archive/Taxes/2024/w2.pdf")]),
        )
        .unwrap();
        assert_eq!(hit, Some(("d".into(), "Archive/Taxes/2024/w2.pdf".into())));
        // A sibling that merely shares the prefix is not forwarded.
        assert_eq!(resolve(&c, "d", "Taxes2/x", at(&[])).unwrap(), None);
    }

    #[test]
    fn chains_follow_across_drives() {
        let c = conn();
        record(&c, "a", "x.txt", "a", "y.txt").unwrap();
        record(&c, "a", "y.txt", "b", "inbox/y.txt").unwrap();
        let hit = resolve(&c, "a", "x.txt", at(&[("b", "inbox/y.txt")])).unwrap();
        assert_eq!(hit, Some(("b".into(), "inbox/y.txt".into())));
    }

    #[test]
    fn the_closest_moved_ancestor_wins() {
        let c = conn();
        record(&c, "d", "a", "d", "moved-a").unwrap();
        record(&c, "d", "a/b", "d", "moved-b").unwrap();
        let hit = resolve(&c, "d", "a/b/c.txt", at(&[("d", "moved-b/c.txt")])).unwrap();
        assert_eq!(hit, Some(("d".into(), "moved-b/c.txt".into())));
    }

    #[test]
    fn a_trail_that_ends_nowhere_or_loops_resolves_to_nothing() {
        let c = conn();
        record(&c, "d", "p", "d", "q").unwrap();
        assert_eq!(resolve(&c, "d", "p", at(&[])).unwrap(), None);
        record(&c, "d", "q", "d", "p").unwrap();
        assert_eq!(resolve(&c, "d", "p", at(&[])).unwrap(), None);
    }

    #[test]
    fn trash_is_not_a_forwarding_address() {
        let c = conn();
        record(&c, "d", "a.txt", "d", ".luna-trash/a.txt").unwrap();
        record(&c, "d", ".luna-trash/b.txt", "d", "b.txt").unwrap();
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM path_moves", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn the_latest_move_from_a_path_wins() {
        let c = conn();
        record(&c, "d", "a", "d", "b").unwrap();
        record(&c, "d", "a", "d", "c").unwrap();
        let hit = resolve(&c, "d", "a", at(&[("d", "b"), ("d", "c")])).unwrap();
        assert_eq!(hit, Some(("d".into(), "c".into())));
    }

    #[test]
    fn old_entries_expire() {
        let c = conn();
        c.execute(
            "INSERT INTO path_moves VALUES ('d', 'old', 'd', 'new', ?1)",
            params![crate::db::now_unix() - FORWARD_TTL_SECS - 10],
        )
        .unwrap();
        record(&c, "d", "x", "d", "y").unwrap();
        assert_eq!(resolve(&c, "d", "old", at(&[("d", "new")])).unwrap(), None);
    }
}
