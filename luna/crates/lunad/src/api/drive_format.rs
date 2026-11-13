//! HTTP for erasing a drive: preview, start, status. Admin only.
//!
//! Thin on purpose. The disk work lives in `drives::format`, the in-memory
//! previews and run status in `drives::format::FormatService`; this file
//! checks who is asking, takes the locks, and turns results into plain JSON.
//!
//! - `POST /api/v1/drive-format/preview {device}`: what is on the drive, the
//!   server's `empty` verdict, `ready_at` (now if empty, now + 30 s otherwise)
//!   and a `preview_id` bound to that physical disk.
//! - `POST /api/v1/drive-format/start {preview_id, label, password?}`: a
//!   password means LUKS2 + ext4, none means exFAT. Returns the run's status,
//!   including its `id`.
//! - `GET /api/v1/drive-format/{id}`: named phase, done/failed, error, the
//!   resulting drive id.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::AppState;
use crate::api::drives::{lock_idle_device, require_admin};
use crate::api::response::{json_error, json_error_code};
use crate::drives::format::{self, PreviewError, StoredPreview, run};

type ApiError = (StatusCode, Json<Value>);

#[derive(Deserialize)]
struct PreviewBody {
    /// The disk's kernel name, as `/api/v1/drives/detected` lists it.
    device: String,
}

#[derive(Deserialize)]
struct StartBody {
    preview_id: String,
    /// The drive's name in Luna.
    label: String,
    /// Present means an encrypted drive.
    #[serde(default)]
    password: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drive-format/preview", post(preview))
        .route("/api/v1/drive-format/start", post(start))
        .route("/api/v1/drive-format/{id}", get(status))
}

fn gone(what: &str) -> ApiError {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, what)
}

async fn preview(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user.id.clone();
    require_admin(user)?;
    let name = body.device.trim().to_string();
    let guard = lock_idle_device(&state, &name).await?;
    // The disk is looked at while holding its lock, so an erase, an add or an
    // eject can't be mounting it at the same time.
    let st = state.clone();
    let looked = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        look(&st, &name)
    })
    .await
    .map_err(|_| gone("Luna couldn't look at this drive. Try again."))??;
    let (preview, registered) = looked;
    let stored = state.format.issue_preview(&user_id, preview, registered);
    Ok(Json(preview_json(&state, &stored)))
}

/// Inspect the disk and find the registered drive (if any) that lives on it.
fn look(
    state: &AppState,
    name: &str,
) -> Result<(format::inspect::Preview, Option<String>), ApiError> {
    let not_here = || {
        json_error(
            StatusCode::NOT_FOUND,
            "Luna can't see a drive with that name.",
        )
    };
    let det = format::detect_now(name).ok_or_else(not_here)?;
    let mock = format::is_mock_device(name);
    if !mock
        && crate::drives::mounted_points_for_disk(&det.name)
            .iter()
            .any(|p| state.drive_manager.is_system_mount(p))
    {
        return Err(json_error_code(
            StatusCode::BAD_REQUEST,
            "system_disk",
            "That's the drive Luna runs from. Luna won't erase it.",
        ));
    }
    let preview = format::preview_now(&state.drive_manager, state.format.tools(), name)
        .ok_or_else(not_here)?;
    let registered = format::registered_on(state, name).map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't read your drives. Try again.",
        )
    })?;
    Ok((preview, registered))
}

fn preview_json(state: &AppState, stored: &StoredPreview) -> Value {
    let p = &stored.preview;
    json!({
        "preview_id": stored.id,
        "now": state.format.now(),
        "issued_at": stored.issued_at,
        "ready_at": stored.ready_at,
        "expires_at": stored.expires_at,
        "wait_seconds": stored.ready_at - stored.issued_at,
        "empty": p.empty,
        "blank": p.blank,
        "device": {
            "name": p.identity.name,
            "model": p.identity.model,
            "size_bytes": p.identity.size_bytes,
            "serial": p.identity.serial,
            "wwn": p.identity.wwn,
        },
        // Dev mock drives can't be encrypted; the UI hides the choice.
        "can_encrypt": !p.identity.mock,
        "registered_drive_id": stored.registered_drive,
        "partitions": p.partitions,
        "signatures": p.signatures,
        "used_bytes": p.used_bytes(),
    })
}

