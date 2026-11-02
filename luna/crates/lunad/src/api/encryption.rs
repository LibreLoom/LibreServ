//! Encryption: the drive's encryption state, and unlocking/locking it.
//!
//! Two permissions live here and they are deliberately different:
//!
//! - **Unlocking** is open to anyone who can already read the drive. If a
//!   person can see the files, they already have everything the password
//!   protects, so withholding the button buys nothing. The rate limit is what
//!   makes that safe.
//! - **Encrypting and decrypting** are Admin-only, matching Remove and Eject.
//!   They change the drive itself, not the session.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::api::response::{json_error, json_error_code};
use crate::drives::luks::{self, ReencryptState};
use crate::drives::vault::{self, UnlockError};

#[derive(Serialize)]
struct EncryptionJson {
    drive_id: String,
    label: String,
    /// The drive on disk is a LUKS2 container.
    encrypted: bool,
    /// The container is open right now.
    unlocked: bool,
    /// An in-place conversion holds the drive.
    converting: bool,
    /// A conversion was started and did not finish. Needs the password.
    interrupted: bool,
    /// The drive is plugged in.
    present: bool,
    /// The filesystem inside, once known.
    fs_type: String,
    /// Whether Luna can convert this drive in place, and why not when it can't.
    can_encrypt: bool,
    cannot_encrypt_reason: String,
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/drives/{id}/encryption", get(state))
        .route("/api/v1/drives/{id}/unlock", post(unlock))
        .route("/api/v1/drives/{id}/lock", post(lock))
        .route("/api/v1/drives/{id}/encrypt", post(encrypt))
        .route("/api/v1/drives/{id}/decrypt", post(decrypt))
}

/// The encryption page's whole view of a drive.
async fn state(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<EncryptionJson>, (StatusCode, Json<serde_json::Value>)> {
    let row = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::get_drive(conn, &id),
    )
    .map_err(|_| internal())?
    .ok_or_else(unknown_drive)?;

    // Members may see the state of a drive they can reach — they need to know
    // why it is unavailable — but not the server plumbing.
    let allowed = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| Ok(crate::auth::has_drive_access(&user, conn, &id)),
    )
    .unwrap_or(false);
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to this drive.",
        ));
    }

    let present = row.state != "missing" && row.state != "ejected";
    let interrupted = if row.encrypted && present && !row.device.is_empty() {
        matches!(
            state
                .drive_manager
                .luks()
                .reencrypt_state(&device_path(&row.device)),
            ReencryptState::Interrupted
        )
    } else {
        false
    };

    let (can_encrypt, cannot_encrypt_reason) = if row.encrypted {
        (false, String::new())
    } else {
        encryptability(&row)
    };

    Ok(Json(EncryptionJson {
        drive_id: row.id,
        label: row.label,
        encrypted: row.encrypted,
        unlocked: row.encrypted && !row.locked,
        converting: row.converting,
        interrupted,
        present,
        fs_type: row.fs_type,
        can_encrypt,
        cannot_encrypt_reason,
    }))
}

/// Whether this drive can be encrypted in place, and the plain reason when it
/// cannot.
///
/// Only ext4 can be converted in place: `cryptsetup reencrypt --encrypt` needs
/// the filesystem shrunk by the header size first, and only ext4 can be shrunk.
/// exFAT, FAT32 and NTFS have no shrink tool, so those drives are encrypted by
/// copying into a new container instead.
fn encryptability(row: &crate::db::DriveRow) -> (bool, String) {
    if row.state == "missing" || row.state == "ejected" {
        return (false, "Plug this drive in to encrypt it.".to_string());
    }
    if row.mount_point.is_empty() {
        return (
            false,
            "Luna can't open this drive right now, so it can't encrypt it.".to_string(),
        );
    }
    let fs = row.fs_type.to_ascii_lowercase();
    if fs != "ext4" {
        return (
            false,
            "Luna can only encrypt ext4 drives in place. To encrypt this one, copy its files to a new encrypted drive.".to_string(),
        );
    }
    let device = device_path(&row.device);
    if !crate::drives::ext4::can_shrink_for_header(&device) {
        return (
            false,
            "This drive is too full or too small to encrypt. Free some space and try again."
                .to_string(),
        );
    }
    (true, String::new())
}

fn device_path(name: &str) -> String {
    if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/dev/{name}")
    }
}

