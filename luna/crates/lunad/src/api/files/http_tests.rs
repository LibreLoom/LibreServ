use super::*;
use crate::api;
use crate::drives::DriveManager;
use crate::drives::mount::shared_mock;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request as HttpReq};
use tower::ServiceExt;

const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
    54321,
);

fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
    let (dir, app, _) = test_app_with_state(mount);
    (dir, app)
}

fn test_app_with_state(
    mount: &std::path::Path,
) -> (tempfile::TempDir, axum::Router, crate::AppState) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    let prefix = luna_core::marker::pick_prefix(mount).unwrap();
    crate::drives::drive_db::create(
        mount,
        &luna_core::marker::Marker::new("photos", "Photos"),
        &prefix,
    )
    .unwrap();
    crate::db::upsert_drive(
        &conn,
        "photos",
        "Photos",
        "as_is",
        "ext4",
        "sda",
        mount.to_str().unwrap(),
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = crate::AppState::new(conn, drive_manager, dir.path());
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state.clone());
    (dir, app, state)
}

fn json_req(
    method: Method,
    uri: &str,
    body: &str,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> HttpReq<Body> {
    let mut builder = HttpReq::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(t) = csrf {
        builder = builder.header("x-csrf-token", t);
    }
    let mut http = builder.body(Body::from(body.to_string())).unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

fn auth_cookies(res: &axum::response::Response) -> (String, String) {
    let mut session = String::new();
    let mut csrf = String::new();
    for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
        let s = value.to_str().unwrap();
        let part = s.split(';').next().unwrap_or("");
        if part.starts_with("luna_session=") {
            session = part.to_string();
        } else if let Some(token) = part.strip_prefix("luna_csrf=") {
            csrf = token.to_string();
        }
    }
    (session, csrf)
}

fn cookie_header(session: &str, csrf: &str) -> String {
    format!("{session}; luna_csrf={csrf}")
}

async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
    app.clone().oneshot(r).await.unwrap()
}

