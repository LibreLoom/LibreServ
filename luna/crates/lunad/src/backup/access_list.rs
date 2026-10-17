//! Who may see a backup: the access list saved with it (plan §2).
//!
//! A backup's visibility never follows the live source. Each successful run
//! (and each grant change while the source is healthy) saves this list into
//! the backup itself; once the source is gone it is frozen.

use std::collections::{BTreeSet, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::access::{CAP_VIEW, KIND_PATH};
use crate::db;

/// The people who may see one backup.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AccessList {
    /// User ids whose Read covers the source root. Sorted, no duplicates.
    pub users: Vec<String>,
    /// The standing Admins entry: a role, not a frozen set of people. True
    /// for every shared backup, false for a private item's backup.
    pub admins: bool,
}

impl AccessList {
    /// Does this list let `user_id` see the backup?
    pub fn allows(&self, user_id: &str, is_admin: bool) -> bool {
        (self.admins && is_admin) || self.users.iter().any(|u| u == user_id)
    }
}

/// The access list for a shared backup of `source_path` on `drive_id`:
/// users whose Read (`CAP_VIEW`) covers the source root through a member
/// grant on the root or an ancestor, plus the Admins entry.
pub fn for_source(conn: &Connection, drive_id: &str, source_path: &str) -> anyhow::Result<AccessList> {
    let source = crate::access::normalize_subject_path(source_path);
    // Admins are covered by the `admins` flag, so they stay out of `users`.
    // Only accounts that still exist count, so a deleted user's leftover
    // grant never lands on the list.
    let people: HashSet<String> = db::list_users(conn)?
        .into_iter()
        .filter(|u| u.role != "admin")
        .map(|u| u.id)
        .collect();

    let mut users = BTreeSet::new();
    for row in db::list_all_access_members(conn)? {
        if row.subject_kind != KIND_PATH || row.drive_id != drive_id {
            continue;
        }
        // Upload-only drop boxes and respond-only grants cannot read the source.
        if row.caps & CAP_VIEW == 0 {
            continue;
        }
        // A grant on a sub-path inside the source does not cover its root.
        let grant = crate::access::normalize_subject_path(&row.path);
        if !crate::access::path_contains(&grant, &source) {
            continue;
        }
        if people.contains(&row.user_id) {
            users.insert(row.user_id);
        }
    }

    Ok(AccessList {
        users: users.into_iter().collect(),
        admins: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{CAP_ALL, CAP_UPLOAD, CAP_VIEW, KIND_ALBUM};

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        for (id, role) in [
            ("u-ann", "member"),
            ("u-bob", "member"),
            ("u-cat", "member"),
            ("u-root", "admin"),
        ] {
            db::insert_user(&conn, id, id, id, "", role).unwrap();
        }
        (dir, conn)
    }

    fn grant(conn: &Connection, id: &str, drive: &str, kind: &str, path: &str, user: &str, caps: i64) {
        let album = if kind == KIND_ALBUM { "alb1" } else { "" };
        db::insert_access_member(
            conn,
            &db::AccessMemberRow {
                id: id.into(),
                subject_kind: kind.into(),
                drive_id: drive.into(),
                path: path.into(),
                album_id: album.into(),
                user_id: user.into(),
                caps,
                created_by: "u-root".into(),
            },
        )
        .unwrap();
    }

    fn users_for(conn: &Connection, drive: &str, source: &str) -> Vec<String> {
        let list = for_source(conn, drive, source).unwrap();
        assert!(list.admins, "shared backups always carry the Admins entry");
        list.users
    }

    #[test]
    fn root_grant_covers_the_source() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "", "u-ann", CAP_VIEW);
        assert_eq!(users_for(&conn, "d", "Photos/2024"), vec!["u-ann"]);
    }

    #[test]
    fn ancestor_grant_covers_the_source() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "Photos", "u-bob", CAP_VIEW);
        assert_eq!(users_for(&conn, "d", "Photos/2024/trip"), vec!["u-bob"]);
    }

    #[test]
    fn exact_grant_covers_the_source() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "Photos/2024", "u-cat", CAP_ALL);
        assert_eq!(users_for(&conn, "d", "Photos/2024"), vec!["u-cat"]);
    }

    #[test]
    fn sub_path_only_grant_is_excluded() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "Photos/2024/trip", "u-ann", CAP_VIEW);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn upload_only_grant_is_excluded() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "", "u-bob", CAP_UPLOAD);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn other_drive_grant_is_excluded() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d2", KIND_PATH, "", "u-cat", CAP_VIEW);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn album_grant_is_excluded() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_ALBUM, "", "u-ann", CAP_VIEW);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn deleted_user_grant_is_excluded() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "", "u-gone", CAP_VIEW);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn admin_grant_stays_out_of_users() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "", "u-root", CAP_VIEW);
        assert!(users_for(&conn, "d", "Photos").is_empty());
    }

    #[test]
    fn non_canonical_grant_spelling_still_covers() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "/Photos//", "u-cat", CAP_VIEW);
        assert_eq!(users_for(&conn, "d", "/Photos/x/"), vec!["u-cat"]);
    }

    #[test]
    fn users_are_sorted_and_deduped() {
        let (_dir, conn) = setup();
        grant(&conn, "g1", "d", KIND_PATH, "", "u-cat", CAP_VIEW);
        grant(&conn, "g2", "d", KIND_PATH, "", "u-ann", CAP_VIEW);
        grant(&conn, "g3", "d", KIND_PATH, "Photos", "u-ann", CAP_ALL);
        grant(&conn, "g4", "d", KIND_PATH, "Photos/2024", "u-ann", CAP_VIEW);
        grant(&conn, "g5", "d", KIND_PATH, "", "u-bob", CAP_VIEW);
        assert_eq!(
            users_for(&conn, "d", "Photos/2024"),
            vec!["u-ann", "u-bob", "u-cat"]
        );
    }

    #[test]
    fn allows_admin_member_and_stranger() {
        let list = AccessList {
            users: vec!["u-ann".into()],
            admins: true,
        };
        assert!(list.allows("u-root", true), "admin via the Admins entry");
        assert!(list.allows("u-ann", false), "member on the list");
        assert!(!list.allows("u-bob", false), "stranger");
        assert!(!list.allows("u-root", false), "admin role alone is not enough");
        assert!(list.allows("u-bob", true), "any admin is let in by the entry");
    }

    #[test]
    fn allows_ignores_admin_entry_when_disabled() {
        let list = AccessList {
            users: vec!["u-ann".into()],
            admins: false,
        };
        assert!(!list.allows("u-root", true), "private backup: no Admins entry");
        assert!(list.allows("u-ann", false));
    }
}
