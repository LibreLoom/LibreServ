use crate::api;
use crate::drives::DriveManager;
use crate::drives::mount::shared_mock;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request as HttpReq, StatusCode};
use tower::ServiceExt;

const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
    54321,
);

fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
    let (dir, app, _state) = test_app_state(mount);
    (dir, app)
}

fn test_app_state(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router, crate::AppState) {
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
        .header("content-type", "application/json")
        .header("accept", "application/json");
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

async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
    app.clone().oneshot(r).await.unwrap()
}

/// Raw PUT of one upload chunk — public upload sessions carry no
/// cookie/CSRF, the link token in the URL is the credential.
fn put_chunk(uri: &str, data: &[u8]) -> HttpReq<Body> {
    let end = data.len().saturating_sub(1);
    let mut http = HttpReq::builder()
        .method(Method::PUT)
        .uri(uri)
        .header("content-type", "application/octet-stream")
        .header("content-range", format!("bytes 0-{end}/{}", data.len()))
        .body(Body::from(data.to_vec()))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

/// Register + sign in as the first user (admin). Returns (cookie, csrf).
async fn admin(app: &axum::Router) -> (String, String) {
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
    (format!("{session}; luna_csrf={csrf}"), csrf)
}

async fn make_link(app: &axum::Router, cookie: &str, csrf: &str, body: &str) -> serde_json::Value {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/access/links",
            body,
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    body_json(res).await
}

async fn public_get(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let res = call(app, json_req(Method::GET, uri, "", None, None)).await;
    let status = res.status();
    (status, body_json(res).await)
}

#[tokio::test]
async fn created_folder_link_resolves_publicly() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "folder");
    assert_eq!(body["name"], "family");
}

#[tokio::test]
async fn created_file_link_resolves_publicly() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/readme.txt"), "hello").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"file","drive_id":"photos","path":"docs/readme.txt","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "file");
    assert_eq!(body["name"], "readme.txt");
}

#[tokio::test]
async fn link_to_a_trashed_item_resolves_publicly() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/note.txt"), "hello").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            "/api/v1/drives/photos/files?path=docs/note.txt",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let v = body_json(res).await;
    let trash_path = v["trash_path"].as_str().unwrap();

    let link = make_link(
        &app,
        &cookie,
        &csrf,
        &serde_json::json!({
            "kind": "file",
            "drive_id": "photos",
            "path": trash_path,
            "caps": "view",
        })
        .to_string(),
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "file");
    // The link page shows the original name — never the `{nonce}-`
    // storage name.
    assert_eq!(body["name"], "note.txt");
}

#[tokio::test]
async fn link_to_a_trashed_folder_lists_contents() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/note.txt"), "hello").unwrap();
    std::fs::write(mount.path().join("docs/other.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            "/api/v1/drives/photos/files?path=docs",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let v = body_json(res).await;
    let trash_path = v["trash_path"].as_str().unwrap();

    let link = make_link(
        &app,
        &cookie,
        &csrf,
        &serde_json::json!({
            "kind": "folder",
            "drive_id": "photos",
            "path": trash_path,
            "caps": "view",
        })
        .to_string(),
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}/list")).await;
    assert_eq!(status, 200, "{body}");
    let mut names: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["note.txt", "other.txt"]);
}

#[tokio::test]
async fn created_dropbox_link_resolves_publicly() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("incoming")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"incoming","caps":"upload"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "dropbox");
}

#[tokio::test]
async fn folder_link_lists_entries() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();
    let (status, body) = public_get(&app, &format!("/s/{token}/list")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["entries"][0]["name"], "note.txt");
}

async fn public_json(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: &str,
) -> (StatusCode, serde_json::Value) {
    let res = call(app, json_req(method, uri, body, None, None)).await;
    let status = res.status();
    (status, body_json(res).await)
}

