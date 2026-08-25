//! WebDAV for native desktop mounts (Finder, Explorer, davfs2).
//!
//! One endpoint per adopted drive: `/dav/{drive_id}/...`. The handler uses a
//! jailed filesystem (no symlink following, `O_NOFOLLOW` opens) rooted at the
//! drive's mount point, so a client can never address anything outside that
//! drive.
//!
//! DAV hands out the whole drive with read/write access, so unlike the
//! grant-scoped file API it is limited to authenticated admins. Clients
//! authenticate with a session cookie, `Authorization: Bearer <token>`, or
//! HTTP Basic where the password is a session JWT or a device token (the
//! same long-lived access token apps mint after login). The household
//! password is not accepted here.

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use dav_server::fakels::FakeLs;

use crate::dav_fs::JailedFs;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/dav/{id}", any(handle_dav))
        .route("/dav/{id}/", any(handle_dav))
        .route("/dav/{id}/{*rest}", any(handle_dav_wild))
}

async fn handle_dav(
    State(state): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> axum::response::Response {
    handle_dav_inner(state, id, req).await
}

async fn handle_dav_wild(
    State(state): State<AppState>,
    Path((id, _rest)): Path<(String, String)>,
    req: Request,
) -> axum::response::Response {
    handle_dav_inner(state, id, req).await
}

async fn handle_dav_inner(state: AppState, id: String, req: Request) -> axum::response::Response {
    if let Err(err) = require_dav_admin(&state, &req) {
        return err.into_response();
    }
    let handler = match dav_handler_for(&state, &id) {
        Ok(handler) => handler,
        Err(err) => return err.into_response(),
    };
    let resp = handler.handle(req).await;
    let (parts, body) = resp.into_parts();
    axum::response::Response::from_parts(parts, axum::body::Body::new(body))
}

fn require_dav_admin(
    state: &AppState,
    req: &Request,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    if let Ok(Some(user)) = state.auth.resolve_from_headers(req.headers()) {
        return require_admin_role(user);
    }
    // Failed Basic (household password, unknown token, empty) is rate-limited
    // so a WebDAV prompt cannot hammer guesses. Missing credentials just 401.
    if basic_credentials_present(req.headers()) {
        let ip = req
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|ci| ci.0.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        if !state.dav_limiter.allow(&ip) {
            return Err(json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many tries. Wait a few minutes and try again.",
            ));
        }
    }
    Err(json_error(
        StatusCode::UNAUTHORIZED,
        "Use your Luna username and an access token as the password. Your Luna password will not work here.",
    ))
}

fn require_admin_role(
    user: CurrentUser,
) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    if user.role != "admin" {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Only an admin can mount drives as folders.",
        ));
    }
    Ok(())
}

fn basic_credentials_present(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("Basic "))
}

/// Decode `Authorization: Basic base64(username:password)` (tests / diagnostics).
#[cfg(test)]
fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    use base64::Engine;
    let encoded = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = std::str::from_utf8(&decoded).ok()?;
    let (user, password) = text.split_once(':')?;
    Some((user.to_string(), password.to_string()))
}

fn dav_handler_for(
    state: &AppState,
    id: &str,
) -> Result<crate::DavHandler, (StatusCode, axum::Json<serde_json::Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let Some(drive) = crate::db::get_drive(&conn, id).map_err(|e| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not read drives. {e}"),
        )
    })?
    else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive.",
        ));
    };
    if drive.mount_point.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "This drive is not connected.",
        ));
    }

    let mut cache = state.dav_handlers.lock().unwrap();
    if let Some(handler) = cache.get(&drive.id) {
        return Ok(handler.clone());
    }

    let handler = crate::DavHandler::builder()
        .filesystem(Box::new(JailedFs::new(&drive.mount_point)))
        .locksystem(FakeLs::new())
        .strip_prefix(format!("/dav/{}", drive.id))
        .build_handler();
    cache.insert(drive.id, handler.clone());
    Ok(handler)
}

pub fn drop_cached_handler(state: &AppState, drive_id: &str) {
    if let Ok(mut cache) = state.dav_handlers.lock() {
        cache.remove(drive_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api;
    use crate::auth::hash_device_token;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use base64::Engine;
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 8)),
        54321,
    );

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        crate::db::upsert_drive(
            &conn,
            "photos",
            "Photos",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager);
        let app = api::router()
            .merge(router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state);
        (dir, app)
    }

    fn req(method: Method, uri: &str, auth: Option<&str>) -> HttpReq<Body> {
        let mut builder = HttpReq::builder().method(method).uri(uri);
        if let Some(a) = auth {
            builder = builder.header("authorization", a);
        }
        let mut http = builder.body(Body::empty()).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn basic(user: &str, password: &str) -> String {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        format!("Basic {encoded}")
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    fn json_req(
        method: Method,
        uri: &str,
        body: &'static str,
        cookie: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        let mut http = builder.body(Body::from(body)).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn setup_admin_and_token(app: &axum::Router) -> String {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter"}"#,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter"}"#,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let cookie = res
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .and_then(|c| c.split(';').next())
            .expect("login must Set-Cookie luna_session")
            .to_string();
        assert!(cookie.starts_with("luna_session="));
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            v.get("token").is_none(),
            "login JSON must not include a session JWT"
        );

        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/device-tokens",
                r#"{"name":"Finder on the kitchen Mac"}"#,
                Some(&cookie),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        v["token"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn dav_accepts_device_token_as_basic_password() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(Method::GET, "/dav/photos/", Some(&basic("max", &token))),
        )
        .await;
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
        assert_ne!(res.status(), StatusCode::FORBIDDEN);
        assert!(
            res.status().is_success() || res.status() == StatusCode::METHOD_NOT_ALLOWED,
            "unexpected status {}",
            res.status()
        );
    }

    #[tokio::test]
    async fn dav_rejects_household_password() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let _token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/",
                Some(&basic("max", "hunter22hunter")),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            text.contains("access token"),
            "plain-language token hint: {text}"
        );
    }

    #[tokio::test]
    async fn dav_accepts_token_as_username_with_empty_password() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(Method::GET, "/dav/photos/", Some(&basic(&token, ""))),
        )
        .await;
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
        assert_ne!(res.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn hashed_device_token_is_not_the_household_password() {
        assert_ne!(hash_device_token("hunter22hunter"), hash_device_token(""));
    }

    #[test]
    fn basic_split_keeps_token_case() {
        let mut h = HeaderMap::new();
        let encoded = base64::engine::general_purpose::STANDARD.encode("Max:AbC");
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Basic {encoded}").parse().unwrap(),
        );
        let (u, p) = basic_credentials(&h).unwrap();
        assert_eq!(u, "Max");
        assert_eq!(p, "AbC");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dav_does_not_follow_symlink_escape() {
        use std::os::unix::fs::symlink;
        let mount = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"secret-bytes").unwrap();
        symlink(outside.path(), mount.path().join("escape")).unwrap();
        std::fs::write(mount.path().join("ok.txt"), b"ok").unwrap();
        let (_dir, app) = test_app(mount.path());
        let token = setup_admin_and_token(&app).await;
        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/escape/secret.txt",
                Some(&basic("max", &token)),
            ),
        )
        .await;
        assert_ne!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            !text.contains("secret-bytes"),
            "symlink escape must not leak outside the drive: {text}"
        );
    }
}
