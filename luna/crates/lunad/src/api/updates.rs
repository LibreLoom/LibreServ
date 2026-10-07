use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::system::updates::{UpdateError, UpdateSettings};

#[derive(Deserialize, Default)]
struct CheckQuery {
    force: Option<bool>,
}

#[derive(Deserialize, Default)]
struct SourceBody {
    #[serde(default)]
    feed_url: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/system/updates", get(check))
        .route("/api/v1/system/updates/apply", post(apply))
        .route(
            "/api/v1/system/updates/os-failed/clear",
            post(clear_os_failed),
        )
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
    let info = tokio::task::spawn_blocking(move || svc.check(crate::VERSION, force))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't check for updates.",
            )
        })?
        .map_err(map_err)?;
    let mut out = serde_json::to_value(info).unwrap_or(json!({}));
    // Not part of the cached feed answer: it changes when the boot settles.
    out["os_update_failed"] = os_update_failed_json(&state);
    Ok(Json(out))
}

/// `{ "version": "…" }` when the last OS update didn't start and Luna went
/// back to the previous system (`version` is empty when unknown), else null.
fn os_update_failed_json(state: &AppState) -> Value {
    match state.updates.failed_os_update() {
        Some(version) => json!({ "version": version }),
        None => Value::Null,
    }
}

/// Forget the failed OS update so the same image is offered again.
async fn clear_os_failed(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let svc = state.updates.clone();
    tokio::task::spawn_blocking(move || svc.clear_failed_os_update())
        .await
        .map_err(|_| clear_failed())?
        .map_err(|_| clear_failed())?;
    Ok(Json(json!({ "ok": true })))
}

fn clear_failed() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna couldn't reset the failed update. Try again.",
    )
}

async fn apply(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(&user)?;
    let svc = state.updates.clone();
    let info = tokio::task::spawn_blocking(move || svc.apply(crate::VERSION))
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
    let stored =
        crate::system::updates::load_settings(&state.db.lock().unwrap()).unwrap_or_default();
    Ok(Json(source_json(&state, &stored)))
}

fn source_json(state: &AppState, stored: &UpdateSettings) -> Value {
    let effective = state.updates.settings();
    json!({
        "feed_url": effective.feed_url,
        "channel": effective.channel,
        "keys": stored.keys,
        "effective_keys": effective.keys,
        "default_keys": state.updates.using_default_keys(),
        "defaults": crate::system::updates::default_settings(),
    })
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
        feed_url: body.feed_url.unwrap_or_default(),
        channel: body.channel.unwrap_or_default(),
        keys: body.keys.unwrap_or_default(),
    };
    let keys = match crate::system::updates::validate_settings(&settings) {
        Ok(keys) => keys,
        Err(message) => return Err(json_error(StatusCode::BAD_REQUEST, message)),
    };

    let stored = UpdateSettings {
        feed_url: settings.feed_url.trim().trim_end_matches('/').to_string(),
        channel: settings.channel.trim().to_string(),
        keys,
    };
    let defaults = crate::system::updates::default_settings();
    // An empty key list means "keep the built-in key", so compare the
    // effective keys against the defaults when deciding to store nothing.
    let effective_keys = if stored.keys.is_empty() {
        defaults.keys.clone()
    } else {
        stored.keys.clone()
    };
    // Saving exactly the defaults stores nothing, so a future change of the
    // compiled-in default still applies to this Luna.
    let to_store = if stored.feed_url == defaults.feed_url
        && stored.channel == defaults.channel
        && effective_keys == defaults.keys
    {
        UpdateSettings::default()
    } else {
        stored.clone()
    };

    let db = state.db.clone();
    let to_save = to_store.clone();
    let save_failed = || {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't save the update source. Try again.",
        )
    };
    tokio::task::spawn_blocking(move || {
        crate::system::updates::save_settings(&db.lock().unwrap(), &to_save)
    })
    .await
    .map_err(|_| save_failed())?
    .map_err(|_| save_failed())?;

    let effective = if to_store.is_empty() {
        defaults
    } else {
        stored
    };
    state
        .updates
        .reconfigure(effective.feed_url, effective.channel, effective.keys);
    let stored =
        crate::system::updates::load_settings(&state.db.lock().unwrap()).unwrap_or_default();
    let mut out = source_json(&state, &stored);
    out["ok"] = json!(true);
    Ok(Json(out))
}

fn require_admin(user: &crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can manage updates.",
        ));
    }
    Ok(())
}