/// Admin-caps folder link over `family/` for the guest-op tests.
async fn edit_link(app: &axum::Router, caps: &str) -> String {
    let (cookie, csrf) = admin(app).await;
    let link = make_link(
        app,
        &cookie,
        &csrf,
        &format!(r#"{{"kind":"folder","drive_id":"photos","path":"family","caps":"{caps}"}}"#),
    )
    .await;
    link["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn guest_stat_reports_in_scope_metadata() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let token = edit_link(&app, "full").await;
    let (status, body) = public_get(&app, &format!("/s/{token}/stat?path=note.txt")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["name"], "note.txt");
    assert_eq!(body["writable"], true);
    // The link root itself reports not-writable.
    let (status, body) = public_get(&app, &format!("/s/{token}/stat")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["writable"], false);
}

#[tokio::test]
async fn guest_mkdir_create_rename_move_delete_inside_scope() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/keep.txt"), "k").unwrap();
    let (_dir, app) = test_app(mount.path());
    let token = edit_link(&app, "full").await;

    let (s, b) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/mkdir"),
        r#"{"path":"trips"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(mount.path().join("family/trips").is_dir());

    let (s, b) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/create"),
        r#"{"path":"trips/plan.md"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(mount.path().join("family/trips/plan.md").is_file());

    let (s, b) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/rename"),
        r#"{"path":"trips/plan.md","new_name":"route.md"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(mount.path().join("family/trips/route.md").is_file());

    let (s, b) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/move"),
        r#"{"paths":["keep.txt"],"dest":"trips"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(mount.path().join("family/trips/keep.txt").is_file());

    let (s, b) = public_json(
        &app,
        Method::DELETE,
        &format!("/s/{token}/file?path=trips/route.md"),
        "",
    )
    .await;
    assert_eq!(s, 200, "{b}");
    assert!(!mount.path().join("family/trips/route.md").exists());
}

#[tokio::test]
async fn guest_ops_cannot_escape_or_touch_the_link_root() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "n").unwrap();
    std::fs::write(mount.path().join("secret.txt"), "s").unwrap();
    let (_dir, app) = test_app(mount.path());
    let token = edit_link(&app, "full").await;

    // Traversal out of scope.
    for (method, uri, body) in [
        (
            Method::DELETE,
            format!("/s/{token}/file?path=../secret.txt"),
            "",
        ),
        (
            Method::POST,
            format!("/s/{token}/rename"),
            r#"{"path":"../secret.txt","new_name":"x"}"#,
        ),
        (
            Method::POST,
            format!("/s/{token}/move"),
            r#"{"paths":["note.txt"],"dest":".."}"#,
        ),
    ] {
        let (s, _) = public_json(&app, method, &uri, body).await;
        assert_eq!(s, 400);
    }
    assert!(mount.path().join("secret.txt").is_file());
    assert!(mount.path().join("family/note.txt").is_file());

    // The shared root itself is not mutable.
    let (s, _) = public_json(&app, Method::DELETE, &format!("/s/{token}/file?path="), "").await;
    assert_eq!(s, 400);
    let (s, _) = public_json(&app, Method::DELETE, &format!("/s/{token}/file?path=."), "").await;
    assert_eq!(s, 400);
    assert!(mount.path().join("family").is_dir());
}

#[tokio::test]
async fn guest_view_link_gets_no_write_ops() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "n").unwrap();
    let (_dir, app) = test_app(mount.path());
    let token = edit_link(&app, "view").await;

    for (method, uri, body) in [
        (Method::POST, format!("/s/{token}/mkdir"), r#"{"path":"x"}"#),
        (
            Method::POST,
            format!("/s/{token}/rename"),
            r#"{"path":"note.txt","new_name":"y"}"#,
        ),
        (Method::DELETE, format!("/s/{token}/file?path=note.txt"), ""),
        (
            Method::POST,
            format!("/s/{token}/move"),
            r#"{"paths":["note.txt"],"dest":""}"#,
        ),
    ] {
        let (s, _) = public_json(&app, method, &uri, body).await;
        assert_eq!(s, 403);
    }
}

#[tokio::test]
async fn dropbox_link_creates_only_at_top_level() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("incoming")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"incoming","caps":"upload"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();

    let (s, b) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/create"),
        r#"{"path":"hello.txt"}"#,
    )
    .await;
    assert_eq!(s, 200, "{b}");
    let (s, _) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/create"),
        r#"{"path":"nested/hello.txt"}"#,
    )
    .await;
    assert_eq!(s, 400);
    // No read-back: stat is view-gated.
    let (s, _) = public_get(&app, &format!("/s/{token}/stat?path=hello.txt")).await;
    assert_eq!(s, 403);
}

/// Create a non-admin user and sign in as them. Returns (cookie, csrf, id).
async fn member(
    app: &axum::Router,
    admin_cookie: &str,
    csrf: &str,
    username: &str,
) -> (String, String, String) {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/users",
            &format!(r#"{{"username":"{username}","password":"memberpass1{username}"}}"#),
            Some(admin_cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let created = body_json(res).await;
    let id = created["id"].as_str().unwrap().to_string();
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/auth/login",
            &format!(r#"{{"username":"{username}","password":"memberpass1{username}"}}"#),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
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
    (format!("{session}; luna_csrf={csrf}"), csrf, id)
}

async fn add_member(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    path: &str,
    user_id: &str,
    caps: &str,
) -> serde_json::Value {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"{path}","user_id":"{user_id}","caps":"{caps}"}}"#
            ),
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    body_json(res).await
}

async fn subject(app: &axum::Router, cookie: &str, path: &str) -> (StatusCode, serde_json::Value) {
    let res = call(
        app,
        json_req(
            Method::GET,
            &format!("/api/v1/access/subject?kind=path&drive_id=photos&path={path}"),
            "",
            Some(cookie),
            None,
        ),
    )
    .await;
    let status = res.status();
    (status, body_json(res).await)
}

/// GET against the public surface with an optional password header and
/// cookie. Returns (status, set-cookie strings, json body).
async fn public_req(
    app: &axum::Router,
    uri: &str,
    password: Option<&str>,
    cookie: Option<&str>,
) -> (StatusCode, Vec<String>, serde_json::Value) {
    let mut builder = HttpReq::builder()
        .method(Method::GET)
        .uri(uri)
        .header("accept", "application/json");
    if let Some(p) = password {
        builder = builder.header("x-share-password", p);
    }
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    let mut http = builder.body(Body::from(String::new())).unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(app, http).await;
    let status = res.status();
    let cookies = res
        .headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .map(|v| {
            v.to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap_or("")
                .to_string()
        })
        .collect();
    (status, cookies, body_json(res).await)
}

