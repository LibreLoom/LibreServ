use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::{delete, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::files::parse_range;
use crate::api::response::json_error;
use crate::files::uploads::{self, UploadError};
use crate::files::{self, FilesError};

const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024 * 1024; // 1 TiB

#[derive(Deserialize)]
struct CreateBody {
    drive_id: String,
    path: Option<String>,
    name: String,
    size: u64,
    /// Set once the person has chosen what to do about a name clash. Only
    /// "keep_both" is read here; the decision is applied at `complete`.
    #[serde(default)]
    on_conflict: Option<String>,
}

#[derive(Deserialize)]
struct CompleteQuery {
    overwrite: Option<String>,
    keep_both: Option<String>,
    hash: Option<String>,
}

pub fn router() -> Router<AppState> {
    // Chunk bodies are fully buffered (`Bytes`). Size from MemAvailable so a
    // 2 GiB Wyse never accepts a 1 GiB chunk into RAM. Floor matches the web UI.
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    Router::new()
        .route(
            "/api/v1/uploads",
            post(create).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/v1/uploads/{id}",
            put(write_chunk).layer(DefaultBodyLimit::max(chunk_max)),
        )
        .route("/api/v1/uploads/{id}/complete", post(complete))
        .route("/api/v1/uploads/{id}", delete(cancel))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_access(
        &state,
        &user,
        &body.drive_id,
        body.path.as_deref().unwrap_or(""),
    )?;
    if body.size > MAX_FILE_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't accept files larger than 1 TB.",
        ));
    }
    let path = body.path.unwrap_or_default();
    // Look before taking the bytes: a taken name needs a decision, and a drive
    // with too little room should say so now, not after the whole upload.
    let free_probe = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        // A folder that doesn't exist yet can't hold a clash, so no check.
        let dir = files::dest_dir(&conn, &body.drive_id, &path).ok();
        if let (Some(dir), Ok(safe)) = (&dir, files::safe_name(&body.name))
            && files::name_taken(dir, &safe)
            && body.on_conflict.is_none()
        {
            return Err(name_clash(Some(uploads::existing_kind(dir, &safe))));
        }
        dir.or_else(|| {
            files::drive_root(&conn, &body.drive_id)
                .ok()
                .map(|d| std::path::PathBuf::from(d.mount_point))
        })
    };
    if let Some(space) = free_probe.and_then(|p| crate::drives::summary::disk_space(&p))
        && space.free_bytes < body.size
    {
        return Err(json_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "This drive is full. Free up some space and try again.",
        ));
    }
    let upload = crate::db::with_db(
        &state.db,
        || UploadError::NotFound,
        |conn| {
            uploads::create_scoped(
                conn,
                &body.drive_id,
                &path,
                &body.name,
                body.size,
                &format!("user:{}", user.id),
            )
        },
    )
    .map_err(map_upload_err)?;
    Ok(Json(json!({
        "upload_id": upload.id,
        "received": upload.received,
        "size": upload.size,
        "name": upload.name,
    })))
}

async fn write_chunk(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id)?;
    let spec = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Each chunk needs a Content-Range header (bytes start-end/total).",
            )
        })?;

    // Content-Range for chunks is "bytes start-end/total". Strip the total —
    // the upload row's promised size is authoritative, not the client's claim.
    let range = spec
        .strip_prefix("bytes ")
        .and_then(|rest| rest.split('/').next())
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
    let (start, end) = parse_range(&format!("bytes={range}"), MAX_FILE_BYTES)
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "That chunk range isn't valid."))?;
    let expected = (end - start + 1) as usize;
    if body.len() != expected {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "The chunk size doesn't match its range.",
        ));
    }
    let chunk_max = crate::budget::limits().upload_chunk_bytes;
    if body.len() > chunk_max {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That upload chunk is too large for the free memory on this Luna. Try a smaller piece, or free some space and try again.",
        ));
    }

    let received = uploads::write_chunk(&state.db, &id, start, &body).map_err(map_upload_err)?;
    Ok(Json(json!({ "upload_id": id, "received": received })))
}

