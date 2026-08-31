//! User folder grants are a permission tree, not one-off tokens.
//!
//! Creating a grant for the same person can drop older grants the new one
//! already covers. A more-specific stronger grant (write under a read parent)
//! stays as an exception.

use rusqlite::Connection;

use crate::db::{self, GrantRow};

/// Strip slashes so `/photos/` and `photos` compare as the same folder.
pub fn normalize_grant_path(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

/// `write` outranks `read`.
pub fn perm_rank(permission: &str) -> u8 {
    match permission {
        "write" => 2,
        "read" => 1,
        _ => 0,
    }
}

pub fn perm_ge(new_perm: &str, old_perm: &str) -> bool {
    perm_rank(new_perm) >= perm_rank(old_perm)
}

/// True when `ancestor` is the same folder as `descendant`, or a parent of it.
/// A descendant never contains its parent. Empty path is the whole drive.
pub fn path_contains(ancestor: &str, descendant: &str) -> bool {
    let ancestor = normalize_grant_path(ancestor);
    let descendant = normalize_grant_path(descendant);
    if ancestor == descendant {
        return true;
    }
    if ancestor.is_empty() {
        return true;
    }
    descendant.starts_with(&format!("{ancestor}/"))
}

/// Older grants for this person on this drive that the new grant makes redundant.
///
/// 1. Equal (same path, same perm) → drop the old row.
/// 2. New path contains the old path (parent or same):
///    - new perm ≥ old perm → drop the old (covered).
///    - new perm < old perm → keep the old (write exception under a read parent).
/// 3. A child grant does not contain its parent — both stay.
pub fn superseded_ids(
    existing: &[GrantRow],
    user_id: &str,
    drive_id: &str,
    new_path: &str,
    new_perm: &str,
) -> Vec<String> {
    let new_path = normalize_grant_path(new_path);
    existing
        .iter()
        .filter(|g| g.user_id == user_id && g.drive_id == drive_id)
        .filter(|g| path_contains(&new_path, &g.path) && perm_ge(new_perm, &g.permission))
        .map(|g| g.id.clone())
        .collect()
}

/// Insert a grant and delete older rows it supersedes.
pub fn create_user_grant(
    conn: &Connection,
    id: &str,
    user_id: &str,
    drive_id: &str,
    path: &str,
    permission: &str,
) -> anyhow::Result<()> {
    let path = normalize_grant_path(path);
    let existing = db::list_grants_for_user(conn, user_id)?;
    let drop = superseded_ids(&existing, user_id, drive_id, &path, permission);
    let tx = conn.unchecked_transaction()?;
    for grant_id in drop {
        db::delete_grant(&tx, &grant_id)?;
    }
    db::insert_grant(&tx, id, user_id, drive_id, &path, permission)?;
    tx.commit()?;
    Ok(())
}

fn grant_identity(g: &GrantRow) -> (String, String, String, String) {
    (
        g.user_id.clone(),
        g.drive_id.clone(),
        normalize_grant_path(&g.path),
        if g.permission == "write" {
            "write".into()
        } else {
            "read".into()
        },
    )
}

/// Drop identical rows (same person, drive, path, perm). Keep the first.
pub fn dedupe_identical(grants: &[GrantRow]) -> Vec<GrantRow> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for g in grants {
        if seen.insert(grant_identity(g)) {
            out.push(g.clone());
        }
    }
    out
}

/// Highest parents the member can open, plus child folders with a stronger perm.
pub fn member_access_roots(grants: &[GrantRow]) -> Vec<GrantRow> {
    let unique = dedupe_identical(grants);
    unique
        .iter()
        .filter(|g| {
            !unique.iter().any(|parent| {
                parent.id != g.id
                    && parent.user_id == g.user_id
                    && parent.drive_id == g.drive_id
                    && path_contains(&parent.path, &g.path)
                    && perm_ge(&parent.permission, &g.permission)
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(id: &str, path: &str, perm: &str) -> GrantRow {
        GrantRow {
            id: id.into(),
            user_id: "sam".into(),
            drive_id: "photos".into(),
            path: path.into(),
            permission: perm.into(),
        }
    }

    #[test]
    fn equal_grant_supersedes_the_old_row() {
        let existing = vec![grant("old", "album", "read")];
        let drop = superseded_ids(&existing, "sam", "photos", "/album/", "read");
        assert_eq!(drop, vec!["old".to_string()]);
    }

    #[test]
    fn parent_with_equal_or_higher_perm_drops_contained_children() {
        let existing = vec![
            grant("child-write", "album/dcim", "write"),
            grant("child-read", "album/print", "read"),
            grant("other-drive", "album", "read"),
        ];
        let mut other = existing[2].clone();
        other.drive_id = "videos".into();
        let existing = vec![existing[0].clone(), existing[1].clone(), other];

        let drop = superseded_ids(&existing, "sam", "photos", "album", "write");
        assert!(drop.contains(&"child-write".to_string()));
        assert!(drop.contains(&"child-read".to_string()));
        assert!(!drop.iter().any(|id| id == "other-drive"));
    }

    #[test]
    fn weaker_parent_keeps_a_stronger_child() {
        let existing = vec![grant("write-on-a", "album/dcim", "write")];
        let drop = superseded_ids(&existing, "sam", "photos", "album", "read");
        assert!(drop.is_empty(), "read on the parent must keep write on the child");
    }

    #[test]
    fn child_grant_does_not_supersede_the_parent() {
        let existing = vec![grant("read-album", "album", "read")];
        let drop = superseded_ids(&existing, "sam", "photos", "album/dcim", "write");
        assert!(drop.is_empty());
    }

    #[test]
    fn create_applies_the_three_supersede_cases() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();

        create_user_grant(&conn, "g1", "sam", "photos", "album/dcim", "write").unwrap();
        create_user_grant(&conn, "g2", "sam", "photos", "album/dcim", "write").unwrap();
        let rows = crate::db::list_grants_for_user(&conn, "sam").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "g2");

        create_user_grant(&conn, "g3", "sam", "photos", "album/print", "read").unwrap();
        create_user_grant(&conn, "g4", "sam", "photos", "album", "write").unwrap();
        let rows = crate::db::list_grants_for_user(&conn, "sam").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "album");
        assert_eq!(rows[0].permission, "write");

        create_user_grant(&conn, "g5", "max", "photos", "album/dcim", "write").unwrap();
        create_user_grant(&conn, "g6", "max", "photos", "", "read").unwrap();
        let rows = crate::db::list_grants_for_user(&conn, "max").unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|g| g.path.is_empty() && g.permission == "read"));
        assert!(
            rows.iter()
                .any(|g| g.path == "album/dcim" && g.permission == "write")
        );
    }

    #[test]
    fn member_roots_hide_covered_children_but_keep_write_exceptions() {
        let grants = vec![
            grant("drive-read", "", "read"),
            grant("dcim-write", "DCIM", "write"),
            grant("dcim-nested-read", "DCIM/print", "read"),
            grant("dup", "", "read"),
        ];
        let roots = member_access_roots(&grants);
        let paths: Vec<(&str, &str)> = roots
            .iter()
            .map(|g| (g.path.as_str(), g.permission.as_str()))
            .collect();
        assert!(paths.contains(&("", "read")));
        assert!(paths.contains(&("DCIM", "write")));
        assert!(!paths.iter().any(|(p, _)| *p == "DCIM/print"));
        assert_eq!(roots.iter().filter(|g| g.path.is_empty()).count(), 1);
    }
}
