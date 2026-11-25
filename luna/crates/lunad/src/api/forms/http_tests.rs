use crate::api;
use crate::drives::DriveManager;
use crate::drives::mount::shared_mock;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request as HttpReq, StatusCode};
use serde_json::Value;
use std::net::SocketAddr;
use tower::ServiceExt;
use uuid::Uuid;

const CLIENT: SocketAddr = SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
    54321,
);

const FORM_DOC: &str = r#"{
    "version": 1,
    "title": "Family reunion RSVP",
    "settings": { "collecting": true, "allowEdits": true, "responseLimit": "one" },
    "questions": [
        { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
          "config": { "options": ["Yes", "No"] } }
    ]
}"#;

fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router, crate::AppState) {
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
    crate::drives::drive_db::create(
        mount,
        &luna_core::marker::Marker::new("photos", "Photos"),
        &luna_core::marker::pick_prefix(mount).unwrap(),
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
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::api::public_limits::limit_public_requests,
        ))
        .with_state(state.clone());
    (dir, app, state)
}

/// Insert an access link row directly — tests shouldn't depend on the
/// link-management endpoint's shape while sharing is reworked.
/// The account the test links belong to. Luna answers share links only once
/// it has an account, and a real link always has one behind it.
fn ensure_link_creator(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
         VALUES ('test', 'test', 'Test', 'unused', 'admin', 0, 0)",
        [],
    )
    .unwrap();
}

fn insert_link(state: &crate::AppState, path: &str, caps: i64) -> String {
    let token = Uuid::new_v4().simple().to_string();
    let conn = state.db.lock().unwrap();
    ensure_link_creator(&conn);
    crate::db::insert_access_link(
        &conn,
        &crate::db::AccessLinkRow {
            id: Uuid::new_v4().to_string(),
            token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
            token: token.clone(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "photos".into(),
            path: path.into(),
            album_id: String::new(),
            caps,
            password_hash: String::new(),
            expires_at: None,
            created_by: "test".into(),
            created_at: 0,
        },
    )
    .unwrap();
    token
}

fn req(method: Method, uri: &str, body: &str) -> HttpReq<Body> {
    let mut http = HttpReq::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
    app.clone().oneshot(r).await.unwrap()
}

async fn body_json(res: axum::response::Response) -> Value {
    let body = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn respond_get_serves_the_form_not_the_bytes() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    // GET /s/{token} must dispatch respond links to the form document —
    // never a file listing, never the raw bytes.
    let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["kind"], "form");
    assert_eq!(v["form"]["title"], "Family reunion RSVP");
    assert_eq!(v["form"]["questions"][0]["id"], "q_1");
    assert!(v.get("entries").is_none(), "must not list files: {v}");
}

