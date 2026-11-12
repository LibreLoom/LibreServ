use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;

/// The API version this lunad speaks, and the oldest client API it still
/// serves (`CLIENT_API` in Desktop and Android is compared against these; see
/// `infra/ci-source/internal/feed/README.md`, "Versions").
///
/// Bump `API_VERSION` when lunad adds API that a client may rely on. Raise
/// `API_OLDEST_SUPPORTED` only when something is removed or broken for
/// older clients. Never lower either.
pub const API_VERSION: u32 = 1;
pub const API_OLDEST_SUPPORTED: u32 = 1;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/health", get(health))
        .route("/api/v1/system/health/check", get(comprehensive_check))
        .route(
            "/api/v1/system/health/check/refresh",
            post(comprehensive_check),
        )
        .route("/api/v1/system/storage", get(storage))
        .route("/api/v1/system/storage/cleanup", post(storage_cleanup))
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "product": "Luna",
        "version": crate::version(),
        "api": {
            "version": API_VERSION,
            "oldest_supported": API_OLDEST_SUPPORTED,
        },
        "uptime_seconds": uptime(),
    }))
}

async fn comprehensive_check(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    method: axum::http::Method,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can check Luna's system health.",
        ));
    }
    let force = method == axum::http::Method::POST;
    let cache = state.health_cache.clone();
    let result = if force || cache.should_refresh() {
        cache.mark_refreshing();
        let state = state.clone();
        let computed = tokio::task::spawn_blocking(move || compute(&state))
            .await
            .unwrap_or_else(|_| failed_response());
        cache.set(computed.clone());
        computed
    } else {
        match cache.get() {
            Some(cached) => cached,
            None => {
                let state = state.clone();
                tokio::task::spawn_blocking(move || compute(&state))
                    .await
                    .unwrap_or_else(|_| failed_response())
            }
        }
    };

    let status = if result.overall_pass {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    Ok((
        status,
        Json(serde_json::to_value(result).unwrap_or(json!({}))),
    ))
}

/// What is using Luna's own disk, biggest first.
async fn storage(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let dir = state.data_dir.clone();
    let report = tokio::task::spawn_blocking(move || crate::system::storage::report(&dir))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't look at its own storage.",
            )
        })?;
    Ok(Json(serde_json::to_value(report).unwrap_or(json!({}))))
}

/// Clear what Luna can make again — copies of documents no editor has open,
/// and update downloads from installs that never finished.
async fn storage_cleanup(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let live = state.office_docs.live_keys().await;
    let dir = state.data_dir.clone();
    let result = tokio::task::spawn_blocking(move || crate::system::storage::cleanup(&dir, &live))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't clear space. Try again.",
            )
        })?;
    // The disk-space check just changed, so the next read must not be cached.
    state.health_cache.invalidate();
    Ok(Json(serde_json::to_value(result).unwrap_or(json!({}))))
}

fn require_admin(user: &crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role == "admin" {
        return Ok(());
    }
    Err(json_error(
        StatusCode::FORBIDDEN,
        "Only an Admin can manage Luna's storage.",
    ))
}

/// Gather probes first — the DB lock is held only for the database checks,
/// and drive probes run after it's released.
fn compute(state: &AppState) -> crate::system::system_health::ComprehensiveHealthResponse {
    use crate::system::system_health::{
        Probes, backup_checks, finish_comprehensive, run_preflight,
    };
    let probes = Probes::from_state(state);
    let (preflight, mut drives) = {
        let conn = state.db.lock().unwrap();
        let mut preflight = run_preflight(&state.data_dir, &conn, &probes);
        // Backup rows warn only, so they never change `healthy`.
        preflight
            .checks
            .extend(backup_checks(&conn, crate::db::now_unix()));
        let drives = crate::db::list_drives(&conn).unwrap_or_default();
        (preflight, drives)
    };
    // A Luna mount that isn't live is treated as no mount: the check then
    // says Luna can't open the drive and doesn't write a test file into
    // the empty folder on the system disk.
    for drive in &mut drives {
        if !state.drive_manager.mount_is_live(&drive.mount_point) {
            drive.mount_point = String::new();
        }
    }
    finish_comprehensive(preflight, drives)
}

fn failed_response() -> crate::system::system_health::ComprehensiveHealthResponse {
    crate::system::system_health::ComprehensiveHealthResponse {
        status: "error".into(),
        timestamp: crate::db::now_unix(),
        overall_pass: false,
        checks: Default::default(),
        summary: Default::default(),
    }
}

