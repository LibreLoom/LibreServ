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