static LIST_QUERIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn count_query(_: &str) {
    LIST_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// A member's listing must cost a bounded number of queries, not a few
/// per entry: 600 files here would be thousands of statements if the
/// drive row and the member's grants were looked up per entry.
#[test]
fn member_listing_issues_a_bounded_number_of_queries() {
    use std::sync::atomic::Ordering;
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    for i in 0..600 {
        std::fs::write(mount.path().join(format!("family/file{i}.txt")), b"x").unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let mut conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    crate::drives::drive_db::create(
        mount.path(),
        &luna_core::marker::Marker::new("photos", "Photos"),
        &luna_core::marker::pick_prefix(mount.path()).unwrap(),
    )
    .unwrap();
    crate::db::upsert_drive(
        &conn,
        "photos",
        "Photos",
        "as_is",
        "ext4",
        "sda",
        mount.path().to_str().unwrap(),
    )
    .unwrap();
    crate::db::insert_access_member(
        &conn,
        &crate::db::AccessMemberRow {
            id: "g1".into(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "photos".into(),
            path: "family".into(),
            album_id: String::new(),
            user_id: "sam".into(),
            caps: crate::access::CAP_VIEW,
            created_by: "test".into(),
        },
    )
    .unwrap();
    conn.trace(Some(count_query));
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = crate::AppState::new(conn, drive_manager, dir.path());
    let sam = crate::auth::CurrentUser {
        id: "sam".into(),
        username: "sam".into(),
        role: "member".into(),
    };

    LIST_QUERIES.store(0, Ordering::Relaxed);
    let entries = visible_entries(&state, &sam, "photos", "family").unwrap();
    assert_eq!(entries.len(), 600);
    assert!(
        entries
            .iter()
            .all(|e| e.caps.contains("view") || !e.caps.is_empty())
    );
    let queries = LIST_QUERIES.load(Ordering::Relaxed);
    assert!(
        queries < 40,
        "listing 600 files issued {queries} queries; per-entry lookups are back"
    );
}

async fn admin_and_sam(app: &axum::Router) -> (String, String, String) {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&res);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1"}"#,
            Some(&admin_cookie),
            Some(&admin_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let sam_id = v["id"].as_str().unwrap().to_string();
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"sam","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (sam_session, sam_csrf) = auth_cookies(&res);
    (cookie_header(&sam_session, &sam_csrf), sam_csrf, sam_id)
}

#[tokio::test]
async fn mkdir_creates_folder_and_respects_grants() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/mkdir",
            r#"{"path":"family/album"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert!(mount.path().join("family/album").is_dir());

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/mkdir",
            r#"{"path":"secret/nope"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!mount.path().join("secret/nope").exists());
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn private_items_are_the_owners_not_the_admins() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&res);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    let post = |uri: &'static str, body: &'static str, cookie: &str, csrf: &str| {
        json_req(Method::POST, uri, body, Some(cookie), Some(csrf))
    };
    let get = |uri: &str, cookie: &str| {
        let mut r = HttpReq::builder()
            .method(Method::GET)
            .uri(uri)
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(CLIENT));
        r
    };

    // Sam makes a private folder and puts a file in it.
    let res = call(
        &app,
        post(
            "/api/v1/drives/photos/files/mkdir",
            r#"{"path":"family/Vault","private":true}"#,
            &sam_cookie,
            &sam_csrf,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = call(
        &app,
        post(
            "/api/v1/drives/photos/files/create",
            r#"{"path":"family/Vault/note.txt"}"#,
            &sam_cookie,
            &sam_csrf,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    // On disk it is not a folder called Vault.
    assert!(!mount.path().join("family/Vault").exists());

    // The same name is taken, whether or not the person can see why.
    for (cookie, csrf) in [(&sam_cookie, &sam_csrf), (&admin_cookie, &admin_csrf)] {
        let res = call(
            &app,
            post(
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":"family/Vault"}"#,
                cookie,
                csrf,
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    // Sam sees it, flagged; the Admin's listing has nothing.
    let sam_list = body_json(
        call(
            &app,
            get("/api/v1/drives/photos/files?path=family", &sam_cookie),
        )
        .await,
    )
    .await;
    assert_eq!(sam_list[0]["name"], "Vault");
    assert_eq!(sam_list[0]["private"], true);
    let admin_list = body_json(
        call(
            &app,
            get("/api/v1/drives/photos/files?path=family", &admin_cookie),
        )
        .await,
    )
    .await;
    assert!(admin_list.as_array().unwrap().is_empty(), "{admin_list}");
    let inside = call(
        &app,
        get("/api/v1/drives/photos/files?path=family/Vault", &sam_cookie),
    )
    .await;
    assert_eq!(inside.status(), 200);
    assert_eq!(body_json(inside).await[0]["name"], "note.txt");

    // The Admin can't open it, stat it, or read what is inside.
    for uri in [
        "/api/v1/drives/photos/files?path=family/Vault",
        "/api/v1/drives/photos/files/stat?path=family/Vault",
        "/api/v1/drives/photos/files/stat?path=family/Vault/note.txt",
    ] {
        let res = call(&app, get(uri, &admin_cookie)).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{uri}");
    }
    let stat = body_json(
        call(
            &app,
            get(
                "/api/v1/drives/photos/files/stat?path=family/Vault",
                &sam_cookie,
            ),
        )
        .await,
    )
    .await;
    assert_eq!(stat["private"], true);

    // Deleting the folder around it would delete it.
    let mut del = HttpReq::builder()
        .method(Method::DELETE)
        .uri("/api/v1/drives/photos/files?path=family")
        .header("cookie", &admin_cookie)
        .header("x-csrf-token", &admin_csrf)
        .body(Body::empty())
        .unwrap();
    del.extensions_mut().insert(ConnectInfo(CLIENT));
    assert_eq!(call(&app, del).await.status(), StatusCode::FORBIDDEN);
    assert!(crate::private::item_at(mount.path(), "family/Vault").is_some());

    // Renaming keeps it private and under its new name.
    let res = call(
        &app,
        post(
            "/api/v1/drives/photos/files/rename",
            r#"{"path":"family/Vault","new_name":"Safe"}"#,
            &sam_cookie,
            &sam_csrf,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let sam_list = body_json(
        call(
            &app,
            get("/api/v1/drives/photos/files?path=family", &sam_cookie),
        )
        .await,
    )
    .await;
    assert_eq!(sam_list[0]["name"], "Safe");
    assert_eq!(sam_list[0]["private"], true);

    // Its owner can open a private file by its real name.
    let res = call(
        &app,
        get(
            "/api/v1/drives/photos/files/content?path=family/Safe/note.txt",
            &sam_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // A zip of the trash never carries a private item to an Admin.
    let mut del = HttpReq::builder()
        .method(Method::DELETE)
        .uri("/api/v1/drives/photos/files?path=family/Safe")
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::empty())
        .unwrap();
    del.extensions_mut().insert(ConnectInfo(CLIENT));
    assert_eq!(call(&app, del).await.status(), 200);
    let res = call(
        &app,
        get(
            "/api/v1/drives/photos/files/content?path=.luna-trash",
            &admin_cookie,
        ),
    )
    .await;
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("note.txt"));
}

/// An ordinary file deleted out of a private folder stays private in
/// the trash — the row recording that must not depend on the boundary
/// still being at its old path, or existing at all.
#[tokio::test]
async fn a_child_deleted_from_a_private_folder_stays_private_in_trash() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&admin_login);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    let post = |uri: &'static str, body: &'static str, cookie: &str, csrf: &str| {
        json_req(Method::POST, uri, body, Some(cookie), Some(csrf))
    };
    let get = |uri: &str, cookie: &str| {
        let mut r = HttpReq::builder()
            .method(Method::GET)
            .uri(uri)
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(CLIENT));
        r
    };
    let del = |path: &str, cookie: &str, csrf: &str| {
        let mut r = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/drives/photos/files?path={path}"))
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::empty())
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(CLIENT));
        r
    };
    let trash_names = |cookie: &str| {
        let app = app.clone();
        let cookie = cookie.to_string();
        async move {
            let v = body_json(
                call(
                    &app,
                    get("/api/v1/drives/photos/files?path=.luna-trash", &cookie),
                )
                .await,
            )
            .await;
            v.as_array()
                .unwrap()
                .iter()
                .map(|e| e["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        }
    };

    // Sam's private folder, ordinary file inside it, file to trash.
    assert_eq!(
        call(
            &app,
            post(
                "/api/v1/drives/photos/files/mkdir",
                r#"{"path":"family/Vault","private":true}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        call(
            &app,
            post(
                "/api/v1/drives/photos/files/create",
                r#"{"path":"family/Vault/note.txt"}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        call(&app, del("family/Vault/note.txt", &sam_cookie, &sam_csrf))
            .await
            .status(),
        200
    );

    // Sam sees it; the Admin's trash list and reads do not.
    assert_eq!(trash_names(&sam_cookie).await.len(), 1);
    assert!(trash_names(&admin_cookie).await.is_empty());
    let entry = trash_names(&sam_cookie).await[0].clone();
    let res = call(
        &app,
        get(
            &format!("/api/v1/drives/photos/files/content?path=.luna-trash/{entry}"),
            &admin_cookie,
        ),
    )
    .await;
    assert_ne!(res.status(), 200, "admin read of trashed private child");

    // The boundary moves — the deleted child still isn't the Admin's.
    assert_eq!(
        call(
            &app,
            post(
                "/api/v1/drives/photos/files/rename",
                r#"{"path":"family/Vault","new_name":"Moved"}"#,
                &sam_cookie,
                &sam_csrf,
            ),
        )
        .await
        .status(),
        200
    );
    assert!(trash_names(&admin_cookie).await.is_empty());

    // The boundary itself is trashed and purged — provenance still holds.
    assert_eq!(
        call(&app, del("family/Moved", &sam_cookie, &sam_csrf))
            .await
            .status(),
        200
    );
    let folder = trash_names(&sam_cookie)
        .await
        .into_iter()
        .find(|n| n.ends_with("Moved"))
        .unwrap();
    let purge_body = format!(r#"{{"path":".luna-trash/{folder}"}}"#);
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/purge",
            &purge_body,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert!(crate::private::under(mount.path(), "").is_empty());
    assert_eq!(trash_names(&sam_cookie).await, vec![entry.clone()]);
    assert!(trash_names(&admin_cookie).await.is_empty());
    let res = call(
        &app,
        get(
            &format!("/api/v1/drives/photos/files/content?path=.luna-trash/{entry}"),
            &admin_cookie,
        ),
    )
    .await;
    assert_ne!(
        res.status(),
        200,
        "admin read after the boundary was purged"
    );
}

#[tokio::test]
async fn create_makes_file_and_respects_grants() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/create",
            r#"{"path":"family/note.txt"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert!(mount.path().join("family/note.txt").is_file());
    assert_eq!(
        std::fs::read(mount.path().join("family/note.txt")).unwrap(),
        b""
    );

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/create",
            r#"{"path":"secret/nope.txt"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!mount.path().join("secret/nope.txt").exists());

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/create",
            r#"{"path":"family/note.txt"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn multipart_path_mismatch_is_forbidden() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    let boundary = "----luna";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nsecret\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
    );
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri("/api/v1/drives/photos/files/upload?path=family")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::from(body))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!mount.path().join("secret/x.txt").exists());
}

#[tokio::test]
async fn oversized_multipart_path_field_is_refused() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    let boundary = "----luna";
    let big_path = "a".repeat(MAX_PATH_FIELD_BYTES + 1);
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{big_path}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
    );
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri("/api/v1/drives/photos/files/upload?path=family")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::from(body))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert!(!mount.path().join("family/a/a/x.txt").exists());
}

#[tokio::test]
async fn list_without_drive_database_names_the_missing_database() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("photo.jpg"), b"jpeg").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    crate::db::upsert_drive(
        &conn,
        "photos",
        "Photos",
        "as_is",
        "ext4",
        "sda",
        mount.path().to_str().unwrap(),
    )
    .unwrap();
    let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
    let state = crate::AppState::new(conn, drive_manager, dir.path());
    let app = api::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::guard,
        ))
        .with_state(state);
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (session, csrf) = auth_cookies(&res);
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files")
        .header("cookie", cookie_header(&session, &csrf))
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["code"], "missing_drive_db");
    let message = value["error"].as_str().unwrap();
    assert!(
        message.contains("database for this drive is missing"),
        "{message}"
    );
    assert!(
        message.contains("On the Drives page, remove this drive, then add it again."),
        "{message}"
    );
    assert!(
        !message.to_ascii_lowercase().contains("unplug"),
        "{message}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn grant_symlink_list_is_forbidden() {
    use std::os::unix::fs::symlink;
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    std::fs::write(mount.path().join("secret/note.txt"), b"nope").unwrap();
    symlink(
        mount.path().join("secret"),
        mount.path().join("family/escape"),
    )
    .unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_VIEW,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files?path=family/escape")
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

fn list_trash_names(mount: &std::path::Path) -> Vec<String> {
    let trash = crate::drives::layout::Layout::detect(mount)
        .unwrap()
        .trash_dir(mount);
    std::fs::read_dir(trash)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != ".meta")
        .collect()
}