async fn complete(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Query(query): Query<CompleteQuery>,
) -> Result<Json<crate::files::FileEntry>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id)?;
    let overwrite = query.overwrite.as_deref() == Some("1");
    // Overwrite wins over keep-both when both are asked for.
    let keep_both = query.keep_both.as_deref() == Some("1") && !overwrite;
    let (drive_id, rel, exists, clash_kind) = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let row = uploads::get_row(&conn, &id).map_err(map_upload_err)?;
        let rel = crate::gallery::gallery_indexer::join_rel(&row.path, &row.name);
        let dir = crate::files::dest_dir(&conn, &row.drive_id, &row.path).ok();
        let exists = dir
            .as_ref()
            .is_some_and(|dir| crate::files::name_taken(dir, &row.name));
        let clash_kind = dir
            .as_ref()
            .filter(|_| exists)
            .map(|dir| uploads::existing_kind(dir, &row.name));
        (row.drive_id, rel, exists, clash_kind)
    };
    // Overwriting is an edit, not an upload: a drop-only member cannot
    // replace a file that is already there. Same rule as the multipart
    // upload path.
    if overwrite && exists {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        if !crate::auth::has_cap(&user, &conn, &drive_id, &rel, crate::access::CAP_EDIT) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to change this file.",
            ));
        }
    }
    let mut entry = uploads::complete(&state.db, &id, overwrite, keep_both, query.hash.as_deref())
        .map_err(|e| {
            if is_name_clash(&e) {
                name_clash(clash_kind)
            } else {
                map_upload_err(e)
            }
        })?;
    // Stamp the caller's real caps on the new file — the browser uses them
    // for row affordances (rename/delete/share) without a second lookup.
    if let Ok(conn) = state.db.lock() {
        entry.caps =
            crate::access::caps_to_str(crate::auth::caps_on_path(&user, &conn, &drive_id, &rel));
    }
    state.gallery.upsert(&drive_id, &rel);
    crate::api::files::invalidate_parent_listing(&state, &drive_id, &rel);
    state.touch_io_activity();
    Ok(Json(entry))
}

async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    check_upload_access(&state, &user, &id)?;
    uploads::cancel(&state.db, &id).map_err(map_upload_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn check_access(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if crate::auth::has_cap(user, &conn, drive_id, path, crate::access::CAP_UPLOAD) {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save here.",
        ))
    }
}

fn check_upload_access(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    upload_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let row = uploads::get_row(&conn, upload_id).map_err(map_upload_err)?;
    // Sessions belong to the principal that opened them — a member may only
    // drive their own `user:{id}` uploads. Admins keep the override.
    if user.role != "admin" && row.principal != format!("user:{}", user.id) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That upload belongs to someone else.",
        ));
    }
    // Reuse this lock — do not call check_access (it would deadlock on the
    // non-reentrant Mutex).
    if crate::auth::has_cap(
        user,
        &conn,
        &row.drive_id,
        &row.path,
        crate::access::CAP_UPLOAD,
    ) {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to save here.",
        ))
    }
}

/// The `409` for a name that is already taken. `existing_kind` says whether
/// a `"file"` or a `"dir"` holds it, when that is known.
pub(crate) fn name_clash(existing_kind: Option<&str>) -> (StatusCode, Json<Value>) {
    let message = if existing_kind == Some("dir") {
        "A folder with this name is already here. Choose another name."
    } else {
        "A file with this name is already here. Rename it or choose another."
    };
    let mut body = json!({ "error": message, "code": "exists" });
    if let Some(kind) = existing_kind {
        body["existing_kind"] = json!(kind);
    }
    (StatusCode::CONFLICT, Json(body))
}

pub(crate) fn is_name_clash(err: &UploadError) -> bool {
    matches!(
        err,
        UploadError::Files(FilesError::Io(e)) | UploadError::Io(e)
            if e.kind() == std::io::ErrorKind::AlreadyExists
    )
}

fn map_upload_err(err: UploadError) -> (StatusCode, Json<Value>) {
    match err {
        UploadError::NotFound => {
            json_error(StatusCode::NOT_FOUND, "Luna doesn't know this upload.")
        }
        UploadError::NotActive => json_error(
            StatusCode::CONFLICT,
            "This upload is already finished or cancelled.",
        ),
        UploadError::SizeMismatch => json_error(
            StatusCode::BAD_REQUEST,
            "That chunk doesn't fit this upload.",
        ),
        UploadError::Files(crate::files::FilesError::UnknownDrive) => json_error(
            StatusCode::NOT_FOUND,
            "Luna can't find this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.",
        ),
        UploadError::Files(crate::files::FilesError::MissingDriveDb) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            crate::files::MISSING_DRIVE_DB_MSG,
        ),
        UploadError::Files(crate::files::FilesError::Path(_)) => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't use that destination.")
        }
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            name_clash(None)
        }
        UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == std::io::ErrorKind::NotADirectory =>
        {
            json_error(StatusCode::BAD_REQUEST, "That destination is not a folder.")
        }
        UploadError::Io(e) if e.kind() == std::io::ErrorKind::AlreadyExists => name_clash(None),
        // Access was pulled (or never held) between session open and install.
        UploadError::Denied => json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to upload here.",
        ),
        // Bytes arrived but don't match the checksum the browser sent.
        UploadError::Io(e) if e.kind() == std::io::ErrorKind::InvalidData => json_error(
            StatusCode::BAD_REQUEST,
            "The file arrived damaged. Upload it again.",
        ),
        UploadError::Io(e) | UploadError::Files(crate::files::FilesError::Io(e))
            if matches!(
                e.kind(),
                std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
            ) =>
        {
            json_error(
                StatusCode::INSUFFICIENT_STORAGE,
                "This drive is full. Free up some space and try again.",
            )
        }
        UploadError::Io(e) | UploadError::Files(crate::files::FilesError::Io(e))
            if e.kind() == std::io::ErrorKind::InvalidFilename =>
        {
            json_error(
                StatusCode::BAD_REQUEST,
                "This drive can't use that name. Try a shorter name without special characters.",
            )
        }
        other => {
            tracing::warn!(error = ?other, "an upload could not be finished");
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish this upload. Check the drive and try again.",
            )
        }
    }
}