async fn start(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<StartBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = user.id.clone();
    require_admin(user)?;
    let label = body.label.trim().to_string();
    if label.is_empty() || label.chars().count() > 80 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Give this drive a name between 1 and 80 characters.",
        ));
    }
    let password = body.password.map(Zeroizing::new);
    if let Some(password) = &password
        && let Err(e) = crate::password::validate_password(password)
    {
        return Err(json_error_code(
            StatusCode::BAD_REQUEST,
            "weak_password",
            e.message(),
        ));
    }
    let encrypted = password.is_some();

    // The preview: still good, issued to this Admin, and its wait is over. The
    // wait is counted on the server from when the preview was issued.
    let stored = state
        .format
        .check_preview(&body.preview_id, &user_id)
        .map_err(|e| match e {
            PreviewError::NotFound => json_error_code(
                StatusCode::NOT_FOUND,
                "preview_not_found",
                "Luna no longer has that preview. Look at the drive again.",
            ),
            PreviewError::Expired => json_error_code(
                StatusCode::GONE,
                "preview_expired",
                "That preview is too old. Look at the drive again.",
            ),
            PreviewError::NotReady(ready_at) => (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "Wait for the countdown to finish, then try again.",
                    "code": "format_not_ready",
                    "ready_at": ready_at,
                    "now": state.format.now(),
                })),
            ),
        })?;
    let identity = stored.preview.identity.clone();
    if identity.mock && encrypted {
        return Err(json_error_code(
            StatusCode::BAD_REQUEST,
            "mock_encryption",
            "Directory mock drives can't be encrypted.",
        ));
    }
    // Check the programs now, so a Luna that can't do this says so right away.
    if !identity.mock
        && let Some(tool) = state.format.tools().missing(run::required_tools(encrypted))
    {
        return Err(json_error_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "missing_tool",
            run::FormatError::MissingTool(tool.to_string()).to_string(),
        ));
    }

    // One erase per disk, and nothing else touching it: the same lock adopt,
    // eject, peek and inspect take. A conflict is a 409 right here, not a
    // failure later.
    let device_guard = lock_idle_device(&state, &identity.name).await?;
    let drive_guard = match &stored.registered_drive {
        Some(id) => Some(state.db.drive_lock(id).try_lock_owned().map_err(|_| {
            json_error_code(
                StatusCode::CONFLICT,
                "drive_busy",
                "Luna is already working on this drive. Wait until it finishes.",
            )
        })?),
        None => None,
    };

    // Re-check: same physical disk and layout, and a no-wait verdict still holds.
    let (st, name, previewed) = (state.clone(), identity.name.clone(), identity.clone());
    let require_empty = stored.preview.empty;
    let previewed_drive = stored.registered_drive.clone();
    let verdict = tokio::task::spawn_blocking(move || {
        let Some(now) = format::identity_now(&st.drive_manager, &name, true) else {
            return Err(drive_changed());
        };
        if !now.same_disk(&previewed) {
            return Err(drive_changed());
        }
        // Adding a drive only writes a marker file, so the layout can't tell
        // that the disk became (or stopped being) a registered drive since the
        // preview. A run must quiesce exactly the drive it was told about.
        if format::registered_on(&st, &name).ok() != Some(previewed_drive) {
            return Err(json_error_code(
                StatusCode::CONFLICT,
                "preview_stale",
                "This drive was added or removed since the preview. Look at the drive again.",
            ));
        }
        if require_empty
            && !format::preview_now(&st.drive_manager, st.format.tools(), &name)
                .is_some_and(|p| p.empty)
        {
            return Err(json_error_code(
                StatusCode::CONFLICT,
                "preview_stale",
                "Files appeared on this drive since the preview. Look at the drive again.",
            ));
        }
        Ok(())
    })
    .await
    .map_err(|_| gone("Luna couldn't look at this drive. Try again."))?;
    verdict?;

    // Accepted: the preview is used up, and the run owns the locks.
    state.format.consume_preview(&stored.id);
    let handle = state
        .format
        .begin_run(&identity.name, stored.registered_drive.clone(), encrypted);
    let status = handle.status();
    let req = run::Request {
        identity,
        label,
        password,
        drive_id: stored.registered_drive.clone(),
        require_empty,
    };
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        // The blocking worker owns these even if the HTTP request closes.
        let _device_guard = device_guard;
        let _drive_guard = drive_guard;
        format::execute(&st, &handle, &req);
    });
    Ok((StatusCode::ACCEPTED, Json(json!(status))))
}

