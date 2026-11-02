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
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["overall_pass"], true);
        assert!(v["checks"]["database"].is_object());
        assert!(v["checks"]["disk_space"].is_object());
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
        let office = items
            .iter()
            .find(|i| i["id"] == "office_pack")
            .expect("office pack row");
        assert_eq!(office["removable"], false);
        assert!(office["bytes"].as_u64().unwrap() >= 64 * 1024);
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
