//! Non-destructive operations on encrypted drives.
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::AppState;
use crate::api::response::{json_error, json_error_code};
use crate::drives::vault::{self, UnlockError};

type ApiError = (StatusCode, Json<serde_json::Value>);

#[derive(Serialize)]
struct EncryptionJson {
    drive_id: String,
    label: String,
    encrypted: bool,
    unlocked: bool,
    converting: bool,
    present: bool,
    fs_type: String,
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
        .route("/api/v1/drives/{id}/encryption", get(state))
        .route("/api/v1/drives/{id}/unlock", post(unlock))
        .route("/api/v1/drives/{id}/lock", post(lock))
        .route("/api/v1/drives/{id}/password", post(change_password))
        .route("/api/v1/drives/{name}/unlock-and-add", post(unlock_and_add))
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
fn ready(row: &crate::db::DriveRow) -> Result<(), ApiError> {
    if row.state == "missing" || row.state == "ejected" {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive is unplugged. Plug it in and try again.",
        ));
    }
    if row.converting {
        return Err(json_error_code(
            StatusCode::LOCKED,
            "drive_converting",
            crate::files::DRIVE_CONVERTING_MSG,
        ));
    }
    if !row.encrypted {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive isn't encrypted.",
        ));
    }
    Ok(())
}
fn limit(state: &AppState, user: &crate::auth::CurrentUser, id: &str) -> Result<(), ApiError> {
    if state
        .unlock_limiter
        .allow(&format!("unlock:{}:{}", user.id, id))
    {
        Ok(())
    } else {
        Err(json_error_code(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_tries",
            "Too many wrong tries. Wait a few minutes, then try again.",
        ))
    }
}
fn failure(err: UnlockError) -> ApiError {
    match err {
        UnlockError::WrongPassword => json_error_code(
            StatusCode::UNAUTHORIZED,
            "wrong_password",
            "That password didn't work.",
        ),
        other => json_error(StatusCode::BAD_REQUEST, other.message()),
    }
}

fn verified_mount(state: &AppState, row: &crate::db::DriveRow) -> bool {
    if row.mount_point.is_empty() || !state.drive_manager.luks().is_open(&row.id) {
        return false;
    }
    let mount = std::path::Path::new(&row.mount_point);
    state.drive_manager.mounter().is_mounted(mount)
        && luna_core::marker::read_marker(mount)
            .ok()
            .flatten()
            .is_some_and(|marker| marker.id == row.id)
}

async fn state(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<EncryptionJson>, ApiError> {
    authorize(&state, &user, &id)?;
    let row = row(&state, &id)?;
    let present = row.state != "missing" && row.state != "ejected";
    let (status, unlocked) = if row.converting {
        let formatting = crate::db::with_db(&state.db, || anyhow::anyhow!("db lock poisoned"), |conn| {
            Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE drive_id=?1 AND state IN ('queued','running'))", [&id], |r| r.get::<_, bool>(0))?)
        }).unwrap_or(false);
        (
            if formatting {
                "formatting"
            } else {
                "unavailable"
            },
            false,
        )
    } else if !present || !row.encrypted {
        ("unavailable", false)
    } else if !state.drive_manager.luks().is_open(&id) {
        ("locked", false)
    } else if verified_mount(&state, &row) {
        ("unlocked", true)
    } else {
        ("unavailable", false)
    };
    Ok(Json(EncryptionJson {
        drive_id: row.id,
        label: row.label,
        encrypted: row.encrypted,
        unlocked,
        converting: row.converting,
        present,
        fs_type: row.fs_type,
        status,
    }))
}

async fn unlock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&state, &user, &id)?;
    let _guard = state.db.drive_lock(&id).lock_owned().await;
    let _closing = state.drive_manager.begin_closing(&id);
    let row = row(&state, &id)?;
    ready(&row)?;
    if verified_mount(&state, &row) {
        return Ok(Json(
            serde_json::json!({"ok": true, "already_unlocked": true}),
        ));
    }
    limit(&state, &user, &id)?;
    let st = state.clone();
    let drive = id.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = _guard;
        let _closing = _closing;
        let partition = st
            .drive_manager
            .luks_partition(&row.device)
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
        let mount = vault::unlock_drive(
            st.drive_manager.mounter(),
            st.drive_manager.luks(),
            &st.data_dir,
            &drive,
            &partition,
            &body.password,
        )
        .map_err(failure)?;
        if crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| vault::record_unlocked(conn, &drive, &mount),
        )
        .is_err()
        {
            let _ = vault::lock_drive(
                st.drive_manager.mounter(),
                st.drive_manager.luks(),
                &drive,
                &mount,
            );
            return Err(internal());
        }
        let mount = std::path::PathBuf::from(mount);
        st.search_index.watch_mount(&drive, mount.clone());
        st.gallery.watch_mount(&drive, mount);
        Ok(Json(serde_json::json!({"ok": true})))
    })
    .await
    .map_err(|_| internal())?
}