#[tokio::test]
async fn respond_stores_sqlite_and_edits_reuse_the_id() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    // New answer → appended to the sibling file. A client-supplied
    // edit_token is ignored on new submissions — Luna mints the secret.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"Yes"},"edit_token":"x"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    let id = v["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("r_"));
    let edit_token = v["edit_token"].as_str().unwrap().to_string();
    assert_ne!(edit_token, "x", "client-chosen secrets are not stored");
    assert!(edit_token.len() >= 16, "minted secrets carry entropy");

    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    let store = super::store::FormStore::open(&db).unwrap();
    let rec = store.get(&id).unwrap().unwrap();
    // The database stores the blake3 hash of the minted secret, never raw.
    assert_eq!(
        rec.edit_hash,
        blake3::hash(edit_token.as_bytes()).to_hex().to_string()
    );
    assert_ne!(rec.edit_hash, edit_token);

    // The respondent can re-fetch their own answers with the secret.
    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{token}/respond?edit_token={edit_token}"),
            "",
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["id"], id);
    assert_eq!(v["answers"]["q_1"], "Yes");

    // An edit appends a second line with the SAME id.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(
                r#"{{"answers":{{"q_1":"No"}},"edit_token":"{edit_token}","response_id":"{id}"}}"#
            ),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await["id"], id);
    let store = super::store::FormStore::open(&db).unwrap();
    assert_eq!(store.live_count().unwrap(), 1);
    assert_eq!(store.get(&id).unwrap().unwrap().answers["q_1"], "No");

    // The wrong secret can't touch someone else's response.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(
                r#"{{"answers":{{"q_1":"Maybe"}},"edit_token":"wrong","response_id":"{id}"}}"#
            ),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A view-only link can't collect answers at all.
    let view_token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_VIEW);
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{view_token}/respond"),
            r#"{"answers":{"q_1":"Yes"},"edit_token":"x"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn respond_requires_the_required_answers() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    // q_1 is required — an empty submission is refused with 400.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{},"edit_token":"x"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    if db.is_file() {
        assert_eq!(
            super::store::FormStore::open(&db)
                .unwrap()
                .live_count()
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn respond_refuses_edits_when_the_form_disallows_them() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(
        mount.path().join("rsvp.lunaform"),
        FORM_DOC.replace("\"allowEdits\": true", "\"allowEdits\": false"),
    )
    .unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    // A first answer with no edit material still goes through…
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"Yes"}}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    let id = v["id"].as_str().unwrap().to_string();
    // …and no usable edit secret comes back.
    assert!(v["edit_token"].is_null(), "no edit secret returned: {v}");

    // …but anything shaped like an edit is refused outright.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"No"},"edit_token":"whatever"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(r#"{{"answers":{{"q_1":"No"}},"response_id":"{id}"}}"#),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The answer lookup that powers edit mode is refused too.
    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{token}/respond?edit_token=whatever"),
            "",
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // None of the refusals touched the database — still just the one record.
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    assert_eq!(
        super::store::FormStore::open(&db)
            .unwrap()
            .live_count()
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn respond_refuses_a_closed_form() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(
        mount.path().join("rsvp.lunaform"),
        FORM_DOC.replace("\"collecting\": true", "\"collecting\": false"),
    )
    .unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    // The form document still loads (so the SPA can say it's closed)…
    let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await["form"]["settings"]["collecting"],
        false
    );

    // …but answers are refused.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"Yes"},"edit_token":"x"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cap_blocks_new_answers_and_uploads_wait_until_sent() {
    let mount = tempfile::tempdir().unwrap();
    let doc = r#"{
        "version": 1,
        "title": "Potluck",
        "settings": { "collecting": true, "allowEdits": true, "maxResponses": 1 },
        "questions": [
            { "id": "q_1", "type": "choice", "label": "Coming?", "required": true,
              "config": { "options": ["Yes", "No"] } },
            { "id": "q_file", "type": "file", "label": "Photo" }
        ]
    }"#;
    std::fs::write(mount.path().join("rsvp.lunaform"), doc).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    let boundary = "----lunaformboundary";
    let mut raw = Vec::new();
    raw.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"note.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
        )
        .as_bytes(),
    );
    raw.extend(b"%PDF-1.1\n");
    raw.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri(format!("/s/{token}/respond-file"))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("accept", "application/json")
        .body(Body::from(raw))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(&app, http).await;
    assert_eq!(res.status(), StatusCode::OK, "{:?}", res.status());
    let uploaded = body_json(res).await;
    let name = uploaded["name"].as_str().unwrap().to_string();
    assert!(super::upload_name_ok(&name), "{name}");
    let files = files_dir(&state, "rsvp.lunaform");
    // Unsent: waiting in the hidden folder's pending area.
    assert!(files.join(super::PENDING_DIR).join(&name).is_file());

    let body =
        format!(r#"{{"answers":{{"q_1":"Yes","q_file":"{name}"}},"edit_token":"secret-one"}}"#);
    let res = call(
        &app,
        req(Method::POST, &format!("/s/{token}/respond"), &body),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    // The presented secret is throwaway — Luna mints the real one and
    // hands it back; the amendment must carry that token.
    let submitted = body_json(res).await;
    let id = submitted["id"].as_str().unwrap().to_string();
    let secret = submitted["edit_token"].as_str().unwrap().to_string();
    // Sending claimed it: out of pending, kept with the answers.
    assert!(files.join(&name).is_file());
    assert!(!files.join(super::PENDING_DIR).join(&name).exists());

    let res = call(&app, req(Method::GET, &format!("/s/{token}"), "")).await;
    let loaded = body_json(res).await;
    assert_eq!(loaded["full"], true);
    assert_eq!(loaded["accepting"], true);

    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"No"},"edit_token":"someone-else"}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let edit = format!(
        r#"{{"answers":{{"q_1":"No","q_file":"{name}"}},"edit_token":"{secret}","response_id":"{id}"}}"#
    );
    let res = call(
        &app,
        req(Method::POST, &format!("/s/{token}/respond"), &edit),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// The form's files folder, as the routes resolve it.
fn files_dir(state: &crate::AppState, rel: &str) -> std::path::PathBuf {
    let conn = state.db.lock().unwrap();
    super::resolve_form(&conn, "photos", rel).unwrap().files
}

const FILE_FORM: &str = r#"{
    "version": 1,
    "title": "Receipts",
    "settings": { "collecting": true, "allowEdits": true },
    "questions": [
        { "id": "q_file", "type": "file", "label": "Receipt", "image": "00000000000000aa.png" }
    ]
}"#;