#[tokio::test]
async fn trash_list_filters_by_write_grant() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
    std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&admin_login);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);

    for path in ["family/a.txt", "secret/b.txt"] {
        let mut http = HttpReq::builder()
            .method(Method::DELETE)
            .uri(format!("/api/v1/drives/photos/files?path={path}"))
            .header("cookie", &admin_cookie)
            .header("x-csrf-token", &admin_csrf)
            .body(Body::empty())
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        let res = call(&app, http).await;
        assert_eq!(res.status(), 200, "delete {path}");
    }

    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files?path=.luna-trash")
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let items = v.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["original_path"], "family/a.txt");

    let secret_item = list_trash_names(mount.path())
        .into_iter()
        .find(|name| name.contains("b.txt"))
        .unwrap();
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/purge",
            &format!(r#"{{"path":".luna-trash/{secret_item}"}}"#),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn trash_list_forbidden_without_write_grant() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_VIEW,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files?path=.luna-trash")
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn folder_download_returns_zip() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("album")).unwrap();
    std::fs::write(mount.path().join("album/beach.jpg"), b"photo").unwrap();
    let (_dir, app) = test_app(mount.path());
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (session, csrf) = auth_cookies(&admin_login);
    let cookie = cookie_header(&session, &csrf);

    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files/content?path=album&download=1")
        .header("cookie", &cookie)
        .header("x-csrf-token", &csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/zip")
    );
    let disposition = res
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(disposition.contains("album.zip"), "{disposition}");
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(body.as_ref().starts_with(b"PK"));
}