fn drive_changed() -> ApiError {
    json_error_code(
        StatusCode::CONFLICT,
        "drive_changed",
        "This isn't the drive that was shown, or it changed. Look at the drive again.",
    )
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(user)?;
    let status = state.format.run_status(&id).ok_or_else(|| {
        json_error_code(
            StatusCode::NOT_FOUND,
            "format_not_found",
            "Luna doesn't have a record of that erase. If Luna restarted, look at the drive again.",
        )
    })?;
    Ok(Json(json!(status)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::db;
    use crate::drives::format::FormatService;
    use crate::drives::format::inspect::{DiskIdentity, PartitionPreview, PartitionState, Preview};
    use crate::drives::format::tools::MockTools;

    struct Harness {
        _dir: tempfile::TempDir,
        state: AppState,
        token: String,
        clock: Arc<AtomicI64>,
        tools: Arc<MockTools>,
        admin_id: String,
    }

    fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let manager = Arc::new(
            crate::drives::DriveManager::new(crate::drives::mount::shared_mock(), dir.path())
                .with_luks(Arc::new(crate::drives::crypt::luks::MockLuks::default())),
        );
        let mut state = AppState::new(conn, manager, dir.path());
        let clock = Arc::new(AtomicI64::new(10_000));
        let tools = Arc::new(MockTools::default());
        let c = clock.clone();
        let mut service =
            FormatService::with_clock(tools.clone(), Arc::new(move || c.load(Ordering::SeqCst)));
        service.mock_step = std::time::Duration::ZERO;
        state.format = Arc::new(service);
        let admin = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = state.auth.issue(&admin).unwrap();
        Harness {
            admin_id: admin.id.clone(),
            _dir: dir,
            state,
            token,
            clock,
            tools,
        }
    }

    async fn call(
        h: &Harness,
        method: &str,
        uri: &str,
        body: Option<Value>,
        token: &str,
    ) -> (StatusCode, Value) {
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                h.state.clone(),
                crate::auth::guard,
            ))
            .with_state(h.state.clone());
        let mut req = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header("Content-Type", "application/json");
                axum::body::Body::from(v.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let response = tower::ServiceExt::oneshot(router, req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn identity(name: &str) -> DiskIdentity {
        DiskIdentity {
            name: name.into(),
            model: "Stick".into(),
            size_bytes: 1 << 30,
            serial: Some("S1".into()),
            wwn: None,
            diskseq: Some(1),
            whole_fs_type: String::new(),
            layout: vec![],
            mock: false,
        }
    }

    fn stored(h: &Harness, empty: bool) -> StoredPreview {
        let preview = Preview {
            identity: identity("sdz"),
            partitions: vec![PartitionPreview {
                name: "sdz1".into(),
                size_bytes: 1,
                fs_type: "exfat".into(),
                label: String::new(),
                state: if empty {
                    PartitionState::Empty
                } else {
                    PartitionState::HasFiles
                },
                used_bytes: None,
                folders: 0,
                files: 0,
                unreadable: 0,
                entries: vec![],
            }],
            blank: false,
            signatures: vec![],
            empty,
        };
        h.state.format.issue_preview(&h.admin_id, preview, None)
    }

    #[tokio::test]
    async fn only_an_admin_may_preview_start_or_ask() {
        let h = harness();
        let member = h
            .state
            .auth
            .register("Sam", "Sam", "hunter22hunter1", "member")
            .unwrap();
        let token = h.state.auth.issue(&member).unwrap();
        for (method, uri, body) in [
            (
                "POST",
                "/api/v1/drive-format/preview",
                Some(json!({"device": "sdz"})),
            ),
            (
                "POST",
                "/api/v1/drive-format/start",
                Some(json!({"preview_id": "x", "label": "A"})),
            ),
            ("GET", "/api/v1/drive-format/abc", None),
        ] {
            let (status, _) = call(&h, method, uri, body, &token).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn starting_before_the_wait_is_over_is_refused_by_the_server() {
        let h = harness();
        let p = stored(&h, false);
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drive-format/start",
            Some(json!({"preview_id": p.id, "label": "Photos"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "format_not_ready");
        assert_eq!(body["ready_at"], p.ready_at);
        // Nothing was touched and the preview is still there for later.
        assert!(h.tools.calls().is_empty());
        h.clock.store(p.ready_at, Ordering::SeqCst);
        assert!(h.state.format.check_preview(&p.id, &p.user_id).is_ok());
    }

    #[tokio::test]
    async fn an_old_or_unknown_preview_is_refused() {
        let h = harness();
        let p = stored(&h, true);
        h.clock.store(p.expires_at, Ordering::SeqCst);
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drive-format/start",
            Some(json!({"preview_id": p.id, "label": "Photos"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(body["code"], "preview_expired");
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drive-format/start",
            Some(json!({"preview_id": "nope", "label": "Photos"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "preview_not_found");
    }

    #[tokio::test]
    async fn names_and_passwords_are_checked_before_the_preview_is_used() {
        let h = harness();
        let p = stored(&h, true);
        for (body, code) in [
            (json!({"preview_id": p.id, "label": "  "}), None),
            (
                json!({"preview_id": p.id, "label": "A", "password": "short"}),
                Some("weak_password"),
            ),
        ] {
            let (status, got) = call(
                &h,
                "POST",
                "/api/v1/drive-format/start",
                Some(body),
                &h.token,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(got.get("code").and_then(|c| c.as_str()), code);
        }
        // Still usable.
        assert!(h.state.format.check_preview(&p.id, &p.user_id).is_ok());
    }

    #[tokio::test]
    async fn a_busy_disk_is_a_409_right_away_and_the_preview_survives() {
        let h = harness();
        let p = stored(&h, true);
        let _held = h
            .state
            .db
            .drive_lock("device:sdz")
            .try_lock_owned()
            .unwrap();
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drive-format/start",
            Some(json!({"preview_id": p.id, "label": "Photos"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "drive_busy");
        assert!(h.state.format.check_preview(&p.id, &p.user_id).is_ok());
    }

    #[tokio::test]
    async fn a_missing_program_is_reported_before_anything_starts() {
        let h = harness();
        h.tools.absent.lock().unwrap().push("mkfs.exfat");
        let p = stored(&h, true);
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drive-format/start",
            Some(json!({"preview_id": p.id, "label": "Photos"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["code"], "missing_tool");
        assert!(body["error"].as_str().unwrap().contains("mkfs.exfat"));
    }

    #[tokio::test]
    async fn an_unknown_disk_cannot_be_previewed_and_an_unknown_run_is_a_404() {
        let h = harness();
        let (status, _) = call(
            &h,
            "POST",
            "/api/v1/drive-format/preview",
            Some(json!({"device": "sdnothere"})),
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, body) = call(&h, "GET", "/api/v1/drive-format/nope", None, &h.token).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "format_not_found");
    }

    #[tokio::test]
    async fn a_run_is_reported_by_id_with_its_phases() {
        let h = harness();
        let run = h.state.format.begin_run("sdz", None, false);
        let (status, body) = call(
            &h,
            "GET",
            &format!("/api/v1/drive-format/{}", run.id()),
            None,
            &h.token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["phase"], "preparing");
        assert_eq!(body["done"], false);
        assert_eq!(body["failed"], false);
        assert!(body["phases"].as_array().unwrap().len() >= 5);
    }

    #[tokio::test]
    async fn the_drive_list_says_formatting_only_while_it_runs() {
        let h = harness();
        {
            let conn = h.state.db.lock().unwrap();
            db::upsert_drive(&conn, "d1", "Photos", "as_is", "exfat", "sdz", "/mnt/d1").unwrap();
        }
        let api = |h: &Harness| {
            let router = axum::Router::new()
                .merge(crate::api::drives::router())
                .layer(axum::middleware::from_fn_with_state(
                    h.state.clone(),
                    crate::auth::guard,
                ))
                .with_state(h.state.clone());
            let req = axum::http::Request::builder()
                .uri("/api/v1/drives")
                .header("Authorization", format!("Bearer {}", h.token))
                .body(axum::body::Body::empty())
                .unwrap();
            async move {
                let res = tower::ServiceExt::oneshot(router, req).await.unwrap();
                let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
                    .await
                    .unwrap();
                serde_json::from_slice::<Value>(&bytes).unwrap()
            }
        };
        let idle = api(&h).await;
        assert!(idle[0].get("formatting").is_none());
        let run = h.state.format.begin_run("sdz", Some("d1".into()), false);
        let busy = api(&h).await;
        assert_eq!(busy[0]["formatting"], true);
        assert_eq!(busy[0]["format_id"], run.id());
        run.finish_ok("d1");
        let after = api(&h).await;
        assert!(after[0].get("formatting").is_none());
    }
}
