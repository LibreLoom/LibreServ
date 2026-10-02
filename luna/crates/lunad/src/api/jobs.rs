use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::jobs::JobError;

#[derive(Deserialize)]
struct CreateJob {
    kind: String,
    from_drive: String,
    from_path: Option<String>,
    to_drive: String,
    to_path: Option<String>,
    /// The caller saw the "this leaves the private folder" warning and chose
    /// to proceed. WebDAV transfers never set this — native clients follow
    /// destination permissions without a Luna-specific prompt.
    #[serde(default)]
    confirm_broaden: bool,
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs", post(create).get(list))
        .route("/api/v1/jobs/{id}", get(get_one).delete(cancel))
}

async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<CreateJob>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna's index is busy. Try again.",
            )
        })?;
        let from_path = body.from_path.as_deref().unwrap_or("");
        let to_path = body.to_path.as_deref().unwrap_or("");
        // Raw `.luna-<uuid>-*` names (the real trash dir, upload temps,
        // markers) are Luna's bookkeeping — the API speaks the `.luna-trash`
        // alias. A raw trash path would otherwise slip past the origin-edit
        // requirement below on nothing but a view grant.
        if crate::files::is_internal_temp(from_path) || crate::files::is_internal_temp(to_path) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Luna can't use that path.",
            ));
        }
        // Moving removes the source — that needs edit, not just view.
        // Anything in trash needs edit on its origin too: that's the bar
        // for even seeing it there (trash paths map to their origin's
        // grants inside has_cap).
        let from_cap = crate::jobs::job_source_cap(&conn, &body.kind, &body.from_drive, from_path);
        if !crate::auth::has_cap(&user, &conn, &body.from_drive, from_path, from_cap) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to copy from here.",
            ));
        }
        if !crate::auth::has_cap(
            &user,
            &conn,
            &body.to_drive,
            to_path,
            crate::access::CAP_UPLOAD,
        ) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "You don't have permission to save here.",
            ));
        }
        if !body.confirm_broaden
            && broadens_access(&conn, &body.from_drive, from_path, &body.to_drive, to_path)
        {
            return Err(crate::api::response::json_error_code(
                StatusCode::CONFLICT,
                "broadens_access",
                "This is in a private folder. Moving or copying it to this folder lets everyone with access to the destination open it.",
            ));
        }
    }
    let job = state
        .job_manager
        .enqueue(
            &body.kind,
            &body.from_drive,
            body.from_path.as_deref().unwrap_or(""),
            &body.to_drive,
            body.to_path.as_deref().unwrap_or(""),
            &user.id,
        )
        .await
        .map_err(map_job_err)?;
    Ok(Json(json!({
        "id": job.id,
        "kind": job.kind,
        "state": job.state,
        "progress": job.progress,
        "total": job.total,
    })))
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<Value>>, (StatusCode, Json<Value>)> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let jobs = if user.role == "admin" {
        state.job_manager.list(limit).map_err(map_job_err)?
    } else {
        state
            .job_manager
            .list_for_user(&user.id, limit)
            .map_err(map_job_err)?
    };
    let conn = state
        .db
        .lock()
        .map_err(|_| map_job_err(JobError::NotFound))?;
    Ok(Json(
        jobs.into_iter()
            .map(|job| job_json(job, &user, &conn))
            .collect(),
    ))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let job = state
        .job_manager
        .get(&id)
        .map_err(map_job_err)?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."))?;
    if !state.job_manager.owns_or_admin(&job, &user) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this job.",
        ));
    }
    let conn = state
        .db
        .lock()
        .map_err(|_| map_job_err(JobError::NotFound))?;
    Ok(Json(job_json(job, &user, &conn)))
}

