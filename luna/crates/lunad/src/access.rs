//! Universal access model: one capability vocabulary for every shareable
//! subject. Members are Luna users holding capabilities on a subject; links
//! are "anyone with this URL" principals. Both ride the same two tables in
//! the central database (`access_members`, `access_links`).
//!
//! Capability bits are ordered by inclusion: FULL covers everything a member
//! can do. Granting is subset-only — a member can hand out any subset of the
//! capabilities they hold on that subject, nothing more.

use rusqlite::Connection;
use std::path::Path;

use crate::db;

/// Capabilities: bitfield. VIEW = open/read/download, UPLOAD = add files,
/// EDIT = rename/delete/move. FULL is everything. RESPOND is link-only:
/// it lets a guest answer a `.lunaform` without seeing the file or other
/// people's answers — never granted to members.
pub type Caps = i64;
pub const CAP_VIEW: Caps = 1;
pub const CAP_UPLOAD: Caps = 2;
pub const CAP_EDIT: Caps = 4;
pub const CAP_RESPOND: Caps = 8;
pub const CAP_ALL: Caps = CAP_VIEW | CAP_UPLOAD | CAP_EDIT;

pub const KIND_PATH: &str = "path";
pub const KIND_ALBUM: &str = "album";

pub fn normalize_subject_kind(kind: &str) -> Option<&'static str> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "path" | "file" | "folder" | "drive" => Some(KIND_PATH),
        "album" => Some(KIND_ALBUM),
        _ => None,
    }
}

/// Stable wire names for capability sets. "view+upload" is both bits;
/// "full" is all three.
pub fn caps_to_str(caps: Caps) -> &'static str {
    match caps {
        CAP_ALL => "full",
        CAP_RESPOND => "respond",
        c if c == CAP_VIEW | CAP_UPLOAD => "view+upload",
        CAP_UPLOAD => "upload",
        0 => "none",
        _ => "view",
    }
}

pub fn caps_from_str(s: &str) -> Option<Caps> {
    match s.trim().to_ascii_lowercase().as_str() {
        "view" => Some(CAP_VIEW),
        "upload" => Some(CAP_UPLOAD),
        "view+upload" | "read_write" | "write" => Some(CAP_VIEW | CAP_UPLOAD),
        "full" | "edit" => Some(CAP_ALL),
        "respond" => Some(CAP_RESPOND),
        _ => None,
    }
}

/// `mine` can grant `want` when want is a subset of mine.
pub fn caps_cover(mine: Caps, want: Caps) -> bool {
    mine & want == want
}

/// A link stops working the moment `expires_at` passes.
pub fn link_expired(link: &db::AccessLinkRow) -> bool {
    link.expires_at.is_some_and(|e| db::now_unix() > e)
}

/// Which capability sets are valid for a subject. Upload alone is only
/// meaningful on a folder (drop box) or album (contribute-only); a single
/// file has nothing to "upload into".
pub fn caps_valid_for(caps: Caps, subject_kind: &str, is_file: bool) -> bool {
    match subject_kind {
        KIND_ALBUM => caps == CAP_VIEW || caps == CAP_UPLOAD || caps == CAP_VIEW | CAP_UPLOAD,
        _ if is_file => caps == CAP_VIEW || caps == CAP_ALL,
        _ => {
            caps == CAP_VIEW
                || caps == CAP_UPLOAD
                || caps == CAP_VIEW | CAP_UPLOAD
                || caps == CAP_ALL
        }
    }
}

/// Links accept the member matrix plus `respond` on `.lunaform` files.
pub fn caps_valid_for_link(caps: Caps, subject_kind: &str, is_file: bool, is_form: bool) -> bool {
    if caps == CAP_RESPOND {
        return subject_kind == KIND_PATH && is_file && is_form;
    }
    caps_valid_for(caps, subject_kind, is_file)
}

/// Normalize a subject path: trim, strip slashes, collapse empties to "".
/// "" means the whole drive (every path is inside it).
pub fn normalize_subject_path(raw: &str) -> String {
    let cleaned = raw.trim().replace('\\', "/");
    let cleaned = cleaned.trim_matches('/');
    if cleaned.is_empty() {
        return String::new();
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        parts.push(part);
    }
    parts.join("/")
}

/// True when `parent` contains `child` ("" contains everything).
pub fn path_contains(parent: &str, child: &str) -> bool {
    if parent.is_empty() {
        return true;
    }
    if parent == child {
        return true;
    }
    child.starts_with(parent) && child.as_bytes().get(parent.len()) == Some(&b'/')
}