/// Add an existing encrypted Luna drive after proving its password and identity.
async fn unlock_and_add(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(name): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can add a drive.",
        ));
    }
    if body.password.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter this drive's password.",
        ));
    }
    let guard = state
        .db
        .drive_lock(&format!("format-device:{name}"))
        .lock_owned()
        .await;
    let busy: bool = crate::db::with_db(&state.db, || anyhow::anyhow!("db lock poisoned"), |conn| {
        Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM drive_format_operations WHERE device=?1 AND state IN ('queued','running'))", [&name], |r| r.get(0))?)
    }).map_err(|_| internal())?;
    if busy {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Luna is already formatting this drive.",
        ));
    }
    limit(&state, &user, &name)?;
    let st = state.clone();
    let disk = name.clone();
    let (result, guard, body) = tokio::task::spawn_blocking(move || {
        let result = (|| {
            let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
            let device = crate::drives::detect::scan_with_dev_mocks(
                std::path::Path::new("/sys/block"),
                &mounts,
            )
            .into_iter()
            .find(|d| d.name == disk && d.is_storage_candidate())
            .ok_or_else(|| {
                json_error(
                    StatusCode::NOT_FOUND,
                    "Luna can't see this drive. Plug it in and try again.",
                )
            })?;
            let partition = st
                .drive_manager
                .luks_partition(&disk)
                .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
            let marker = vault::inspect_identity(
                st.drive_manager.mounter(),
                st.drive_manager.luks(),
                &st.data_dir,
                &partition,
                &body.password,
            )
            .map_err(failure)?;
            Ok::<_, ApiError>((device, marker))
        })();
        (result, guard, body)
    })
    .await
    .map_err(|_| internal())?;
    let (device, marker) = result?;
    let id = marker.id.clone();
    let drive_guard = state.db.drive_lock(&id).lock_owned().await;
    let st = state.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let _drive_guard = drive_guard;
        let _closing = st.drive_manager.begin_closing(&id);
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        let same =
            crate::drives::detect::scan_with_dev_mocks(std::path::Path::new("/sys/block"), &mounts)
                .into_iter()
                .any(|d| {
                    d.name == device.name
                        && d.is_storage_candidate()
                        && d.diskseq == device.diskseq
                        && d.size_bytes == device.size_bytes
                });
        if !same {
            return Err(json_error(
                StatusCode::CONFLICT,
                "This drive changed. Plug it in and try again.",
            ));
        }
        if row(&st, &id).is_ok() {
            return Err(json_error(
                StatusCode::CONFLICT,
                "Luna already knows this drive. Find it in your drives to unlock it.",
            ));
        }
        let partition = st
            .drive_manager
            .luks_partition(&device.name)
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
        let mount = vault::unlock_drive(
            st.drive_manager.mounter(),
            st.drive_manager.luks(),
            &st.data_dir,
            &id,
            &partition,
            &body.password,
        )
        .map_err(failure)?;
        let registered = crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| {
                let tx = conn.unchecked_transaction()?;
                if crate::db::get_drive(&tx, &id)?.is_some() {
                    anyhow::bail!("drive already exists");
                }
                crate::db::upsert_drive(
                    &tx,
                    &id,
                    &marker.label,
                    "as_is",
                    "ext4",
                    &device.name,
                    &mount,
                )?;
                crate::db::set_drive_encrypted(&tx, &id, true)?;
                crate::db::set_drive_locked(&tx, &id, false)?;
                tx.commit()?;
                Ok(())
            },
        );
        if registered.is_err() {
            let _ = vault::lock_drive(
                st.drive_manager.mounter(),
                st.drive_manager.luks(),
                &id,
                &mount,
            );
            return Err(internal());
        }
        let path = std::path::PathBuf::from(mount);
        st.search_index.watch_mount(&id, path.clone());
        st.gallery.watch_mount(&id, path);
        Ok(Json(serde_json::json!({"ok": true, "drive_id": id})))
    })
    .await
    .map_err(|_| internal())?
}

fn hold_background_work(
    state: &AppState,
    id: &str,
) -> Result<
    (
        Vec<crate::backup::drive_backup::RunSlot>,
        Vec<crate::backup::cloud::run::RunSlot>,
    ),
    ApiError,