#[tokio::test]
async fn wider_grant_preserves_explicit_child_rows() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;

    // A weak child grant, then a full grant on the parent: the child row
    // must survive (explicit descendants are exceptions, not duplicates).
    add_member(&app, &cookie, &csrf, "family/kids", &sam, "view").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "full").await;

    let (s, st) = subject(&app, &cookie, "family/kids").await;
    assert_eq!(s, 200, "{st}");
    let direct = st["members"].as_array().unwrap();
    assert_eq!(direct.len(), 1, "{st}");
    assert_eq!(direct[0]["caps"], "view");
    assert_eq!(direct[0]["effective_caps"], "full");
    assert_eq!(direct[0]["can_manage"], true);
    let inherited = st["inherited_members"].as_array().unwrap();
    assert_eq!(inherited.len(), 1, "{st}");
    assert_eq!(inherited[0]["caps"], "full");
    assert_eq!(inherited[0]["inherited_from"]["path"], "family");
    assert_eq!(inherited[0]["inherited_from"]["name"], "family");
    // A sibling folder is not an ancestor — nothing leaks sideways.
    std::fs::create_dir_all(mount.path().join("other")).unwrap();
    add_member(&app, &cookie, &csrf, "other", &sam, "view").await;
    let (_, st) = subject(&app, &cookie, "family/kids").await;
    assert_eq!(st["inherited_members"].as_array().unwrap().len(), 1);

    // The member sees every explicit grant, including the retained child.
    let res = call(
        &app,
        json_req(Method::GET, "/api/v1/access/mine", "", Some(&mcookie), None),
    )
    .await;
    let mine = body_json(res).await;
    let paths: Vec<&str> = mine["with_me"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"family"), "{mine}");
    assert!(paths.contains(&"family/kids"), "{mine}");
    assert!(paths.contains(&"other"), "{mine}");

    // Roots still collapse to the widest grants for permission math.
    let res = call(
        &app,
        json_req(Method::GET, "/api/v1/me/access", "", Some(&mcookie), None),
    )
    .await;
    let roots = body_json(res).await;
    assert_eq!(roots.as_array().unwrap().len(), 2, "{roots}");

    // Removing the root leaves the explicit child standing.
    let res = call(
        &app,
        json_req(Method::GET, "/api/v1/access/mine", "", Some(&mcookie), None),
    )
    .await;
    let mine = body_json(res).await;
    let root_id = mine["with_me"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["path"] == "family")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            &format!("/api/v1/access/members/{root_id}"),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (_, st) = subject(&app, &cookie, "family/kids").await;
    assert_eq!(st["members"].as_array().unwrap().len(), 1);
    assert_eq!(st["members"][0]["caps"], "view");
    assert_eq!(st["members"][0]["effective_caps"], "view");
    assert!(st["inherited_members"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn inherited_from_flags_parents_the_caller_cannot_open() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (jcookie, _jcsrf, jules) = member(&app, &cookie, &csrf, "jules").await;
    let (_sc, _scsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "full").await;
    add_member(&app, &cookie, &csrf, "family/kids", &jules, "view").await;

    // Jules holds only the child: the parent grant is visible but its
    // subject can't be opened for inspection.
    let (s, st) = subject(&app, &jcookie, "family/kids").await;
    assert_eq!(s, 200, "{st}");
    let inh = st["inherited_members"].as_array().unwrap();
    assert_eq!(inh.len(), 1, "{st}");
    assert_eq!(inh[0]["inherited_from"]["can_inspect"], false, "{st}");

    let (_, st) = subject(&app, &cookie, "family/kids").await;
    assert_eq!(
        st["inherited_members"][0]["inherited_from"]["can_inspect"], true,
        "{st}"
    );
}

#[tokio::test]
async fn inherited_links_only_surface_when_manageable() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family/kids", &sam, "view").await;

    // A link wider than the member's own access must not hand them its
    // address; a view link they cover is fine.
    let wide = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
    )
    .await;
    assert!(wide["url"].is_string());

    let (s, st) = subject(&app, &mcookie, "family/kids").await;
    assert_eq!(s, 200, "{st}");
    assert!(st["inherited_links"].as_array().unwrap().is_empty(), "{st}");

    let (_, st) = subject(&app, &cookie, "family/kids").await;
    let inh = st["inherited_links"].as_array().unwrap();
    assert_eq!(inh.len(), 1, "{st}");
    assert_eq!(inh[0]["inherited_from"]["path"], "family");
    assert_eq!(inh[0]["can_manage"], true);
    assert!(inh[0]["url"].is_string());
}