/// Upload one small PDF through a respond link; returns the minted name.
async fn upload_pdf(app: &axum::Router, token: &str) -> String {
    let boundary = "----lunaformboundary";
    let mut raw = Vec::new();
    raw.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"r.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
        )
        .as_bytes(),
    );
    raw.extend(b"%PDF-1.1\n");
    raw.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut http = HttpReq::builder()
        .method(Method::POST)
        .uri(format!("/s/{token}/respond-file"))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .header("accept", "application/json")
        .body(Body::from(raw))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    let res = call(app, http).await;
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res).await["name"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn files_folder_is_luna_owned_and_unsent_uploads_expire() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("receipts.lunaform"), FILE_FORM).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "receipts.lunaform", crate::access::CAP_RESPOND);
    let files = files_dir(&state, "receipts.lunaform");
    // Listings, search, Photos, zips, and the files API skip it.
    let folder = files.file_name().unwrap().to_str().unwrap();
    assert!(crate::files::is_internal_temp(folder), "{folder}");

    let old = upload_pdf(&app, &token).await;
    let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
    std::fs::File::options()
        .write(true)
        .open(files.join(super::PENDING_DIR).join(&old))
        .unwrap()
        .set_modified(stale)
        .unwrap();
    // The next upload sweeps anything nobody sent within the hour.
    let fresh = upload_pdf(&app, &token).await;
    assert!(!files.join(super::PENDING_DIR).join(&old).exists());
    assert!(files.join(super::PENDING_DIR).join(&fresh).is_file());
}

#[tokio::test]
async fn answers_can_only_name_their_own_unsent_uploads() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("receipts.lunaform"), FILE_FORM).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "receipts.lunaform", crate::access::CAP_RESPOND);
    let files = files_dir(&state, "receipts.lunaform");
    std::fs::create_dir_all(&files).unwrap();
    // The question's own picture sits in the same folder.
    std::fs::write(files.join("00000000000000aa.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    let send = |name: &str| {
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(r#"{{"answers":{{"q_file":"{name}"}}}}"#),
        )
    };
    let res = call(&app, send("00000000000000aa.png")).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // A sent attachment can't be claimed again by a second answer.
    let name = upload_pdf(&app, &token).await;
    let res = call(&app, send(&name)).await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = call(&app, send(&name)).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn edits_and_deletes_remove_attachments_but_keep_pictures() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("receipts.lunaform"), FILE_FORM).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "receipts.lunaform", crate::access::CAP_RESPOND);
    let files = files_dir(&state, "receipts.lunaform");

    let first = upload_pdf(&app, &token).await;
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(r#"{{"answers":{{"q_file":"{first}"}}}}"#),
        ),
    )
    .await;
    let sent = body_json(res).await;
    let id = sent["id"].as_str().unwrap().to_string();
    let secret = sent["edit_token"].as_str().unwrap().to_string();

    // Editing to a new file drops the old one.
    let second = upload_pdf(&app, &token).await;
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            &format!(
                r#"{{"answers":{{"q_file":"{second}"}},"edit_token":"{secret}","response_id":"{id}"}}"#
            ),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!files.join(&first).exists());
    assert!(files.join(&second).is_file());

    // Deleting the response removes its file; the question picture stays.
    std::fs::write(files.join("00000000000000aa.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    let form = {
        let conn = state.db.lock().unwrap();
        super::resolve_form(&conn, "photos", "receipts.lunaform").unwrap()
    };
    let _ = super::delete_response(&state, "photos", &form, Some(&id)).unwrap();
    assert!(!files.join(&second).exists());
    assert!(files.join("00000000000000aa.png").is_file());
}