> {
    let (working, protections) = crate::db::with_db(&state.db, || anyhow::anyhow!("db lock poisoned"), |conn| {
        let working: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE state IN ('running','queued') AND (from_drive=?1 OR to_drive=?1))", [id], |row| row.get(0))?;
        let protections = crate::db::list_protections(conn)?.into_iter().filter(|p| p.source_drive == id || p.target_drive == id).collect::<Vec<_>>();
        Ok((working, protections))
    }).map_err(|_| internal())?;
    let busy = || {
        json_error(
            StatusCode::CONFLICT,
            "Wait for copies and backups using this drive to finish, then try locking it again.",
        )
    };
    if working {
        return Err(busy());
    }
    let mut local = Vec::new();
    let mut cloud = Vec::new();
    for protection in protections {
        local.push(
            crate::backup::drive_backup::try_hold(&state.db, &protection.id).ok_or_else(busy)?,
        );
        cloud.push(
            crate::backup::cloud::run::RunSlot::take(&state.db, &protection.id).ok_or_else(busy)?,
        );
    }
    Ok((local, cloud))
}

async fn lock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize(&state, &user, &id)?;
    let _guard = state.db.drive_lock(&id).lock_owned().await;
    let _closing = state.drive_manager.begin_closing(&id);
    let row = row(&state, &id)?;
    ready(&row)?;
    if state.collab.drive_is_active(&id) || state.office_docs.drive_is_active(&id) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "Close documents open from this drive, then try locking it again.",
        ));
    }
    crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::set_drive_converting(conn, &id, true),
    )
    .map_err(|_| internal())?;
    let gate = OperationGate {
        state: state.clone(),
        id: id.clone(),
    };
    state.ram_cache.begin_close(&id);
    let st = state.clone();
    let drive = id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _guard = _guard;
        let _closing = _closing;
        let _gate = gate;
        let _ram_close = RamClose {
            state: st.clone(),
            id: drive.clone(),
        };
        let _background = hold_background_work(&st, &drive)?;
        if !st.ram_cache.dirty_rels_for_drive(&drive).is_empty()
            && (row.mount_point.is_empty()
                || st
                    .ram_cache
                    .flush_drive_dirty(&drive, std::path::Path::new(&row.mount_point))
                    .is_err())
        {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't finish saving files on this drive. Wait a moment and try again.",
            ));
        }
        st.gallery.unwatch_mount(&drive);
        st.search_index.unwatch_mount(&drive);
        let canonical_mount = vault::mount_point_for(&st.data_dir, &drive);
        let mount_point = if row.mount_point.is_empty() {
            canonical_mount.to_string_lossy().into_owned()
        } else {
            row.mount_point.clone()
        };
        if let Err(e) = vault::lock_drive(
            st.drive_manager.mounter(),
            st.drive_manager.luks(),
            &drive,
            &mount_point,
        ) {
            // If closing the mapper failed after unmount, try to restore access.
            if !row.mount_point.is_empty()
                && !st
                    .drive_manager
                    .mounter()
                    .is_mounted(std::path::Path::new(&row.mount_point))
                && st.drive_manager.luks().is_open(&drive)
            {
                let _ = vault::mount_container(st.drive_manager.mounter(), &st.data_dir, &drive);
            }
            if !row.mount_point.is_empty()
                && st
                    .drive_manager
                    .mounter()
                    .is_mounted(std::path::Path::new(&row.mount_point))
            {
                let mount = std::path::PathBuf::from(&row.mount_point);
                st.search_index.watch_mount(&drive, mount.clone());
                st.gallery.watch_mount(&drive, mount);
            } else {
                let _ = crate::db::with_db(
                    &st.db,
                    || anyhow::anyhow!("db lock poisoned"),
                    |conn| crate::db::set_drive_mount_point(conn, &drive, ""),
                );
            }
            return Err(json_error(StatusCode::BAD_REQUEST, e.to_string()));
        }
        crate::db::with_db(
            &st.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| vault::record_locked(conn, &drive),
        )
        .map_err(|_| internal())?;
        st.ram_cache.drop_drive(&drive);
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err(internal()));
    result?;
    Ok(Json(serde_json::json!({"ok": true})))
}

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
    authorize(&state, &user, &id)?;
    if body.new_password.is_empty() || body.current_password.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter the current and new passwords.",
        ));
    }
    let _guard = state.db.drive_lock(&id).lock_owned().await;
    let _closing = state.drive_manager.begin_closing(&id);
    let row = row(&state, &id)?;
    ready(&row)?;
    limit(&state, &user, &id)?;
    let manager = state.drive_manager.clone();
    let result = tokio::task::spawn_blocking(move || {
        let result = manager.luks_partition(&row.device).and_then(|partition| {
            manager
                .luks()
                .change_password(&partition, &body.current_password, &body.new_password)
        });
        (result, _guard, _closing)
    })
    .await
    .map_err(|_| internal())?;
    let (result, _guard, _closing) = result;
    result.map_err(|e| {
        if e.to_string() == "That password didn't work." {
            failure(UnlockError::WrongPassword)
        } else {
            json_error(StatusCode::BAD_REQUEST, e.to_string())
        }
    })?;
    Ok(Json(serde_json::json!({"ok": true})))
}