async fn cancel(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let job = state
        .job_manager
        .get(&id)
        .map_err(map_job_err)?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."))?;
    if !state.job_manager.owns_or_admin(&job, &user) {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this job.",
        ));
    }
    state.job_manager.cancel(&id).map_err(map_job_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn job_json(
    job: crate::db::JobRow,
    viewer: &crate::auth::CurrentUser,
    conn: &rusqlite::Connection,
) -> Value {
    // A job's paths are verbatim only for the member who created it.
    // Everyone else — admins included — gets `.luna-<uuid>` internals
    // blanked: those paths are Luna's own bookkeeping, which this surface
    // must not leak.
    let hidden = |drive: &str, path: &str, was_private: bool| {
        viewer.id != job.user_id
            && (was_private
                || crate::files::is_internal_temp(path)
                || crate::auth::inside_private(conn, drive, path))
    };
    let from_hidden = hidden(&job.from_drive, &job.from_path, job.from_private);
    let to_hidden = hidden(&job.to_drive, &job.to_path, job.to_private);
    let redacted = from_hidden || to_hidden;
    json!({
        "id": job.id,
        "kind": job.kind,
        "state": job.state,
        "user_id": job.user_id,
        "from_drive": job.from_drive,
        "from_path": if from_hidden { "private".to_string() } else { job.from_path },
        "to_drive": job.to_drive,
        "to_path": if to_hidden { "private".to_string() } else { job.to_path },
        "progress": if redacted { 0 } else { job.progress },
        "total": if redacted { 0 } else { job.total },
        "error": if redacted { String::new() } else { job.error },
    })
}

/// Does this transfer carry an ordinary item out of its private folder's
/// boundary — so people who can reach the destination can now open it? A
/// private folder itself keeps its boundary wherever it lands, and a move
/// inside the same boundary changes nothing. Trash sources answer from
/// their recorded provenance (the live row may be gone).
pub(crate) fn broadens_access(
    conn: &rusqlite::Connection,
    from_drive: &str,
    from_path: &str,
    to_drive: &str,
    to_path: &str,
) -> bool {
    let root_of = |drive_id: &str| {
        crate::db::get_drive(conn, drive_id)
            .ok()
            .flatten()
            .filter(|d| !d.mount_point.is_empty())
            .map(|d| std::path::PathBuf::from(d.mount_point))
    };
    let Some(src_root) = root_of(from_drive) else {
        return false;
    };
    let src_real = crate::files::real_rel(&src_root, from_path);
    // A private folder carries its own boundary: no broadening either way.
    if crate::private::item_at(&src_root, &src_real).is_some() {
        return false;
    }
    let boundary = crate::private::boundary_for(&src_root, &src_real).or_else(|| {
        crate::files::trash_private_meta(conn, from_drive, from_path)
            .ok()
            .flatten()
            .map(|m| crate::private::Boundary {
                path: m.private_path,
                owner: m.private_owner,
            })
    });
    let Some(boundary) = boundary else {
        return false;
    };
    let Some(dst_root) = root_of(to_drive) else {
        return false;
    };
    let dst_real = crate::files::real_rel(&dst_root, to_path);
    match crate::private::boundary_for(&dst_root, &dst_real) {
        // Moving within the same private folder keeps the same boundary.
        Some(dst) => src_root != dst_root || dst.path != boundary.path,
        None => true,
    }
}

fn map_job_err(err: JobError) -> (StatusCode, Json<Value>) {
    match err {
        JobError::UnknownKind => json_error(
            StatusCode::BAD_REQUEST,
            "Luna only knows how to copy or move.",
        ),
        JobError::Conflict => json_error(
            StatusCode::CONFLICT,
            "A file or folder with this name is already there. Choose a different destination.",
        ),
        JobError::Symlink => json_error(StatusCode::BAD_REQUEST, "Luna can't copy links yet."),
        JobError::Blocked => json_error(
            StatusCode::FORBIDDEN,
            "This folder holds private items that only their owners can move.",
        ),
        JobError::Files(crate::files::FilesError::UnknownDrive) => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know one of these drives. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.",
        ),
        JobError::Files(crate::files::FilesError::MissingDriveDb) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            crate::files::MISSING_DRIVE_DB_MSG,
        ),
        JobError::Files(crate::files::FilesError::Path(_)) => {
            json_error(StatusCode::BAD_REQUEST, "Luna can't use that path.")
        }
        JobError::Files(crate::files::FilesError::Io(ref e))
            if e.kind() == std::io::ErrorKind::InvalidInput =>
        {
            json_error(StatusCode::BAD_REQUEST, "Luna can't use that path.")
        }
        JobError::NotFound => json_error(StatusCode::NOT_FOUND, "Luna doesn't know this job."),
        JobError::Denied => json_error(
            StatusCode::FORBIDDEN,
            "You no longer have permission to do this.",
        ),
        _ => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't start this job. Check the drives and try again.",
        ),
    }
}

#[cfg(test)]
mod http_tests {
    use axum::body::Body;
    use axum::extract::connect_info::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
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

    fn json_req(method: Method, uri: &str, body: &str, cookie: &str, csrf: &str) -> HttpReq<Body> {
        let mut http = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .body(Body::from(body.to_string()))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn admin_cookie(app: &axum::Router) -> (String, String) {
        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                "",
                "",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                "",
                "",
            ))
            .await
            .unwrap();
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

