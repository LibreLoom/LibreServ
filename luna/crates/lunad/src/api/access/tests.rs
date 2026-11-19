use super::*;
use crate::access::CAP_ALL;
use axum::http::HeaderValue;

fn link(path: &str, caps: Caps) -> AccessLinkRow {
    AccessLinkRow {
        id: "l1".into(),
        token_hash: "tok".into(),
        token: "t".into(),
        subject_kind: KIND_PATH.into(),
        drive_id: "d1".into(),
        path: path.into(),
        album_id: String::new(),
        caps,
        password_hash: String::new(),
        expires_at: None,
        created_by: "u1".into(),
        created_at: 0,
    }
}

#[test]
fn child_under_link_stays_inside_the_shared_folder() {
    assert_eq!(
        child_under_link("photos/summer", "beach.jpg").as_deref(),
        Some("photos/summer/beach.jpg")
    );
    assert_eq!(child_under_link("photos", "").as_deref(), Some("photos"));
    assert_eq!(child_under_link("", "a/b").as_deref(), Some("a/b"));
    assert!(child_under_link("photos", "../etc").is_none());
    assert!(child_under_link("photos", "/etc/passwd").is_none());
}

#[test]
fn child_under_link_collapses_but_never_escapes() {
    // `//` folds to the one spelling the jail resolves, so a scope check
    // that says `photos/a/b` is checked on exactly that path. `\`, `.`
    // and `..` stay refused — a backslash is never a separator.
    assert_eq!(
        child_under_link("photos", "a//b").as_deref(),
        Some("photos/a/b")
    );
    assert_eq!(
        child_under_link("photos", "a///b//c").as_deref(),
        Some("photos/a/b/c")
    );
    // `.` folds to the same canonical form REST lands on.
    assert_eq!(
        child_under_link("photos", "a/./b").as_deref(),
        Some("photos/a/b")
    );
    assert!(child_under_link("photos", "a\\b").is_none());
    assert!(child_under_link("photos", "a\\b\\c").is_none());
    assert!(child_under_link("photos", "./a").is_none());
    assert!(child_under_link("photos", "a//../b").is_none());
}

#[test]
fn scoped_child_refuses_trash_reaching_spellings() {
    // A link that is not itself trash-scoped must never reach trash —
    // not by the `.luna-trash` alias and not by the real `{prefix}-trash`
    // disk name, however it is spelled.
    let err = || json_error(StatusCode::BAD_REQUEST, "nope");
    let l = link("", CAP_ALL);
    for rel in [
        ".luna-trash",
        ".luna-trash/x",
        ".luna-trash//x",
        ".luna-01234567-89ab-cdef-0123-456789abcdef-trash",
        ".luna-01234567-89ab-cdef-0123-456789abcdef-trash/x",
    ] {
        assert!(scoped_child(&l, rel, err()).is_err(), "{rel} must fail");
    }
    // A trash-scoped link still reaches its own subject.
    let trash_link = link(".luna-trash/entry", CAP_VIEW);
    assert_eq!(
        scoped_child(&trash_link, "", err()).unwrap(),
        ".luna-trash/entry"
    );
}

#[test]
fn upload_scope_compares_canonical_spellings() {
    // A session row that recorded a doubled-separator destination is the
    // same folder — scope must compare the canonical form on both sides,
    // and a `\`-spelled row is not a folder at all.
    let (_dir, conn) = scope_conn();
    let l = link("photos", CAP_ALL);
    assert!(upload_in_link_scope(
        &conn,
        &l,
        "d1",
        "photos//summer",
        "x.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &l,
        "d1",
        "photos\\summer",
        "x.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &l,
        "d1",
        "photos/../x",
        "x.jpg"
    ));
}

#[test]
fn prefers_html_follows_accept_order() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/json"),
    );
    assert!(prefers_html(&headers));
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    assert!(!prefers_html(&headers));
}

/// A conn whose "d1" drive is really adopted at `dir/drive` — the
/// canonical scope check needs the mount and the folders to exist.
fn scope_conn() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("drive");
    std::fs::create_dir_all(mount.join("photos/summer")).unwrap();
    std::fs::write(mount.join("photos/beach.jpg"), b"x").unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("d1", "Drive"),
        &prefix,
    )
    .unwrap();
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Drive",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    (dir, conn)
}