#[tokio::test]
async fn form_file_route_shows_pictures_to_viewers_and_attachments_to_managers() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("receipts.lunaform"), FILE_FORM).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let respond = insert_link(&state, "receipts.lunaform", crate::access::CAP_RESPOND);
    let files = files_dir(&state, "receipts.lunaform");
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("00000000000000aa.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    let name = upload_pdf(&app, &respond).await;
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{respond}/respond"),
            &format!(r#"{{"answers":{{"q_file":"{name}"}}}}"#),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let get = |token: &str, file: &str| {
        req(
            Method::GET,
            &format!("/s/{token}/form-file?name={file}"),
            "",
        )
    };
    let view = insert_link(&state, "receipts.lunaform", crate::access::CAP_VIEW);
    let res = call(&app, get(&view, "00000000000000aa.png")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "image/png");
    let res = call(&app, get(&view, &name)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let full = insert_link(&state, "receipts.lunaform", crate::access::CAP_ALL);
    let res = call(&app, get(&full, &name)).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "application/pdf");
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
}

fn insert_link_full(
    state: &crate::AppState,
    path: &str,
    caps: i64,
    password_hash: &str,
    expires_at: Option<i64>,
) -> String {
    let token = Uuid::new_v4().simple().to_string();
    let conn = state.db.lock().unwrap();
    ensure_link_creator(&conn);
    crate::db::insert_access_link(
        &conn,
        &crate::db::AccessLinkRow {
            id: Uuid::new_v4().to_string(),
            token_hash: blake3::hash(token.as_bytes()).to_hex().to_string(),
            token: token.clone(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "photos".into(),
            path: path.into(),
            album_id: String::new(),
            caps,
            password_hash: password_hash.into(),
            expires_at,
            created_by: "test".into(),
            created_at: 0,
        },
    )
    .unwrap();
    token
}

fn write_answers(mount: &std::path::Path) {
    let db = super::store::db_path_for(&mount.join("rsvp.lunaform")).unwrap();
    let mut store = super::store::FormStore::open(&db).unwrap();
    let mut answers = serde_json::Map::new();
    answers.insert("q_1".into(), Value::String("Yes".into()));
    store.insert("r_1", "HASHSECRET", 1, &answers).unwrap();
    answers.insert("q_1".into(), Value::String("No".into()));
    store.update("r_1", 2, &answers).unwrap();
}

async fn register_and_login(
    app: &axum::Router,
    username: &str,
    password: &str,
) -> (String, String) {
    let res = call(
        app,
        req(
            Method::POST,
            "/api/v1/auth/register",
            &format!(
                r#"{{"username":"{username}","display_name":"{username}","password":"{password}"}}"#
            ),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    login(app, username, password).await
}

async fn login(app: &axum::Router, username: &str, password: &str) -> (String, String) {
    let res = call(
        app,
        req(
            Method::POST,
            "/api/v1/auth/login",
            &format!(r#"{{"username":"{username}","password":"{password}"}}"#),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let mut session = String::new();
    let mut csrf = String::new();
    for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
        let s = value.to_str().unwrap();
        let part = s.split(';').next().unwrap_or("");
        if part.starts_with("luna_session=") {
            session = part.to_string();
        } else if let Some(t) = part.strip_prefix("luna_csrf=") {
            csrf = t.to_string();
        }
    }
    (format!("{session}; luna_csrf={csrf}"), csrf)
}

fn authed_req(method: Method, uri: &str, cookie: &str) -> HttpReq<Body> {
    let mut http = HttpReq::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

fn authed_bytes(
    method: Method,
    uri: &str,
    cookie: &str,
    csrf: &str,
    bytes: Vec<u8>,
) -> HttpReq<Body> {
    let mut http = HttpReq::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .header("content-type", "application/vnd.sqlite3")
        .body(Body::from(bytes))
        .unwrap();
    http.extensions_mut().insert(ConnectInfo(CLIENT));
    http
}

/// Collected answers are manager data: only a full (edit-capable) link
/// on the form opens them — minus the stored edit hashes — with
/// no-store/no-referrer headers. View links are refused.
#[tokio::test]
async fn guest_full_link_reads_responses_view_link_denied() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    write_answers(mount.path());
    let (_dir, app, state) = test_app(mount.path());

    // A view link can open the form but never reads collected answers.
    let view = insert_link(&state, "rsvp.lunaform", crate::access::CAP_VIEW);
    let res = call(&app, req(Method::GET, &format!("/s/{view}/responses"), "")).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_ALL);
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert_eq!(res.headers()["referrer-policy"], "no-referrer");
    let v = body_json(res).await;
    // Edits collapse to the latest version of each response.
    let answers = v["responses"].as_array().unwrap();
    assert_eq!(answers.len(), 1);
    assert!(answers.iter().all(|r| r.get("edit").is_none()));
    assert_eq!(answers[0]["answers"]["q_1"], "No");
    assert_eq!(answers[0]["sent_at"], 1);

    // The file list's badge asks for the count alone.
    let res = call(
        &app,
        req(Method::GET, &format!("/s/{token}/responses?count=1"), ""),
    )
    .await;
    assert_eq!(body_json(res).await, serde_json::json!({ "count": 1 }));

    // A view link can't delete; a full link can, once.
    let res = call(
        &app,
        req(Method::DELETE, &format!("/s/{view}/responses?id=r_1"), ""),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = call(
        &app,
        req(Method::DELETE, &format!("/s/{token}/responses?id=r_1"), ""),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = call(
        &app,
        req(Method::DELETE, &format!("/s/{token}/responses?id=r_1"), ""),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert_eq!(
        body_json(res).await["responses"].as_array().unwrap().len(),
        0
    );
    write_answers(mount.path());

    // Folder links resolve the file beneath their root.
    let folder = insert_link(&state, "", crate::access::CAP_ALL);
    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{folder}/responses?path=rsvp.lunaform"),
            "",
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await["responses"].as_array().unwrap().len(),
        1
    );
}

/// Respond links collect answers but must never read anyone's back;
/// traversal, expired, and wrong-password links all fail.
#[tokio::test]
async fn responses_route_denies_respond_traversal_expired_and_password() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    write_answers(mount.path());
    let (_dir, app, state) = test_app(mount.path());

    let respond = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);
    let res = call(
        &app,
        req(Method::GET, &format!("/s/{respond}/responses"), ""),
    )
    .await;
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "respond can't read answers"
    );

    // Full links get past the answers cap gate — traversal and scope
    // checks must still hold.
    let folder = insert_link(&state, "", crate::access::CAP_ALL);
    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{folder}/responses?path=../rsvp.lunaform"),
            "",
        ),
    )
    .await;
    assert!(res.status().is_client_error(), "traversal must fail");

    // A path that names the sibling file itself is not a form.
    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{folder}/responses?path=.rsvp.lunaform.responses.sqlite"),
            "",
        ),
    )
    .await;
    assert!(res.status().is_client_error());

    let expired = insert_link_full(
        &state,
        "rsvp.lunaform",
        crate::access::CAP_ALL,
        "",
        Some(crate::db::now_unix() - 60),
    );
    let res = call(
        &app,
        req(Method::GET, &format!("/s/{expired}/responses"), ""),
    )
    .await;
    assert_eq!(res.status(), StatusCode::GONE);

    let gated = insert_link_full(
        &state,
        "rsvp.lunaform",
        crate::access::CAP_ALL,
        &crate::auth::hash_password_unchecked("right-password").unwrap(),
        None,
    );
    let res = call(&app, req(Method::GET, &format!("/s/{gated}/responses"), "")).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let mut wrong = req(Method::GET, &format!("/s/{gated}/responses"), "");
    *wrong.headers_mut() = wrong.headers().clone();
    wrong
        .headers_mut()
        .insert("x-share-password", "wrong-password".parse().unwrap());
    let res = call(&app, wrong).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// A missing sibling means "no answers yet" — but a symlinked sibling is a
