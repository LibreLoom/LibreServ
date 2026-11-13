//! Encryption of a drive that already exists: state, unlock, lock, change
//! password, and unlock-and-add for an encrypted drive Luna hasn't registered.
//!
//! Thin HTTP. The work is in `drives::crypt` (`vault` and `luks`). Nothing
//! here sets encryption up or erases: turning protection on or off hands off
//! to the one format flow (`api/drive_format.rs`).
//!
//! - `GET  /api/v1/drives/{id}/encryption`: state (anyone who can see the drive)
//! - `POST /api/v1/drives/{id}/unlock {password}`: open it (anyone who can see it)
//! - `POST /api/v1/drives/{id}/lock`: close it (anyone who can see it)
//! - `POST /api/v1/drives/{id}/password {current_password, new_password}`: Admin
//! - `POST /api/v1/drives/{name}/unlock-and-add {password}`: Admin; `name` is
//!   the detected device, as for `adopt`
//!
//! Wrong passwords are rate limited per user and drive (five tries, then a
//! wait). Only wrong passwords count.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::AppState;
use crate::api::drives::{find_device, lock_idle_device, require_admin};
use crate::api::response::{json_error, json_error_code};
use crate::drives::crypt::vault::{self, LockError, UnlockError};
use crate::drives::format::tools::ToolError;

type ApiError = (StatusCode, Json<serde_json::Value>);

#[derive(Serialize)]
struct EncryptionJson {
    drive_id: String,
    label: String,
    encrypted: bool,
    /// The drive is encrypted and its container is open and mounted.
    unlocked: bool,
    /// The drive is encrypted and not open: it needs its password.
    locked: bool,
    present: bool,
    /// `not_encrypted`, `unplugged`, `formatting`, `locked`, `unlocked`, or
    /// `unavailable` (encrypted and unlocked, but its mount isn't right).
    status: &'static str,
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

impl Drop for PasswordBody {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Deserialize)]
struct ChangePasswordBody {
    current_password: String,
    new_password: String,
}

impl Drop for ChangePasswordBody {
    fn drop(&mut self) {
        self.current_password.zeroize();
        self.new_password.zeroize();
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drives/{id}/encryption", get(encryption_state))
        .route("/api/v1/drives/{id}/unlock", post(unlock))
        .route("/api/v1/drives/{id}/lock", post(lock))
        .route("/api/v1/drives/{id}/password", post(change_password))
        .route("/api/v1/drives/{name}/unlock-and-add", post(unlock_and_add))
}

// ---------------------------------------------------------------------------
// Helpers

fn internal() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't finish with this drive. Try again.",
    )
}

fn unknown_drive() -> ApiError {
    json_error_code(
        StatusCode::NOT_FOUND,
        "unknown_drive",
        "Luna doesn't know this drive.",
    )
}

fn row(state: &AppState, id: &str) -> Result<crate::db::DriveRow, ApiError> {
    crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::get_drive(conn, id),
    )
    .map_err(|_| internal())?
    .ok_or_else(unknown_drive)
}

fn authorize(state: &AppState, user: &crate::auth::CurrentUser, id: &str) -> Result<(), ApiError> {
    let allowed = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| Ok(crate::auth::has_drive_access(user, conn, id)),
    )
    .unwrap_or(false);
    if allowed {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to this drive.",
        ))
    }
}

fn is_formatting(state: &AppState, row: &crate::db::DriveRow) -> bool {
    state.format.running_on_device(&row.device).is_some()
        || crate::drives::format::drive_is_formatting(&row.id)
}

/// The drive can be unlocked, locked or have its password changed: plugged in,
/// encrypted, and not being erased.
fn ready(state: &AppState, row: &crate::db::DriveRow) -> Result<(), ApiError> {
    if row.state == "missing" || row.state == "ejected" {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive is unplugged. Plug it in and try again.",
        ));
    }
    if !row.encrypted {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive isn't encrypted.",
        ));
    }
    if is_formatting(state, row) {
        return Err(json_error_code(
            StatusCode::CONFLICT,
            "drive_busy",
            "Luna is erasing this drive right now. Try again when it finishes.",
        ));
    }
    Ok(())
}