#[tokio::test]
async fn link_patch_distinguishes_absent_from_null() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view","password":"s3cret-passw0rd","expires_in_days":7}"#,
    )
    .await;
    let id = link["id"].as_str().unwrap();

    // Empty patch keeps password and expiry.
    let res = call(
        &app,
        json_req(
            Method::PATCH,
            &format!("/api/v1/access/links/{id}"),
            "{}",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = body_json(res).await;
    assert_eq!(body["has_password"], true, "{body}");
    assert!(body["expires_at"].is_number(), "{body}");

    // Explicit null clears both.
    let res = call(
        &app,
        json_req(
            Method::PATCH,
            &format!("/api/v1/access/links/{id}"),
            r#"{"password":null,"expires_in_days":null}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = body_json(res).await;
    assert_eq!(body["has_password"], false, "{body}");
    assert!(body["expires_at"].is_null(), "{body}");
}

#[tokio::test]
async fn password_change_revokes_proof_cookies() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view","password":"0ld-passw0rd-ok"}"#,
    )
    .await;
    let id = link["id"].as_str().unwrap().to_string();
    let token = link["token"].as_str().unwrap().to_string();

    // First password check mints a proof cookie; the cookie alone then works.
    let (s, cookies, _) = public_req(
        &app,
        &format!("/s/{token}?meta=1"),
        Some("0ld-passw0rd-ok"),
        None,
    )
    .await;
    assert_eq!(s, 200);
    let proof = cookies
        .iter()
        .find(|c| c.starts_with(&format!("luna_link_{id}=")))
        .cloned()
        .expect("proof cookie");
    let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof)).await;
    assert_eq!(s, 200);

    // Rotating the password kills the outstanding proof.
    let res = call(
        &app,
        json_req(
            Method::PATCH,
            &format!("/api/v1/access/links/{id}"),
            r#"{"password":"new-passw0rd-2"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof)).await;
    assert_eq!(s, 401);
    let (s, cookies, _) = public_req(
        &app,
        &format!("/s/{token}?meta=1"),
        Some("new-passw0rd-2"),
        None,
    )
    .await;
    assert_eq!(s, 200);
    let proof2 = cookies
        .iter()
        .find(|c| c.starts_with(&format!("luna_link_{id}=")))
        .cloned()
        .expect("new proof cookie");
    let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof2)).await;
    assert_eq!(s, 200);

    // A removed link rejects everything, proof or not.
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            &format!("/api/v1/access/links/{id}"),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (s, _, _) = public_req(&app, &format!("/s/{token}?meta=1"), None, Some(&proof2)).await;
    assert_eq!(s, 404);
    let (s, _, _) = public_req(
        &app,
        &format!("/s/{token}?meta=1"),
        Some("new-passw0rd-2"),
        None,
    )
    .await;
    assert_eq!(s, 404);
}

// -------------------------------------------------------------------
// Guest diagram collab + share lifecycle (rename/move/trash/restore)
// -------------------------------------------------------------------

/// Stand the app up on a real socket — a WebSocket upgrade only exists
/// on a live connection (hyper fills `OnUpgrade`), so the collab route
/// can't be driven through `oneshot`.
async fn spawn_app(app: axum::Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}

struct WsReply {
    status: u16,
    head: String,
    stream: tokio::net::TcpStream,
    buf: Vec<u8>,
}

/// Write a bare-bones upgrade request over TCP and read the response
/// head — enough HTTP to reach the route, no client library needed.
async fn ws_connect(
    addr: std::net::SocketAddr,
    path: &str,
    extra_headers: &[(&str, &str)],
) -> WsReply {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "GET {path} HTTP/1.1\r\nHost: luna\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    );
    for (k, v) in extra_headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .expect("ws response timed out")
            .unwrap();
        assert!(n > 0, "connection closed before a response");
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let rest = buf.split_off(split + 4);
    WsReply {
        status,
        head,
        stream,
        buf: rest,
    }
}

/// Read one unmasked server→client text frame. Skips pings. Supports
/// the 16-bit length form so a `welcome` with peer records fits.
async fn ws_next_text(reply: &mut WsReply) -> Option<serde_json::Value> {
    use tokio::io::AsyncReadExt;
    loop {
        if reply.buf.len() >= 2 {
            let opcode = reply.buf[0] & 0x0f;
            let len_marker = reply.buf[1] & 0x7f;
            let (header, len) = if len_marker == 126 {
                if reply.buf.len() < 4 {
                    (0, 0)
                } else {
                    let len = u16::from_be_bytes([reply.buf[2], reply.buf[3]]) as usize;
                    (4, len)
                }
            } else if len_marker == 127 {
                return None;
            } else {
                (2, len_marker as usize)
            };
            if header > 0 && reply.buf.len() >= header + len {
                let payload = reply.buf[header..header + len].to_vec();
                reply.buf.drain(..header + len);
                if opcode == 0x1 {
                    return serde_json::from_slice(&payload).ok();
                }
                continue;
            }
        }
        let mut chunk = [0u8; 4096];
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            reply.stream.read(&mut chunk),
        )
        .await
        .ok()?
        .ok()?;
        if n == 0 {
            return None;
        }
        reply.buf.extend_from_slice(&chunk[..n]);
    }
}

/// Client→server text frame. Mask key is all zeros, which is a legal
/// mask and leaves the payload unchanged.
async fn ws_send_text(reply: &mut WsReply, text: &str) {
    use tokio::io::AsyncWriteExt;
    let payload = text.as_bytes();
    assert!(payload.len() < 126, "test frame must fit in 7-bit length");
    let mut frame = Vec::with_capacity(6 + payload.len());
    frame.push(0x81);
    frame.push(0x80 | payload.len() as u8);
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(payload);
    reply.stream.write_all(&frame).await.unwrap();
}

/// `luna_link_{id}=<proof>` out of a response head's Set-Cookie line.
fn proof_from_head(head: &str, id: &str) -> Option<String> {
    let want = format!("luna_link_{id}=");
    head.lines().find_map(|line| {
        line.strip_prefix("set-cookie: ")
            .or_else(|| line.strip_prefix("Set-Cookie: "))
            .and_then(|v| v.split(';').next())
            .filter(|c| c.starts_with(&want))
            .map(str::to_string)
    })
}

