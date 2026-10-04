use super::*;

fn service() -> (tempfile::TempDir, AuthService) {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let conn = db::open(&data_dir.join("luna.db")).unwrap();
    let secret = crate::secrets::ensure_jwt_secret(&data_dir, &conn).unwrap();
    let db = Arc::new(crate::Db::new(conn));
    (dir, AuthService::new(db, secret, data_dir))
}

#[test]
fn first_user_is_admin_and_login_round_trips() {
    let (_dir, auth) = service();
    let user = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    assert_eq!(user.role, "admin");

    let (_, token) = auth.login("max", "hunter22hunter1").unwrap();
    let current = auth.verify(&token).unwrap();
    assert_eq!(current.username, "max");
    assert!(auth.login("max", "wrong-password").is_err());
}

#[test]
fn reset_admin_password_lets_them_sign_in_again() {
    let (_dir, auth) = service();
    auth.register("Max", "Max", "old-password-1", "user")
        .unwrap();
    auth.reset_admin_password("new-password-1").unwrap();
    assert!(auth.login("max", "old-password-1").is_err());
    auth.login("max", "new-password-1").unwrap();
}

#[test]
fn console_reset_user_password_skips_policy() {
    let (_dir, auth) = service();
    auth.register("Max", "Max", "old-password12", "user")
        .unwrap();
    // Short / no-digit passwords fail normal policy — recovery must still
    // accept them so a headless reset can succeed.
    auth.reset_user_password("max", "short").unwrap();
    auth.login("max", "short").unwrap();
    assert!(auth.login("max", "old-password12").is_err());
}