#[tokio::test]
async fn folder_without_download_flag_is_rejected() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("album")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (session, csrf) = auth_cookies(&admin_login);
    let cookie = cookie_header(&session, &csrf);
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri("/api/v1/drives/photos/files/content?path=album")
        .header("cookie", &cookie)
        .header("x-csrf-token", &csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn scoped_upload_to_multi_level_missing_dirs_is_allowed() {
    // Regression: a write grant used to be refused whenever more than one
    // destination level was missing — the access check only resolved the
    // request's immediate parent, so `family/a/b` 403'd for a folder grant
    // on `family` even though the create path would have made both.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    // Chunked-upload create (POST /api/v1/uploads).
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/uploads",
            r#"{"drive_id":"photos","path":"family/a/b","name":"n.txt","size":3}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // Multipart upload (POST /api/v1/drives/{id}/files/upload).
    let boundary = "----luna";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nfamily/x/y\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"m.txt\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--{boundary}--\r\n"
    );
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri("/api/v1/drives/photos/files/upload?path=family/x/y")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::from(body))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), 200);
    // Small uploads land in the RAM dirty cache and flush on a blocking
    // task — poll briefly for the durable file.
    let dest = mount.path().join("family/x/y/m.txt");
    for _ in 0..100 {
        if dest.is_file() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(dest.is_file());

    // Outside the grant still refuses, even for missing paths.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/uploads",
            r#"{"drive_id":"photos","path":"secret/a/b","name":"n.txt","size":3}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(!mount.path().join("secret/a").exists());
}

async fn admin_cookie(app: &axum::Router) -> (String, String) {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/register",
            r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    admin_login(app).await
}

/// Login-only variant for tests that already registered "max"
/// (`admin_and_sam` registers him on the way to sam's session).
async fn admin_login(app: &axum::Router) -> (String, String) {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (session, csrf) = auth_cookies(&res);
    (cookie_header(&session, &csrf), csrf)
}

async fn delete_path(app: &axum::Router, cookie: &str, csrf: &str, path: &str) -> String {
    let mut http = HttpReq::builder()
        .method(Method::DELETE)
        .uri(format!("/api/v1/drives/photos/files?path={path}"))
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(app, http).await;
    assert_eq!(res.status(), 200, "delete {path}");
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    v["trash_path"].as_str().unwrap().to_string()
}

async fn get_files(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    path: &str,
) -> axum::response::Response {
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v1/drives/photos/files?path={}",
            urlencoding(path)
        ))
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    call(app, http).await
}

fn urlencoding(path: &str) -> String {
    path.replace('%', "%25")
        .replace('/', "%2F")
        .replace(' ', "%20")
}