fn map_err(err: UpdateError) -> (StatusCode, Json<Value>) {
    match err {
        UpdateError::NoneAvailable => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        UpdateError::Checksum
        | UpdateError::MissingSignature
        | UpdateError::BadSignature
        | UpdateError::BadFeed
        | UpdateError::UnknownFormat
        | UpdateError::Replayed
        | UpdateError::MissingPart => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        UpdateError::Unreachable => json_error(StatusCode::BAD_GATEWAY, err.to_string()),
        UpdateError::NoFeed => json_error(StatusCode::NOT_FOUND, err.to_string()),
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
    use crate::drives::mount::shared_mock;
    use crate::system::updates::{HttpGet, Installer, UpdateService};
    use axum::body::Body;
    use axum::http::Request;
    use std::collections::HashMap;
    use std::io::Cursor;
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

    const FEED_JSON: &str = r#"{"format":1,"unit":"luna","channel":"stable","version":"0.9.0","published":"2026-10-12T14:03:00Z","notes":"hello luna","parts":[{"name":"lunad","os":"linux","arch":"ARCH","file":"lunad-linux-amd64-musl","size":3,"sha256":"3a2d1f1ad8a24b0e0cbd9f1fae1f8bbd0c4b3c6c1d4b6f6c8b1a1d1f1f1f1f1f","urls":["http://dl.test/lunad"]}]}"#;

    fn app() -> (axum::Router, String, crate::AppState) {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            o => o,
        };
        let feed = FEED_JSON.replace("ARCH", arch).into_bytes();
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let sig = minisign::sign(None, &kp.sk, Cursor::new(&feed), None, None)
            .unwrap()
            .to_string()
            .into_bytes();
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let dm = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let mut map = HashMap::new();
        map.insert("http://feeds.test/luna/stable.json".into(), (200, feed));
        map.insert(
            "http://feeds.test/luna/stable.json.minisig".into(),
            (200, sig),
        );
        let updates = Arc::new(UpdateService::with_keys(
            Box::new(MapHttp(map)),
            Box::new(NoopInstall),
            "http://feeds.test".into(),
            "stable".into(),
            vec![kp.pk.to_base64()],
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

    async fn json_of(response: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn put(token: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/api/v1/system/updates/source")
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn check_reads_the_signed_feed() {
        let (router, token, _state) = app();
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
        let v = json_of(response).await;
        assert_eq!(v["latest_version"], "0.9.0");
        assert_eq!(v["release_notes"], "hello luna");
        assert_eq!(v["update_available"], true);
        assert!(v.get("url").is_none(), "no release page link any more");
    }

    struct FailedInstall(std::sync::Mutex<Option<String>>);
    impl Installer for FailedInstall {
        fn install_lunad(&self, _bytes: &[u8]) -> Result<(), UpdateError> {
            Ok(())
        }
        fn read_os_failed(&self) -> Option<String> {
            self.0.lock().unwrap().clone().map(|_| "deadbeef".into())
        }
        fn read_os_failed_version(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn clear_os_failed(&self) -> Result<(), UpdateError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    fn req(method: &str, uri: &str, token: &str) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn a_failed_os_update_is_reported_and_can_be_cleared_by_an_admin() {
        let (_unused, token, mut state) = app();
        // Swap in an updater that remembers a failed image (same feed).
        let src = state.updates.settings();
        let feed = FEED_JSON
            .replace(
                "ARCH",
                match std::env::consts::ARCH {
                    "x86_64" => "amd64",
                    "aarch64" => "arm64",
                    o => o,
                },
            )
            .into_bytes();
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let sig = minisign::sign(None, &kp.sk, Cursor::new(&feed), None, None)
            .unwrap()
            .to_string()
            .into_bytes();
        let mut map = HashMap::new();
        map.insert(format!("{}/luna/stable.json", src.feed_url), (200, feed));
        map.insert(
            format!("{}/luna/stable.json.minisig", src.feed_url),
            (200, sig),
        );
        state.updates = Arc::new(UpdateService::with_keys(
            Box::new(MapHttp(map)),
            Box::new(FailedInstall(std::sync::Mutex::new(Some("0.8.0".into())))),
            src.feed_url,
            "stable".into(),
            vec![kp.pk.to_base64()],
        ));
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());

        let v = json_of(
            router
                .clone()
                .oneshot(req("GET", "/api/v1/system/updates?force=true", &token))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(v["os_update_failed"], json!({ "version": "0.8.0" }));

        // A plain member can't clear it.
        let member = state
            .auth
            .register("Mia", "Mia", "hunter22hunter1", "user")
            .unwrap();
        let member_token = state.auth.issue(&member).unwrap();
        let response = router
            .clone()
            .oneshot(req(
                "POST",
                "/api/v1/system/updates/os-failed/clear",
                &member_token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(state.updates.failed_os_update().is_some());

        let response = router
            .clone()
            .oneshot(req(
                "POST",
                "/api/v1/system/updates/os-failed/clear",
                &token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_of(response).await["ok"], true);

        let v = json_of(
            router
                .oneshot(req("GET", "/api/v1/system/updates?force=true", &token))
                .await
                .unwrap(),
        )
        .await;
        assert!(v["os_update_failed"].is_null());
    }

    #[tokio::test]
    async fn no_failed_update_reports_null() {
        let (router, token, _state) = app();
        let v = json_of(
            router
                .oneshot(req("GET", "/api/v1/system/updates?force=true", &token))
                .await
                .unwrap(),
        )
        .await;
        assert!(v["os_update_failed"].is_null());
    }

    #[tokio::test]
    async fn source_get_shows_active_settings() {
        let (router, token, _state) = app();
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
        let v = json_of(response).await;
        assert_eq!(v["feed_url"], "http://feeds.test");
        assert_eq!(v["channel"], "stable");
        // The test updater trusts its own key, not the built-in one.
        assert_eq!(v["default_keys"], false);
        assert_eq!(v["keys"], json!([]));
        assert!(!v["effective_keys"].as_array().unwrap().is_empty());
        assert!(v["defaults"]["feed_url"].is_string());
        assert_eq!(v["defaults"]["channel"], "stable");
        assert!(v.get("api_base").is_none());
        assert!(v.get("owner").is_none());
        assert!(v.get("repo").is_none());
    }

    #[tokio::test]
    async fn source_put_persists_and_reconfigures() {
        let (router, token, state) = app();
        // A key that is NOT the compiled-in release key.
        let key = minisign::KeyPair::generate_unencrypted_keypair()
            .unwrap()
            .pk
            .to_base64();
        let body = format!(
            r#"{{"feed_url":"https://staging.feeds.test/feeds/","channel":"beta","keys":["{key}"]}}"#
        );
        let response = router.oneshot(put(&token, &body)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let v = json_of(response).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["channel"], "beta");

        // The running updater switched source without a restart.
        let got = state.updates.settings();
        assert_eq!(got.feed_url, "https://staging.feeds.test/feeds");
        assert_eq!(got.channel, "beta");
        assert_eq!(got.keys, vec![key.clone()]);
        assert!(!state.updates.using_default_keys());

        // Persisted in the DB, so a restart keeps it.
        let stored = crate::system::updates::load_settings(&state.db.lock().unwrap()).unwrap();
        assert_eq!(stored.feed_url, "https://staging.feeds.test/feeds");
        assert_eq!(stored.channel, "beta");
        assert_eq!(stored.keys, vec![key]);
    }

    #[tokio::test]
    async fn source_put_rejects_bad_input() {
        let (router, token, _state) = app();
        for bad in [
            r#"{"feed_url":"","channel":"stable"}"#,
            r#"{"feed_url":"ftp://nope","channel":"stable"}"#,
            r#"{"feed_url":"https://a.test/feeds","channel":"nightly"}"#,
            r#"{"feed_url":"https://a.test/feeds"}"#,
            r#"{"feed_url":"https://a.test/feeds","channel":"stable","keys":["garbage"]}"#,
        ] {
            let response = router.clone().oneshot(put(&token, bad)).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "body: {bad}");
        }
    }

    #[tokio::test]
    async fn source_is_admin_only() {
        let (router, _token, state) = app();
        // Second registered user is a plain member.
        let member = state
            .auth
            .register("Mia", "Mia", "hunter22hunter1", "user")
            .unwrap();
        assert_eq!(member.role, "user");
        let member_token = state.auth.issue(&member).unwrap();

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
            .oneshot(put(
                &member_token,
                r#"{"feed_url":"https://a.test/feeds","channel":"stable"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn source_put_with_defaults_clears_stored_row() {
        let (router, token, state) = app();
        let staging = r#"{"feed_url":"https://staging.feeds.test/feeds","channel":"beta"}"#;
        let response = router.clone().oneshot(put(&token, staging)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(crate::system::updates::load_settings(&state.db.lock().unwrap()).is_some());

        // …then restore this binary's defaults: the stored row goes away.
        let d = crate::system::updates::default_settings();
        let body = format!(
            r#"{{"feed_url":"{}","channel":"{}"}}"#,
            d.feed_url, d.channel
        );
        let response = router.oneshot(put(&token, &body)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(crate::system::updates::load_settings(&state.db.lock().unwrap()).is_none());
    }

    #[tokio::test]
    async fn the_repo_key_fetch_route_is_gone() {
        let (router, token, _state) = app();
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/system/updates/source/keys")
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
}