#[cfg(test)]
mod http_tests {
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq, header};
    use tower::ServiceExt;

    use super::*;
    use crate::api;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
        4242,
    );

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
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
            .with_state(state);
        (dir, app)
    }

    fn req(
        method: Method,
        uri: impl AsRef<str>,
        cookie: &str,
        csrf: &str,
        body: Body,
        extra: &[(&str, &str)],
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder().method(method).uri(uri.as_ref());
        if !cookie.is_empty() {
            builder = builder.header("cookie", cookie);
        }
        if !csrf.is_empty() {
            builder = builder.header("x-csrf-token", csrf);
        }
        for (k, v) in extra {
            builder = builder.header(*k, *v);
        }
        let mut http = builder.body(body).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn session_cookie(res: &axum::response::Response) -> (String, String) {
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(header::SET_COOKIE) {
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

    async fn login(app: &axum::Router, name: &str) -> (String, String) {
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/auth/login",
                "",
                "",
                Body::from(format!(
                    r#"{{"username":"{name}","password":"hunter22hunter1"}}"#
                )),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        session_cookie(&res)
    }

    async fn register(app: &axum::Router, name: &str, cookie: &str, csrf: &str) -> String {
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/auth/register",
                cookie,
                csrf,
                Body::from(format!(
                    r#"{{"username":"{name}","display_name":"{name}","password":"hunter22hunter1"}}"#
                )),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        v["id"].as_str().unwrap_or_default().to_string()
    }

    fn grant(dir: &tempfile::TempDir, user_id: &str, path: &str, caps: crate::access::Caps) {
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

    /// First user is admin; registering another makes them a member.
    async fn two_members(
        app: &axum::Router,
    ) -> ((String, String, String), (String, String, String)) {
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/auth/register",
                "",
                "",
                Body::from(
                    r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                ),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let (admin_cookie, admin_csrf) = login(app, "max").await;
        let sam_id = register(app, "sam", &admin_cookie, &admin_csrf).await;
        let eve_id = register(app, "eve", &admin_cookie, &admin_csrf).await;
        let (sam_cookie, sam_csrf) = login(app, "sam").await;
        let (eve_cookie, eve_csrf) = login(app, "eve").await;
        (
            (sam_cookie, sam_csrf, sam_id),
            (eve_cookie, eve_csrf, eve_id),
        )
    }

    #[tokio::test]
    async fn upload_session_belongs_to_its_creator() {
        // Sam opens a session; Eve — with the same folder grant — cannot
        // write chunks to it, complete it, or cancel it.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        let (dir, app) = test_app(mount.path());
        let ((sam_cookie, sam_csrf, sam_id), (eve_cookie, eve_csrf, eve_id)) =
            two_members(&app).await;
        grant(&dir, &sam_id, "drop", crate::access::CAP_ALL);
        grant(&dir, &eve_id, "drop", crate::access::CAP_ALL);

        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/uploads",
                &sam_cookie,
                &sam_csrf,
                Body::from(r#"{"drive_id":"photos","path":"drop","name":"x.bin","size":4}"#),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let upload_id = v["upload_id"].as_str().unwrap().to_string();

        // Eve tries to drive Sam's session three ways — all refused.
        for (method, uri) in [
            (Method::PUT, format!("/api/v1/uploads/{upload_id}")),
            (
                Method::POST,
                format!("/api/v1/uploads/{upload_id}/complete"),
            ),
            (Method::DELETE, format!("/api/v1/uploads/{upload_id}")),
        ] {
            let res = app
                .clone()
                .oneshot(req(
                    method,
                    &uri,
                    &eve_cookie,
                    &eve_csrf,
                    Body::from("data"),
                    &[("content-range", "bytes 0-3/4")],
                ))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{uri}");
        }

        // Sam's own session still works.
        let res = app
            .clone()
            .oneshot(req(
                Method::PUT,
                format!("/api/v1/uploads/{upload_id}"),
                &sam_cookie,
                &sam_csrf,
                Body::from("data"),
                &[("content-range", "bytes 0-3/4")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                format!("/api/v1/uploads/{upload_id}/complete"),
                &sam_cookie,
                &sam_csrf,
                Body::empty(),
                &[],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(
            std::fs::read(mount.path().join("drop/x.bin")).unwrap(),
            b"data"
        );
    }

    #[tokio::test]
    async fn chunked_overwrite_needs_edit() {
        // Upload-only member: a chunked session completing onto an existing
        // name with overwrite=1 is an edit, not an upload.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        std::fs::write(mount.path().join("drop/x.bin"), b"old!").unwrap();
        let (dir, app) = test_app(mount.path());
        let ((sam_cookie, sam_csrf, sam_id), _) = two_members(&app).await;
        grant(&dir, &sam_id, "drop", crate::access::CAP_UPLOAD);

        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/uploads",
                &sam_cookie,
                &sam_csrf,
                Body::from(r#"{"drive_id":"photos","path":"drop","name":"x.bin","size":4}"#),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let upload_id = v["upload_id"].as_str().unwrap().to_string();

        let res = app
            .clone()
            .oneshot(req(
                Method::PUT,
                format!("/api/v1/uploads/{upload_id}"),
                &sam_cookie,
                &sam_csrf,
                Body::from("new!"),
                &[("content-range", "bytes 0-3/4")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                format!("/api/v1/uploads/{upload_id}/complete?overwrite=1"),
                &sam_cookie,
                &sam_csrf,
                Body::empty(),
                &[],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            std::fs::read(mount.path().join("drop/x.bin")).unwrap(),
            b"old!"
        );
    }

    fn create_body(extra: &str) -> String {
        format!(r#"{{"drive_id":"photos","path":"drop","name":"x.bin","size":4{extra}}}"#)
    }

    async fn json_of(res: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn a_taken_name_is_decided_before_the_bytes_and_kept_both_at_complete() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        std::fs::write(mount.path().join("drop/x.bin"), b"old!").unwrap();
        let (dir, app) = test_app(mount.path());
        let ((sam_cookie, sam_csrf, sam_id), _) = two_members(&app).await;
        grant(&dir, &sam_id, "drop", crate::access::CAP_ALL);
        let json_header = [("content-type", "application/json")];

        // No choice yet: the session is refused with the clash named.
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/uploads",
                &sam_cookie,
                &sam_csrf,
                Body::from(create_body("")),
                &json_header,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let v = json_of(res).await;
        assert_eq!(v["code"], "exists");
        assert_eq!(v["existing_kind"], "file");

        // With the choice made, the session opens and the bytes arrive.
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/uploads",
                &sam_cookie,
                &sam_csrf,
                Body::from(create_body(r#","on_conflict":"keep_both""#)),
                &json_header,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let upload_id = json_of(res).await["upload_id"]
            .as_str()
            .unwrap()
            .to_string();
        let res = app
            .clone()
            .oneshot(req(
                Method::PUT,
                format!("/api/v1/uploads/{upload_id}"),
                &sam_cookie,
                &sam_csrf,
                Body::from("new!"),
                &[("content-range", "bytes 0-3/4")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // A plain complete still refuses the clash, and keeps the session.
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                format!("/api/v1/uploads/{upload_id}/complete"),
                &sam_cookie,
                &sam_csrf,
                Body::empty(),
                &[],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let v = json_of(res).await;
        assert_eq!(v["code"], "exists");
        assert_eq!(v["existing_kind"], "file");

        // Keep both lands it beside the old file, under the next free name.
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                format!("/api/v1/uploads/{upload_id}/complete?keep_both=1"),
                &sam_cookie,
                &sam_csrf,
                Body::empty(),
                &[],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(json_of(res).await["name"], "x (1).bin");
        assert_eq!(
            std::fs::read(mount.path().join("drop/x.bin")).unwrap(),
            b"old!"
        );
        assert_eq!(
            std::fs::read(mount.path().join("drop/x (1).bin")).unwrap(),
            b"new!"
        );
    }

    #[tokio::test]
    async fn a_file_too_big_for_the_free_space_is_refused_up_front() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("drop")).unwrap();
        let (dir, app) = test_app(mount.path());
        let ((sam_cookie, sam_csrf, sam_id), _) = two_members(&app).await;
        grant(&dir, &sam_id, "drop", crate::access::CAP_ALL);

        // Just under the 1 TB limit: no drive in a test has that much free.
        let size = MAX_FILE_BYTES - 1;
        let body =
            format!(r#"{{"drive_id":"photos","path":"drop","name":"huge.bin","size":{size}}}"#);
        let res = app
            .clone()
            .oneshot(req(
                Method::POST,
                "/api/v1/uploads",
                &sam_cookie,
                &sam_csrf,
                Body::from(body),
                &[("content-type", "application/json")],
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::INSUFFICIENT_STORAGE);
        assert!(!mount.path().join("drop/huge.bin").exists());
    }
}
