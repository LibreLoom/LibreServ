use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::net::connect::ConnectError;

#[derive(Deserialize)]
struct SourcesBody {
    sources: Vec<Value>,
}

#[derive(Deserialize)]
struct TokenBody {
    token: Option<String>,
    code: Option<String>,
}

impl TokenBody {
    fn value(&self) -> &str {
        self.token.as_deref().or(self.code.as_deref()).unwrap_or("")
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connect/status", get(status))
        .route(
            "/api/v1/connect/device-token",
            post(save_device_token).delete(remove_device_token),
        )
        .route("/api/v1/connect/backup-sources", post(set_sources))
}

async fn status(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Json<crate::net::connect::ConnectStatus> {
    if state.connect.is_connect_active() {
        let connect = state.connect.clone();
        let _ = tokio::task::spawn_blocking(move || connect.sync_status_from_cloud()).await;
    }
    let setup = state.auth.count_users().unwrap_or(1) == 0;
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    Json(state.connect.status_for(setup || admin))
}

fn setup_or_admin(state: &AppState, current: Option<&Extension<crate::auth::CurrentUser>>) -> bool {
    if state.auth.count_users().unwrap_or(1) == 0 {
        return true;
    }
    current.map(|u| u.role == "admin").unwrap_or(false)
}

async fn save_device_token(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<TokenBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !setup_or_admin(&state, current.as_ref()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can enter a device token.",
        ));
    }
    let token = body.value().to_string();
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.set_oss_code(&token))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save that device token.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({
        "ok": true,
        "message": "Luna will use this device token to sign in to Luna Connect. Keep this page open."
    })))
}

async fn remove_device_token(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    require_admin(user)?;
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.remove_device_token())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't remove the device token.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "ok": true })))
}

async fn set_sources(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<SourcesBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.connect.is_connect_active() {
        return Err(connect_inactive_error());
    }
    require_admin(user)?;
    let sources = {
        let conn = state.db.lock().map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna is updating its file list. Wait a moment and try again.",
            )
        })?;
        let drives = crate::db::list_drives(&conn).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't read your drives.",
            )
        })?;
        crate::backup::cloud_backup::validate_backup_sources(body.sources, &drives)
            .map_err(map_connect_err)?
    };
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.set_backup_sources(sources))
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't save those folders.",
            )
        })?
        .map_err(map_connect_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn require_admin(user: crate::auth::CurrentUser) -> Result<(), (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can change remote access.",
        ));
    }
    Ok(())
}

fn connect_inactive_error() -> (StatusCode, Json<Value>) {
    json_error(
        StatusCode::NOT_FOUND,
        "Luna Connect is not set up on this Luna. Add a device token in Settings → About → Advanced.",
    )
}