// Prevent new file operations during unmount, even if the request is dropped.
struct OperationGate {
    state: AppState,
    id: String,
}
impl Drop for OperationGate {
    fn drop(&mut self) {
        let _ = crate::db::with_db(
            &self.state.db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| crate::db::set_drive_converting(conn, &self.id, false),
        );
    }
}

struct RamClose {
    state: AppState,
    id: String,
}
impl Drop for RamClose {
    fn drop(&mut self) {
        self.state.ram_cache.end_close(&self.id);
    }
}

fn unknown_drive() -> ApiError {
    json_error_code(
        StatusCode::NOT_FOUND,
        "unknown_drive",
        "Luna doesn't know this drive.",
    )
}
fn internal() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't finish with this drive. Try again.",
    )
}

pub fn profile() -> (&'static str, &'static str, &'static str) {
    (
        crate::drives::luks::CIPHER,
        crate::drives::luks::KEY_BITS,
        crate::drives::luks::SECTOR_BYTES,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn drive() -> crate::db::DriveRow {
        crate::db::DriveRow {
            id: "d1".into(),
            label: "Photos".into(),
            state: "as_is".into(),
            fs_type: "ext4".into(),
            device: "sdb".into(),
            mount_point: String::new(),
            encrypted: true,
            locked: true,
            converting: false,
        }
    }

    #[test]
    fn absent_and_formatting_drives_cannot_be_changed() {
        let mut row = drive();
        row.state = "missing".into();
        assert_eq!(ready(&row).unwrap_err().0, StatusCode::BAD_REQUEST);
        row.state = "as_is".into();
        row.converting = true;
        let (status, body) = ready(&row).unwrap_err();
        assert_eq!(status, StatusCode::LOCKED);
        assert_eq!(body.0["code"], "drive_converting");
    }

    /// A state with one encrypted, locked drive on a mock mount and an Admin token.
    fn app(dir: &std::path::Path) -> (crate::AppState, String) {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir,
        ));
        let state = crate::AppState::new(conn, manager, dir);
        {
            let conn = state.db.lock().unwrap();
            crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdb", "").unwrap();
            crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
            crate::db::set_drive_locked(&conn, "d1", true).unwrap();
        }
        let admin = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = state.auth.issue(&admin).unwrap();
        (state, token)
    }

    async fn get(
        state: &crate::AppState,
        token: &str,
        uri: &str,
    ) -> (StatusCode, serde_json::Value) {
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let response = router
            .oneshot(
                Request::get(uri)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    /// The web UI reads protection state from this route, so its shape is
    /// recorded into the contract fixture the fake lunad is checked against.
    #[tokio::test]
    async fn the_encryption_state_reports_a_locked_drive() {
        let dir = tempfile::tempdir().unwrap();
        let (state, token) = app(dir.path());
        let (status, body) = get(&state, &token, "/api/v1/drives/d1/encryption").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["encrypted"], true);
        assert_eq!(body["unlocked"], false);
        assert_eq!(body["present"], true);
        assert_eq!(body["status"], "locked");
        assert_eq!(body["converting"], false);
    }

    #[tokio::test]
    async fn old_destructive_endpoints_are_not_registered() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let manager = std::sync::Arc::new(crate::drives::DriveManager::new(
            crate::drives::mount::shared_mock(),
            dir.path(),
        ));
        let state = crate::AppState::new(conn, manager, dir.path());
        for action in ["encrypt", "decrypt", "reformat"] {
            let response = router()
                .with_state(state.clone())
                .oneshot(
                    Request::post(format!("/api/v1/drives/d1/{action}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn wrong_password_has_a_distinct_response() {
        let (status, body) = failure(UnlockError::WrongPassword);
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body.0["code"], "wrong_password");
        let (status, _) = failure(UnlockError::Other("Mount failed".into()));
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