#[tokio::test]
async fn trash_browses_like_a_folder() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs/sub")).unwrap();
    std::fs::write(mount.path().join("docs/report.txt"), b"hi").unwrap();
    std::fs::write(mount.path().join("docs/sub/deep.txt"), b"deep").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;

    let docs_trash = delete_path(&app, &cookie, &csrf, "docs").await;
    assert!(docs_trash.starts_with(".luna-trash/"));

    // The trash root lists like a folder, annotated with origins.
    let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["kind"], "dir");
    assert_eq!(entry["original_name"], "docs");
    assert_eq!(entry["original_path"], "docs");
    assert!(entry["name"].as_str().unwrap() != "docs");

    // Trashed folders open and keep their real names inside.
    let res = get_files(&app, &cookie, &csrf, &docs_trash).await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let sub = entries
        .iter()
        .find(|e| e["name"] == "sub")
        .expect("sub dir listed by its real name");
    assert_eq!(sub["original_path"], "docs/sub");

    // Nested listing works too.
    let res = get_files(&app, &cookie, &csrf, &format!("{docs_trash}/sub")).await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(entries.as_array().unwrap()[0]["name"], "deep.txt");

    // Stat and content serve trash items read-only.
    let res = call(
        &app,
        json_req(
            Method::GET,
            &format!(
                "/api/v1/drives/photos/files/stat?path={}",
                urlencoding(&format!("{docs_trash}/report.txt"))
            ),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let stat: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(stat["trashed_from"], "docs/report.txt");

    let res = call(
        &app,
        json_req(
            Method::GET,
            &format!(
                "/api/v1/drives/photos/files/content?path={}&download=1",
                urlencoding(&format!("{docs_trash}/report.txt"))
            ),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let disposition = res
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(disposition.contains("report.txt"), "{disposition}");
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    assert_eq!(body.as_ref(), b"hi");

    // A trashed folder still downloads as a zip under its old name.
    let res = call(
        &app,
        json_req(
            Method::GET,
            &format!(
                "/api/v1/drives/photos/files/content?path={}&download=1",
                urlencoding(&docs_trash)
            ),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let disposition = res
        .headers()
        .get(axum::http::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(disposition.contains("docs.zip"), "{disposition}");

    // Writes into trash stay refused.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/mkdir",
            r#"{"path":".luna-trash/newdir"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_ne!(res.status(), 200);
}

#[tokio::test]
async fn trash_folder_view_filters_by_origin_grant() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
    std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&admin_login);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
    let secret_trash = delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

    // Sam sees only the entry whose origin she could edit.
    let res = get_files(&app, &sam_cookie, &sam_csrf, ".luna-trash").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["original_path"], "family/a.txt");

    // And she cannot open or read the other entry.
    let res = get_files(&app, &sam_cookie, &sam_csrf, &secret_trash).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = call(
        &app,
        json_req(
            Method::GET,
            &format!(
                "/api/v1/drives/photos/files/content?path={}",
                urlencoding(&secret_trash)
            ),
            "",
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn trash_root_lists_empty_when_never_used() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn trash_root_stats_empty_when_never_used() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let res = call(
        &app,
        json_req(
            Method::GET,
            "/api/v1/drives/photos/files/stat?path=.luna-trash",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let stat: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(stat["name"], "Trash");
    assert_eq!(stat["kind"], "dir");
}

#[tokio::test]
async fn purging_the_trash_root_empties_it() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("a.txt"), b"a").unwrap();
    std::fs::write(mount.path().join("b.txt"), b"b").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let trash_a = delete_path(&app, &cookie, &csrf, "a.txt").await;
    let trash_b = delete_path(&app, &cookie, &csrf, "b.txt").await;

    // Purging the trash root itself removes every entry.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/purge",
            r#"{"path":".luna-trash"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 0);
    for entry in [&trash_a, &trash_b] {
        let res = get_files(&app, &cookie, &csrf, entry).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{entry} is gone");
    }

    // Emptying an already-empty trash is a quiet no-op.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/purge",
            r#"{"path":".luna-trash"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn renaming_a_trash_entry_retitles_it() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/old.txt"), b"x").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let trash_rel = delete_path(&app, &cookie, &csrf, "docs/old.txt").await;

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            &serde_json::json!({"path": trash_rel, "new_name": "new.txt"}).to_string(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // The listing shows the retitled name, never the nonce-prefixed
    // on-disk entry name.
    let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["original_name"], "new.txt");
    assert_eq!(entries[0]["original_path"], "docs/new.txt");
    assert!(entries[0]["name"].as_str().unwrap().ends_with("-new.txt"));
}

async fn resolve_path(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    path: &str,
) -> axum::response::Response {
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v1/drives/photos/files/resolve?path={}",
            urlencoding(path)
        ))
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    call(app, http).await
}

#[tokio::test]
async fn old_links_follow_a_renamed_folder_until_it_is_trashed() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("Taxes/2024")).unwrap();
    std::fs::write(mount.path().join("Taxes/2024/w2.pdf"), b"x").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            r#"{"path":"Taxes","new_name":"Old taxes"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    let res = resolve_path(&app, &cookie, &csrf, "Taxes/2024/w2.pdf").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let hit: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(hit["drive_id"], "photos");
    assert_eq!(hit["path"], "Old taxes/2024/w2.pdf");
    assert_eq!(hit["kind"], "file");

    // A path that still exists is never forwarded.
    let res = resolve_path(&app, &cookie, &csrf, "Old taxes").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // Trash ends the trail.
    delete_path(&app, &cookie, &csrf, &urlencoding("Old taxes")).await;
    let res = resolve_path(&app, &cookie, &csrf, "Taxes/2024/w2.pdf").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn forwarding_never_reveals_a_folder_the_member_cannot_see() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/plan.txt"), b"x").unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "family", crate::access::CAP_VIEW);

    // The file moves somewhere Sam has no grant.
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    crate::files::move_rel(&conn, "photos", "family/plan.txt", "secret/plan.txt").unwrap();

    let res = resolve_path(&app, &sam_cookie, &sam_csrf, "family/plan.txt").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // Once Sam can see the new location, her old link follows it.
    grant_path(&dir, &sam_id, "secret", crate::access::CAP_VIEW);
    let res = resolve_path(&app, &sam_cookie, &sam_csrf, "family/plan.txt").await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn moving_a_trash_item_out_uses_the_original_name() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("inbox")).unwrap();
    std::fs::write(mount.path().join("note.txt"), b"back").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let trash_rel = delete_path(&app, &cookie, &csrf, "note.txt").await;

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/jobs",
            &serde_json::json!({
                "kind": "move",
                "from_drive": "photos",
                "from_path": trash_rel,
                "to_drive": "photos",
                "to_path": "inbox",
            })
            .to_string(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let job: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let job_id = job["id"].as_str().unwrap().to_string();

    for _ in 0..200 {
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!("/api/v1/jobs/{job_id}"),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        if v["state"] == "done" {
            break;
        }
        assert_ne!(v["state"], "error", "{}", v["error"]);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let names: Vec<String> = std::fs::read_dir(mount.path().join("inbox"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    // The destination carries the original name — never the
    // `{nonce}-` storage prefix.
    assert_eq!(names, vec!["note.txt".to_string()]);

    let res = get_files(&app, &cookie, &csrf, ".luna-trash").await;
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn member_actions_follow_trash_origins() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
    std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let admin_login = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&admin_login);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    let family_trash = delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
    let secret_trash = delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

    // Edit rights on the origin carry over: Sam can rename the entry
    // whose origin she could edit…
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            &serde_json::json!({"path": family_trash, "new_name": "a2.txt"}).to_string(),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // …but not the one from a folder she has no grant on.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            &serde_json::json!({"path": secret_trash, "new_name": "b2.txt"}).to_string(),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

/// Grant `user_id` a path-scoped member row on the test "photos" drive.
fn grant_path(dir: &tempfile::TempDir, user_id: &str, path: &str, caps: crate::access::Caps) {
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    crate::db::insert_access_member(
        &conn,
        &crate::db::AccessMemberRow {
            id: uuid::Uuid::new_v4().to_string(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "photos".into(),
            path: path.into(),
            album_id: String::new(),
            user_id: user_id.into(),
            caps,
            created_by: "test".into(),
        },
    )
    .unwrap();
}

async fn stat_path(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    path: &str,
) -> axum::response::Response {
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v1/drives/photos/files/stat?path={}",
            urlencoding(path)
        ))
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    call(app, http).await
}

#[tokio::test]
async fn member_inspect_never_walks_up_to_a_deep_grant() {
    // Sam may read docs/inner only. WebDAV walks the ancestors so she can
    // reach it — the HTTP files API must not: `docs` stays invisible to
    // stat and to listing, and nothing about siblings leaks.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs/inner")).unwrap();
    std::fs::write(mount.path().join("docs/inner/file.pdf"), b"x").unwrap();
    std::fs::write(mount.path().join("docs/sibling.txt"), b"s").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "docs/inner", crate::access::CAP_VIEW);

    for path in ["docs", "docs/sibling.txt", "nope/missing.txt"] {
        let res = stat_path(&app, &sam_cookie, &sam_csrf, path).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "stat {path}");
        let res = get_files(&app, &sam_cookie, &sam_csrf, path).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "list {path}");
    }

    // The drive root opens (a member row exists on this drive) but lists
    // nothing — `docs` is only an ancestor of her grant, so it hides.
    let res = get_files(&app, &sam_cookie, &sam_csrf, "").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(entries.as_array().unwrap().is_empty(), "{entries}");

    // The granted folder itself inspects and lists normally.
    let res = stat_path(&app, &sam_cookie, &sam_csrf, "docs/inner").await;
    assert_eq!(res.status(), 200);
    let res = get_files(&app, &sam_cookie, &sam_csrf, "docs/inner").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let names: Vec<_> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["file.pdf".to_string()]);
}