#[test]
fn upload_scope_covers_whole_drive_links() {
    let (_dir, conn) = scope_conn();
    let link = link("", CAP_ALL);
    assert!(upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos",
        "beach.jpg"
    ));
    assert!(upload_in_link_scope(&conn, &link, "d1", "", "root.txt"));
    assert!(!upload_in_link_scope(
        &conn,
        &link,
        "d2",
        "photos",
        "beach.jpg"
    ));
}

#[test]
fn upload_scope_is_shared_folder_for_folder_links() {
    let (_dir, conn) = scope_conn();
    let link = link("photos", CAP_VIEW | CAP_UPLOAD);
    assert!(upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos",
        "beach.jpg"
    ));
    assert!(upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos/summer",
        "beach.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos2024",
        "beach.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "records",
        "beach.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &link,
        "d2",
        "photos",
        "beach.jpg"
    ));
}

#[test]
fn upload_scope_replaces_the_shared_file_for_file_links() {
    let (_dir, conn) = scope_conn();
    let link = link("photos/beach.jpg", access::CAP_ALL);
    assert!(upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos",
        "beach.jpg"
    ));
    assert!(!upload_in_link_scope(
        &conn,
        &link,
        "d1",
        "photos",
        "other.jpg"
    ));
    assert!(!upload_in_link_scope(&conn, &link, "d1", "", "beach.jpg"));
}

#[test]
fn scoped_upload_belongs_only_to_the_creating_link() {
    let (_dir, conn) = scope_conn();
    let link = link("photos", CAP_ALL);
    let up = uploads::create_scoped(&conn, "d1", "photos", "up.bin", 4, "link:l1").unwrap();
    // Same link, same folder: in scope.
    assert!(scoped_upload(&conn, &link, &up.id).is_ok());
    // A second link over the same folder cannot drive the session —
    // path scope alone would have allowed it.
    let mut other = self::link("photos", CAP_ALL);
    other.id = "l2".into();
    let err = scoped_upload(&conn, &other, &up.id).unwrap_err();
    assert_eq!(err.0, StatusCode::FORBIDDEN);
    // And a member's session is never a link's, even in the same folder.
    let member_up = uploads::create_scoped(&conn, "d1", "photos", "m.bin", 4, "user:u9").unwrap();
    let err = scoped_upload(&conn, &link, &member_up.id).unwrap_err();
    assert_eq!(err.0, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// The private wall while its drive is away (locked or unplugged)
// ---------------------------------------------------------------------------

fn current_user(id: &str, role: &str) -> CurrentUser {
    CurrentUser {
        id: id.into(),
        username: id.into(),
        role: role.into(),
    }
}

/// A drive with a marker, `Family`, and Alice's private `Family/Vault`.
/// Bob holds Full on `Family` and Read on the Vault.
fn private_window_conn() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("drive");
    std::fs::create_dir_all(&mount).unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("d1", "Drive"),
        &prefix,
    )
    .unwrap();
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Drive",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    crate::db::insert_user(&conn, "alice", "alice", "Alice", "x", "user").unwrap();
    crate::db::insert_user(&conn, "bob", "bob", "Bob", "x", "user").unwrap();
    crate::db::insert_user(&conn, "admin", "admin", "Admin", "x", "admin").unwrap();
    crate::files::mkdir(&conn, "d1", "Family").unwrap();
    crate::files::mkdir_as(&conn, "d1", "Family/Vault", Some("alice")).unwrap();
    let mut family = member_row("m-family", "bob", "Family");
    family.caps = CAP_ALL;
    crate::db::insert_access_member(&conn, &family).unwrap();
    let mut vault = member_row("m-vault", "bob", "Family/Vault");
    vault.caps = CAP_VIEW;
    crate::db::insert_access_member(&conn, &vault).unwrap();
    (dir, conn)
}

fn member_row(id: &str, user: &str, path: &str) -> crate::db::AccessMemberRow {
    crate::db::AccessMemberRow {
        id: id.into(),
        subject_kind: KIND_PATH.into(),
        drive_id: "d1".into(),
        path: path.into(),
        album_id: String::new(),
        user_id: user.into(),
        caps: CAP_VIEW,
        created_by: "alice".into(),
    }
}