/// Refuse while this user is locked out of this drive after wrong tries.
fn check_not_locked_out(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive: &str,
) -> Result<(), ApiError> {
    if state.unlock_guard.is_locked(&user.id, drive) {
        Err(json_error_code(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_tries",
            "Too many wrong tries. Wait a few minutes, then try again.",
        ))
    } else {
        Ok(())
    }
}

/// Count a wrong password and say so. When that was the try that locks the
/// user out, say that too.
fn wrong_password(state: &AppState, user: &crate::auth::CurrentUser, drive: &str) -> ApiError {
    let locked_out = state.unlock_guard.record_failure(&user.id, drive);
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "error": if locked_out {
                "That password didn't work. Too many wrong tries, so wait a few minutes before trying again."
            } else {
                "That password didn't work."
            },
            "code": "wrong_password",
            "locked_out": locked_out,
        })),
    )
}

/// Turn a failed unlock into the response. A wrong password counts against
/// the user; nothing else does.
fn unlock_failure(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive: &str,
    err: UnlockError,
) -> ApiError {
    match err {
        UnlockError::WrongPassword => wrong_password(state, user, drive),
        UnlockError::NotPresent => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        UnlockError::WrongDrive => {
            json_error_code(StatusCode::CONFLICT, "wrong_drive", err.to_string())
        }
        UnlockError::Other(message) => json_error(StatusCode::BAD_REQUEST, message),
    }
}

fn tool_failure(
    state: &AppState,
    user: &crate::auth::CurrentUser,
    drive: &str,
    err: ToolError,
) -> ApiError {
    match err {
        ToolError::WrongPassword => wrong_password(state, user, drive),
        other => json_error(StatusCode::BAD_REQUEST, other.to_string()),
    }
}

/// Watch a drive that just became readable, so photos and search catch up.
fn watch(state: &AppState, id: &str, mount: &std::path::Path) {
    state.search_index.watch_mount(id, mount.to_path_buf());
    state.gallery.watch_mount(id, mount.to_path_buf());
}

// ---------------------------------------------------------------------------
// State

async fn encryption_state(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<EncryptionJson>, ApiError> {
    authorize(&state, &user, &id)?;
    let row = row(&state, &id)?;
    let present = row.state != "missing" && row.state != "ejected";
    let formatting = is_formatting(&state, &row);
    let manager = state.drive_manager.clone();
    let check = row.clone();
    let open = tokio::task::spawn_blocking(move || vault::is_open_and_mounted(&manager, &check))
        .await
        .map_err(|_| internal())?;
    let status = if !row.encrypted {
        "not_encrypted"
    } else if !present {
        "unplugged"
    } else if formatting {
        "formatting"
    } else if row.locked {
        "locked"
    } else if open {
        "unlocked"
    } else {
        "unavailable"
    };
    Ok(Json(EncryptionJson {
        drive_id: row.id,
        label: row.label,
        encrypted: row.encrypted,
        unlocked: status == "unlocked",
        locked: row.encrypted && row.locked,
        present,
        status,
    }))
}

// ---------------------------------------------------------------------------
// Unlock

async fn unlock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&state, &user, &id)?;
    let first = row(&state, &id)?;
    ready(&state, &first)?;
    let device_guard = lock_idle_device(&state, &first.device).await?;
    let drive_guard = state.db.drive_lock(&id).try_lock_owned().map_err(|_| {
        json_error_code(
            StatusCode::CONFLICT,
            "drive_busy",
            "Luna is already working on this drive. Wait until it finishes.",
        )
    })?;
    let closing = state.drive_manager.begin_closing(&id);
    // Read again under the locks: the row may have changed while waiting.
    let row = row(&state, &id)?;
    ready(&state, &row)?;
    let already = {
        let manager = state.drive_manager.clone();
        let check = row.clone();
        tokio::task::spawn_blocking(move || {
            !check.locked && vault::is_open_and_mounted(&manager, &check)
        })
        .await
        .map_err(|_| internal())?
    };
    if already {
        return Ok(Json(
            serde_json::json!({"ok": true, "already_unlocked": true}),
        ));
    }
    if body.password.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter this drive's password.",
        ));
    }
    check_not_locked_out(&state, &user, &id)?;
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        // The work owns the locks even if the request is dropped.
        let _device_guard = device_guard;
        let _drive_guard = drive_guard;
        let _closing = closing;
        let mount =
            match vault::unlock_drive(&st.drive_manager, &row.id, &row.device, &body.password) {
                Ok(mount) => mount,
                Err(e) => return Err(unlock_failure(&st, &user, &row.id, e)),
            };
        st.unlock_guard.clear_success(&user.id, &row.id);
        let recorded = crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| vault::record_unlocked(conn, &row.id, &mount.to_string_lossy()),
        );
        if recorded.is_err() {
            // Never leave it open when the registry doesn't say so.
            vault::close_for_lock(&st.drive_manager, &row);
            return Err(internal());
        }
        watch(&st, &row.id, &mount);
        Ok(Json(serde_json::json!({"ok": true})))
    })
    .await
    .map_err(|_| internal())?
}