#[tokio::test]
async fn member_file_grant_lists_one_entry() {
    // A grant on a file — same shape the public share page gives guests:
    // listing the file returns the file itself as a single row, while its
    // parent folder stays closed.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("pics")).unwrap();
    std::fs::write(mount.path().join("pics/a.jpg"), b"jpg").unwrap();
    std::fs::write(mount.path().join("pics/b.jpg"), b"jpg2").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "pics/a.jpg", crate::access::CAP_VIEW);

    let res = get_files(&app, &sam_cookie, &sam_csrf, "pics/a.jpg").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "a.jpg");

    // The parent is not hers — listing it is forbidden, and stat on the
    // sibling (which exists) answers the same 403 as a missing path.
    let res = get_files(&app, &sam_cookie, &sam_csrf, "pics").await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = stat_path(&app, &sam_cookie, &sam_csrf, "pics/b.jpg").await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The drive root opens (she has a row on this drive) but lists no
    // ancestor of her grant — the chain to `a.jpg` stays invisible.
    let res = get_files(&app, &sam_cookie, &sam_csrf, "").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(entries.as_array().unwrap().is_empty(), "{entries}");
}

#[tokio::test]
async fn member_upload_only_grant_is_view_blind() {
    // A drop folder: Sam can save into `drop` but never see what's in it.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("drop")).unwrap();
    std::fs::write(mount.path().join("drop/secret.txt"), b"s").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "drop", crate::access::CAP_UPLOAD);

    // The landing itself resolves (stat works so the UI can anchor on it),
    // but its listing is empty — the upload grant carries no read.
    let res = stat_path(&app, &sam_cookie, &sam_csrf, "drop").await;
    assert_eq!(res.status(), 200);
    let res = get_files(&app, &sam_cookie, &sam_csrf, "drop").await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 0);

    // Children stay closed: stat and content both refuse.
    let res = stat_path(&app, &sam_cookie, &sam_csrf, "drop/secret.txt").await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = call(
        &app,
        json_req(
            Method::GET,
            "/api/v1/drives/photos/files/content?path=drop%2Fsecret.txt",
            "",
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn member_upload_overwrite_needs_edit() {
    // Upload-only members drop new files — replacing an existing one is
    // an edit, even when the client passes overwrite=1.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("drop")).unwrap();
    std::fs::write(mount.path().join("drop/x.txt"), b"old").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "drop", crate::access::CAP_UPLOAD);

    let boundary = "----luna";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nnew\r\n--{boundary}--\r\n"
    );
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri("/api/v1/drives/photos/files/upload?path=drop&overwrite=1")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::from(body))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        std::fs::read(mount.path().join("drop/x.txt")).unwrap(),
        b"old"
    );

    // Same shape with the real grants: a full-access member may replace.
    // (Small uploads buffer through the RAM dirty overlay before the
    // background flush lands them — read back through the API.)
    grant_path(&dir, &sam_id, "docs", crate::access::CAP_ALL);
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/x.txt"), b"old").unwrap();
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri("/api/v1/drives/photos/files/upload?path=docs&overwrite=1")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("cookie", &sam_cookie)
        .header("x-csrf-token", &sam_csrf)
        .body(Body::from(format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.txt\"\r\nContent-Type: text/plain\r\n\r\nnew\r\n--{boundary}--\r\n"
        )))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), 200);
    let res = call(
        &app,
        json_req(
            Method::GET,
            "/api/v1/drives/photos/files/content?path=docs%2Fx.txt",
            "",
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    assert_eq!(&body[..], b"new");
}

#[tokio::test]
async fn member_trash_zip_skips_foreign_origins() {
    // The trash zip mirrors the filtered listing: entries whose origin
    // Sam cannot edit never enter the archive.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("secret")).unwrap();
    std::fs::write(mount.path().join("family/a.txt"), b"a").unwrap();
    std::fs::write(mount.path().join("secret/b.txt"), b"b").unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    grant_path(&dir, &sam_id, "family", crate::access::CAP_ALL);

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            r#"{"username":"max","password":"hunter22hunter1"}"#,
            None,
            None,
        ),
    )
    .await;
    let (admin_session, admin_csrf) = auth_cookies(&res);
    let admin_cookie = cookie_header(&admin_session, &admin_csrf);
    delete_path(&app, &admin_cookie, &admin_csrf, "family/a.txt").await;
    delete_path(&app, &admin_cookie, &admin_csrf, "secret/b.txt").await;

    // Download the whole trash root as a zip.
    let res = call(
        &app,
        json_req(
            Method::GET,
            "/api/v1/drives/photos/files/content?path=.luna-trash&download=1",
            "",
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(body)).unwrap();
    let names: Vec<String> = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(
        names.iter().any(|n| n.contains("a.txt")),
        "own trashed file is in the zip: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n.contains("b.txt")),
        "foreign trashed file stays out: {names:?}"
    );
}