#[test]
fn a_locked_or_unplugged_drive_reports_no_caps_at_all() {
    let (dir, conn) = private_window_conn();
    let bob = current_user("bob", "user");
    let admin = current_user("admin", "admin");
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family/Vault"),
        CAP_VIEW,
        "mounted: only his own Read row reaches into the private folder"
    );

    // Locked: mount_point is empty and the registry cannot be read.
    crate::db::set_drive_locked(&conn, "d1", true).unwrap();
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family/Vault"),
        0,
        "the ancestor Full grant must not cover a private path"
    );
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family"),
        0,
        "nothing on an unreadable drive is provably non-private"
    );
    assert_eq!(
        crate::auth::caps_on_path(&admin, &conn, "d1", "Family/Vault"),
        0,
        "the Admin role is no shortcut either"
    );

    // Unplugged: the mount folder is left behind as an empty directory.
    crate::db::set_drive_locked(&conn, "d1", false).unwrap();
    let empty = dir.path().join("empty-mount");
    std::fs::create_dir_all(&empty).unwrap();
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Drive",
        "as_is",
        "ext4",
        "sda",
        empty.to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family/Vault"),
        0
    );
    assert_eq!(crate::auth::caps_on_path(&admin, &conn, "d1", "Family"), 0);

    // Plugged back in: the private wall is back, not the ancestor grant.
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Drive",
        "as_is",
        "ext4",
        "sda",
        dir.path().join("drive").to_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family/Vault"),
        CAP_VIEW
    );
    assert_eq!(
        crate::auth::caps_on_path(&bob, &conn, "d1", "Family"),
        CAP_ALL
    );
}

#[test]
fn a_member_may_narrow_but_not_raise_their_own_row_on_a_private_subject() {
    use super::access_admin::may_retune_own;
    // Mounted private subject: his effective caps are the Read row.
    assert!(!may_retune_own(CAP_VIEW, CAP_VIEW, CAP_ALL));
    assert!(may_retune_own(CAP_VIEW, CAP_VIEW, 0));
    // Locked/unplugged: the subject reports no inherited caps, so even the
    // Read row is preserved only in the narrowing direction.
    assert!(!may_retune_own(0, CAP_VIEW, CAP_ALL));
    assert!(may_retune_own(0, CAP_VIEW, 0));
    // An ordinary subject with Full still narrows and retunes freely.
    assert!(may_retune_own(CAP_ALL, CAP_ALL, CAP_VIEW));
}

#[test]
fn an_admin_cannot_reach_private_metadata_while_the_drive_is_away() {
    use super::access_admin::may_manage_link;
    let (dir, conn) = private_window_conn();
    let admin = current_user("admin", "admin");
    let row = AccessLinkRow {
        id: "l1".into(),
        token_hash: "tok".into(),
        token: "t".into(),
        subject_kind: KIND_PATH.into(),
        drive_id: "d1".into(),
        path: "Family/Vault".into(),
        album_id: String::new(),
        caps: CAP_VIEW,
        password_hash: String::new(),
        expires_at: None,
        created_by: "alice".into(),
        created_at: 0,
    };
    crate::db::insert_access_link(&conn, &row).unwrap();
    // Mounted: the private wall keeps the Admin out of her link.
    assert!(!may_manage_link(&conn, &admin, &row));

    // Locked: privacy cannot be denied, so the same answer holds and the
    // share inventory sees no way in.
    crate::db::set_drive_locked(&conn, "d1", true).unwrap();
    assert!(path_is_private(&conn, "d1", "Family/Vault"));
    let subj = resolve_subject(&conn, KIND_PATH, "d1", "Family/Vault", "").unwrap();
    assert!(subj.private && subj.private_unknown);
    assert_eq!(my_caps(&conn, &admin, &subj), 0);
    assert!(!may_manage_link(&conn, &admin, &row));

    // Unplugged (empty mount folder): same.
    crate::db::set_drive_locked(&conn, "d1", false).unwrap();
    let empty = dir.path().join("empty-mount");
    std::fs::create_dir_all(&empty).unwrap();
    crate::db::upsert_drive(
        &conn,
        "d1",
        "Drive",
        "as_is",
        "ext4",
        "sda",
        empty.to_str().unwrap(),
    )
    .unwrap();
    assert!(path_is_private(&conn, "d1", "Family/Vault"));
    let subj = resolve_subject(&conn, KIND_PATH, "d1", "Family/Vault", "").unwrap();
    assert_eq!(my_caps(&conn, &admin, &subj), 0);
    assert!(!may_manage_link(&conn, &admin, &row));
}