    #[tokio::test]
    async fn raw_luna_names_are_not_job_paths() {
        // A raw `{prefix}-trash` name must never reach the job executor —
        // the API speaks `.luna-trash`, and internal names would slip past
        // the origin-edit rule for trash sources.
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;
        let prefix = crate::drives::drive_db::prefix_for(mount.path()).unwrap();
        let raw_trash = format!("{prefix}-trash/x");
        let marker_db = format!("{prefix}.sqlite3");

        for from_path in [raw_trash.as_str(), marker_db.as_str()] {
            let res = app
                .clone()
                .oneshot(json_req(
                    Method::POST,
                    "/api/v1/jobs",
                    &serde_json::json!({
                        "kind": "copy",
                        "from_drive": "photos",
                        "from_path": from_path,
                        "to_drive": "photos",
                        "to_path": "",
                    })
                    .to_string(),
                    &cookie,
                    &csrf,
                ))
                .await
                .unwrap();
            assert_eq!(
                res.status(),
                StatusCode::BAD_REQUEST,
                "raw internal path {from_path} accepted"
            );
        }
        // …and the destination side is held to the same rule.
        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/jobs",
                &serde_json::json!({
                    "kind": "copy",
                    "from_drive": "photos",
                    "from_path": "x.txt",
                    "to_drive": "photos",
                    "to_path": raw_trash,
                })
                .to_string(),
                &cookie,
                &csrf,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn job_json_hides_internal_paths_from_non_owners() {
        // Admins list everyone's jobs, but a job path inside a `.luna-<uuid>`
        // namespace must not render to them — the owner alone sees the
        // verbatim path.
        let row = |from: &str, to: &str| crate::db::JobRow {
            id: "j1".into(),
            kind: "move".into(),
            state: "running".into(),
            from_drive: "photos".into(),
            from_path: from.into(),
            to_drive: "photos".into(),
            to_path: to.into(),
            progress: 0,
            total: 10,
            error: String::new(),
            user_id: "sam".into(),
            from_private: false,
            to_private: false,
        };
        let who = |id: &str, role: &str| crate::auth::CurrentUser {
            id: id.into(),
            username: id.into(),
            role: role.into(),
        };
        let internal = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-trash/entry/photo.jpg";

        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let owner = job_json(row(internal, "docs"), &who("sam", "member"), &conn);
        assert_eq!(
            owner["from_path"], internal,
            "the owner sees their own paths"
        );

        let admin = job_json(row(internal, "docs"), &who("max", "admin"), &conn);
        assert_eq!(admin["from_path"], "private");
        assert_eq!(
            admin["to_path"], "docs",
            "only the internal side is blanked"
        );
        assert_eq!(admin["user_id"], "sam");

        // Ordinary paths stay readable for admins — only internals redact.
        let plain = job_json(row("docs/a.txt", "docs/b.txt"), &who("max", "admin"), &conn);
        assert_eq!(plain["from_path"], "docs/a.txt");
    }

    #[tokio::test]
    async fn member_move_needs_edit_not_view() {
        // Moving destroys the source — a view-only grant must not enqueue it.
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("docs")).unwrap();
        std::fs::write(mount.path().join("docs/note.txt"), b"hi").unwrap();
        let (dir, app) = test_app(mount.path());
        let (cookie, csrf) = admin_cookie(&app).await;

        // Register member sam, grant view-only on `docs`.
        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1"}"#,
                &cookie,
                &csrf,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let sam_id = v["id"].as_str().unwrap().to_string();
        {
            let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
            crate::db::insert_access_member(
                &conn,
                &crate::db::AccessMemberRow {
                    id: "g1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: "photos".into(),
                    path: "docs".into(),
                    album_id: String::new(),
                    user_id: sam_id,
                    caps: crate::access::CAP_VIEW,
                    created_by: "test".into(),
                },
            )
            .unwrap();
        }
        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"sam","password":"hunter22hunter1"}"#,
                "",
                "",
            ))
            .await
            .unwrap();
        let mut session = String::new();
        let mut sam_csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                sam_csrf = token.to_string();
            }
        }
        let sam_cookie = format!("{session}; luna_csrf={sam_csrf}");

        let res = app
            .clone()
            .oneshot(json_req(
                Method::POST,
                "/api/v1/jobs",
                &serde_json::json!({
                    "kind": "move",
                    "from_drive": "photos",
                    "from_path": "docs/note.txt",
                    "to_drive": "photos",
                    "to_path": "docs",
                })
                .to_string(),
                &sam_cookie,
                &sam_csrf,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(mount.path().join("docs/note.txt").exists());
    }
}