/// Add an existing encrypted Luna drive, after proving its password and
/// identity. Also the way back for a locked drive whose device name changed.
async fn unlock_and_add(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(name): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(user.clone())?;
    if body.password.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter this drive's password.",
        ));
    }
    let device_guard = lock_idle_device(&state, &name).await?;
    if state.format.running_on_device(&name).is_some() {
        return Err(json_error_code(
            StatusCode::CONFLICT,
            "drive_busy",
            "Luna is erasing this drive right now. Try again when it finishes.",
        ));
    }
    let device = find_device(&name).await.ok_or_else(|| {
        json_error(
            StatusCode::NOT_FOUND,
            "Luna can't see this drive. Plug it in and try again.",
        )
    })?;
    check_not_locked_out(&state, &user, &name)?;
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        let _device_guard = device_guard;
        // Read the identity first: it needs only the password, not a registry row.
        let partition = vault::luks_partition(&st.drive_manager, &device.name)
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
        let marker = vault::inspect_identity(&st.drive_manager, &partition, &body.password)
            .map_err(|e| unlock_failure(&st, &user, &name, e))?;
        let id = marker.id.clone();
        let _drive_guard = st.db.drive_lock(&id).try_lock_owned().map_err(|_| {
            json_error_code(
                StatusCode::CONFLICT,
                "drive_busy",
                "Luna is already working on this drive. Wait until it finishes.",
            )
        })?;
        let _closing = st.drive_manager.begin_closing(&id);
        let existing = crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| crate::db::get_drive(conn, &id),
        )
        .map_err(|_| internal())?;
        if let Some(known) = &existing
            && (!known.encrypted || (known.device == device.name && known.state != "missing"))
        {
            return Err(json_error(
                StatusCode::CONFLICT,
                "Luna already knows this drive. Find it in your drives to unlock it.",
            ));
        }
        let mount = vault::unlock_drive(&st.drive_manager, &id, &device.name, &body.password)
            .map_err(|e| unlock_failure(&st, &user, &name, e))?;
        st.unlock_guard.clear_success(&user.id, &name);
        let registered = crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| {
                let tx = conn.unchecked_transaction()?;
                // A known drive keeps its name and access; a new one is registered.
                let label = existing
                    .as_ref()
                    .map(|k| k.label.clone())
                    .unwrap_or_else(|| marker.label.clone());
                crate::db::upsert_drive(
                    &tx,
                    &id,
                    &label,
                    "as_is",
                    "ext4",
                    &device.name,
                    &mount.to_string_lossy(),
                )?;
                crate::db::set_drive_encrypted(&tx, &id, true)?;
                tx.commit()?;
                Ok(())
            },
        );
        if registered.is_err() {
            let stub = crate::db::DriveRow {
                id: id.clone(),
                label: marker.label.clone(),
                state: "as_is".into(),
                fs_type: "ext4".into(),
                device: device.name.clone(),
                mount_point: mount.to_string_lossy().into_owned(),
                encrypted: true,
                locked: false,
            };
            vault::close_for_lock(&st.drive_manager, &stub);
            return Err(internal());
        }
        watch(&st, &id, &mount);
        Ok(Json(serde_json::json!({"ok": true, "drive_id": id})))
    })
    .await
    .map_err(|_| internal())?
}

