use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::updates::{UpdateError, UpdateSettings};

#[derive(Deserialize, Default)]
struct CheckQuery {
    force: Option<bool>,
}

#[derive(Deserialize, Default)]
struct SourceBody {
    #[serde(default)]
    api_base: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/system/updates", get(check))
        .route("/api/v1/system/updates/apply", post(apply))
        .route(
            "/api/v1/system/updates/source",
            get(get_source).put(save_source),
        )
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
    let reboot = info.reboot_required;
    let latest = info.latest_version.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if reboot {
            let _ = std::process::Command::new("reboot").status();
            // If reboot is unavailable (dev), fall back to process exit.
            std::process::exit(0);
        }
        std::process::exit(0);
    });
    Ok(Json(json!({
        "ok": true,
        "latest_version": latest,
        "reboot_required": reboot,
        "message": "The new software is installed. Luna will restart in a moment — sign in again after it comes back.",
    })))
}

/// The update source in effect, for the admin settings screen. Public keys
/// are never secret material, but the endpoint stays admin-gated like the
/// rest of the update surface.
///
/// `keys` is what is stored in the DB (empty means “use the built-in release
/// key”). `effective_keys` is what the updater trusts right now — always
/// populated so the UI can show the shipped key without asking anyone to
/// paste it.
async fn get_source(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let svc = state.updates.clone();
    let effective = svc.settings();
    let stored = crate::updates::load_settings(&state.db.lock().unwrap()).unwrap_or_default();
    Ok(Json(json!({
        "api_base": effective.api_base,
        "owner": effective.owner,
        "repo": effective.repo,
        "keys": stored.keys,
        "effective_keys": effective.keys,
        "default_keys": svc.using_default_keys(),
        "defaults": crate::updates::default_settings(),
    })))
}