fn map_connect_err(err: ConnectError) -> (StatusCode, Json<Value>) {
    match err {
        ConnectError::Unreachable => json_error(
            StatusCode::BAD_GATEWAY,
            "Luna Connect couldn't be reached. Check your internet connection and try again.",
        ),
        ConnectError::GatewayChallenge => json_error(
            StatusCode::BAD_GATEWAY,
            crate::net::connect::CONNECT_CHALLENGED_MSG,
        ),
        ConnectError::Conflict => json_error(
            StatusCode::CONFLICT,
            "That name is already in use, or Connect is already on. Pick another name or turn it off first.",
        ),
        ConnectError::InvalidToken => json_error(
            StatusCode::UNAUTHORIZED,
            crate::net::connect::DEVICE_TOKEN_REJECTED_MSG,
        ),
        ConnectError::Unbound => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        ConnectError::Other(msg) => json_error(StatusCode::BAD_REQUEST, msg),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::net::connect::ConnectService;
    use crate::{AppState, db};

    const TOKEN: &str = "ABCD-EFGH-JKMN-PQRS-TVWX";

    struct Harness {
        _dir: tempfile::TempDir,
        data_dir: std::path::PathBuf,
        state: AppState,
        router: axum::Router,
        admin: Option<String>,
        member: Option<String>,
    }

    /// `users`: register an Admin and a member (false = first-run, no users).
    fn harness(users: bool) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = Arc::new(DriveManager::new(shared_mock(), dir.path()));
        // Never reach the real Connect from a test.
        let connect = Arc::new(ConnectService::new(
            dir.path(),
            Some("http://127.0.0.1:1".into()),
        ));
        let state = AppState::new(conn, drive_manager, dir.path()).with_connect(connect);
        let (admin, member) = if users {
            let a = state
                .auth
                .register("Max", "Max", "hunter22hunter1", "admin")
                .unwrap();
            let m = state
                .auth
                .register("Jamie", "Jamie", "hunter22hunter1", "user")
                .unwrap();
            (
                Some(state.auth.issue(&a).unwrap()),
                Some(state.auth.issue(&m).unwrap()),
            )
        } else {
            (None, None)
        };
        let router = axum::Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Harness {
            data_dir: dir.path().to_path_buf(),
            _dir: dir,
            state,
            router,
            admin,
            member,
        }
    }

    async fn send(
        h: &Harness,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let res = h
            .router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn only_an_admin_can_enter_or_remove_a_device_token() {
        let h = harness(true);
        let (status, body) = send(
            &h,
            Method::POST,
            "/api/v1/connect/device-token",
            h.member.as_deref(),
            Some(json!({ "token": TOKEN })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "Only an Admin can enter a device token.");
        assert!(!h.state.connect.is_connect_active());

        let (status, _) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.member.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_admin_saves_a_token_that_turns_connect_on_and_off() {
        let h = harness(true);
        let (status, body) = send(
            &h,
            Method::POST,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            Some(json!({ "token": TOKEN })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(h.state.connect.is_connect_active());
        // The accepted `code` spelling works too, and lowercase is normalized.
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            Some(json!({ "code": TOKEN.to_lowercase() })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(h.data_dir.join("device-token"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the token file is private");
        }

        let (status, _) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!h.state.connect.is_connect_active());
        assert!(!h.data_dir.join("device-token").exists());
    }

    #[tokio::test]
    async fn a_malformed_token_is_refused_in_plain_words() {
        let h = harness(true);
        for bad in ["", "hello", "ABCD-EFGH", "ABCD-EFGH-JKMN-PQRS-TVW!"] {
            let (status, body) = send(
                &h,
                Method::POST,
                "/api/v1/connect/device-token",
                h.admin.as_deref(),
                Some(json!({ "token": bad })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}");
            assert!(
                body["error"].as_str().unwrap().contains("device token"),
                "{body}"
            );
        }
        assert!(!h.state.connect.is_connect_active());
    }

    #[tokio::test]
    async fn first_run_setup_may_enter_a_token_without_signing_in() {
        let h = harness(false);
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/device-token",
            None,
            Some(json!({ "token": TOKEN })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(h.state.connect.is_connect_active());
        // Once someone has an account, anonymous callers are turned away.
        h.state
            .auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/device-token",
            None,
            Some(json!({ "token": TOKEN })),
        )
        .await;
        assert_ne!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn backup_sources_need_connect_first_and_then_an_admin() {
        let h = harness(true);
        let body = Some(json!({ "sources": [] }));
        // Connect off: the same plain answer for everyone, before any role check.
        let (status, err) = send(
            &h,
            Method::POST,
            "/api/v1/connect/backup-sources",
            h.admin.as_deref(),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(
            err["error"]
                .as_str()
                .unwrap()
                .contains("Luna Connect is not set up")
        );

        h.state.connect.set_oss_code(TOKEN).unwrap();
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/backup-sources",
            h.member.as_deref(),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/backup-sources",
            h.admin.as_deref(),
            body,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn status_is_readable_but_only_admins_receive_the_token() {
        let h = harness(true);
        h.state.connect.set_oss_code(TOKEN).unwrap();
        let (status, admin_view) = send(
            &h,
            Method::GET,
            "/api/v1/connect/status",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, member_view) = send(
            &h,
            Method::GET,
            "/api/v1/connect/status",
            h.member.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        // Only the Admin's view carries the device token (it is shown in
        // Settings → About); a member never receives it.
        assert!(admin_view.to_string().contains(TOKEN));
        assert!(!member_view.to_string().contains(TOKEN));
        assert_eq!(member_view["connect_active"], true);
    }
}