/// real error, and an oversized one is skipped with a notice instead of
/// pretending the form has no answers at all.
#[tokio::test]
async fn responses_missing_empty_symlink_and_oversize_notice() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_ALL);

    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await["responses"].as_array().unwrap().len(),
        0
    );

    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    std::os::unix::fs::symlink("/etc/hostname", &db).unwrap();
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert!(res.status().is_server_error(), "symlink answers must fail");
    std::fs::remove_file(&db).unwrap();

    std::fs::write(&db, b"this is not a sqlite database").unwrap();
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert!(
        res.status().is_server_error(),
        "a corrupt answers database must fail"
    );
}

/// Read members can read answers — the list, summary, download and editor —
/// while delete/clear/save still need Write. That is the decided model.
#[tokio::test]
async fn read_member_reads_responses_and_delete_needs_write() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    write_answers(mount.path());
    let (_dir, app, state) = test_app(mount.path());
    let (admin_cookie, _csrf) = register_and_login(&app, "max", "hunter22hunter1").await;

    {
        let conn = state.db.lock().unwrap();
        crate::db::insert_user(&conn, "u-ann", "ann", "Ann", "unused", "member").unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "m-ann".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "rsvp.lunaform".into(),
                album_id: String::new(),
                user_id: "u-ann".into(),
                caps: crate::access::CAP_ALL,
                created_by: "u".into(),
            },
        )
        .unwrap();
        // View-only member with Read on the folder: can open the form and
        // read its answers, but cannot change them.
        crate::db::insert_user(&conn, "u-bob", "bob", "Bob", "unused", "member").unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "m-bob".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: String::new(),
                album_id: String::new(),
                user_id: "u-bob".into(),
                caps: crate::access::CAP_VIEW,
                created_by: "u".into(),
            },
        )
        .unwrap();
    }
    // Give Ann and Bob real session rows by minting logins — simplest is
    // the HTTP flow, so set their passwords to something they can use.
    {
        let conn = state.db.lock().unwrap();
        for (id, pw) in [("u-ann", "ann-password"), ("u-bob", "bob-password")] {
            let hash = crate::auth::hash_password_unchecked(pw).unwrap();
            conn.execute(
                "UPDATE users SET password_hash=?1 WHERE id=?2",
                rusqlite::params![hash, id],
            )
            .unwrap();
        }
    }
    let (ann_cookie, ann_csrf) = login(&app, "ann", "ann-password").await;
    let (bob_cookie, bob_csrf) = login(&app, "bob", "bob-password").await;

    // Read member: the Responses list is readable, and the file itself is
    // readable. Deleting still needs Write.
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
            &bob_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await["responses"].as_array().unwrap().len(),
        1
    );
    let res = call(
        &app,
        authed_bytes(
            Method::DELETE,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform&id=r_1",
            &bob_cookie,
            &bob_csrf,
            Vec::new(),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/drives/photos/files/content?path=.rsvp.lunaform.responses.sqlite",
            &bob_cookie,
        ),
    )
    .await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "a Read member can read the answers file"
    );

    // The SQLite route is the same read path for ordinary and private forms.
    // Read can open the database; only CAP_EDIT can replace it.
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/sqlite?drive_id=photos&path=rsvp.lunaform",
            &bob_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let revision = res
        .headers()
        .get("x-form-revision")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let bytes = axum::body::to_bytes(res.into_body(), 20 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    assert!(bytes.starts_with(b"SQLite format 3"));
    let save_uri =
        format!("/api/v1/forms/sqlite?drive_id=photos&path=rsvp.lunaform&revision={revision}");
    let res = call(
        &app,
        authed_bytes(
            Method::PUT,
            &save_uri,
            &bob_cookie,
            &bob_csrf,
            bytes.clone(),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // An answer arrives while the editor holds its copy. Saving the old
    // revision must refuse rather than overwrite that answer.
    let respond = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{respond}/respond"),
            r#"{"answers":{"q_1":"No"}}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = call(
        &app,
        authed_bytes(
            Method::PUT,
            &save_uri,
            &ann_cookie,
            &ann_csrf,
            bytes.clone(),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // Reloading after the conflict gives a snapshot with both answers and a
    // fresh revision; this save is accepted, and its own old revision is not.
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/sqlite?drive_id=photos&path=rsvp.lunaform",
            &ann_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let fresh_revision = res
        .headers()
        .get("x-form-revision")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let fresh = axum::body::to_bytes(res.into_body(), 20 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    let fresh_uri = format!(
        "/api/v1/forms/sqlite?drive_id=photos&path=rsvp.lunaform&revision={fresh_revision}"
    );
    let res = call(
        &app,
        authed_bytes(
            Method::PUT,
            &fresh_uri,
            &ann_cookie,
            &ann_csrf,
            fresh.clone(),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = call(
        &app,
        authed_bytes(Method::PUT, &fresh_uri, &ann_cookie, &ann_csrf, fresh),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform&count=1",
            &ann_cookie,
        ),
    )
    .await;
    assert_eq!(body_json(res).await["count"], 2);

    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
            &ann_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["responses"].as_array().unwrap().len(), 2);
    assert!(
        v["responses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("edit").is_none())
    );

    // Admin reads them too; a member with no grant is refused.
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
            &admin_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    {
        let conn = state.db.lock().unwrap();
        crate::db::delete_access_member(&conn, "m-ann").unwrap();
    }
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
            &ann_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

/// The summary keeps value counts for choice questions but never ships every
/// distinct free-text answer; usage reports the form's storage without
/// answers.
#[tokio::test]
async fn summary_filters_text_values_and_usage_reports_storage() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(
        mount.path().join("rsvp.lunaform"),
        r#"{
    "version": 1,
    "title": "Feedback",
    "settings": { "collecting": true, "allowEdits": true },
    "questions": [
        { "id": "q_1", "type": "choice", "label": "Coming?", "config": { "options": ["Yes", "No"] } },
        { "id": "q_2", "type": "long_text", "label": "Anything else?" }
    ]
}"#,
    )
    .unwrap();
    let (_dir, app, _state) = test_app(mount.path());
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    let mut store = super::store::FormStore::open(&db).unwrap();
    for (i, (choice, note)) in [("Yes", "first note"), ("No", "second note")]
        .into_iter()
        .enumerate()
    {
        let mut answers = serde_json::Map::new();
        answers.insert("q_1".into(), Value::String(choice.into()));
        answers.insert("q_2".into(), Value::String(note.into()));
        store
            .insert(&format!("r_{i}"), "h", i as i64, &answers)
            .unwrap();
    }
    drop(store);
    let (cookie, _csrf) = register_and_login(&app, "max", "hunter22hunter1").await;

    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/summary?drive_id=photos&path=rsvp.lunaform",
            &cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res).await;
    assert_eq!(body["total"], 2);
    let questions = body["questions"].as_array().unwrap();
    let choice = questions.iter().find(|q| q["id"] == "q_1").unwrap();
    assert_eq!(choice["answered"], 2);
    assert_eq!(choice["values"].as_array().unwrap().len(), 2);
    let text = questions.iter().find(|q| q["id"] == "q_2").unwrap();
    assert_eq!(text["answered"], 2);
    assert_eq!(text["values"].as_array().unwrap().len(), 0);

    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/usage?drive_id=photos&path=rsvp.lunaform",
            &cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let usage = body_json(res).await;
    assert!(usage["used_bytes"].as_u64().unwrap() > 0);
    assert!(usage["quota_bytes"].as_u64().unwrap() > 0);
}

/// The owner can reset a form: every answer and respondent attachment goes,
/// the revision moves, and the count drops to zero.
#[tokio::test]
async fn owner_can_clear_all_answers() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    write_answers(mount.path());
    let (_dir, app, state) = test_app(mount.path());
    let (cookie, csrf) = register_and_login(&app, "max", "hunter22hunter1").await;

    let res = call(
        &app,
        authed_bytes(
            Method::DELETE,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform&clear=1",
            &cookie,
            &csrf,
            Vec::new(),
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform&count=1",
            &cookie,
        ),
    )
    .await;
    assert_eq!(body_json(res).await["count"], 0);
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    assert_eq!(
        super::store::FormStore::open(&db)
            .unwrap()
            .live_count()
            .unwrap(),
        0
    );
    let _ = state;
}

/// Answers are paged in SQLite: each request carries a bounded page and the
/// total, so the browser never has to receive the whole store.
#[tokio::test]
async fn responses_are_paged_and_counted() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(mount.path().join("rsvp.lunaform"), FORM_DOC).unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    let mut store = super::store::FormStore::open(&db).unwrap();
    let mut answers = serde_json::Map::new();
    answers.insert("q_1".into(), Value::String("Yes".into()));
    for i in 0..250 {
        store
            .insert(&format!("r_{i:03}"), "h", i, &answers)
            .unwrap();
    }
    let full = insert_link(&state, "rsvp.lunaform", crate::access::CAP_ALL);

    let res = call(
        &app,
        req(Method::GET, &format!("/s/{full}/responses?limit=100"), ""),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let v = body_json(res).await;
    assert_eq!(v["responses"].as_array().unwrap().len(), 100);
    assert_eq!(v["total"], 250);
    assert_eq!(v["next_offset"], 100);
    assert_eq!(v["responses"][0]["id"], "r_000");

    let res = call(
        &app,
        req(
            Method::GET,
            &format!("/s/{full}/responses?offset=200&limit=100"),
            "",
        ),
    )
    .await;
    let v = body_json(res).await;
    assert_eq!(v["responses"].as_array().unwrap().len(), 50);
    assert!(v["next_offset"].is_null());

    let res = call(
        &app,
        req(Method::GET, &format!("/s/{full}/responses?count=1"), ""),
    )
    .await;
    assert_eq!(body_json(res).await["count"], 250);
}

/// `maxResponses` counts live SQLite rows; the cap check and insert share
/// the same per-form lock.
#[tokio::test]
async fn max_responses_counts_live_rows() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(
        mount.path().join("rsvp.lunaform"),
        r#"{
    "version": 1,
    "title": "Potluck",
    "settings": { "collecting": true, "allowEdits": true, "maxResponses": 2 },
    "questions": [
        { "id": "q_1", "type": "short_text", "label": "Name", "required": true }
    ]
}"#,
    )
    .unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    let mut store = super::store::FormStore::open(&db).unwrap();
    let mut answers = serde_json::Map::new();
    answers.insert("q_1".into(), Value::String("Ann".into()));
    store.insert("r_1", "h1", 1, &answers).unwrap();
    answers.insert("q_1".into(), Value::String("Bob".into()));
    store.insert("r_2", "h2", 2, &answers).unwrap();
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_1":"Cara"}}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res).await["error"],
        "This form has all the answers it can take."
    );

    let full = insert_link(&state, "rsvp.lunaform", crate::access::CAP_ALL);
    let res = call(
        &app,
        req(Method::GET, &format!("/s/{full}/responses?count=1"), ""),
    )
    .await;
    assert_eq!(body_json(res).await["count"], 2);
}