fn same_subject(a: &db::AccessMemberRow, b: &db::AccessMemberRow) -> bool {
    a.subject_kind == b.subject_kind
        && a.drive_id == b.drive_id
        && a.path == b.path
        && a.album_id == b.album_id
}

/// Rows the new member row fully covers (same user, inside scope, subset caps).
/// A stronger child row stays — a member keeping more access on a nested
/// folder is a deliberate exception, not a duplicate.
pub fn superseded_member_ids(
    rows: &[db::AccessMemberRow],
    new: &db::AccessMemberRow,
) -> Vec<String> {
    let mut doomed = Vec::new();
    for row in rows {
        if row.user_id != new.user_id || row.subject_kind != new.subject_kind {
            continue;
        }
        if !caps_cover(new.caps, row.caps) {
            continue;
        }
        if same_subject(row, new) {
            doomed.push(row.id.clone());
            continue;
        }
        if new.subject_kind == KIND_PATH
            && row.drive_id == new.drive_id
            && path_contains(&new.path, &row.path)
        {
            doomed.push(row.id.clone());
        }
    }
    doomed
}

/// Insert a member row. Explicit grants on nested subjects survive a wider
/// grant — a member keeping different access on a child folder is a
/// deliberate exception, not a duplicate. Same-subject retunes happen in
/// the API layer (`add_member` updates the row it finds).
pub fn create_member(conn: &Connection, new: &db::AccessMemberRow) -> Result<(), String> {
    db::insert_access_member(conn, new).map_err(|e| e.to_string())
}

/// The path-subject rows a member holds, reduced to access roots: drop rows
/// fully covered by a wider row (parent path, at-least-equal caps).
pub fn member_access_roots(rows: Vec<db::AccessMemberRow>) -> Vec<db::AccessMemberRow> {
    let paths: Vec<&db::AccessMemberRow> = rows
        .iter()
        .filter(|r| r.subject_kind == KIND_PATH)
        .collect();
    let mut out: Vec<db::AccessMemberRow> = Vec::new();
    for row in rows.iter() {
        if row.subject_kind != KIND_PATH {
            out.push(row.clone());
            continue;
        }
        let covered = paths.iter().any(|other| {
            other.id != row.id
                && other.drive_id == row.drive_id
                && path_contains(&other.path, &row.path)
                && caps_cover(other.caps, row.caps)
        });
        if !covered {
            out.push(row.clone());
        }
    }
    out
}

/// The member's effective capabilities on a filesystem path: union of every
/// path row whose scope contains it. Album rows don't apply here.
pub fn member_caps_on_path(rows: &[db::AccessMemberRow], drive_id: &str, path: &str) -> Caps {
    let mut caps: Caps = 0;
    for row in rows {
        if row.subject_kind != KIND_PATH || row.drive_id != drive_id {
            continue;
        }
        if path_contains(&row.path, path) {
            caps |= row.caps;
        }
    }
    caps
}

/// The member's capabilities on one album.
pub fn member_caps_on_album(
    rows: &[db::AccessMemberRow],
    home_drive_id: &str,
    album_id: &str,
) -> Caps {
    let mut caps: Caps = 0;
    for row in rows {
        if row.subject_kind == KIND_ALBUM
            && row.drive_id == home_drive_id
            && row.album_id == album_id
        {
            caps |= row.caps;
        }
    }
    caps
}

