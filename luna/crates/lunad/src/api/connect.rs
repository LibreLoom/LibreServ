use axum::extract::{ConnectInfo, Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::net::connect::ConnectError;

#[derive(Deserialize)]
struct DeviceTokenBody {
    device_token: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connect/status", get(status))
        // The device token identifies and pairs this Luna; it is never a
        // bearer credential. PUT sets or replaces it locally without asking
        // Connect; nothing reads it back (status only says whether it is set).
        .route(
            "/api/v1/connect/device-token",
            axum::routing::put(save_device_token).delete(remove_device_token),
        )
        .route("/api/v1/connect/unbind", post(unbind))
}

#[derive(Deserialize)]
struct UnbindBody {
    #[serde(default)]
    password: String,
}

async fn unbind(
    State(state): State<AppState>,
    Extension(user): Extension<crate::auth::CurrentUser>,
    Json(body): Json<UnbindBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can unbind Luna Connect.",
        ));
    }
    if body.password.trim().is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Type your current password to unbind Luna Connect.",
        ));
    }
    crate::api::auth::confirm_password(
        &state,
        &user,
        &body.password,
        "That password is wrong. Luna Connect was not unbound.",
    )
    .await?;
    if !state.connect.can_unbind() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This Luna isn't linked to Luna Connect.",
        ));
    }
    let connect = state.connect.clone();
    tokio::task::spawn_blocking(move || connect.unbind_now())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't unbind Luna Connect. Try again.",
            )
        })?
        .map_err(map_unbind_err)?;
    Ok(Json(json!({ "ok": true })))
}

fn map_unbind_err(err: ConnectError) -> (StatusCode, Json<Value>) {
    match err {
        ConnectError::Unreachable => json_error(
            StatusCode::GATEWAY_TIMEOUT,
            "Luna Connect didn't answer, or had a problem. Remote access is stopped, and Luna will keep trying to disconnect.",
        ),
        ConnectError::InvalidToken => json_error(
            StatusCode::BAD_GATEWAY,
            "Luna Connect no longer accepts this Luna's connection. Reconnect it from Luna Connect.",
        ),
        other => map_connect_err(other),
    }
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Json<Value> {
    if state.connect.poll_needed() {
        let connect = state.connect.clone();
        let _ = tokio::task::spawn_blocking(move || connect.sync_status_from_cloud()).await;
    }
    let setup = state.auth.count_users().unwrap_or(1) == 0;
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    let status = state
        .connect
        .status_for(admin || (setup && crate::api::auth::is_lan_request(&addr, &headers)));
    Json(serde_json::to_value(status).unwrap_or_else(|_| json!({})))
}

fn setup_or_admin(state: &AppState, current: Option<&Extension<crate::auth::CurrentUser>>) -> bool {
    state.auth.count_users().unwrap_or(1) == 0
        || current.map(|u| u.role == "admin").unwrap_or(false)
}

async fn save_device_token(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current: Option<Extension<crate::auth::CurrentUser>>,
    Json(body): Json<DeviceTokenBody>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !setup_or_admin(&state, current.as_ref()) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can enter a device token.",
        ));
    }
    let admin = current.as_ref().is_some_and(|u| u.role == "admin");
    if !admin {
        if !crate::auth::setup_origin_allowed(&state, &headers) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Open Luna at its own address to enter the device token.",
            ));
        }
        if !crate::api::auth::is_lan_request(&addr, &headers) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "Enter the device token from the same network as Luna, or sign in as an Admin first.",
            ));
        }
        if !state.login_limiter.allow(&format!(
            "device-token:{}",
            crate::api::auth::client_ip(&addr, &headers)
        )) {
            return Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many tries. Wait a few minutes and try again.",
            ));
        }
        // Before an Admin exists, an anonymous caller may only set the first
        // token; replacing a saved one is an Admin's job.
        if state.connect.has_device_token()
            && !state.connect.device_token_matches(&body.device_token)
        {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                "This Luna already has a device token. An Admin can change it after setup.",
            ));
        }
    }
    let service = state.connect.clone();
    let token = body.device_token;
    tokio::task::spawn_blocking(move || service.set_device_token(&token))
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
        "message": "Luna will use this device token to pair with Luna Connect. Keep this page open."
    })))
}

