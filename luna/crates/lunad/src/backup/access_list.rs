//! Who may see a backup: the access list saved with it (plan §2).
//!
//! A backup's visibility never follows the live source. Each successful run
//! (and each grant change while the source is healthy) saves this list into
//! the backup itself; once the source is gone it is frozen.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

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
pub fn for_source(
    conn: &Connection,
    drive_id: &str,
    source_path: &str,
) -> anyhow::Result<AccessList> {
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

/// Where a folder sits relative to private items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrivateSource {
    /// Not private and not inside a private item.
    Shared,
    /// The folder is itself a private item owned by `owner`.
    OwnItem { owner: String },
    /// The folder is inside a private item (or is private trash).
    Inside,
}

/// Classify `path` on `drive_id` against the private items on that drive.
pub fn private_source(conn: &Connection, drive_id: &str, path: &str) -> PrivateSource {
    let norm = crate::access::normalize_subject_path(path);
    let mount = match db::get_drive(conn, drive_id) {
        Ok(Some(d)) if !d.mount_point.is_empty() => d.mount_point,
        _ => return PrivateSource::Shared,
    };
    let root = Path::new(&mount);
    // Same translation as `auth::private_boundary`, so both agree on paths.
    let real = crate::files::real_rel(root, &norm).into_owned();
    if let Some(b) = crate::private::boundary_for(root, &real) {
        return if b.path == real {
            PrivateSource::OwnItem { owner: b.owner }
        } else {
            PrivateSource::Inside
        };
    }
    if crate::files::is_trash_api(&norm)
        && matches!(
            crate::files::trash_private_meta(conn, drive_id, &real),
            Ok(Some(_))
        )
    {
        return PrivateSource::Inside;
    }
    PrivateSource::Shared
}

/// The access list for a private item at `path` on `drive_id`: the owner,
/// plus anyone whose Read (`CAP_VIEW`) is a member grant on the item itself.
/// Grants on ancestors or inside the item do not count. Never has Admins.
pub fn for_private(
    conn: &Connection,
    drive_id: &str,
    path: &str,
    owner: &str,
) -> anyhow::Result<AccessList> {
    let item = crate::access::normalize_subject_path(path);
    let people: HashSet<String> = db::list_users(conn)?.into_iter().map(|u| u.id).collect();

    let mut users = BTreeSet::new();
    users.insert(owner.to_string());
    for row in db::list_all_access_members(conn)? {
        if row.subject_kind != KIND_PATH || row.drive_id != drive_id {
            continue;
        }
        if row.caps & CAP_VIEW == 0 {
            continue;
        }
        if crate::access::normalize_subject_path(&row.path) != item {
            continue;
        }
        if people.contains(&row.user_id) {
            users.insert(row.user_id);
        }
    }

    Ok(AccessList {
        users: users.into_iter().collect(),
        admins: false,
    })
}

/// The access list a saved backup should carry now.
pub fn for_row(conn: &Connection, row: &db::ProtectionRow) -> anyhow::Result<AccessList> {
    if row.private_owner.is_empty() {
        return for_source(conn, &row.source_drive, &row.source_path);
    }
    if row.kind == "cloud" {
        return Ok(AccessList {
            users: vec![row.private_owner.clone()],
            admins: false,
        });
    }
    for_private(
        conn,
        &row.source_drive,
        &row.source_path,
        &row.private_owner,
    )
}