/// Ids of albums (on `home_drive_id`) the member has any capabilities on.
pub fn member_album_ids(rows: &[db::AccessMemberRow], home_drive_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = rows
        .iter()
        .filter(|r| r.subject_kind == KIND_ALBUM && r.drive_id == home_drive_id)
        .map(|r| r.album_id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Album members let a user view photos through the album even without a
/// filesystem grant — the album itself is the access. True when the user
/// holds view caps on an album that contains `(drive_id, path)` as an item,
/// or whose contribution folder holds it. The closure decides membership so
/// the caller can resolve each album's home drive (items may live on any
/// mounted drive).
pub fn path_visible_via_album<F>(
    conn: &Connection,
    user_id: &str,
    _drive_id: &str,
    _path: &str,
    album_contains: F,
) -> bool
where
    F: Fn(&str, &str) -> bool, // (home_drive_id, album_id) -> contains?
{
    let Ok(rows) = db::list_access_members_for_user(conn, user_id) else {
        return false;
    };
    for row in rows {
        if row.subject_kind != KIND_ALBUM || row.caps & CAP_VIEW == 0 {
            continue;
        }
        if album_contains(&row.drive_id, &row.album_id) {
            return true;
        }
    }
    false
}

/// Sanitize a subject path for storage; rejects `..` escapes.
pub fn clean_subject_path(raw: &str) -> Option<String> {
    let norm = normalize_subject_path(raw);
    if Path::new(&norm)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(norm)
}

/// Path-subject tables sharing the same shape (id, subject_kind, drive_id,
/// path). Album rows live in the same tables but are never touched here —
/// subjects follow files, not albums.
const SUBJECT_TABLES: [&str; 2] = ["access_members", "access_links"];

/// Retarget path-subject rows after a rename or move inside one drive: rows
/// on `old_path` and on anything under it keep their suffix beneath
/// `new_path`. An empty `old_path` means the whole drive — drive renames are
/// not path operations, so nothing moves. Returns the number of rows moved.
pub fn repath_subjects(
    conn: &Connection,
    drive_id: &str,
    old_path: &str,
    new_path: &str,
) -> anyhow::Result<usize> {
    repath_subjects_move(conn, drive_id, old_path, drive_id, new_path)
}

/// `repath_subjects` across drives — a cross-device move carries its shares
/// to `(new_drive, new_path)`.
pub fn repath_subjects_move(
    conn: &Connection,
    old_drive: &str,
    old_path: &str,
    new_drive: &str,
    new_path: &str,
) -> anyhow::Result<usize> {
    let old_path = normalize_subject_path(old_path);
    let new_path = normalize_subject_path(new_path);
    if old_path.is_empty() {
        return Ok(0);
    }
    let mut moved = 0usize;
    for table in SUBJECT_TABLES {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, path FROM {table} WHERE subject_kind = ?1 AND drive_id = ?2"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![KIND_PATH, old_drive], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, path) in rows {
            if !path_contains(&old_path, &path) {
                continue;
            }
            let suffix = &path[old_path.len()..];
            let retargeted = format!("{new_path}{suffix}");
            conn.execute(
                &format!("UPDATE {table} SET drive_id = ?1, path = ?2 WHERE id = ?3"),
                rusqlite::params![new_drive, retargeted, id],
            )?;
            moved += 1;
        }
    }
    Ok(moved)
}

/// Revoke every path-subject grant at or under `path` — the subject went to
/// trash, so its shares die with it. Grants on parent folders stay; album
/// rows are never matched. Returns the number of rows deleted.
pub fn drop_subjects_under(conn: &Connection, drive_id: &str, path: &str) -> anyhow::Result<usize> {
    let path = normalize_subject_path(path);
    if path.is_empty() {
        return Ok(0);
    }
    let mut dropped = 0usize;
    for table in SUBJECT_TABLES {
        let mut stmt = conn.prepare(&format!(
            "SELECT id, path FROM {table} WHERE subject_kind = ?1 AND drive_id = ?2"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params![KIND_PATH, drive_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, row_path) in rows {
            if !path_contains(&path, &row_path) {
                continue;
            }
            conn.execute(
                &format!("DELETE FROM {table} WHERE id = ?1"),
                rusqlite::params![id],
            )?;
            dropped += 1;
        }
    }
    Ok(dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_roundtrip() {
        for (s, c) in [
            ("view", CAP_VIEW),
            ("upload", CAP_UPLOAD),
            ("view+upload", CAP_VIEW | CAP_UPLOAD),
            ("full", CAP_ALL),
        ] {
            assert_eq!(caps_from_str(s), Some(c));
            assert_eq!(caps_from_str(caps_to_str(c)), Some(c));
        }
        assert_eq!(caps_from_str("nonsense"), None);
    }

    #[test]
    fn covering() {
        assert!(caps_cover(CAP_ALL, CAP_VIEW));
        assert!(caps_cover(CAP_ALL, CAP_ALL));
        assert!(caps_cover(CAP_VIEW | CAP_UPLOAD, CAP_UPLOAD));
        assert!(!caps_cover(CAP_VIEW, CAP_UPLOAD));
        assert!(!caps_cover(CAP_VIEW | CAP_UPLOAD, CAP_ALL));
    }

    #[test]
    fn validity_matrix() {
        // files: no upload-only, no view+upload (upload alone meaningless)
        assert!(caps_valid_for(CAP_VIEW, KIND_PATH, true));
        assert!(caps_valid_for(CAP_ALL, KIND_PATH, true));
        assert!(!caps_valid_for(CAP_UPLOAD, KIND_PATH, true));
        assert!(!caps_valid_for(CAP_VIEW | CAP_UPLOAD, KIND_PATH, true));
        // folders/drives: everything
        for c in [CAP_VIEW, CAP_UPLOAD, CAP_VIEW | CAP_UPLOAD, CAP_ALL] {
            assert!(caps_valid_for(c, KIND_PATH, false));
        }
        // albums: no edit bit
        assert!(caps_valid_for(CAP_VIEW, KIND_ALBUM, false));
        assert!(caps_valid_for(CAP_UPLOAD, KIND_ALBUM, false));
        assert!(caps_valid_for(CAP_VIEW | CAP_UPLOAD, KIND_ALBUM, false));
        assert!(!caps_valid_for(CAP_ALL, KIND_ALBUM, false));
        assert!(!caps_valid_for(CAP_EDIT, KIND_ALBUM, false));
        assert!(!caps_valid_for(CAP_EDIT, KIND_PATH, false));
        assert!(!caps_valid_for(0, KIND_PATH, false));
    }

    #[test]
    fn paths() {
        assert_eq!(normalize_subject_path("/a//b/"), "a/b");
        assert_eq!(normalize_subject_path(""), "");
        assert!(path_contains("", "anything"));
        assert!(path_contains("a", "a/b"));
        assert!(!path_contains("a", "ab"));
        assert_eq!(clean_subject_path("../escape"), None);
        assert_eq!(clean_subject_path("a/../b"), None);
    }

    #[test]
    fn supersede_rules() {
        let mk = |id: &str, path: &str, caps: Caps| db::AccessMemberRow {
            id: id.into(),
            subject_kind: KIND_PATH.into(),
            drive_id: "d".into(),
            path: path.into(),
            album_id: String::new(),
            user_id: "u".into(),
            caps,
            created_by: "a".into(),
        };
        let rows = vec![
            mk("old-same", "a", CAP_VIEW),
            mk("child-write", "a/b", CAP_ALL),
        ];
        // equal-caps same-path row is replaced; the stronger child stays
        let new = mk("new", "a", CAP_VIEW);
        assert_eq!(superseded_member_ids(&rows, &new), vec!["old-same"]);
        // a parent widened to full access covers the child too — both go
        let new = mk("new", "a", CAP_ALL);
        let doomed = superseded_member_ids(&rows, &new);
        assert!(doomed.contains(&"old-same".to_string()));
        assert!(doomed.contains(&"child-write".to_string()));
    }

    fn member(id: &str, path: &str, caps: Caps) -> db::AccessMemberRow {
        db::AccessMemberRow {
            id: id.into(),
            subject_kind: KIND_PATH.into(),
            drive_id: "d".into(),
            path: path.into(),
            album_id: String::new(),
            user_id: "u".into(),
            caps,
            created_by: "a".into(),
        }
    }

    #[test]
    fn create_member_preserves_explicit_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        create_member(&conn, &member("child", "a/b", CAP_ALL)).unwrap();
        create_member(&conn, &member("root", "a", CAP_ALL)).unwrap();
        let rows = db::list_access_members_for_user(&conn, "u").unwrap();
        assert_eq!(rows.len(), 2);

        // Narrowing the root grant leaves the explicit child untouched.
        db::update_access_member_caps(&conn, "root", CAP_VIEW).unwrap();
        let rows = db::list_access_members_for_user(&conn, "u").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(member_caps_on_path(&rows, "d", "a/b"), CAP_ALL);

        // Removing the root leaves the child grant standing on its own.
        db::delete_access_member(&conn, "root").unwrap();
        let rows = db::list_access_members_for_user(&conn, "u").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "a/b");
        assert_eq!(member_caps_on_path(&rows, "d", "a/b"), CAP_ALL);
        assert_eq!(member_caps_on_path(&rows, "d", "a/c"), 0);
    }

    fn member_row(id: &str, drive: &str, path: &str) -> db::AccessMemberRow {
        db::AccessMemberRow {
            id: id.into(),
            subject_kind: KIND_PATH.into(),
            drive_id: drive.into(),
            path: path.into(),
            album_id: String::new(),
            user_id: "u".into(),
            caps: CAP_VIEW,
            created_by: "a".into(),
        }
    }

    fn link_row(id: &str, drive: &str, path: &str) -> db::AccessLinkRow {
        db::AccessLinkRow {
            id: id.into(),
            token_hash: format!("h-{id}"),
            token: String::new(),
            subject_kind: KIND_PATH.into(),
            drive_id: drive.into(),
            path: path.into(),
            album_id: String::new(),
            caps: CAP_VIEW,
            password_hash: String::new(),
            expires_at: None,
            created_by: "a".into(),
            created_at: 0,
        }
    }

    fn album_member(id: &str) -> db::AccessMemberRow {
        let mut row = member_row(id, "d", "");
        row.subject_kind = KIND_ALBUM.into();
        row.album_id = "alb1".into();
        row
    }

    fn album_link(id: &str) -> db::AccessLinkRow {
        let mut row = link_row(id, "d", "");
        row.subject_kind = KIND_ALBUM.into();
        row.album_id = "alb1".into();
        row
    }

    #[test]
    fn repath_moves_member_and_link_rows_with_the_subject() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        db::insert_access_member(&conn, &member_row("m1", "d", "family")).unwrap();
        db::insert_access_member(&conn, &member_row("m2", "d", "family/kids")).unwrap();
        db::insert_access_link(&conn, &link_row("l1", "d", "family/kids")).unwrap();
        db::insert_access_member(&conn, &member_row("m3", "d", "family2")).unwrap();
        db::insert_access_member(&conn, &member_row("m4", "d", "")).unwrap();
        db::insert_access_member(&conn, &album_member("am")).unwrap();
        db::insert_access_link(&conn, &album_link("al")).unwrap();

        let moved = repath_subjects(&conn, "d", "family", "kin").unwrap();
        assert_eq!(moved, 3);

        let paths = |id: &str| db::get_access_member(&conn, id).unwrap().unwrap().path;
        assert_eq!(paths("m1"), "kin");
        assert_eq!(paths("m2"), "kin/kids");
        // Prefix lookalikes and wider grants are untouched.
        assert_eq!(paths("m3"), "family2");
        assert_eq!(paths("m4"), "");
        let link = db::get_access_link(&conn, "l1").unwrap().unwrap();
        assert_eq!(link.path, "kin/kids");
        // Album rows never move.
        let alb_m = db::get_access_member(&conn, "am").unwrap().unwrap();
        assert_eq!(alb_m.subject_kind, KIND_ALBUM);
        let alb_l = db::get_access_link(&conn, "al").unwrap().unwrap();
        assert_eq!(alb_l.subject_kind, KIND_ALBUM);
    }

    #[test]
    fn repath_move_retargets_across_drives() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        db::insert_access_member(&conn, &member_row("m1", "a", "docs")).unwrap();
        db::insert_access_link(&conn, &link_row("l1", "a", "docs/plan.drawio")).unwrap();

        let moved = repath_subjects_move(&conn, "a", "docs", "b", "inbox/docs").unwrap();
        assert_eq!(moved, 2);
        let m = db::get_access_member(&conn, "m1").unwrap().unwrap();
        assert_eq!((m.drive_id.as_str(), m.path.as_str()), ("b", "inbox/docs"));
        let l = db::get_access_link(&conn, "l1").unwrap().unwrap();
        assert_eq!(
            (l.drive_id.as_str(), l.path.as_str()),
            ("b", "inbox/docs/plan.drawio")
        );

        // A whole-drive subject isn't a path op — nothing moves.
        assert_eq!(repath_subjects_move(&conn, "a", "", "b", "x").unwrap(), 0);
    }

    #[test]
    fn drop_subjects_under_revokes_only_the_trashed_tree() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        db::insert_access_member(&conn, &member_row("m1", "d", "family/kids")).unwrap();
        db::insert_access_member(&conn, &member_row("m2", "d", "family")).unwrap();
        db::insert_access_link(&conn, &link_row("l1", "d", "family/kids")).unwrap();
        db::insert_access_member(&conn, &album_member("am")).unwrap();
        db::insert_access_link(&conn, &album_link("al")).unwrap();

        // Trashing the child drops its rows; the parent's stays.
        let dropped = drop_subjects_under(&conn, "d", "family/kids").unwrap();
        assert_eq!(dropped, 2);
        assert!(db::get_access_member(&conn, "m1").unwrap().is_none());
        assert!(db::get_access_link(&conn, "l1").unwrap().is_none());
        assert!(db::get_access_member(&conn, "m2").unwrap().is_some());
        assert!(db::get_access_member(&conn, "am").unwrap().is_some());
        assert!(db::get_access_link(&conn, "al").unwrap().is_some());
    }
}