/// Unlock a drive. Anyone who can read it may do this; the rate limit is what
/// keeps a Member with a live session from guessing.
async fn unlock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let row = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::get_drive(conn, &id),
    )
    .map_err(|_| internal())?
    .ok_or_else(unknown_drive)?;

    let allowed = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| Ok(crate::auth::has_drive_access(&user, conn, &id)),
    )
    .unwrap_or(false);
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to this drive.",
        ));
    }
    if !row.encrypted {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive isn't encrypted, so it doesn't need a password.",
        ));
    }
    if row.converting {
        return Err(json_error_code(
            StatusCode::LOCKED,
            "drive_converting",
            crate::files::DRIVE_CONVERTING_MSG,
        ));
    }
    if !row.locked && !row.mount_point.is_empty() {
        // Already open — nothing to do, and asking for the password again
        // would be a confusing way to say so.
        return Ok(Json(
            serde_json::json!({ "ok": true, "already_unlocked": true }),
        ));
    }

    // Per user, per drive: five wrong tries then a wait. Keyed on the user so
    // one person cannot spend the whole household's attempts.
    let key = format!("unlock:{}:{}", user.id, id);
    if !state.unlock_limiter.allow(&key) {
        return Err(json_error_code(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_tries",
            "Too many wrong tries. Wait a few minutes, then try again.",
        ));
    }

    let (manager, data_dir, drive_id, device) = (
        state.drive_manager.clone(),
        state.data_dir.clone(),
        row.id.clone(),
        device_path(&row.device),
    );
    let password = body.password;
    let result = tokio::task::spawn_blocking(move || {
        vault::unlock_drive(
            manager.mounter(),
            manager.luks(),
            &data_dir,
            &drive_id,
            &device,
            &password,
        )
    })
    .await
    .map_err(|_| internal())?;

    match result {
        Ok(mount_point) => {
            crate::db::with_db(
                &state.db,
                || anyhow::anyhow!("db lock poisoned"),
                |conn| vault::record_unlocked(conn, &id, &mount_point),
            )
            .map_err(|_| internal())?;
            // The drive just became readable: re-arm what indexes it.
            let mount = std::path::PathBuf::from(&mount_point);
            state.search_index.watch_mount(&id, mount.clone());
            state.gallery.watch_mount(&id, mount);
            Ok(Json(serde_json::json!({ "ok": true })))
        }
        Err(UnlockError::WrongPassword) => Err(json_error_code(
            StatusCode::UNAUTHORIZED,
            "wrong_password",
            "That password didn't work.",
        )),
        Err(UnlockError::NotPresent) => Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive is unplugged. Plug it in and try again.",
        )),
        Err(other) => Err(json_error(StatusCode::BAD_REQUEST, other.message())),
    }
}

/// Lock a drive: flush, unmount, then close the container.
async fn lock(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let row = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::get_drive(conn, &id),
    )
    .map_err(|_| internal())?
    .ok_or_else(unknown_drive)?;

    let allowed = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| Ok(crate::auth::has_drive_access(&user, conn, &id)),
    )
    .unwrap_or(false);
    if !allowed {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to this drive.",
        ));
    }
    if !row.encrypted {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive isn't encrypted, so there's nothing to lock.",
        ));
    }
    if row.converting {
        return Err(json_error_code(
            StatusCode::LOCKED,
            "drive_converting",
            crate::files::DRIVE_CONVERTING_MSG,
        ));
    }

    // Buffered saves must land before the unmount, exactly like Eject.
    state.ram_cache.begin_close(&id);
    let _ = state
        .ram_cache
        .flush_drive_dirty(&id, std::path::Path::new(&row.mount_point));

    let (manager, mount_point, drive_id) = (
        state.drive_manager.clone(),
        row.mount_point.clone(),
        row.id.clone(),
    );
    tokio::task::spawn_blocking(move || {
        vault::lock_drive(manager.mounter(), manager.luks(), &drive_id, &mount_point)
    })
    .await
    .map_err(|_| internal())?
    .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;

    crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| vault::record_locked(conn, &id),
    )
    .map_err(|_| internal())?;

    // Nothing can read it now: drop the watchers and the RAM cache.
    state.gallery.unwatch_mount(&id);
    state.search_index.unwatch_mount(&id);
    state.ram_cache.drop_drive(&id);

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Start encrypting a drive. Admin-only, and destructive in the sense that the
/// drive is unavailable for hours and the password cannot be recovered.
async fn encrypt(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    start_conversion(
        state,
        user,
        id,
        body.password,
        crate::drives::convert::Direction::Encrypt,
    )
    .await
}

/// Start decrypting a drive. Asks for the password: it proves the person knows
/// it rather than merely sitting at an unlocked session, and it is the last
/// moment before the files become readable by anyone who plugs the drive in.
async fn decrypt(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Path(id): Path<String>,
    Json(body): Json<PasswordBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    start_conversion(
        state,
        user,
        id,
        body.password,
        crate::drives::convert::Direction::Decrypt,
    )
    .await
}