/// Why a private row must stop now, or None. Used by drive and cloud repath
/// checks. A drive that is not mounted gives no decision.
pub fn private_stop_reason(conn: &Connection, row: &db::ProtectionRow) -> Option<&'static str> {
    if row.private_owner.is_empty() {
        return None;
    }
    match db::get_drive(conn, &row.source_drive) {
        Ok(Some(d)) if !d.mount_point.is_empty() => {}
        _ => return None,
    }
    match private_source(conn, &row.source_drive, &row.source_path) {
        PrivateSource::OwnItem { owner } if owner == row.private_owner => None,
        PrivateSource::OwnItem { .. } => Some("This folder now belongs to someone else."),
        PrivateSource::Inside => Some("This private item is now inside another private item."),
        PrivateSource::Shared => Some("This folder is no longer a private item."),
    }
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

    fn grant(
        conn: &Connection,
        id: &str,
        drive: &str,
        kind: &str,
        path: &str,
        user: &str,
        caps: i64,
    ) {
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
        grant(
            &conn,
            "g1",
            "d",
            KIND_PATH,
            "Photos/2024/trip",
            "u-ann",
            CAP_VIEW,
        );
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
        grant(
            &conn,
            "g4",
            "d",
            KIND_PATH,
            "Photos/2024",
            "u-ann",
            CAP_VIEW,
        );
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
        assert!(
            !list.allows("u-root", false),
            "admin role alone is not enough"
        );
        assert!(
            list.allows("u-bob", true),
            "any admin is let in by the entry"
        );
    }

    #[test]
    fn allows_ignores_admin_entry_when_disabled() {
        let list = AccessList {
            users: vec!["u-ann".into()],
            admins: false,
        };
        assert!(
            !list.allows("u-root", true),
            "private backup: no Admins entry"
        );
        assert!(list.allows("u-ann", false));
    }

    /// A mounted drive "drive-a" with a Luna marker, registered in the db.
    fn mounted(dir: &tempfile::TempDir, conn: &Connection) {
        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(&mount).unwrap();
        let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
        crate::drives::drive_db::create(
            &mount,
            &luna_core::marker::Marker::new("drive-a", "A"),
            &prefix,
        )
        .unwrap();
        db::upsert_drive(
            conn,
            "drive-a",
            "A",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        db::set_drive_state(conn, "drive-a", "as_is").unwrap();
    }

    fn private_row(
        conn: &Connection,
        id: &str,
        kind: &str,
        drive: &str,
        path: &str,
        owner: &str,
    ) -> db::ProtectionRow {
        db::insert_protection(
            conn,
            &db::NewProtection {
                id,
                kind,
                source_drive: drive,
                source_path: path,
                target_drive: "drive-a",
                private_owner: owner,
                created_by: "u-root",
                created_at: 0,
            },
        )
        .unwrap()
    }

    #[test]
    fn private_row_never_has_admins() {
        let (dir, conn) = setup();
        mounted(&dir, &conn);
        crate::private::create(&dir.path().join("drive-a"), "Family/Vault", "u-ann").unwrap();
        let drive_row = private_row(&conn, "p1", "drive", "drive-a", "Family/Vault", "u-ann");
        let list = for_row(&conn, &drive_row).unwrap();
        assert!(!list.admins, "private drive row has no Admins entry");

        let cloud_row = private_row(&conn, "p2", "cloud", "", "", "u-ann");
        let list = for_row(&conn, &cloud_row).unwrap();
        assert!(!list.admins, "private cloud row has no Admins entry");
        assert_eq!(list.users, vec!["u-ann"]);
    }

    #[test]
    fn private_list_has_grants_on_the_item_only() {
        let (dir, conn) = setup();
        mounted(&dir, &conn);
        grant(
            &conn,
            "g1",
            "drive-a",
            KIND_PATH,
            "Family/Vault",
            "u-bob",
            CAP_VIEW,
        );
        grant(
            &conn, "g2", "drive-a", KIND_PATH, "Family", "u-cat", CAP_VIEW,
        );
        grant(
            &conn,
            "g3",
            "drive-a",
            KIND_PATH,
            "Family/Vault",
            "u-root",
            CAP_VIEW,
        );
        let list = for_private(&conn, "drive-a", "Family/Vault", "u-ann").unwrap();
        assert_eq!(list.users, vec!["u-ann", "u-bob", "u-root"]);
        assert!(!list.admins);
    }

    #[test]
    fn private_source_kinds() {
        let (dir, conn) = setup();
        mounted(&dir, &conn);
        crate::private::create(&dir.path().join("drive-a"), "Family/Vault", "u-ann").unwrap();
        assert_eq!(
            private_source(&conn, "drive-a", "Family/Vault"),
            PrivateSource::OwnItem {
                owner: "u-ann".into()
            }
        );
        assert_eq!(
            private_source(&conn, "drive-a", "Family/Vault/Deep"),
            PrivateSource::Inside
        );
        assert_eq!(
            private_source(&conn, "drive-a", "Family"),
            PrivateSource::Shared
        );
    }

    #[test]
    fn stop_reason_cases() {
        let (dir, conn) = setup();
        mounted(&dir, &conn);
        let root = dir.path().join("drive-a");
        crate::private::create(&root, "Family/Vault", "u-ann").unwrap();
        crate::private::create(&root, "Family/Other", "u-bob").unwrap();

        let own = private_row(&conn, "p1", "drive", "drive-a", "Family/Vault", "u-ann");
        assert_eq!(private_stop_reason(&conn, &own), None);

        let other = private_row(&conn, "p2", "drive", "drive-a", "Family/Other", "u-ann");
        assert_eq!(
            private_stop_reason(&conn, &other),
            Some("This folder now belongs to someone else.")
        );

        let inside = private_row(
            &conn,
            "p3",
            "drive",
            "drive-a",
            "Family/Vault/Deep",
            "u-ann",
        );
        assert_eq!(
            private_stop_reason(&conn, &inside),
            Some("This private item is now inside another private item.")
        );

        let plain = private_row(&conn, "p4", "drive", "drive-a", "Family", "u-ann");
        assert_eq!(
            private_stop_reason(&conn, &plain),
            Some("This folder is no longer a private item.")
        );

        let unmounted = private_row(&conn, "p5", "drive", "drive-missing", "Family", "u-ann");
        assert_eq!(private_stop_reason(&conn, &unmounted), None);
    }

    #[test]
    fn shared_row_is_unchanged() {
        let (dir, conn) = setup();
        mounted(&dir, &conn);
        grant(
            &conn, "g1", "drive-a", KIND_PATH, "Photos", "u-ann", CAP_VIEW,
        );
        let row = private_row(&conn, "s1", "drive", "drive-a", "Photos/2024", "");
        assert_eq!(
            for_row(&conn, &row).unwrap(),
            for_source(&conn, "drive-a", "Photos/2024").unwrap()
        );
        assert_eq!(private_stop_reason(&conn, &row), None);
    }
}