fn uptime() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_shape() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let router = super::router().with_state(AppState::new(conn, drive_manager, dir.path()));
        let response = tower::ServiceExt::oneshot(
            router,
            axum::http::Request::builder()
                .uri("/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["product"], "Luna");
    }

    #[tokio::test]
    async fn health_reports_api_compatibility() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let router = super::router().with_state(AppState::new(conn, drive_manager, dir.path()));
        let response = tower::ServiceExt::oneshot(
            router,
            axum::http::Request::builder()
                .uri("/api/v1/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["api"]["version"], 1);
        assert_eq!(v["api"]["oldest_supported"], 1);
        // Clients compare these as numbers, never as strings.
        assert!(v["api"]["version"].is_u64() && v["api"]["oldest_supported"].is_u64());
        const { assert!(super::API_OLDEST_SUPPORTED <= super::API_VERSION) };
        // The reported version is luna/VERSION.
        let file =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../VERSION")).unwrap();
        assert_eq!(v["version"], file.trim());
        assert_eq!(v["version"], crate::version());
    }

    #[tokio::test]
    async fn comprehensive_check_returns_checks() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/system/health/check")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["overall_pass"], true);
        assert!(v["checks"]["database"].is_object());
        assert!(v["checks"]["disk_space"].is_object());
    }

    /// The contract recorder keeps one shape per route, merged over every
    /// answer it sees. The test above records whatever this host happens to
    /// report — usually warnings — so this one records the passing answer: the
    /// rows that never carry `more` or `details` on success, and a covered
    /// backup row whose `covered_by` is an object rather than null.
    ///
    /// It builds its own `AppState` and routers, so it never competes with the
    /// test above for the cache, the database, or the recorder's mutex.
    #[tokio::test]
    async fn passing_health_and_covered_backup_are_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();

        let tools_dir = dir.path().join("tools");
        std::fs::create_dir_all(&tools_dir).unwrap();
        for name in [
            "ffmpeg",
            "ffprobe",
            "heif-dec",
            "blkid",
            "mount",
            "umount",
            "smartctl",
            "fstrim",
            "grub-editenv",
            "findfs",
        ] {
            let path = tools_dir.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let probes = crate::system::system_health::Probes {
            clock: crate::system::system_health::ClockReading {
                now_unix: db::now_unix(),
                synced: Some(true),
            },
            network: Some(crate::net::NetworkStatus {
                ethernet_connected: true,
                wifi_interface: None,
                wifi_connected: false,
                has_default_route: true,
                ipv4: vec!["192.168.1.20".into()],
                interfaces: vec![],
            }),
            connect: None,
            usable_update_keys: 1,
            default_update_keys: true,
            on_luna_os: true,
            path_dirs: vec![tools_dir],
            kernel_ntfs: true,
            whiteboard_editor: true,
            whiteboard_fonts: true,
        };
        // A passing office_pack and diagram_pack need the packs on disk. On a
        // test machine there is no image pack root, so `packs::dir` gives the
        // data folder and they can be written there.
        let office = crate::packs::dir(&state.data_dir, "eurooffice");
        for rel in [
            "web-apps/apps/api/documents/api.js",
            "x2t/x2t.js",
            "x2t/x2t.wasm",
            "sdkjs/word/sdk-all-min.js",
            "sdkjs/cell/sdk-all-min.js",
            "sdkjs/slide/sdk-all-min.js",
        ] {
            let path = office.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x").unwrap();
        }
        std::fs::create_dir_all(office.join("fonts")).unwrap();
        let drawio = crate::packs::dir(&state.data_dir, "drawio");
        std::fs::create_dir_all(&drawio).unwrap();
        std::fs::write(drawio.join("pack.json"), r#"{"pack":"luna-drawio"}"#).unwrap();
        std::fs::write(drawio.join("index.html"), "x").unwrap();

        let passing = {
            let conn = state.db.lock().unwrap();
            let mut preflight =
                crate::system::system_health::run_preflight(&state.data_dir, &conn, &probes);
            preflight
                .checks
                .extend(crate::system::system_health::backup_checks(
                    &conn,
                    db::now_unix(),
                ));
            let drives = db::list_drives(&conn).unwrap_or_default();
            crate::system::system_health::finish_comprehensive(preflight, drives)
        };
        state.health_cache.set(passing);

        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/system/health/check")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
            .await
            .unwrap();
        let passing: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        for name in ["heic_tools", "office_pack", "smart_tool", "video_tools"] {
            assert_eq!(passing["checks"][name]["status"], "passed", "{name}");
            assert!(passing["checks"][name].get("more").is_none(), "{name}");
            assert!(passing["checks"][name].get("details").is_none(), "{name}");
        }
        // The network and NTFS rows still carry no `more` on success.
        assert_eq!(passing["checks"]["network"]["status"], "passed");
        assert!(passing["checks"]["network"].get("more").is_none());
        assert_eq!(passing["checks"]["ntfs_support"]["status"], "passed");
        assert!(passing["checks"]["ntfs_support"].get("more").is_none());

        // A folder covered by a parent backup answers with the parent, not null;
        // the fake sends both, so the contract must record both. The parent has
        // to be finished for `covering_protection` to match it.
        let (status, body) = {
            let access = format!(r#"{{"users":["{}"],"admins":true}}"#, user.id);
            {
                let conn = state.db.lock().unwrap();
                for (id, path) in [("docs", "docs"), ("docs-sub", "docs/sub")] {
                    db::insert_protection(
                        &conn,
                        &db::NewProtection {
                            id,
                            kind: db::PROTECTION_DRIVE,
                            source_drive: "d1",
                            source_path: path,
                            target_drive: "d2",
                            private_owner: "",
                            created_by: &user.id,
                            created_at: 0,
                        },
                    )
                    .unwrap();
                    conn.execute(
                        "UPDATE protections SET access_json = ?1 WHERE id = ?2",
                        rusqlite::params![access, id],
                    )
                    .unwrap();
                }
                db::record_protection_ok(&conn, "docs", 5, &access).unwrap();
            }
            let router = axum::Router::new()
                .merge(crate::api::backups::router())
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    crate::auth::guard,
                ))
                .with_state(state.clone());
            let response = router
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/api/v1/backups")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            )
        };
        assert_eq!(status, axum::http::StatusCode::OK);
        assert!(
            body.as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["covered_by"].is_object())),
            "expected a covered row in {body}"
        );
    }

    #[tokio::test]
    async fn comprehensive_check_rejects_member() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let _admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let token = auth.issue(&member).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/system/health/check")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    }

    /// Admin router + token for the storage routes.
    async fn admin_app() -> (tempfile::TempDir, axum::Router, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        (dir, router, token)
    }

    #[tokio::test]
    async fn storage_names_what_is_using_the_disk() {
        let (dir, router, token) = admin_app().await;
        std::fs::create_dir_all(dir.path().join("eurooffice/sdkjs")).unwrap();
        std::fs::write(
            dir.path().join("eurooffice/sdkjs/sdk-all-min.js"),
            vec![0u8; 64 * 1024],
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("office_bundles/key-a")).unwrap();
        std::fs::write(
            dir.path().join("office_bundles/key-a/Editor.bin"),
            vec![1u8; 8192],
        )
        .unwrap();

        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/system/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["total_bytes"].as_u64().unwrap() > 0);
        let items = v["items"].as_array().unwrap();
        // The editor packs are in the OS image, not on the data partition, so
        // they are not a row here even when an old box still has a copy.
        assert!(
            !items.iter().any(|i| i["id"] == "office_pack"),
            "software is not the data partition's: {items:?}"
        );
        let temporary_row = items
            .iter()
            .find(|i| i["id"] == "temporary")
            .expect("temporary files row");
        assert!(temporary_row["bytes"].as_u64().unwrap() >= 8192);
        let temporary = items
            .iter()
            .find(|i| i["id"] == "temporary")
            .expect("temporary files row");
        assert_eq!(temporary["removable"], true);
    }

    #[tokio::test]
    async fn storage_cleanup_clears_temporary_files_and_says_how_much() {
        let (dir, router, token) = admin_app().await;
        std::fs::create_dir_all(dir.path().join("office_bundles/key-a")).unwrap();
        std::fs::write(
            dir.path().join("office_bundles/key-a/Editor.bin"),
            vec![1u8; 8192],
        )
        .unwrap();

        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/v1/system/storage/cleanup")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["freed_bytes"].as_u64().unwrap() >= 8192);
        assert_eq!(v["cleared"][0], "temporary");
        assert!(!dir.path().join("office_bundles/key-a").exists());
    }

    #[tokio::test]
    async fn storage_rejects_member() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let _admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let token = auth.issue(&member).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        let response = router
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/system/storage")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
    }
}