#[tokio::test]
async fn guest_collab_ws_upgrades_and_shares_one_room() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/plan.drawio"), "<mxfile/>").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"file","drive_id":"photos","path":"docs/plan.drawio","caps":"full"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap().to_string();
    let addr = spawn_app(app).await;

    let mut first = ws_connect(addr, &format!("/s/{token}/collab/ws"), &[]).await;
    assert_eq!(first.status, 101, "{}", first.head);
    let msg = ws_next_text(&mut first).await.unwrap();
    assert_eq!(msg["type"], "welcome", "{msg}");
    assert_eq!(msg["can_write"], true);
    assert_eq!(msg["peers"].as_array().unwrap().len(), 1);
    assert_eq!(msg["peers"][0]["username"], "Guest");

    // A second guest on the same link joins the same room.
    let mut second = ws_connect(addr, &format!("/s/{token}/collab/ws"), &[]).await;
    assert_eq!(second.status, 101, "{}", second.head);
    let msg = ws_next_text(&mut second).await.unwrap();
    assert_eq!(msg["type"], "welcome", "{msg}");
    assert_eq!(msg["peers"].as_array().unwrap().len(), 2);
    // The first socket hears the join, numbered so the two sessions
    // are distinguishable — same rule as member collab.
    let joined = ws_next_text(&mut first).await.unwrap();
    assert_eq!(joined["type"], "peer_join", "{joined}");
    assert_eq!(joined["peer"]["username"], "Guest (2)");

    // A draw.io diff patch is an opaque op. The other guest hears the
    // patch. The sender hears only the sequence, so it can name that
    // edit when it saves.
    ws_send_text(
        &mut first,
        r#"{"type":"op","payload":{"kind":"patch","patch":{"n":1},"checksum":"a"}}"#,
    )
    .await;
    let op = ws_next_text(&mut second).await.unwrap();
    assert_eq!(op["type"], "op", "{op}");
    assert_eq!(op["payload"]["kind"], "patch");
    assert_eq!(op["payload"]["patch"]["n"], 1);
    assert_eq!(op["payload"]["checksum"], "a");
    let ack = ws_next_text(&mut first).await.unwrap();
    assert_eq!(ack["type"], "ack", "{ack}");
    assert_eq!(ack["seq"], 1);

    // One saver at a time. The election is a direct reply, not a broadcast.
    ws_send_text(&mut first, r#"{"type":"save_lock"}"#).await;
    let grant = ws_next_text(&mut first).await.unwrap();
    assert_eq!(grant["type"], "save_lock", "{grant}");
    assert_eq!(grant["granted"], true);
    ws_send_text(&mut second, r#"{"type":"save_lock"}"#).await;
    let deny = ws_next_text(&mut second).await.unwrap();
    assert_eq!(deny["type"], "save_lock", "{deny}");
    assert_eq!(deny["granted"], false);
    ws_send_text(&mut first, r#"{"type":"save_end"}"#).await;
    ws_send_text(&mut second, r#"{"type":"save_lock"}"#).await;
    let after = ws_next_text(&mut second).await.unwrap();
    assert_eq!(after["granted"], true, "{after}");
}

#[tokio::test]
async fn guest_collab_ws_view_only_follows_and_bad_targets_are_refused() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/plan.drawio"), "<mxfile/>").unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let view = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let view_token = view["token"].as_str().unwrap().to_string();
    let full = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#,
    )
    .await;
    let token = full["token"].as_str().unwrap().to_string();
    let addr = spawn_app(app).await;
    let ws = |token: &str, path: &str| format!("/s/{token}/collab/ws?path={path}");

    // A view link follows live edits but cannot send them.
    let mut res = ws_connect(addr, &ws(&view_token, "plan.drawio"), &[]).await;
    assert_eq!(res.status, 101, "{}", res.head);
    let msg = ws_next_text(&mut res).await.unwrap();
    assert_eq!(msg["type"], "welcome");
    assert_eq!(msg["can_write"], false);
    ws_send_text(
        &mut res,
        r#"{"type":"op","payload":{"kind":"patch","patch":{"n":1}}}"#,
    )
    .await;
    let denied = ws_next_text(&mut res).await.unwrap();
    assert_eq!(denied["type"], "error", "{denied}");
    // Escapes, non-diagrams, and missing files are refused pre-upgrade.
    let res = ws_connect(addr, &ws(&token, "../plan.drawio"), &[]).await;
    assert_eq!(res.status, 400, "{}", res.head);
    let res = ws_connect(addr, &ws(&token, "note.txt"), &[]).await;
    assert_eq!(res.status, 400, "{}", res.head);
    let res = ws_connect(addr, &ws(&token, "missing.drawio"), &[]).await;
    assert_eq!(res.status, 404, "{}", res.head);
    // A real in-scope diagram upgrades.
    let mut res = ws_connect(addr, &ws(&token, "plan.drawio"), &[]).await;
    assert_eq!(res.status, 101, "{}", res.head);
    assert_eq!(ws_next_text(&mut res).await.unwrap()["type"], "welcome");
    // Unknown tokens never reach the handler.
    let res = ws_connect(addr, &ws("nope", "plan.drawio"), &[]).await;
    assert_eq!(res.status, 404, "{}", res.head);
}

#[tokio::test]
async fn guest_collab_ws_authenticates_password_links_by_header_or_proof() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/plan.drawio"), "<mxfile/>").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"file","drive_id":"photos","path":"docs/plan.drawio","caps":"full","password":"s3cret-passw0rd"}"#,
    )
    .await;
    let id = link["id"].as_str().unwrap().to_string();
    let token = link["token"].as_str().unwrap().to_string();
    let addr = spawn_app(app).await;
    let path = format!("/s/{token}/collab/ws");

    // No credentials at all → password challenge, not an upgrade.
    let res = ws_connect(addr, &path, &[]).await;
    assert_eq!(res.status, 401, "{}", res.head);

    // The password header upgrades and mints the proof cookie — which is
    // what a real browser relies on, since WebSocket requests can't set
    // custom headers.
    let res = ws_connect(addr, &path, &[("x-share-password", "s3cret-passw0rd")]).await;
    assert_eq!(res.status, 101, "{}", res.head);
    let proof = proof_from_head(&res.head, &id).expect("proof cookie");
    drop(res);

    let mut res = ws_connect(addr, &path, &[("cookie", proof.as_str())]).await;
    assert_eq!(res.status, 101, "{}", res.head);
    assert_eq!(ws_next_text(&mut res).await.unwrap()["type"], "welcome");
}

