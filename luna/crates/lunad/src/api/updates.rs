use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::updates::UpdateError;

#[derive(Deserialize, Default)]
struct CheckQuery {
    force: Option<bool>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/system/updates", get(check))
        .route("/api/v1/system/updates/apply", post(apply))
}

async fn check(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Query(q): Query<CheckQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let svc = state.updates.clone();
    let force = q.force.unwrap_or(false);
    let info = tokio::task::spawn_blocking(move || svc.check(env!("CARGO_PKG_VERSION"), force))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check for updates.",
            )
        })?
        .map_err(map_err)?;
    Ok(Json(serde_json::to_value(info).unwrap_or(json!({}))))
}

async fn apply(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let svc = state.updates.clone();
    let info = tokio::task::spawn_blocking(move || svc.apply(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't install the update.",
            )
        })?
        .map_err(map_err)?;
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        std::process::exit(0);
    });
    Ok(Json(json!({
        "ok": true,
        "latest_version": info.latest_version,
        "message": "The new software is installed. Luna will restart in a moment — sign in again after it comes back.",
    })))
}

fn require_admin(user: &crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can do that.",
        ));
    }
    Ok(())
}

fn map_err(err: UpdateError) -> (StatusCode, Json<Value>) {
    match err {
        UpdateError::NoneAvailable => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        UpdateError::Checksum
        | UpdateError::MissingChecksum
        | UpdateError::MissingSignature
        | UpdateError::BadSignature => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        UpdateError::Unreachable => json_error(StatusCode::BAD_GATEWAY, err.to_string()),
        UpdateError::Other(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't install the update. Try again.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use crate::updates::{HttpGet, Installer, UpdateError, UpdateService};
    use axum::body::Body;
    use axum::http::Request;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tower::ServiceExt;

    struct MapHttp(HashMap<String, (u16, Vec<u8>)>);
    impl HttpGet for MapHttp {
        fn get(&self, url: &str) -> Result<(u16, Vec<u8>), UpdateError> {
            self.0.get(url).cloned().ok_or(UpdateError::Unreachable)
        }
    }
    struct NoopInstall;
    impl Installer for NoopInstall {
        fn install_lunad(&self, _bytes: &[u8]) -> Result<(), UpdateError> {
            Ok(())
        }
    }

    fn app(releases_json: &[u8]) -> (axum::Router, String) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let dm = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let mut map = HashMap::new();
        map.insert(
            "http://forgejo.test/api/v1/repos/LibreLoom/LibreServ/releases?limit=50".into(),
            (200, releases_json.to_vec()),
        );
        let updates = Arc::new(UpdateService::new(
            Box::new(MapHttp(map)),
            Box::new(NoopInstall),
            "http://forgejo.test/api/v1".into(),
            "LibreLoom".into(),
            "LibreServ".into(),
        ));
        let mut state = crate::AppState::new(conn, dm, dir.path());
        state.updates = updates;
        let auth = state.auth.clone();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        let token = auth.issue(&user).unwrap();
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        (router, token)
    }

    #[tokio::test]
    async fn check_uses_fake_forgejo_and_filters_luna_tags() {
        let body = br#"[{"tag_name":"v9.0.0","body":"libreserv","html_url":"x","prerelease":false,"draft":false},{"tag_name":"luna-v0.9.0","body":"hello luna","html_url":"https://example.test/luna-v0.9.0","prerelease":false,"draft":false}]"#;
        let (router, token) = app(body);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/system/updates?force=true")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["latest_version"], "luna-v0.9.0");
        assert_eq!(v["update_available"], true);
    }
}