/// Save a new update source. Persists to the DB, validates, and hot-swaps the
/// running updater. An all-default body clears the stored override.
async fn save_source(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<SourceBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let settings = UpdateSettings {
        api_base: body.api_base.unwrap_or_default(),
        owner: body.owner.unwrap_or_default(),
        repo: body.repo.unwrap_or_default(),
        keys: body.keys.unwrap_or_default(),
    };
    let keys = match crate::updates::validate_settings(&settings) {
        Ok(keys) => keys,
        Err(message) => return Err(json_error(StatusCode::BAD_REQUEST, message)),
    };

    let stored = UpdateSettings {
        api_base: settings.api_base.trim().to_string(),
        owner: settings.owner.trim().to_string(),
        repo: settings.repo.trim().to_string(),
        keys,
    };
    let defaults = crate::updates::default_settings();
    // An empty key list means "keep the built-in key", so compare the
    // effective keys against the defaults when deciding to store nothing.
    let effective_keys = if stored.keys.is_empty() {
        defaults.keys.clone()
    } else {
        stored.keys.clone()
    };
    // Saving exactly the defaults stores nothing, so a future change of the
    // compiled-in default still applies to this Luna.
    let to_store = if stored.api_base == defaults.api_base
        && stored.owner == defaults.owner
        && stored.repo == defaults.repo
        && effective_keys == defaults.keys
    {
        UpdateSettings::default()
    } else {
        stored.clone()
    };

    let db = state.db.clone();
    let to_save = to_store.clone();
    tokio::task::spawn_blocking(move || {
        crate::updates::save_settings(&db.lock().unwrap(), &to_save)
    })
    .await
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save the update source. Try again.",
        )
    })?
    .map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save the update source. Try again.",
        )
    })?;

    let effective = if to_store.is_empty() {
        defaults
    } else {
        stored
    };
    state.updates.reconfigure(
        effective.api_base,
        effective.owner,
        effective.repo,
        effective.keys,
    );
    let back = state.updates.settings();
    let stored = crate::updates::load_settings(&state.db.lock().unwrap()).unwrap_or_default();
    Ok(Json(json!({
        "ok": true,
        "api_base": back.api_base,
        "owner": back.owner,
        "repo": back.repo,
        "keys": stored.keys,
        "effective_keys": back.keys,
        "default_keys": state.updates.using_default_keys(),
        "defaults": crate::updates::default_settings(),
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

    fn app(releases_json: &[u8]) -> (axum::Router, String, crate::AppState) {
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
            .with_state(state.clone());
        (router, token, state)
    }

    #[tokio::test]
    async fn check_uses_fake_forgejo_and_filters_luna_tags() {
        let body = br#"[{"tag_name":"v9.0.0","body":"libreserv","html_url":"x","prerelease":false,"draft":false},{"tag_name":"luna-v0.9.0","body":"hello luna","html_url":"https://example.test/luna-v0.9.0","prerelease":false,"draft":false}]"#;
        let (router, token, _state) = app(body);
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

    #[tokio::test]
    async fn source_get_shows_active_settings() {
        let (router, token, _state) = app(b"[]");
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/v1/system/updates/source")
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
        assert_eq!(v["api_base"], "http://forgejo.test/api/v1");
        assert_eq!(v["owner"], "LibreLoom");
        assert_eq!(v["repo"], "LibreServ");
        assert_eq!(v["default_keys"], true);
        assert_eq!(v["keys"], json!([]));
        assert!(!v["effective_keys"].as_array().unwrap().is_empty());
        assert_eq!(v["effective_keys"], v["defaults"]["keys"]);
        assert!(v["defaults"]["api_base"].is_string());
    }

    #[tokio::test]
    async fn source_put_persists_and_reconfigures() {
        let (router, token, state) = app(b"[]");
        // A key that is NOT the compiled-in release key.
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let key = kp.pk.to_base64();
        let body = format!(
            r#"{{"api_base":"https://staging.forgejo.test/api/v1","owner":"MyOrg","repo":"LunaFork","keys":["{key}"]}}"#
        );
        let response = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/system/updates/source")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // The running updater switched source without a restart.
        let got = state.updates.settings();
        assert_eq!(got.api_base, "https://staging.forgejo.test/api/v1");
        assert_eq!(got.owner, "MyOrg");
        assert_eq!(got.repo, "LunaFork");
        assert_eq!(got.keys, vec![key.clone()]);
        assert!(!state.updates.using_default_keys());

        // The settings are persisted in the DB (config round-trip), so a
        // restart keeps them.
        let stored = crate::updates::load_settings(&state.db.lock().unwrap()).unwrap();
        assert_eq!(stored.api_base, "https://staging.forgejo.test/api/v1");
        assert_eq!(stored.keys, vec![key]);
    }

    #[tokio::test]
    async fn source_put_rejects_bad_input() {
        let (router, token, _state) = app(b"[]");
        for bad in [
            r#"{"api_base":"","owner":"o","repo":"r"}"#,
            r#"{"api_base":"ftp://nope","owner":"o","repo":"r"}"#,
            r#"{"api_base":"https://a.test/api/v1","owner":"","repo":"r"}"#,
            r#"{"api_base":"https://a.test/api/v1","owner":"o","repo":"r","keys":["garbage"]}"#,
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("PUT")
                        .uri("/api/v1/system/updates/source")
                        .header("Authorization", format!("Bearer {token}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from(bad))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "body: {bad}");
        }
    }

    #[tokio::test]
    async fn source_is_admin_only() {
        let (router, token, state) = app(b"[]");
        // Second registered user is a plain member.
        let member = state
            .auth
            .register("Mia", "Mia", "hunter22hunter1", "user")
            .unwrap();
        assert_eq!(member.role, "user");
        let member_token = state.auth.issue(&member).unwrap();
        let _ = token; // admin token unused here

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/system/updates/source")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/system/updates/source")
                    .header("Authorization", format!("Bearer {member_token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        r#"{"api_base":"https://a.test/api/v1","owner":"o","repo":"r"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn source_put_with_defaults_clears_stored_row() {
        let (router, token, state) = app(b"[]");
        // First point at staging…
        let staging = r#"{"api_base":"https://staging.forgejo.test/api/v1","owner":"MyOrg","repo":"LunaFork"}"#;
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/system/updates/source")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(staging))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(crate::updates::load_settings(&state.db.lock().unwrap()).is_some());

        // …then restore this binary's defaults: the stored row goes away.
        let d = crate::updates::default_settings();
        let body = format!(
            r#"{{"api_base":"{}","owner":"{}","repo":"{}"}}"#,
            d.api_base, d.owner, d.repo
        );
        let response = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/v1/system/updates/source")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(crate::updates::load_settings(&state.db.lock().unwrap()).is_none());
    }
}