async fn start_conversion(
    state: AppState,
    user: crate::auth::CurrentUser,
    id: String,
    password: String,
    direction: crate::drives::convert::Direction,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use crate::drives::convert::Direction;
    // Changing whether a drive is encrypted is an Admin action, matching
    // Remove and Eject.
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can change whether a drive is encrypted.",
        ));
    }
    let row = crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::get_drive(conn, &id),
    )
    .map_err(|_| internal())?
    .ok_or_else(unknown_drive)?;

    // Everything that can refuse is decided here, before anything is changed.
    let plan = crate::drives::convert::plan(&row, direction)
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.message()))?;

    // Hold the drive exclusively for the whole run. This stops browse, uploads,
    // WebDAV, gallery indexing and backups in one place, because they all go
    // through `drive_root()`.
    let _closing = state.drive_manager.begin_closing(&id);
    crate::db::with_db(
        &state.db,
        || anyhow::anyhow!("db lock poisoned"),
        |conn| crate::db::set_drive_converting(conn, &id, true),
    )
    .map_err(|_| internal())?;

    // The drive lock makes the conversion exclusive against other writers.
    let guard = state.db.drive_lock(&id).lock_owned().await;

    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let db = state.db.clone();
    let drive_id = id.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let result = crate::drives::convert::run(&plan, &password, |_| {}, cancel);
        // Whatever happened, the drive is no longer converting: either it
        // finished, or it is interrupted and needs the password again.
        let _ = crate::db::with_db(
            &db,
            || anyhow::anyhow!("db lock poisoned"),
            |conn| crate::db::set_drive_converting(conn, &drive_id, false),
        );
        match result {
            Ok(()) => {
                let _ = crate::db::with_db(
                    &db,
                    || anyhow::anyhow!("db lock poisoned"),
                    |conn| {
                        match direction {
                            Direction::Encrypt => {
                                crate::db::set_drive_encrypted(conn, &drive_id, true)?;
                                // The container is not open after an in-place
                                // conversion: the password went with the job.
                                crate::db::set_drive_locked(conn, &drive_id, true)
                            }
                            Direction::Decrypt => {
                                crate::db::set_drive_encrypted(conn, &drive_id, false)?;
                                crate::db::set_drive_locked(conn, &drive_id, false)
                            }
                        }
                    },
                );
                tracing::info!(drive = %drive_id, ?direction, "drive conversion finished");
            }
            Err(e) => {
                // An interrupted encryption has a header on disk, so the drive
                // must not be described as plain from here on.
                if direction == Direction::Encrypt {
                    let _ = crate::db::with_db(
                        &db,
                        || anyhow::anyhow!("db lock poisoned"),
                        |conn| {
                            crate::db::set_drive_encrypted(conn, &drive_id, true)?;
                            crate::db::set_drive_locked(conn, &drive_id, true)
                        },
                    );
                }
                tracing::warn!(drive = %drive_id, error = %e, "drive conversion did not finish");
            }
        }
    });

    Ok(Json(serde_json::json!({ "ok": true, "started": true })))
}

fn unknown_drive() -> (StatusCode, Json<serde_json::Value>) {
    json_error_code(
        StatusCode::NOT_FOUND,
        "unknown_drive",
        "Luna doesn't know this drive.",
    )
}

fn internal() -> (StatusCode, Json<serde_json::Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't read this drive's settings. Try again.",
    )
}