/// Opt out of Connect: forget the device token. Admin only, and only once
/// Luna is no longer linked to (or disconnecting from) Luna Connect.
async fn remove_device_token(
    State(state): State<AppState>,
    current: Option<Extension<crate::auth::CurrentUser>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !current.as_ref().is_some_and(|u| u.role == "admin") {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an Admin can remove the device token.",
        ));
    }
    let service = state.connect.clone();
    tokio::task::spawn_blocking(move || service.remove_device_token())
        .await
        .map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Luna couldn't remove the device token.",
            )
        })?
        .map_err(|err| match err {
            ConnectError::Other(msg) if msg == crate::net::connect::DISCONNECT_FIRST_MSG => {
                json_error(StatusCode::CONFLICT, msg)
            }
            other => map_connect_err(other),
        })?;
    Ok(Json(json!({ "ok": true })))
}

fn map_connect_err(err: ConnectError) -> (StatusCode, Json<Value>) {
    match err {
        ConnectError::Unreachable => json_error(
            StatusCode::BAD_GATEWAY,
            "Luna couldn't reach Luna Connect, or Luna Connect had a problem. Check your internet connection, then try again.",
        ),
        ConnectError::GatewayChallenge => json_error(
            StatusCode::BAD_GATEWAY,
            crate::net::connect::CONNECT_CHALLENGED_MSG,
        ),
        ConnectError::Conflict => json_error(
            StatusCode::CONFLICT,
            "Luna Connect did not accept this change. Try again.",
        ),
        ConnectError::InvalidToken | ConnectError::Revoked => json_error(
            StatusCode::UNAUTHORIZED,
            crate::net::connect::CREDENTIAL_REJECTED_MSG,
        ),
        ConnectError::Unbound => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        ConnectError::NoPairing => json_error(StatusCode::CONFLICT, err.to_string()),
        ConnectError::PairingRejected => json_error(StatusCode::BAD_REQUEST, err.to_string()),
        ConnectError::Other(msg) => json_error(StatusCode::BAD_REQUEST, msg),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request, StatusCode};
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::net::connect::{ConnectService, DEVICE_TOKEN_FILE};
    use crate::{AppState, db};

    const TOKEN: &str = "7K4M2Q9XR8N36T5W1PZH";
    const GROUPED: &str = "7K4M-2Q9X-R8N3-6T5W-1PZH";
    const CREDENTIAL: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const PASSWORD: &str = "hunter22hunter1";

    struct Harness {
        _dir: tempfile::TempDir,
        data_dir: std::path::PathBuf,
        state: AppState,
        router: axum::Router,
        admin: Option<String>,
        member: Option<String>,
    }

    fn harness(users: bool) -> Harness {
        harness_at(users, "http://127.0.0.1:1")
    }

    fn harness_at(users: bool, base_url: &str) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let connect = Arc::new(ConnectService::new(dir.path(), Some(base_url.to_string())));
        let state = AppState::new(conn, drive_manager, dir.path()).with_connect(connect);
        let (admin, member) = if users {
            let a = state
                .auth
                .register("Max", "Max", PASSWORD, "admin")
                .unwrap();
            let m = state
                .auth
                .register("Jamie", "Jamie", PASSWORD, "user")
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
        let mut http = req.body(body).unwrap();
        http.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:40000".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let res = h.router.clone().oneshot(http).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn seed_bound(h: &Harness) {
        std::fs::write(h.data_dir.join(DEVICE_TOKEN_FILE), format!("{TOKEN}\n")).unwrap();
        std::fs::write(
            h.data_dir
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
            format!("{CREDENTIAL}\n"),
        )
        .unwrap();
        h.state
            .connect
            .save(&json!({
                "state": "bound",
                "bound": true,
                "paired": true,
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock-token",
                "tunnel_active": true,
            }))
            .unwrap();
    }

    fn serve_connect(status: u16, body: &str) -> (String, Arc<AtomicUsize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_string();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                seen.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{addr}"), calls)
    }

    #[tokio::test]
    async fn only_an_admin_can_set_the_device_token() {
        let h = harness(true);
        let (status, _) = send(
            &h,
            Method::PUT,
            "/api/v1/connect/device-token",
            h.member.as_deref(),
            Some(json!({ "device_token": TOKEN })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!h.data_dir.join(DEVICE_TOKEN_FILE).exists());
    }

    #[tokio::test]
    async fn an_admin_saves_the_device_token() {
        let h = harness(true);
        let (status, body) = send(
            &h,
            Method::PUT,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            Some(json!({ "device_token": "7k4m-2q9x-r8n3-6t5w-1pzh" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            std::fs::read_to_string(h.data_dir.join(DEVICE_TOKEN_FILE))
                .unwrap()
                .trim(),
            TOKEN
        );
        assert!(h.state.connect.poll_wake().is_set());
        assert!(!h.state.connect.is_connect_active());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(h.data_dir.join(DEVICE_TOKEN_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn malformed_device_tokens_are_refused() {
        let h = harness(true);
        for body in [
            json!({ "device_token": "short" }),
            json!({ "device_token": "7K4M2Q9XR8N36T5W1PZU" }),
            json!({ "device_uid": TOKEN, "verification_code": "A3F91C" }),
        ] {
            let (status, _) = send(
                &h,
                Method::PUT,
                "/api/v1/connect/device-token",
                h.admin.as_deref(),
                Some(body),
            )
            .await;
            assert_ne!(status, StatusCode::OK);
        }
        assert!(!h.data_dir.join(DEVICE_TOKEN_FILE).exists());
    }

    #[tokio::test]
    async fn first_run_setup_may_enter_the_device_token_on_the_lan() {
        let h = harness(false);
        let (status, _) = send(
            &h,
            Method::PUT,
            "/api/v1/connect/device-token",
            None,
            Some(json!({ "device_token": TOKEN })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(h.state.connect.has_device_token());
    }

    async fn send_from(
        h: &Harness,
        peer: &str,
        headers: &[(&str, &str)],
        body: Value,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(Method::PUT)
            .uri("/api/v1/connect/device-token")
            .header("content-type", "application/json");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let mut http = req.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut()
            .insert(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
        let res = h.router.clone().oneshot(http).await.unwrap();
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
    async fn anonymous_token_save_is_origin_and_lan_guarded() {
        let h = harness(false);
        let body = json!({ "device_token": TOKEN });
        let (status, _) = send_from(
            &h,
            "192.168.1.20:40000",
            &[("host", "evil.example:8090")],
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send_from(
            &h,
            "203.0.113.7:40000",
            &[("x-forwarded-for", "192.168.1.20")],
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send_from(
            &h,
            "127.0.0.1:40000",
            &[("cf-connecting-ip", "203.0.113.7")],
            body,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!h.data_dir.join(DEVICE_TOKEN_FILE).exists());
    }

    #[tokio::test]
    async fn anonymous_setup_cannot_replace_the_device_token() {
        let h = harness(false);
        h.state.connect.set_device_token(TOKEN).unwrap();
        let (status, _) = send(
            &h,
            Method::PUT,
            "/api/v1/connect/device-token",
            None,
            Some(json!({ "device_token": "ZZZZYYYYXXXXWWWWVVVV" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(h.state.connect.device_token().unwrap(), TOKEN);
    }

    #[tokio::test]
    async fn replacing_the_token_is_local_only_and_keeps_the_binding() {
        let (url, calls) = serve_connect(200, r#"{"ok":true}"#);
        let h = harness_at(true, &url);
        seed_bound(&h);
        let (status, body) = send(
            &h,
            Method::PUT,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            Some(json!({ "device_token": "ZZZZYYYYXXXXWWWWVVVV" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            h.state.connect.device_token().unwrap(),
            "ZZZZYYYYXXXXWWWWVVVV"
        );
        assert!(
            h.data_dir
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE)
                .exists()
        );
        assert!(h.state.connect.is_connect_active());
        assert_eq!(
            h.state.connect.public_hostname().as_deref(),
            Some("photos.luna.servers.libreloom.org")
        );
    }

    #[tokio::test]
    async fn only_an_admin_can_remove_the_device_token() {
        let h = harness(true);
        h.state.connect.set_device_token(TOKEN).unwrap();
        for token in [h.member.as_deref(), None] {
            let (status, _) = send(
                &h,
                Method::DELETE,
                "/api/v1/connect/device-token",
                token,
                None,
            )
            .await;
            assert!(
                status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED,
                "{status}"
            );
        }
        assert!(h.data_dir.join(DEVICE_TOKEN_FILE).exists());
    }

    #[tokio::test]
    async fn the_device_token_cannot_be_removed_while_linked() {
        let h = harness(true);
        seed_bound(&h);
        let (status, body) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"], "Disconnect Luna Connect first.");
        assert!(h.data_dir.join(DEVICE_TOKEN_FILE).exists());
        // An owed unbind blocks it too.
        std::fs::remove_file(
            h.data_dir
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE),
        )
        .unwrap();
        std::fs::write(
            h.data_dir.join(crate::net::connect::UNBIND_PENDING_FILE),
            "{}",
        )
        .unwrap();
        let (status, _) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(h.data_dir.join(DEVICE_TOKEN_FILE).exists());
    }

    #[tokio::test]
    async fn removing_the_device_token_deletes_it_and_stops_polling() {
        let h = harness(true);
        h.state.connect.set_device_token(TOKEN).unwrap();
        assert!(h.state.connect.poll_needed());
        let (status, body) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "ok": true }));
        assert!(!h.data_dir.join(DEVICE_TOKEN_FILE).exists());
        assert!(!h.state.connect.has_device_token());
        assert!(!h.state.connect.poll_needed());
        // Removing it again is harmless.
        let (status, _) = send(
            &h,
            Method::DELETE,
            "/api/v1/connect/device-token",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn unbind_is_for_an_admin_with_their_password() {
        let (url, _) = serve_connect(200, r#"{"ok":true}"#);
        let h = harness_at(true, &url);
        seed_bound(&h);
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/unbind",
            h.member.as_deref(),
            Some(json!({ "password": PASSWORD })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, body) = send(
            &h,
            Method::POST,
            "/api/v1/connect/unbind",
            h.admin.as_deref(),
            Some(json!({ "password": "not-my-password" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert!(h.state.connect.is_connect_active());
    }

    #[tokio::test]
    async fn failed_unbind_stops_remote_access_and_retries() {
        let (url, _) = serve_connect(500, r#"{"error":"down"}"#);
        let h = harness_at(true, &url);
        seed_bound(&h);
        let (status, _) = send(
            &h,
            Method::POST,
            "/api/v1/connect/unbind",
            h.admin.as_deref(),
            Some(json!({ "password": PASSWORD })),
        )
        .await;
        assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
        assert!(h.state.connect.unbind_pending());
        assert!(!h.state.connect.is_connect_active());
        assert!(h.state.connect.public_hostname().is_none());
        assert!(
            h.data_dir
                .join(crate::net::connect::CONNECT_CREDENTIAL_FILE)
                .exists()
        );
    }

    #[tokio::test]
    async fn remote_setup_status_does_not_reveal_the_device_token() {
        let h = harness(false);
        h.state.connect.set_device_token(TOKEN).unwrap();
        let mut request = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/connect/status")
            .header("host", "photos.luna.servers.libreloom.org")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "203.0.113.7:40000".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let response = h.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["device_token_set"], true);
        assert!(!body.to_string().contains(TOKEN));
        assert!(!body.to_string().contains(GROUPED));
    }

    #[tokio::test]
    async fn status_never_returns_the_rolling_credential() {
        let h = harness(true);
        seed_bound(&h);
        let (status, admin) = send(
            &h,
            Method::GET,
            "/api/v1/connect/status",
            h.admin.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!admin.to_string().contains(CREDENTIAL));
        assert_eq!(admin["state"], "bound");
        assert_eq!(admin["device_token_set"], true);
        assert!(!admin.to_string().contains(TOKEN));
        let (status, member) = send(
            &h,
            Method::GET,
            "/api/v1/connect/status",
            h.member.as_deref(),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!member.to_string().contains(CREDENTIAL));
    }
}