/// GET helper for endpoints outside `/files` — same cookies, same guard.
async fn get_json(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    uri: &str,
) -> (axum::http::StatusCode, serde_json::Value) {
    let mut http = HttpReq::builder()
        .method(Method::GET)
        .uri(uri)
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(app, http).await;
    let status = res.status();
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn member_without_share_cap_cannot_redistribute() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;

    // Full content access on docs/ — but no share capability.
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g-docs".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "docs".into(),
                album_id: String::new(),
                user_id: sam_id.clone(),
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    // Adding people is manage-level: refused without CAP_SHARE.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{sam_id}","caps":"view"}}"#
            ),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST); // self-grant

    // Register a second member to share with.
    let (admin_cookie, admin_csrf) = admin_login(&app).await;
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/users",
            r#"{"username":"kim","display_name":"Kim","password":"hunter22hunter1","role":"user"}"#,
            Some(&admin_cookie),
            Some(&admin_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    let kim_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{kim_id}","caps":"view"}}"#
            ),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A public link is manage-level too.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/links",
            r#"{"kind":"path","drive_id":"photos","path":"docs","caps":"view"}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The roster is hidden from members without share rights — they see
    // that sharing exists (counts), never who or which links.
    let (status, subj) = get_json(
        &app,
        &sam_cookie,
        &sam_csrf,
        "/api/v1/access/subject?kind=path&drive_id=photos&path=docs",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(subj["my_caps"], "full");
    assert!(subj["members"].as_array().unwrap().is_empty());
    assert!(subj["links"].as_array().unwrap().is_empty());

    // With CAP_SHARE granted, both doors open.
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::update_access_member_caps(
            &conn,
            "g-docs",
            crate::access::CAP_ALL | crate::access::CAP_SHARE,
        )
        .unwrap();
    }
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"docs","user_id":"{kim_id}","caps":"view"}}"#
            ),
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn summary_space_follows_view_grants() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "family".into(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_UPLOAD,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }

    // Upload-only: the drive is reachable for drop-offs, but capacity —
    // drive metadata — is not.
    let (status, summary) = get_json(
        &app,
        &sam_cookie,
        &sam_csrf,
        "/api/v1/drives/photos/summary",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(summary["mounted"], true);
    assert!(summary["total_bytes"].is_null());
    assert!(summary["free_bytes"].is_null());
    assert!(summary["used_bytes"].is_null());

    // Any view-bearing grant on the drive earns the storage readout.
    {
        let conn = crate::db::open(&_dir.path().join("luna.db")).unwrap();
        crate::db::update_access_member_caps(
            &conn,
            "g1",
            crate::access::CAP_VIEW | crate::access::CAP_UPLOAD,
        )
        .unwrap();
    }
    let (status, summary) = get_json(
        &app,
        &sam_cookie,
        &sam_csrf,
        "/api/v1/drives/photos/summary",
    )
    .await;
    assert_eq!(status, 200);
    assert!(summary["total_bytes"].is_number());
    assert!(summary["free_bytes"].is_number());
}