#[tokio::test]
async fn rename_retargets_member_and_link_rows() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family/kids")).unwrap();
    let (_dir, app, state) = test_app_state(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (_mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "view").await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family/kids","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap().to_string();
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            r#"{"path":"family","new_name":"kin"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    // The link kept working at the new path.
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "folder");
    assert_eq!(body["name"], "kids");
    // And the member grant moved with the folder.
    let conn = state.db.lock().unwrap();
    let rows = crate::db::list_access_members_for_user(&conn, &sam).unwrap();
    assert!(
        rows.iter()
            .any(|r| r.drive_id == "photos" && r.path == "kin"),
        "{rows:?}"
    );
}

/// Poll a job until it leaves "running" (or time out).
async fn wait_job(app: &axum::Router, cookie: &str, id: &str) -> serde_json::Value {
    for _ in 0..100 {
        let res = call(
            app,
            json_req(
                Method::GET,
                &format!("/api/v1/jobs/{id}"),
                "",
                Some(cookie),
                None,
            ),
        )
        .await;
        let job = body_json(res).await;
        if job["state"].as_str() != Some("running") {
            return job;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("job {id} did not finish");
}

async fn enqueue_move(
    app: &axum::Router,
    cookie: &str,
    csrf: &str,
    from_drive: &str,
    from_path: &str,
    to_drive: &str,
    to_path: &str,
) -> serde_json::Value {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/jobs",
            &format!(
                r#"{{"kind":"move","from_drive":"{from_drive}","from_path":"{from_path}","to_drive":"{to_drive}","to_path":"{to_path}"}}"#
            ),
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let job = body_json(res).await;
    let done = wait_job(app, cookie, job["id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "done", "{done}");
    done
}

#[tokio::test]
async fn move_retargets_share_rows() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::create_dir_all(mount.path().join("archive")).unwrap();
    let (_dir, app, state) = test_app_state(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap().to_string();
    enqueue_move(
        &app, &cookie, &csrf, "photos", "family", "photos", "archive",
    )
    .await;
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "folder");
    let conn = state.db.lock().unwrap();
    let link_row = crate::db::get_access_link(&conn, link["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(link_row.path, "archive/family");
}

#[tokio::test]
async fn cross_drive_move_retargets_share_rows() {
    let mount = tempfile::tempdir().unwrap();
    let mount_b = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app, state) = test_app_state(mount.path());
    // A second adopted drive — same filesystem, so the job still renames
    // but the rows must follow it to the other drive id.
    let prefix = luna_core::marker::pick_prefix(mount_b.path()).unwrap();
    crate::drives::drive_db::create(
        mount_b.path(),
        &luna_core::marker::Marker::new("backup", "Backup"),
        &prefix,
    )
    .unwrap();
    {
        let conn = state.db.lock().unwrap();
        crate::db::upsert_drive(
            &conn,
            "backup",
            "Backup",
            "as_is",
            "ext4",
            "sdb",
            mount_b.path().to_str().unwrap(),
        )
        .unwrap();
    }
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap().to_string();
    enqueue_move(&app, &cookie, &csrf, "photos", "family", "backup", "").await;
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "folder");
    let conn = state.db.lock().unwrap();
    let link_row = crate::db::get_access_link(&conn, link["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        (link_row.drive_id.as_str(), link_row.path.as_str()),
        ("backup", "family")
    );
}

#[tokio::test]
async fn rename_form_file_keeps_respond_link() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(
        mount.path().join("docs/rsvp.lunaform"),
        r#"{"version":1,"title":"RSVP","questions":[]}"#,
    )
    .unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"file","drive_id":"photos","path":"docs/rsvp.lunaform","caps":"respond"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap().to_string();
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/rename",
            r#"{"path":"docs/rsvp.lunaform","new_name":"party.lunaform"}"#,
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (status, body) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "form");
}

#[tokio::test]
async fn trash_revokes_the_file_link_and_restore_does_not_revive_it() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let file_link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"file","drive_id":"photos","path":"family/note.txt","caps":"view"}"#,
    )
    .await;
    let file_token = file_link["token"].as_str().unwrap().to_string();
    let folder_link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;
    let folder_token = folder_link["token"].as_str().unwrap().to_string();

    let res = call(
        &app,
        json_req(
            Method::DELETE,
            "/api/v1/drives/photos/files?path=family/note.txt",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let body = body_json(res).await;
    let trash_path = body["trash_path"].as_str().unwrap().to_string();

    // The trashed file's link is dead; the parent's is untouched.
    let (status, _) = public_get(&app, &format!("/s/{file_token}?meta=1")).await;
    assert_eq!(status, 404);
    let (status, body) = public_get(&app, &format!("/s/{folder_token}?meta=1")).await;
    assert_eq!(status, 200, "{body}");

    // Restoring the file must not resurrect its grants.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/drives/photos/files/restore",
            &format!(r#"{{"path":"{trash_path}","dest":"family/note.txt"}}"#),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let (status, _) = public_get(&app, &format!("/s/{file_token}?meta=1")).await;
    assert_eq!(status, 404);
}

// -------------------------------------------------------------------
// Confinement + access-management regressions
// -------------------------------------------------------------------

/// Create an album on the photos drive and return its id.
async fn make_album(app: &axum::Router, cookie: &str, csrf: &str, name: &str) -> String {
    let res = call(
        app,
        json_req(
            Method::POST,
            "/api/v1/gallery/albums",
            &format!(r#"{{"name":"{name}"}}"#),
            Some(cookie),
            Some(csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    body_json(res).await["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn album_link_gets_no_path_operations() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("secret.txt"), "s").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let album_id = make_album(&app, &cookie, &csrf, "Trip").await;
    // view+upload so cap checks pass and only the subject-kind gate can
    // refuse — before the fix these calls walked the whole drive root.
    let link = make_link(
        &app,
        &cookie,
        &csrf,
        &serde_json::json!({
            "kind": "album",
            "drive_id": "photos",
            "album_id": album_id,
            "caps": "view+upload",
        })
        .to_string(),
    )
    .await;
    let token = link["token"].as_str().unwrap();

    // The link page itself still answers as an album.
    let (s, b) = public_get(&app, &format!("/s/{token}?meta=1")).await;
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["kind"], "album");

    // Path-shaped operations on a non-path subject are refused.
    let (s, _) = public_get(&app, &format!("/s/{token}/stat")).await;
    assert_eq!(s, StatusCode::GONE);
    let (s, _) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/mkdir"),
        r#"{"path":"x"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::GONE);
    let (s, _) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/create"),
        r#"{"path":"x.jpg"}"#,
    )
    .await;
    assert_eq!(s, StatusCode::GONE);
    // Nothing was created at the drive root.
    assert!(!mount.path().join("x").exists());
    assert!(!mount.path().join("x.jpg").exists());
}

#[tokio::test]
async fn whole_drive_link_cannot_reach_the_trash() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("docs")).unwrap();
    std::fs::write(mount.path().join("docs/note.txt"), "hi").unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    // Put something in the trash so .luna-trash really exists on disk.
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            "/api/v1/drives/photos/files?path=docs/note.txt",
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    let link = make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"","caps":"view"}"#,
    )
    .await;
    let token = link["token"].as_str().unwrap();

    // The trash alias is out of scope for a link that isn't trash-scoped.
    let (s, b) = public_get(&app, &format!("/s/{token}/list?path=.luna-trash")).await;
    assert_eq!(s, 404, "{b}");
    let (s, b) = public_get(&app, &format!("/s/{token}/zip?path=.luna-trash")).await;
    assert_eq!(s, 404, "{b}");

    // The root listing still works — and never shows the trash dir.
    let (s, b) = public_get(&app, &format!("/s/{token}/list")).await;
    assert_eq!(s, 200, "{b}");
    let names: Vec<&str> = b["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"docs"), "{b}");
    assert!(!names.iter().any(|n| n.contains("trash")), "{b}");
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_inside_a_share_cannot_escape_it() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    std::fs::write(mount.path().join("family/note.txt"), "n").unwrap();
    std::fs::write(mount.path().join("secret.txt"), "s").unwrap();
    std::os::unix::fs::symlink(mount.path(), mount.path().join("family/escape")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let token = edit_link(&app, "full").await;

    // Reads: the symlink resolves outside the link root.
    let (s, _) = public_get(&app, &format!("/s/{token}/file?path=escape/secret.txt")).await;
    assert_eq!(s, 404);
    let (s, _) = public_get(&app, &format!("/s/{token}/list?path=escape")).await;
    assert_eq!(s, 404);
    let (s, _) = public_get(&app, &format!("/s/{token}/stat?path=escape/secret.txt")).await;
    assert_eq!(s, 404);
    let (s, _) = public_get(&app, &format!("/s/{token}/zip?path=escape")).await;
    assert_eq!(s, 404);

    // Writes: a symlinked component is refused without following it.
    let (s, _) = public_json(
        &app,
        Method::DELETE,
        &format!("/s/{token}/file?path=escape/secret.txt"),
        "",
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/move"),
        r#"{"paths":["note.txt"],"dest":"escape"}"#,
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = public_json(
        &app,
        Method::POST,
        &format!("/s/{token}/create"),
        r#"{"path":"escape/planted.txt"}"#,
    )
    .await;
    assert_eq!(s, 404);

    // The outside file is untouched and nothing landed through the link.
    assert_eq!(
        std::fs::read(mount.path().join("secret.txt")).unwrap(),
        b"s"
    );
    assert!(!mount.path().join("planted.txt").exists());
}

#[tokio::test]
async fn revoked_creator_cannot_read_or_patch_their_link() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "full+share").await;

    // Sam mints a link while the grant covers it.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/links",
            r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let link = body_json(res).await;
    let link_id = link["id"].as_str().unwrap().to_string();
    assert!(link["url"].as_str().unwrap().starts_with("/s/"));

    // The admin pulls Sam's access to the folder.
    let (_, st) = subject(&app, &cookie, "family").await;
    let row_id = st["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == sam)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            &format!("/api/v1/access/members/{row_id}"),
            "",
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);

    // Having created the link no longer counts: the subject sheet is
    // shut, the inventory drops the row (no URL to recover), and the
    // password patch is refused.
    let (s, _) = subject(&app, &mcookie, "family").await;
    assert_eq!(s, 403);
    let res = call(
        &app,
        json_req(Method::GET, "/api/v1/access/mine", "", Some(&mcookie), None),
    )
    .await;
    let mine = body_json(res).await;
    assert!(
        !mine["sharing"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["path"] == "family"),
        "{mine}"
    );
    let res = call(
        &app,
        json_req(
            Method::PATCH,
            &format!("/api/v1/access/links/{link_id}"),
            r#"{"password":"n3w-passw0rd"}"#,
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn member_grants_reject_self_and_missing_paths() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "full").await;

    // A self-grant is refused even with full caps on the subject.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"family","user_id":"{sam}","caps":"view"}}"#
            ),
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 400);

    // A path that doesn't exist can't be shared.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"ghost","user_id":"{sam}","caps":"view"}}"#
            ),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 404);

    // A `..` path never becomes a stored row.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"../outside","user_id":"{sam}","caps":"view"}}"#
            ),
            Some(&cookie),
            Some(&csrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn upload_only_member_gets_counts_not_the_roster() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, _mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "upload").await;
    make_link(
        &app,
        &cookie,
        &csrf,
        r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"view"}"#,
    )
    .await;

    // Counts still render ("N people · M links") but neither the member
    // roster nor link details leave the manage-level gate.
    let (s, st) = subject(&app, &mcookie, "family").await;
    assert_eq!(s, 200, "{st}");
    assert_eq!(st["my_caps"], "upload");
    assert_eq!(st["member_count"], 1, "{st}");
    assert_eq!(st["link_count"], 1, "{st}");
    assert_eq!(st["members"].as_array().unwrap().len(), 0, "{st}");
    assert_eq!(st["links"].as_array().unwrap().len(), 0, "{st}");
}