// ---------------------------------------------------------------------------
// Lock

async fn lock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Unlocking is for anyone who can see the drive; locking is Admin only, so a
    // Member can't shut a drive away from everyone else.
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can lock this drive.",
        ));
    }
    authorize(&state, &user, &id)?;
    let first = row(&state, &id)?;
    ready(&state, &first)?;
    let device_guard = lock_idle_device(&state, &first.device).await?;
    let drive_guard = state.db.drive_lock(&id).try_lock_owned().map_err(|_| {
        json_error_code(
            StatusCode::CONFLICT,
            "drive_busy",
            "Luna is already working on this drive. Wait until it finishes.",
        )
    })?;
    let closing = state.drive_manager.begin_closing(&id);
    let row = row(&state, &id)?;
    ready(&state, &row)?;
    if row.locked {
        // Already locked; make sure no key is left in the kernel.
        let manager = state.drive_manager.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if manager.luks().is_open(&row.id) {
                vault::close_for_lock(&manager, &row);
            }
        })
        .await;
        return Ok(Json(
            serde_json::json!({"ok": true, "already_locked": true}),
        ));
    }
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        let _device_guard = device_guard;
        let _drive_guard = drive_guard;
        let _closing = closing;
        vault::lock_drive(&st, &id).map_err(|e| match e {
            LockError::Busy(message) => {
                json_error_code(StatusCode::CONFLICT, "drive_busy", message)
            }
            LockError::Other(message) => json_error(StatusCode::BAD_REQUEST, message),
        })?;
        Ok(Json(serde_json::json!({"ok": true})))
    })
    .await
    .map_err(|_| internal())?
}

// ---------------------------------------------------------------------------
// Change password

