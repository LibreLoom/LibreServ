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
        // requirement below on nothing but a view grant. Member homes are
        // addressable, so their contents may be job sources/destinations;
        // the home root itself never moves through the public API — only
        // the member-home drive switch relocates it.
        if crate::files::is_blocked_user_path(from_path)
            || crate::files::is_blocked_user_path(to_path)
        {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Luna can't use that path.",
            ));
        }
        if crate::member_home::is_home_root(from_path) {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "Home folders stay at the drive root — they can't be moved or copied.",
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
    Ok(Json(
        jobs.into_iter().map(|job| job_json(job, &user)).collect(),
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
    Ok(Json(job_json(job, &user)))
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

fn job_json(job: crate::db::JobRow, viewer: &crate::auth::CurrentUser) -> Value {
    // A job's paths are verbatim only for the member who created it.
    // Everyone else — admins included — gets member-home and `.luna-<uuid>`
    // internals blanked: those paths identify another member's private
    // files and Luna's own bookkeeping, which this surface must not leak.
    let path = |p: String| -> String {
        if viewer.id == job.user_id
            || !(crate::member_home::is_member_home_path(&p) || crate::files::is_internal_temp(&p))
        {
            p
        } else {
            "private".to_string()
        }
    };
    // For a member-home move, name the member — admins legitimately know
    // who lives on the box (they manage users), and a member only ever
    // lists their own jobs. The home *path* stays scrubbed; this is just
    // the "whose folder is moving" label.
    let member = crate::member_home::owner_username(&job.from_path);
    json!({
        "id": job.id,
        "kind": job.kind,
        "state": job.state,
        "user_id": job.user_id,
        "member": member,
        "from_drive": job.from_drive,
        "from_path": path(job.from_path),
        "to_drive": job.to_drive,
        "to_path": path(job.to_path),
        "progress": job.progress,
        "total": job.total,
        "error": job.error,
    })
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
        JobError::Files(crate::files::FilesError::UnknownDrive) => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know one of these drives. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in.",
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
            "The permission this job was created with is gone.",
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
    fn job_json_hides_home_and_internal_paths_from_non_owners() {
        // Admins list everyone's jobs, but a job path inside a member home
        // or a `.luna-<uuid>` namespace must not render to them — the owner
        // alone sees the verbatim path.
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
        };
        let who = |id: &str, role: &str| crate::auth::CurrentUser {
            id: id.into(),
            username: id.into(),
            role: role.into(),
        };
        let home = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-members/sam/photo.jpg";
        let internal = ".luna-3f6a8c1e-9b2d-4a7c-8e5f-1a2b3c4d5e6f-members/sam";

        let owner = job_json(row(home, "docs"), &who("sam", "member"));
        assert_eq!(owner["from_path"], home, "the owner sees their own paths");

        let admin = job_json(row(home, "docs"), &who("max", "admin"));
        assert_eq!(admin["from_path"], "private");
        assert_eq!(
            admin["to_path"], "docs",
            "only the internal side is blanked"
        );
        // …but the member-name label still lands: "whose folder is moving"
        // is safe metadata for the admin who manages users, and it never
        // exposes the internal path itself.
        assert_eq!(admin["member"], "sam");
        assert_eq!(admin["user_id"], "sam");

        let internal_job = job_json(row(internal, internal), &who("max", "admin"));
        assert_eq!(internal_job["from_path"], "private");
        assert_eq!(internal_job["to_path"], "private");
        assert_eq!(internal_job["member"], "sam");

        // Ordinary paths stay readable for admins — only internals redact.
        let plain = job_json(row("docs/a.txt", "docs/b.txt"), &who("max", "admin"));
        assert_eq!(plain["from_path"], "docs/a.txt");
        assert_eq!(plain["member"], serde_json::Value::Null);
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
