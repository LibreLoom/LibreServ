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
        .with_state(state.clone());
    (dir, app, state)
}

/// Insert an access link row directly — tests shouldn't depend on the
/// link-management endpoint's shape while sharing is reworked.
fn insert_link(state: &crate::AppState, path: &str, caps: i64) -> String {
    let token = Uuid::new_v4().simple().to_string();
    let conn = state.db.lock().unwrap();
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
async fn respond_appends_jsonl_and_edits_reuse_the_id() {
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

    let jsonl = std::fs::read_to_string(mount.path().join("rsvp.lunaform.responses")).unwrap();
    let rec: Value = serde_json::from_str(jsonl.trim()).unwrap();
    // The file stores the blake3 hash of the minted secret, never raw.
    assert_eq!(
        rec["edit"].as_str().unwrap(),
        blake3::hash(edit_token.as_bytes()).to_hex().to_string()
    );
    assert_ne!(rec["edit"].as_str().unwrap(), edit_token);

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
    let jsonl = std::fs::read_to_string(mount.path().join("rsvp.lunaform.responses")).unwrap();
    assert_eq!(jsonl.lines().count(), 2);

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
    assert!(!mount.path().join("rsvp.lunaform.responses").exists());
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

    // None of the refusals touched the file — still just the one record.
    let jsonl = std::fs::read_to_string(mount.path().join("rsvp.lunaform.responses")).unwrap();
    assert_eq!(jsonl.lines().count(), 1);
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
    // Listings, search, Gallery, zips, and the files API skip it.
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
    std::fs::write(
        mount.join("rsvp.lunaform.responses"),
        concat!(
            r#"{"id":"r_1","edit":"HASHSECRET","answers":{"q_1":"Yes"},"at":1}"#,
            "\n",
            r#"{"id":"r_1","edit":"HASHSECRET","answers":{"q_1":"No"},"at":2}"#,
            "\n"
        ),
    )
    .unwrap();
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
            &format!("/s/{folder}/responses?path=rsvp.lunaform.responses"),
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

/// A missing sibling means "no answers yet" — but a symlinked sibling or
/// an oversized one is a real error, never a silent empty list.
#[tokio::test]
async fn responses_missing_empty_symlink_and_oversize_denied() {
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

    let sibling = mount.path().join("rsvp.lunaform.responses");
    std::os::unix::fs::symlink("/etc/hostname", &sibling).unwrap();
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert!(res.status().is_client_error(), "symlink answers must fail");
    std::fs::remove_file(&sibling).unwrap();

    let f = std::fs::File::create(&sibling).unwrap();
    f.set_len(super::MAX_RESPONSES_READ_BYTES + 1).unwrap();
    drop(f);
    let res = call(&app, req(Method::GET, &format!("/s/{token}/responses"), "")).await;
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

/// A member with a full file grant reads the form's answers — no parent
/// folder access required — while a view-only member and a stranger get
/// nothing: collected answers are manager data.
#[tokio::test]
async fn member_full_grant_reads_responses_view_denied() {
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
        // View-only member: can open the form, must not read answers.
        crate::db::insert_user(&conn, "u-bob", "bob", "Bob", "unused", "member").unwrap();
        crate::db::insert_access_member(
            &conn,
            &crate::db::AccessMemberRow {
                id: "m-bob".into(),
                subject_kind: crate::access::KIND_PATH.into(),
                drive_id: "photos".into(),
                path: "rsvp.lunaform".into(),
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
    let (ann_cookie, _ann_csrf) = login(&app, "ann", "ann-password").await;
    let (bob_cookie, _bob_csrf) = login(&app, "bob", "bob-password").await;

    // View-only member: denied.
    let res = call(
        &app,
        authed_req(
            Method::GET,
            "/api/v1/forms/responses?drive_id=photos&path=rsvp.lunaform",
            &bob_cookie,
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

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
    assert_eq!(v["responses"].as_array().unwrap().len(), 1);
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