async fn change_password(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<ChangePasswordBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can change this drive's password.",
        ));
    }
    if body.current_password.is_empty() || body.new_password.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter the current and the new password.",
        ));
    }
    if let Err(e) = crate::password::validate_password(&body.new_password) {
        return Err(json_error_code(
            StatusCode::BAD_REQUEST,
            "weak_password",
            e.message(),
        ));
    }
    let first = row(&state, &id)?;
    ready(&state, &first)?;
    let device_guard = lock_idle_device(&state, &first.device).await?;
    let drive_guard = state.db.drive_lock(&id).try_lock_owned().map_err(|_| {
        json_error_code(
            StatusCode::CONFLICT,
            "drive_busy",
            "Luna is already working on this drive. Wait until it finishes.",
        )
    })?;
    let closing = state.drive_manager.begin_closing(&id);
    let row = row(&state, &id)?;
    ready(&state, &row)?;
    check_not_locked_out(&state, &user, &id)?;
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        let _device_guard = device_guard;
        let _drive_guard = drive_guard;
        let _closing = closing;
        let partition = vault::luks_partition(&st.drive_manager, &row.device)
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
        st.drive_manager
            .luks()
            .change_password(&partition, &body.current_password, &body.new_password)
            .map_err(|e| tool_failure(&st, &user, &id, e))?;
        st.unlock_guard.clear_success(&user.id, &id);
        Ok(Json(serde_json::json!({"ok": true})))
    })
    .await
    .map_err(|_| internal())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::DriveManager;
    use crate::drives::crypt::luks::{Luks, MockLuks};
    use crate::drives::format::tools::MockTools;
    use crate::drives::fsprobe::{FsInfo, MockFsProbe};
    use crate::drives::mount::MockMounter;
    use crate::{db, files};
    use axum::body::Body;
    use axum::http::Request;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use tower::ServiceExt;

    struct Harness {
        /// Fresh per harness: the "being locked" gate is process-wide, so tests
        /// that run side by side must not share a drive id.
        id: String,
        _dir: tempfile::TempDir,
        state: AppState,
        mounter: Arc<MockMounter>,
        luks: Arc<MockLuks>,
        admin: String,
        member: String,
    }

    /// One encrypted, locked drive `d1` on disk `sdb`, an Admin and a Member with
    /// read access to it. The container's password is `correct-horse-1`.
    fn harness() -> Harness {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let mounter = Arc::new(MockMounter::default());
        let luks = Arc::new(MockLuks::default());
        *luks.password.lock().unwrap() = Some("correct-horse-1".into());
        let probe = MockFsProbe::default();
        probe.disks.lock().unwrap().insert(
            "sdb".into(),
            vec![FsInfo {
                name: "sdb1".into(),
                fs_type: "crypto_LUKS".into(),
                label: String::new(),
                size_bytes: 1 << 30,
            }],
        );
        let manager = Arc::new(
            DriveManager::new_with_probe(mounter.clone(), dir.path(), Arc::new(probe))
                .with_luks(luks.clone()),
        );
        let mut state = AppState::new(conn, manager, dir.path());
        let mut service = crate::drives::format::FormatService::new(Arc::new(MockTools::default()));
        service.mock_step = std::time::Duration::ZERO;
        service.busy_retry = std::time::Duration::ZERO;
        state.format = Arc::new(service);
        // The marker the drive carries inside its container.
        let root = state.drive_manager.adopted_mount_point(&id);
        std::fs::create_dir_all(&root).unwrap();
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        luna_core::marker::write_marker(
            &root,
            &luna_core::marker::Marker::new(&id, "Photos"),
            &prefix,
        )
        .unwrap();
        {
            let conn = state.db.lock().unwrap();
            db::upsert_drive(&conn, &id, "Photos", "as_is", "ext4", "sdb", "").unwrap();
            db::set_drive_encrypted(&conn, &id, true).unwrap();
            db::set_drive_locked(&conn, &id, true).unwrap();
        }
        let admin = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = state
            .auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        {
            let conn = state.db.lock().unwrap();
            db::insert_access_member(
                &conn,
                &db::AccessMemberRow {
                    id: "m1".into(),
                    subject_kind: crate::access::KIND_PATH.into(),
                    drive_id: id.clone(),
                    path: String::new(),
                    album_id: String::new(),
                    user_id: member.id.clone(),
                    caps: crate::access::CAP_VIEW,
                    created_by: admin.id.clone(),
                },
            )
            .unwrap();
        }
        Harness {
            id,
            admin: state.auth.issue(&admin).unwrap(),
            member: state.auth.issue(&member).unwrap(),
            _dir: dir,
            state,
            mounter,
            luks,
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
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header("Content-Type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let response = router.oneshot(req.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    impl Harness {
        fn uri(&self, tail: &str) -> String {
            format!("/api/v1/drives/{}/{tail}", self.id)
        }
    }

    fn drive(h: &Harness) -> db::DriveRow {
        db::get_drive(&h.state.db.lock().unwrap(), &h.id)
            .unwrap()
            .unwrap()
    }

    fn unlock_body(password: &str) -> Option<Value> {
        Some(json!({ "password": password }))
    }

    #[tokio::test]
    async fn a_locked_drive_reports_itself_and_files_code_refuses_it_with_423() {
        let h = harness();
        let (status, body) = call(&h, "GET", &h.uri("encryption"), None, &h.admin).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "locked");
        assert_eq!(body["locked"], true);
        assert_eq!(body["unlocked"], false);
        // The one gate: even with a stale mount path, a locked drive is refused,
        // and the answer is "locked", not "can't find this drive".
        let conn = h.state.db.lock().unwrap();
        conn.execute(
            "UPDATE drives SET mount_point = '/somewhere' WHERE id = ?1",
            [&h.id],
        )
        .unwrap();
        let refused = files::drive_root(&conn, &h.id).unwrap_err();
        assert!(matches!(refused, files::FilesError::Locked));
        let (status, body) = crate::api::files::map_files_err(refused);
        assert_eq!(status, StatusCode::LOCKED);
        assert_eq!(body.0["code"], "drive_locked");
        assert_eq!(body.0["error"], files::DRIVE_LOCKED_MSG);
    }

    #[tokio::test]
    async fn the_right_password_unlocks_and_the_files_gate_opens() {
        let h = harness();
        let (status, _) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let row = drive(&h);
        assert!(!row.locked && row.encrypted);
        assert_eq!(
            row.mount_point,
            h.state
                .drive_manager
                .adopted_mount_point(&h.id)
                .to_string_lossy()
        );
        assert!(files::drive_root(&h.state.db.lock().unwrap(), &h.id).is_ok());
        let (_, body) = call(&h, "GET", &h.uri("encryption"), None, &h.admin).await;
        assert_eq!(body["status"], "unlocked");
        // Unlocking again is a no-op, not a second attempt.
        let opens = h.luks.count("open");
        let (status, body) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("whatever"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["already_unlocked"], true);
        assert_eq!(h.luks.count("open"), opens);
    }

    #[tokio::test]
    async fn a_member_who_can_see_the_drive_can_unlock_it_but_not_lock_it_and_a_stranger_cannot() {
        let h = harness();
        let (status, _) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.member,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(&h, "POST", &h.uri("lock"), None, &h.member).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!drive(&h).locked);
        // No access at all.
        let stranger = h
            .state
            .auth
            .register("Sam", "Sam", "hunter22hunter1", "user")
            .unwrap();
        let token = h.state.auth.issue(&stranger).unwrap();
        let (status, _) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn locking_closes_the_container_and_files_code_says_locked() {
        let h = harness();
        call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.admin,
        )
        .await;
        let (status, _) = call(&h, "POST", &h.uri("lock"), None, &h.admin).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!h.luks.is_open(&h.id));
        let row = drive(&h);
        assert!(row.locked && row.mount_point.is_empty());
        assert!(matches!(
            files::drive_root(&h.state.db.lock().unwrap(), &h.id),
            Err(files::FilesError::Locked)
        ));
        // Locking a locked drive is fine.
        let (status, body) = call(&h, "POST", &h.uri("lock"), None, &h.admin).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["already_locked"], true);
    }

    #[tokio::test]
    async fn a_busy_drive_refuses_to_lock_and_stays_unlocked() {
        let h = harness();
        call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.admin,
        )
        .await;
        *h.mounter.busy_unmounts.lock().unwrap() = 1000;
        let (status, body) = call(&h, "POST", &h.uri("lock"), None, &h.admin).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "drive_busy");
        assert!(h.luks.is_open(&h.id));
        assert!(!drive(&h).locked);
    }

    #[tokio::test]
    async fn five_wrong_tries_lock_the_person_out_even_for_the_right_password() {
        let h = harness();
        let uri = h.uri("unlock");
        for tries in 1..=5 {
            let (status, body) = call(&h, "POST", &uri, unlock_body("nope"), &h.admin).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "try {tries}");
            assert_eq!(body["code"], "wrong_password");
            assert_eq!(body["locked_out"], tries == 5);
        }
        let (status, body) = call(&h, "POST", &uri, unlock_body("correct-horse-1"), &h.admin).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["code"], "too_many_tries");
        assert!(drive(&h).locked);
        // Another person is not locked out by this one's tries.
        let (status, _) = call(&h, "POST", &uri, unlock_body("correct-horse-1"), &h.member).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn right_passwords_never_count_toward_the_limit() {
        let h = harness();
        let uri = h.uri("unlock");
        for _ in 0..4 {
            call(&h, "POST", &uri, unlock_body("nope"), &h.admin).await;
        }
        let (status, _) = call(&h, "POST", &uri, unlock_body("correct-horse-1"), &h.admin).await;
        assert_eq!(status, StatusCode::OK);
        call(&h, "POST", &h.uri("lock"), None, &h.admin).await;
        // The count was cleared by the success, so four more wrong tries are still allowed.
        for _ in 0..4 {
            let (status, _) = call(&h, "POST", &uri, unlock_body("nope"), &h.admin).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
    }

    #[tokio::test]
    async fn a_plain_or_unplugged_drive_cannot_be_unlocked() {
        let h = harness();
        {
            let conn = h.state.db.lock().unwrap();
            db::upsert_drive(&conn, "plain", "Stick", "as_is", "exfat", "sdc", "/mnt/p").unwrap();
        }
        let (status, body) = call(
            &h,
            "POST",
            "/api/v1/drives/plain/unlock",
            unlock_body("x"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "This drive isn't encrypted.");
        {
            let conn = h.state.db.lock().unwrap();
            db::set_drive_state(&conn, &h.id, "missing").unwrap();
        }
        let (status, body) = call(&h, "POST", &h.uri("unlock"), unlock_body("x"), &h.admin).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("unplugged"));
        assert_eq!(h.luks.count("open"), 0);
    }

    #[tokio::test]
    async fn a_drive_being_erased_cannot_be_unlocked() {
        let h = harness();
        let run = h.state.format.begin_run("sdb", Some(h.id.clone()), true);
        let (status, body) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "drive_busy");
        drop(run);
    }

    #[tokio::test]
    async fn only_an_admin_changes_the_password_and_it_needs_the_current_one() {
        let h = harness();
        let uri = h.uri("password");
        let body =
            json!({"current_password": "correct-horse-1", "new_password": "brand-new-pass-2"});
        let (status, _) = call(&h, "POST", &uri, Some(body.clone()), &h.member).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(h.luks.count("change_password"), 0);

        let wrong = json!({"current_password": "guess", "new_password": "brand-new-pass-2"});
        let (status, got) = call(&h, "POST", &uri, Some(wrong), &h.admin).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(got["code"], "wrong_password");

        let weak = json!({"current_password": "correct-horse-1", "new_password": "short"});
        let (status, got) = call(&h, "POST", &uri, Some(weak), &h.admin).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(got["code"], "weak_password");

        let (status, _) = call(&h, "POST", &uri, Some(body), &h.admin).await;
        assert_eq!(status, StatusCode::OK);
        // Only the new password opens it now.
        assert!(h.luks.open("/dev/sdb1", "x", "correct-horse-1").is_err());
        assert!(h.luks.open("/dev/sdb1", "x", "brand-new-pass-2").is_ok());
    }

    #[tokio::test]
    async fn guessing_through_the_password_change_counts_against_the_same_limit() {
        let h = harness();
        let uri = h.uri("password");
        let wrong = json!({"current_password": "guess", "new_password": "brand-new-pass-2"});
        for _ in 0..5 {
            call(&h, "POST", &uri, Some(wrong.clone()), &h.admin).await;
        }
        let (status, _) = call(
            &h,
            "POST",
            &h.uri("unlock"),
            unlock_body("correct-horse-1"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn unlock_and_add_is_for_admins_and_needs_a_password() {
        let h = harness();
        let (status, _) = call(
            &h,
            "POST",
            "/api/v1/drives/sdb/unlock-and-add",
            unlock_body("correct-horse-1"),
            &h.member,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &h,
            "POST",
            "/api/v1/drives/sdb/unlock-and-add",
            unlock_body(""),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // A disk that is not plugged in.
        let (status, _) = call(
            &h,
            "POST",
            "/api/v1/drives/sdnothere/unlock-and-add",
            unlock_body("x"),
            &h.admin,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(h.luks.count("open"), 0);
    }
}