/// The profile a new container is formatted with, for the docs and tests.
pub fn profile() -> (&'static str, &'static str, &'static str) {
    (luks::CIPHER, luks::KEY_BITS, luks::SECTOR_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ext4_is_converted_in_place() {
        let row = crate::db::DriveRow {
            id: "d1".into(),
            label: "Photos".into(),
            state: "as_is".into(),
            fs_type: "exfat".into(),
            device: "sdb1".into(),
            mount_point: "/mnt/d1".into(),
            encrypted: false,
            locked: false,
            converting: false,
        };
        let (ok, reason) = encryptability(&row);
        assert!(!ok);
        // The reason must say what to do instead, not just refuse.
        assert!(reason.contains("copy its files to a new encrypted drive"));
    }

    #[test]
    fn an_unplugged_drive_says_to_plug_it_in() {
        let row = crate::db::DriveRow {
            id: "d1".into(),
            label: "Photos".into(),
            state: "missing".into(),
            fs_type: "ext4".into(),
            device: "sdb1".into(),
            mount_point: String::new(),
            encrypted: false,
            locked: false,
            converting: false,
        };
        let (ok, reason) = encryptability(&row);
        assert!(!ok);
        assert_eq!(reason, "Plug this drive in to encrypt it.");
    }

    #[test]
    fn the_frozen_profile_is_the_one_the_plan_settled_on() {
        let (cipher, key, sector) = profile();
        assert_eq!(cipher, "aes-xts-plain64");
        assert_eq!(key, "512");
        assert_eq!(sector, "512");
    }

    #[test]
    fn a_device_name_is_turned_into_a_path() {
        assert_eq!(device_path("sdb1"), "/dev/sdb1");
        // An already-absolute name is left alone.
        assert_eq!(device_path("/dev/sdb1"), "/dev/sdb1");
    }

    // ── Through HTTP: the gate the UI actually depends on ──────────────────

    use axum::body::Body;
    use axum::http::{Method, Request as HttpReq, StatusCode};
    use tower::ServiceExt;

    fn app(dir: &std::path::Path, mount: &str) -> (crate::AppState, String) {
        let conn = crate::db::open(&dir.join("luna.db")).unwrap();
        let mock = crate::drives::mount::shared_mock();
        let manager = std::sync::Arc::new(crate::drives::DriveManager::new(mock, dir));
        let state = crate::AppState::new(conn, manager, dir);
        {
            let conn = state.db.lock().unwrap();
            crate::db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "sdz", mount).unwrap();
        }
        let admin = state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = state.auth.issue(&admin).unwrap();
        (state, token)
    }

    async fn call(
        state: &crate::AppState,
        token: &str,
        method: Method,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let router = axum::Router::new()
            .merge(super::router())
            .merge(crate::api::files::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let request = match body {
            Some(v) => builder
                .header("content-type", "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn a_locked_drive_answers_423_with_a_code_the_ui_can_route_on() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, token) = app(dir.path(), mount.to_str().unwrap());
        {
            let conn = state.db.lock().unwrap();
            crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
            crate::db::set_drive_locked(&conn, "d1", true).unwrap();
        }
        // Browsing the drive is refused before anything touches the filesystem.
        let (status, body) =
            call(&state, &token, Method::GET, "/api/v1/drives/d1/files", None).await;
        assert_eq!(status, StatusCode::LOCKED);
        assert_eq!(body["code"], "drive_locked");
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("unlock it in Luna's web page")
        );
    }

    #[tokio::test]
    async fn a_converting_drive_answers_423_with_its_own_code() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, token) = app(dir.path(), mount.to_str().unwrap());
        {
            let conn = state.db.lock().unwrap();
            crate::db::set_drive_converting(&conn, "d1", true).unwrap();
        }
        let (status, body) =
            call(&state, &token, Method::GET, "/api/v1/drives/d1/files", None).await;
        assert_eq!(status, StatusCode::LOCKED);
        assert_eq!(body["code"], "drive_converting");
    }

    #[tokio::test]
    async fn the_encryption_state_reports_a_locked_drive() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, token) = app(dir.path(), mount.to_str().unwrap());
        {
            let conn = state.db.lock().unwrap();
            crate::db::set_drive_encrypted(&conn, "d1", true).unwrap();
            crate::db::set_drive_locked(&conn, "d1", true).unwrap();
        }
        let (status, body) = call(
            &state,
            &token,
            Method::GET,
            "/api/v1/drives/d1/encryption",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["encrypted"], true);
        assert_eq!(body["unlocked"], false);
        assert_eq!(body["present"], true);
    }

    #[tokio::test]
    async fn unlocking_an_unencrypted_drive_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, token) = app(dir.path(), mount.to_str().unwrap());
        let (status, body) = call(
            &state,
            &token,
            Method::POST,
            "/api/v1/drives/d1/unlock",
            Some(serde_json::json!({ "password": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("isn't encrypted"));
    }

    #[tokio::test]
    async fn encrypting_a_non_ext4_drive_explains_what_to_do_instead() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, token) = app(dir.path(), mount.to_str().unwrap());
        {
            let conn = state.db.lock().unwrap();
            // Most drives are exFAT, and that is the case that cannot convert.
            crate::db::upsert_drive(
                &conn,
                "d1",
                "Photos",
                "as_is",
                "exfat",
                "sdz",
                mount.to_str().unwrap(),
            )
            .unwrap();
        }
        let (status, body) = call(
            &state,
            &token,
            Method::POST,
            "/api/v1/drives/d1/encrypt",
            Some(serde_json::json!({ "password": "hunter22hunter1" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("copy its files to a new encrypted drive"),
            "got {}",
            body["error"]
        );
    }

    #[tokio::test]
    async fn a_member_cannot_start_encryption() {
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join("m");
        std::fs::create_dir_all(&mount).unwrap();
        let (state, _token) = app(dir.path(), mount.to_str().unwrap());
        let member = state
            .auth
            .register("Sam", "Sam", "hunter22hunter1", "user")
            .unwrap();
        let token = state.auth.issue(&member).unwrap();
        let (status, body) = call(
            &state,
            &token,
            Method::POST,
            "/api/v1/drives/d1/encrypt",
            Some(serde_json::json!({ "password": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body["error"].as_str().unwrap().contains("Only an Admin"));
    }
}