#[tokio::test]
async fn summary_counts_and_shortcuts_include_the_callers_private_folders() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("Docs")).unwrap();
    let (dir, app) = test_app(mount.path());
    let (sam_cookie, sam_csrf, sam_id) = admin_and_sam(&app).await;
    {
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "g1".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: String::new(),
                album_id: String::new(),
                user_id: sam_id,
                caps: crate::access::CAP_ALL,
                created_by: "test".into(),
            },
        )
        .unwrap();
    }
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/mkdir",
            r#"{"path":"Vault","private":true}"#,
            Some(&sam_cookie),
            Some(&sam_csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // Sam's own private folder counts and shows up as a shortcut, under
    // its real name — not hidden behind its `.luna-…` disk name.
    let (status, summary) = get_json(
        &app,
        &sam_cookie,
        &sam_csrf,
        "/api/v1/drives/photos/summary",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(summary["folders"], 2, "{summary}");
    assert_eq!(summary["shortcuts"], serde_json::json!(["Docs", "Vault"]));
}

#[tokio::test]
async fn recents_reflect_renames_without_duplicates_and_prune_deletes() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;

    // 1. Create a file whiteboard.excalidraw on the photos drive
    let file_path = mount.path().join("whiteboard.excalidraw");
    std::fs::write(&file_path, b"drawing").unwrap();

    // 2. Record it in recents
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/me/recents",
            &serde_json::to_string(&serde_json::json!({
                "driveId": "photos",
                "path": "whiteboard.excalidraw",
                "kind": "file"
            }))
            .unwrap(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // 3. GET /api/v1/me/recents returns whiteboard.excalidraw
    let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
    assert_eq!(status, 200);
    let list = recents.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["path"], "whiteboard.excalidraw");

    // 4. Rename whiteboard.excalidraw to 67.excalidraw via Luna API
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            &serde_json::to_string(&serde_json::json!({
                "path": "whiteboard.excalidraw",
                "new_name": "67.excalidraw"
            }))
            .unwrap(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // 5. User accesses 67.excalidraw (simulating navigation)
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/me/recents",
            &serde_json::to_string(&serde_json::json!({
                "driveId": "photos",
                "path": "67.excalidraw",
                "kind": "file"
            }))
            .unwrap(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // 6. GET /api/v1/me/recents: expects 67.excalidraw and NO duplicates
    let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
    assert_eq!(status, 200);
    let list = recents.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["path"], "67.excalidraw");

    // 7. Delete 67.excalidraw to trash
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            "/api/v1/drives/photos/files?path=67.excalidraw",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // 8. GET /api/v1/me/recents: 67.excalidraw should NOT be shown
    let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
    assert_eq!(status, 200);
    let list = recents.as_array().unwrap();
    assert_eq!(list.len(), 0);

    // 9. Create another file and delete it on disk directly (out-of-band)
    let ghost_path = mount.path().join("ghost.txt");
    std::fs::write(&ghost_path, b"ghost").unwrap();
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/me/recents",
            &serde_json::to_string(&serde_json::json!({
                "driveId": "photos",
                "path": "ghost.txt",
                "kind": "file"
            }))
            .unwrap(),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    // Delete directly on disk
    std::fs::remove_file(&ghost_path).unwrap();
    // GET /api/v1/me/recents detects it is missing and prunes it
    let (status, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
    assert_eq!(status, 200);
    assert_eq!(recents.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn recents_check_drive_entries() {
    let mount = tempfile::tempdir().unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let post = |drive: &str| {
        json_req(
            Method::POST,
            "/api/v1/me/recents",
            &serde_json::to_string(&serde_json::json!({ "driveId": drive, "path": "" })).unwrap(),
            Some(&cookie),
            Some(&csrf),
        )
    };
    // A drive that doesn't exist is refused, not stored.
    let res = call(&app, post("no-such-drive")).await;
    assert_eq!(res.status(), 404);
    // A real drive is stored and listed as a drive.
    let res = call(&app, post("photos")).await;
    assert_eq!(res.status(), 200);
    let (_, recents) = get_json(&app, &cookie, &csrf, "/api/v1/me/recents").await;
    let list = recents.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["kind"], "drive");
}

async fn trash_one(app: &axum::Router, cookie: &str, csrf: &str, name: &str) -> String {
    delete_path(app, cookie, csrf, name).await
}

fn status_of(res: &axum::response::Response) -> u16 {
    res.status().as_u16()
}

#[tokio::test]
async fn two_restores_of_one_trash_item_have_one_winner() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("a.txt"), b"x").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let trashed = trash_one(&app, &cookie, &csrf, "a.txt").await;
    let restore = |dest: &str| {
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/restore",
            &format!(r#"{{"path":"{trashed}","dest":"{dest}"}}"#),
            Some(&cookie),
            Some(&csrf),
        )
    };
    let (one, two) = tokio::join!(
        call(&app, restore("first.txt")),
        call(&app, restore("second.txt"))
    );
    let ok = [status_of(&one), status_of(&two)]
        .iter()
        .filter(|s| **s == 200)
        .count();
    assert_eq!(ok, 1, "exactly one restore wins");
    let landed = ["first.txt", "second.txt"]
        .iter()
        .filter(|n| mount.path().join(n).is_file())
        .count();
    assert_eq!(landed, 1, "the item exists in exactly one place");
}

#[tokio::test]
async fn request_paths_land_in_the_one_canonical_form() {
    // `a//b` and `a/./b` are the same item REST, the listing index and
    // grants all see; `..` and `\` are refused at the door rather than
    // reinterpreted as separators.
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/note.txt"), b"hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;

    for path in ["docs//note.txt", "docs/./note.txt"] {
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!(
                    "/api/v1/drives/photos/files/stat?path={}",
                    urlencoding(path)
                ),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "{path}");
    }
    // `..` is refused, not walked.
    for encoded in ["docs%2F..%2Fnote.txt", "docs%5Cnote.txt"] {
        let res = call(
            &app,
            json_req(
                Method::GET,
                &format!("/api/v1/drives/photos/files/stat?path={encoded}"),
                "",
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 400, "{encoded} must be refused");
    }
    // The raw on-disk trash name is not a readable path — the
    // `.luna-trash` alias is the only spelling that reaches trash.
    let prefix = crate::drives::drive_db::prefix_for(mount.path()).unwrap();
    let res = call(
        &app,
        json_req(
            Method::GET,
            &format!("/api/v1/drives/photos/files?path={prefix}-trash"),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert!(
        res.status() == 400 || res.status() == 404,
        "raw trash root must not list, got {}",
        res.status()
    );
}

#[tokio::test]
async fn a_purge_waits_for_the_drive_lock_while_reads_carry_on() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("a.txt"), b"x").unwrap();
    let (_dir, app, state) = test_app_with_state(mount.path());
    let (cookie, csrf) = admin_cookie(&app).await;
    let trashed = trash_one(&app, &cookie, &csrf, "a.txt").await;

    // Someone else is changing this drive.
    let guard = state.db.drive_lock("photos").lock_owned().await;
    let purge = tokio::spawn({
        let app = app.clone();
        let (cookie, csrf) = (cookie.clone(), csrf.clone());
        async move {
            call(
                &app,
                json_req(
                    Method::POST,
                    "/api/v1/drives/photos/files/purge",
                    &format!(r#"{{"path":"{trashed}"}}"#),
                    Some(&cookie),
                    Some(&csrf),
                ),
            )
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!purge.is_finished(), "the purge queues behind the lock");

    // The database lock is free, so listings still answer.
    let listing = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_files(&app, &cookie, &csrf, ""),
    )
    .await
    .expect("a listing is not stuck behind a purge");
    assert_eq!(listing.status(), 200);

    drop(guard);
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), purge)
        .await
        .expect("the purge runs once the lock frees")
        .unwrap();
    assert_eq!(res.status(), 200);
}