fn member(conn: &Connection, id: &str, user_id: &str, drive_id: &str, path: &str, caps: i64) {
    crate::db::insert_access_member(
        conn,
        &crate::db::AccessMemberRow {
            id: id.into(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: drive_id.into(),
            path: path.into(),
            album_id: String::new(),
            user_id: user_id.into(),
            caps,
            created_by: "test".into(),
        },
    )
    .unwrap();
}

#[test]
fn grants_scope_access_by_folder() {
    let (dir, auth) = service();
    let admin = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let sam = auth
        .register("sam", "Sam", "hunter22hunter1", "user")
        .unwrap();
    let conn = auth.db.lock().unwrap();
    member(
        &conn,
        "g1",
        &sam.id,
        "drive-a",
        "family",
        crate::access::CAP_VIEW,
    );
    let sam_user = CurrentUser {
        id: sam.id.clone(),
        username: sam.username.clone(),
        role: "user".into(),
    };
    assert!(has_drive_access(&sam_user, &conn, "drive-a"));
    assert!(!has_drive_access(&sam_user, &conn, "drive-b"));
    assert!(can_access(
        &sam_user,
        &conn,
        "drive-a",
        "family/photos",
        false
    ));
    assert!(!can_access(&sam_user, &conn, "drive-a", "other", false));
    assert!(
        !can_access(&sam_user, &conn, "drive-a", "family", true),
        "read grant is not write"
    );
    assert!(can_access(
        &CurrentUser {
            id: admin.id.clone(),
            username: admin.username.clone(),
            role: "admin".into()
        },
        &conn,
        "drive-a",
        "anything",
        true
    ));
    // Deep grant: ancestors are browsable; siblings are not.
    member(
        &conn,
        "g2",
        &sam.id,
        "drive-b",
        "family/photos",
        crate::access::CAP_VIEW,
    );
    assert!(can_browse_path(&sam_user, &conn, "drive-b", ""));
    assert!(can_browse_path(&sam_user, &conn, "drive-b", "family"));
    assert!(can_browse_path(
        &sam_user,
        &conn,
        "drive-b",
        "family/photos"
    ));
    assert!(!can_browse_path(
        &sam_user,
        &conn,
        "drive-b",
        "family/other"
    ));
    assert!(!can_browse_path(&sam_user, &conn, "drive-b", "secret"));
    drop(conn);
    drop((dir, auth));
}

#[test]
fn upload_only_grant_is_view_blind() {
    let (dir, auth) = service();
    let _admin = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let sam = auth
        .register("sam", "Sam", "hunter22hunter1", "user")
        .unwrap();
    let conn = auth.db.lock().unwrap();
    let sam_user = CurrentUser {
        id: sam.id.clone(),
        username: sam.username.clone(),
        role: "user".into(),
    };
    // Whole-drive upload-only grant: fully browse-blind — PUT lands on
    // the granted path but no folder on the drive opens for walking.
    member(
        &conn,
        "gu",
        &sam.id,
        "drive-c",
        "",
        crate::access::CAP_UPLOAD,
    );
    assert!(!can_browse_path(&sam_user, &conn, "drive-c", ""));
    assert!(!can_browse_path(&sam_user, &conn, "drive-c", "photos"));
    assert!(!can_browse_path(&sam_user, &conn, "drive-c", "photos/2024"));
    // Folder-scoped upload-only grant: same blindness — no ancestors,
    // no grant dir, no children.
    member(
        &conn,
        "gu2",
        &sam.id,
        "drive-d",
        "drop/inbox",
        crate::access::CAP_UPLOAD,
    );
    assert!(!can_browse_path(&sam_user, &conn, "drive-d", ""));
    assert!(!can_browse_path(&sam_user, &conn, "drive-d", "drop"));
    assert!(!can_browse_path(&sam_user, &conn, "drive-d", "drop/inbox"));
    assert!(!can_browse_path(
        &sam_user,
        &conn,
        "drive-d",
        "drop/inbox/file.txt"
    ));
    assert!(!can_browse_path(&sam_user, &conn, "drive-d", "other"));
    // Blind, not powerless: the upload capability itself still holds
    // on both granted paths.
    assert!(has_cap(
        &sam_user,
        &conn,
        "drive-c",
        "",
        crate::access::CAP_UPLOAD
    ));
    assert!(has_cap(
        &sam_user,
        &conn,
        "drive-d",
        "drop/inbox",
        crate::access::CAP_UPLOAD
    ));
    // The grant folder still resolves as an inspectable landing — the
    // member's own row makes it addressable (empty listing, hidden
    // children), it just isn't browsable.
    assert!(can_inspect_path(&sam_user, &conn, "drive-d", "drop/inbox"));
    drop(conn);
    drop((dir, auth));
}

#[test]
fn inspect_path_never_opens_grant_ancestors() {
    let (dir, auth) = service();
    let _admin = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let sam = auth
        .register("sam", "Sam", "hunter22hunter1", "user")
        .unwrap();
    let conn = auth.db.lock().unwrap();
    let sam_user = CurrentUser {
        id: sam.id.clone(),
        username: sam.username.clone(),
        role: "user".into(),
    };
    // A deep file grant: the file itself and the drive root inspect,
    // every ancestor stays closed.
    member(
        &conn,
        "g1",
        &sam.id,
        "drive-a",
        "docs/reports/2024/file.pdf",
        crate::access::CAP_VIEW,
    );
    assert!(can_inspect_path(&sam_user, &conn, "drive-a", ""));
    assert!(!can_inspect_path(&sam_user, &conn, "drive-a", "docs"));
    assert!(!can_inspect_path(
        &sam_user,
        &conn,
        "drive-a",
        "docs/reports"
    ));
    assert!(!can_inspect_path(
        &sam_user,
        &conn,
        "drive-a",
        "docs/reports/2024"
    ));
    assert!(can_inspect_path(
        &sam_user,
        &conn,
        "drive-a",
        "docs/reports/2024/file.pdf"
    ));
    assert!(!can_inspect_path(&sam_user, &conn, "drive-a", "secret"));
    // A member with no rows at all can't even inspect the drive root.
    let nobody = CurrentUser {
        id: "nobody".into(),
        username: "nobody".into(),
        role: "user".into(),
    };
    assert!(!can_inspect_path(&nobody, &conn, "drive-a", ""));
    // An upload-only member resolves exactly their grant path — the
    // landing folder must open so uploads can drop there.
    member(
        &conn,
        "g2",
        &sam.id,
        "drive-b",
        "drop/inbox",
        crate::access::CAP_UPLOAD,
    );
    assert!(can_inspect_path(&sam_user, &conn, "drive-b", "drop/inbox"));
    assert!(!can_inspect_path(&sam_user, &conn, "drive-b", "drop"));
    assert!(!can_inspect_path(
        &sam_user,
        &conn,
        "drive-b",
        "drop/inbox/file.txt"
    ));
    assert!(can_inspect_path(&sam_user, &conn, "drive-b", ""));
    drop(conn);
    drop((dir, auth));
}

#[test]
fn private_items_answer_to_their_owner_not_to_admins_or_wide_grants() {
    let (dir, auth) = service();
    let admin = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let alice = auth
        .register("alice", "Alice", "hunter22hunter1", "user")
        .unwrap();
    let bob = auth
        .register("bob", "Bob", "hunter22hunter1", "user")
        .unwrap();
    let mount = dir.path().join("drive-a");
    std::fs::create_dir_all(&mount).unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("drive-a", "A"),
        &prefix,
    )
    .unwrap();
    let conn = auth.db.lock().unwrap();
    crate::db::upsert_drive(
        &conn,
        "drive-a",
        "A",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    crate::db::set_drive_state(&conn, "drive-a", "as_is").unwrap();
    crate::files::mkdir(&conn, "drive-a", "Family").unwrap();
    crate::files::mkdir_as(&conn, "drive-a", "Family/Vault", Some(&alice.id)).unwrap();
    crate::files::create(&conn, "drive-a", "Family/Vault/note.txt").unwrap();
    let user = |u: &db::UserRow, role: &str| CurrentUser {
        id: u.id.clone(),
        username: u.username.clone(),
        role: role.into(),
    };
    let (admin_u, alice_u, bob_u) = (
        user(&admin, "admin"),
        user(&alice, "user"),
        user(&bob, "user"),
    );

    // Bob can edit all of Family, but not what Alice made private in it.
    member(
        &conn,
        "g1",
        &bob.id,
        "drive-a",
        "Family",
        crate::access::CAP_ALL,
    );
    assert!(can_access(&bob_u, &conn, "drive-a", "Family/other", true));
    assert!(!can_access(&bob_u, &conn, "drive-a", "Family/Vault", false));
    assert!(!can_access(
        &bob_u,
        &conn,
        "drive-a",
        "Family/Vault/note.txt",
        false
    ));
    assert!(!can_inspect_path(&bob_u, &conn, "drive-a", "Family/Vault"));
    // Admin owns the box, not Alice's private items.
    assert!(can_access(&admin_u, &conn, "drive-a", "Family/other", true));
    assert!(!can_access(
        &admin_u,
        &conn,
        "drive-a",
        "Family/Vault",
        false
    ));
    assert!(!can_inspect_path(
        &admin_u,
        &conn,
        "drive-a",
        "Family/Vault/note.txt"
    ));
    assert!(!can_browse_path(&admin_u, &conn, "drive-a", "Family/Vault"));
    // The owner holds everything inside.
    assert!(can_access(
        &alice_u,
        &conn,
        "drive-a",
        "Family/Vault/note.txt",
        true
    ));
    // An exact grant on the private item reaches in; one above does not.
    member(
        &conn,
        "g2",
        &bob.id,
        "drive-a",
        "Family/Vault",
        crate::access::CAP_VIEW,
    );
    assert!(can_access(
        &bob_u,
        &conn,
        "drive-a",
        "Family/Vault/note.txt",
        false
    ));
    assert!(!can_access(
        &bob_u,
        &conn,
        "drive-a",
        "Family/Vault/note.txt",
        true
    ));
    // Deleting Family would delete Alice's folder.
    assert!(holds_unreachable_private(
        &bob_u, &conn, "drive-a", "Family"
    ));
    assert!(!holds_unreachable_private(
        &alice_u, &conn, "drive-a", "Family"
    ));

    // An item whose owner this Luna doesn't know belongs to nobody: only
    // an Admin can reach it.
    crate::private::create(&mount, "Family/Orphan", "someone-else").unwrap();
    assert!(can_access(
        &admin_u,
        &conn,
        "drive-a",
        "Family/Orphan",
        true
    ));
    assert!(!can_access(
        &bob_u,
        &conn,
        "drive-a",
        "Family/Orphan",
        false
    ));
    assert_eq!(crate::private::ownerless_total(&conn), 1);
    assert_eq!(crate::private::adopt_ownerless(&conn, &bob.id), 1);
    assert!(can_access(&bob_u, &conn, "drive-a", "Family/Orphan", true));
    drop(conn);
    drop((dir, auth));
}

#[test]
fn owning_a_private_item_keeps_the_drive_in_reach() {
    let (dir, auth) = service();
    auth.register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let alice = auth
        .register("alice", "Alice", "hunter22hunter1", "user")
        .unwrap();
    let mount = dir.path().join("drive-a");
    std::fs::create_dir_all(&mount).unwrap();
    let prefix = luna_core::marker::pick_prefix(&mount).unwrap();
    crate::drives::drive_db::create(
        &mount,
        &luna_core::marker::Marker::new("drive-a", "A"),
        &prefix,
    )
    .unwrap();
    let conn = auth.db.lock().unwrap();
    crate::db::upsert_drive(
        &conn,
        "drive-a",
        "A",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    let alice_u = CurrentUser {
        id: alice.id.clone(),
        username: alice.username.clone(),
        role: "user".into(),
    };
    assert!(!has_drive_access(&alice_u, &conn, "drive-a"));
    crate::files::mkdir_as(&conn, "drive-a", "Mine", Some(&alice.id)).unwrap();
    // No folder is shared with her, yet her own item keeps the drive open.
    assert!(has_drive_access(&alice_u, &conn, "drive-a"));
    assert!(has_write_on_drive(&alice_u, &conn, "drive-a"));
    assert!(can_inspect_path(&alice_u, &conn, "drive-a", ""));
    assert!(can_browse_path(&alice_u, &conn, "drive-a", ""));
    // A deleted person's items stay walled off, not ownerless.
    drop(conn);
    auth.delete_user(&alice.id).unwrap();
    let conn = auth.db.lock().unwrap();
    assert_eq!(crate::private::ownerless_total(&conn), 0);
}

#[cfg(unix)]
#[test]
fn grant_symlink_leaving_folder_is_denied() {
    use std::os::unix::fs::symlink;
    let (dir, auth) = service();
    let sam = {
        auth.register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        auth.register("sam", "Sam", "hunter22hunter1", "user")
            .unwrap()
    };
    let mount = dir.path().join("drive-a");
    std::fs::create_dir_all(mount.join("family")).unwrap();
    std::fs::create_dir_all(mount.join("secret")).unwrap();
    std::fs::write(mount.join("secret/note.txt"), b"nope").unwrap();
    symlink(mount.join("secret"), mount.join("family/escape")).unwrap();
    let conn = auth.db.lock().unwrap();
    crate::db::upsert_drive(
        &conn,
        "drive-a",
        "A",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    member(
        &conn,
        "g1",
        &sam.id,
        "drive-a",
        "family",
        crate::access::CAP_VIEW,
    );
    let sam_user = CurrentUser {
        id: sam.id.clone(),
        username: sam.username.clone(),
        role: "user".into(),
    };
    assert!(can_access(
        &sam_user,
        &conn,
        "drive-a",
        "family/photos",
        false
    ));
    assert!(
        !can_access(&sam_user, &conn, "drive-a", "family/escape", false),
        "symlink out of the granted folder must 403"
    );
    assert!(!can_access(
        &sam_user,
        &conn,
        "drive-a",
        "family/escape/note.txt",
        false
    ));
    drop(conn);
    drop((dir, auth));
}

#[test]
fn device_token_round_trips_and_revokes() {
    let (_dir, auth) = service();
    let max = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();

    let token = {
        let conn = auth.db.lock().unwrap();
        let raw_token = "secret-device-token-value";
        crate::db::insert_device_token(
            &conn,
            "dt1",
            &max.id,
            "My phone",
            &hash_device_token(raw_token),
            None,
        )
        .unwrap();
        raw_token.to_string()
    };

    let (who, id) = auth.verify_device_token(&token).unwrap().unwrap();
    assert_eq!(who.id, max.id);
    assert_eq!(id, "dt1");

    // Unknown token -> None, and a revoked token -> None.
    assert!(auth.verify_device_token("nope").unwrap().is_none());
    {
        let conn = auth.db.lock().unwrap();
        crate::db::revoke_device_token(&conn, "dt1").unwrap();
    }
    assert!(auth.verify_device_token(&token).unwrap().is_none());
}

#[test]
fn bumping_token_version_invalidates_browser_sessions_only() {
    let (_dir, auth) = service();
    let max = auth
        .register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    let (_, session) = auth.login("max", "hunter22hunter1").unwrap();
    assert!(auth.verify(&session).is_ok());

    let device_raw = "phone-token-keep";
    {
        let conn = auth.db.lock().unwrap();
        crate::db::insert_device_token(
            &conn,
            "dt-keep",
            &max.id,
            "Phone",
            &hash_device_token(device_raw),
            None,
        )
        .unwrap();
        crate::db::bump_user_token_version(&conn, &max.id).unwrap();
    }
    assert!(auth.verify(&session).is_err());
    assert!(auth.verify_device_token(device_raw).unwrap().is_some());

    let (_, session2) = auth.login("max", "hunter22hunter1").unwrap();
    assert!(auth.verify(&session2).is_ok());
}

#[test]
fn https_proxy_sets_secure_cookie_http_does_not() {
    let mut https = HeaderMap::new();
    https.insert("x-forwarded-proto", "https".parse().unwrap());
    assert!(request_is_https(&https));
    assert!(session_cookie("t", true).contains("Secure"));
    assert!(!session_cookie("t", false).contains("Secure"));
}

#[test]
fn csrf_origin_parsing_matches_authority() {
    assert!(origin_matches_host(
        "https://luna.local",
        Some("luna.local")
    ));
    assert!(origin_matches_host(
        "http://localhost:8080",
        Some("localhost:8080")
    ));
    assert!(origin_matches_host(
        "https://[::1]:9000",
        Some("[::1]:9000")
    ));
    // Cross-origin and spoofed-host mismatches are refused.
    assert!(!origin_matches_host(
        "https://evil.example",
        Some("luna.local")
    ));
    // An explicit port differs from a portless Host — same rule as
    // Luna Connect's originGuard (plain authority comparison).
    assert!(!origin_matches_host("https://host:443", Some("host")));
    // Garbage and scheme-less origins fail closed; browsers always send
    // a scheme, so legitimate clients keep working.
    assert!(!origin_matches_host("not a url", Some("luna.local")));
    assert!(!origin_matches_host("luna.local", Some("luna.local")));
    assert!(!origin_matches_host("", Some("luna.local")));
    // No Host at all fails closed.
    assert!(!origin_matches_host("https://luna.local", None));
}

#[test]
fn basic_auth_reads_token_from_password_or_username() {
    fn header(user: &str, password: &str) -> HeaderMap {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Basic {encoded}").parse().unwrap(),
        );
        h
    }
    assert_eq!(
        token_from_headers(&header("max", "device-token-abc")).as_deref(),
        Some("device-token-abc")
    );
    assert_eq!(
        token_from_headers(&header("device-token-abc", "")).as_deref(),
        Some("device-token-abc")
    );
    assert!(token_from_headers(&header("", "")).is_none());
}

#[test]
fn username_is_normalized_and_unique() {
    let (_dir, auth) = service();
    auth.register("Max", "Max", "hunter22hunter1", "user")
        .unwrap();
    assert!(matches!(
        auth.register("MAX", "Other", "hunter22hunter1", "user"),
        Err(AuthError::Taken)
    ));
    assert!(
        auth.register("x", "Bad", "hunter22hunter1", "user")
            .is_err()
    );
}