#[tokio::test]
async fn equal_cap_members_cannot_touch_each_others_rows() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let (mcookie, mcsrf, sam) = member(&app, &cookie, &csrf, "sam").await;
    let (_jcookie, _jcsrf, jules) = member(&app, &cookie, &csrf, "jules").await;
    add_member(&app, &cookie, &csrf, "family", &sam, "view").await;
    add_member(&app, &cookie, &csrf, "family", &jules, "view").await;

    // Admin reads the roster to learn the row ids.
    let (_, st) = subject(&app, &cookie, "family").await;
    let row_of = |uid: &str| {
        st["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["user_id"] == uid)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let jules_row = row_of(&jules);
    let sam_row = row_of(&sam);

    // Same caps, no manage bar: Sam cannot retune or remove Jules's row.
    let res = call(
        &app,
        json_req(
            Method::PATCH,
            &format!("/api/v1/access/members/{jules_row}"),
            r#"{"caps":"view"}"#,
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 403);
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            &format!("/api/v1/access/members/{jules_row}"),
            "",
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 403);
    // Re-granting Jules (the retune path through add_member) fails too.
    let res = call(
        &app,
        json_req(
            Method::POST,
            "/api/v1/access/members",
            &format!(
                r#"{{"kind":"path","drive_id":"photos","path":"family","user_id":"{jules}","caps":"view"}}"#
            ),
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 403);

    // Leaving your own share still works without the manage bar.
    let res = call(
        &app,
        json_req(
            Method::DELETE,
            &format!("/api/v1/access/members/{sam_row}"),
            "",
            Some(&mcookie),
            Some(&mcsrf),
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn one_link_cannot_drive_another_links_upload() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(mount.path().join("family")).unwrap();
    let (_dir, app) = test_app(mount.path());
    let (cookie, csrf) = admin(&app).await;
    let body = r#"{"kind":"folder","drive_id":"photos","path":"family","caps":"full"}"#;
    let t1 = make_link(&app, &cookie, &csrf, body).await["token"]
        .as_str()
        .unwrap()
        .to_string();
    let t2 = make_link(&app, &cookie, &csrf, body).await["token"]
        .as_str()
        .unwrap()
        .to_string();

    // Link A opens an upload session inside the shared folder…
    let res = call(
        &app,
        json_req(
            Method::POST,
            &format!("/s/{t1}/upload"),
            r#"{"name":"a.bin","size":4}"#,
            None,
            None,
        ),
    )
    .await;
    assert_eq!(res.status(), 200);
    let up = body_json(res).await;
    let upload_id = up["upload_id"].as_str().unwrap();

    // …which link B — same folder, same caps — must not drive.
    let res = call(
        &app,
        put_chunk(&format!("/s/{t2}/upload/{upload_id}"), b"data"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Link A still owns it.
    let res = call(
        &app,
        put_chunk(&format!("/s/{t1}/upload/{upload_id}"), b"data"),
    )
    .await;
    assert_eq!(res.status(), 200);
}