/// One text answer is capped, a form's smaller `maxLength` is honoured, and
/// the refusal names the question. A real essay still goes through.
#[tokio::test]
async fn oversized_answers_are_refused_with_the_question_named() {
    let mount = tempfile::tempdir().unwrap();
    std::fs::write(
        mount.path().join("rsvp.lunaform"),
        r#"{
    "version": 1,
    "title": "Stories",
    "settings": { "collecting": true, "allowEdits": true },
    "questions": [
        { "id": "q_story", "type": "long_text", "label": "Your story" },
        { "id": "q_nick", "type": "short_text", "label": "Nickname",
          "config": { "maxLength": 5 } }
    ]
}"#,
    )
    .unwrap();
    let (_dir, app, state) = test_app(mount.path());
    let token = insert_link(&state, "rsvp.lunaform", crate::access::CAP_RESPOND);

    let huge = serde_json::json!({
        "answers": { "q_story": "x".repeat(super::MAX_ANSWER_TEXT_BYTES + 1) }
    })
    .to_string();
    let res = call(
        &app,
        req(Method::POST, &format!("/s/{token}/respond"), &huge),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let v = body_json(res).await;
    assert!(
        v["error"].as_str().unwrap().contains("Your story"),
        "the refusal names the question: {v}"
    );
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    if db.is_file() {
        assert_eq!(
            super::store::FormStore::open(&db)
                .unwrap()
                .live_count()
                .unwrap(),
            0
        );
    }

    // The form's own smaller limit wins and is named too.
    let res = call(
        &app,
        req(
            Method::POST,
            &format!("/s/{token}/respond"),
            r#"{"answers":{"q_nick":"abcdef"}}"#,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let v = body_json(res).await;
    assert!(v["error"].as_str().unwrap().contains("Nickname"), "{v}");

    // A real essay is well under the cap.
    let essay = "It was a long day. ".repeat(500);
    let body = serde_json::json!({ "answers": { "q_story": essay } }).to_string();
    let res = call(
        &app,
        req(Method::POST, &format!("/s/{token}/respond"), &body),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let db = super::store::db_path_for(&mount.path().join("rsvp.lunaform")).unwrap();
    let store = super::store::FormStore::open(&db).unwrap();
    assert_eq!(store.live_count().unwrap(), 1, "the essay was stored");

    // Many answers that each pass still have to fit the payload cap.
    let questions: Vec<Value> = (0..5)
        .map(|i| {
            serde_json::json!({
                "id": format!("q_{i}"),
                "type": "long_text",
                "label": format!("Essay {i}")
            })
        })
        .collect();
    let doc = serde_json::json!({
        "version": 1,
        "title": "Essays",
        "settings": { "collecting": true, "allowEdits": true },
        "questions": questions
    });
    std::fs::write(mount.path().join("essays.lunaform"), doc.to_string()).unwrap();
    let essays = insert_link(&state, "essays.lunaform", crate::access::CAP_RESPOND);
    let mut answers = serde_json::Map::new();
    for i in 0..5 {
        answers.insert(format!("q_{i}"), Value::String("y".repeat(30 * 1024)));
    }
    let body = serde_json::json!({ "answers": answers }).to_string();
    let res = call(
        &app,
        req(Method::POST, &format!("/s/{essays}/respond"), &body),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let v = body_json(res).await;
    assert!(
        v["error"].as_str().unwrap().contains("too long to save"),
        "{v}"
    );
}
