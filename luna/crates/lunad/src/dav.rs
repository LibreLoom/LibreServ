//! WebDAV for native desktop mounts (Finder, Explorer, davfs2).
//!
//! One endpoint per adopted drive: `/dav/{drive_id}/...`. The handler uses a
//! grant-filtered jailed filesystem (no symlink following, `O_NOFOLLOW` opens)
//! rooted at the drive's mount point, so a client can never address anything
//! outside that drive — and members only see folders granted to them.
//!
//! Clients authenticate with a session cookie, `Authorization: Bearer <token>`,
//! or HTTP Basic where the password is a session JWT or a device token (the
//! same long-lived access token apps mint after login). The household
//! password is not accepted here. Access matches the signed-in user: admins
//! see the whole drive; members see their grants (read or write).

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use dav_server::fakels::FakeLs;

use crate::dav_fs::GrantFs;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::{CurrentUser, has_drive_access};

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
    let user = match require_dav_user(&state, &req) {
        Ok(user) => user,
        Err(err) => return err.into_response(),
    };
    let handler = match dav_handler_for(&state, &id, user) {
        Ok(handler) => handler,
        Err(err) => return err.into_response(),
    };
    let resp = handler.handle(req).await;
    let (parts, body) = resp.into_parts();
    axum::response::Response::from_parts(parts, axum::body::Body::new(body))
}

fn require_dav_user(
    state: &AppState,
    req: &Request,
) -> Result<CurrentUser, (StatusCode, axum::Json<serde_json::Value>)> {
    if let Ok(Some(user)) = state.auth.resolve_from_headers(req.headers()) {
        return Ok(user);
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
    user: CurrentUser,
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
    if !has_drive_access(&user, &conn, &drive.id) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have access to this drive.",
        ));
    }
    let mount_point = drive.mount_point.clone();
    let drive_id = drive.id.clone();
    drop(conn);

    // Per-request handler: grants are user-specific, so we must not share one
    // filesystem across sessions.
    Ok(crate::DavHandler::builder()
        .filesystem(Box::new(GrantFs::new(
            &mount_point,
            user,
            drive_id.clone(),
            state.db.clone(),
        )))
        .locksystem(FakeLs::new())
        .strip_prefix(format!("/dav/{drive_id}"))
        .build_handler())
}

/// Kept for call sites that used to invalidate a shared DavHandler cache.
/// Handlers are built per request now, so this is a no-op.
pub fn drop_cached_handler(_state: &AppState, _drive_id: &str) {}

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

    fn test_app(mount: &std::path::Path) -> (tempfile::TempDir, axum::Router, crate::AppState) {
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
        let state = crate::AppState::new(conn, drive_manager, dir.path());
        let app = api::router()
            .merge(router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        (dir, app, state)
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

    fn req_body(method: Method, uri: &str, auth: Option<&str>, body: &'static [u8]) -> HttpReq<Body> {
        let mut builder = HttpReq::builder().method(method).uri(uri);
        if let Some(a) = auth {
            builder = builder.header("authorization", a);
        }
        let mut http = builder.body(Body::from(body)).unwrap();
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
        body: &str,
        cookie: Option<&str>,
        csrf: Option<&str>,
    ) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        if let Some(t) = csrf {
            builder = builder.header("x-csrf-token", t);
        }
        let mut http = builder.body(Body::from(body.to_string())).unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    fn auth_cookies(res: &axum::response::Response) -> (String, String) {
        let mut session = String::new();
        let mut csrf = String::new();
        for value in res.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = value.to_str().unwrap();
            let part = s.split(';').next().unwrap_or("");
            if part.starts_with("luna_session=") {
                session = part.to_string();
            } else if let Some(token) = part.strip_prefix("luna_csrf=") {
                csrf = token.to_string();
            }
        }
        (session, csrf)
    }

    async fn login_and_token(
        app: &axum::Router,
        username: &str,
        password: &str,
        token_name: &str,
    ) -> String {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                &format!(
                    r#"{{"username":"{username}","password":"{password}"}}"#
                ),
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "login {username}");
        let (session, csrf) = auth_cookies(&res);
        let cookie = format!("{session}; luna_csrf={csrf}");
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/device-tokens",
                &format!(r#"{{"name":"{token_name}"}}"#),
                Some(&cookie),
                Some(&csrf),
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

    async fn setup_admin_and_token(app: &axum::Router) -> String {
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/register",
                r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        login_and_token(app, "max", "hunter22hunter1", "Finder on the kitchen Mac").await
    }

    /// Admin + member with a grant. Returns (admin_token, member_token, member_user_id).
    async fn setup_admin_member_grant(
        app: &axum::Router,
        state: &crate::AppState,
        grant_path: &str,
        permission: &str,
    ) -> (String, String, String) {
        let admin_token = setup_admin_and_token(app).await;

        // Admin session to create member.
        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (session, csrf) = auth_cookies(&res);
        let cookie = format!("{session}; luna_csrf={csrf}");

        let res = call(
            app,
            json_req(
                Method::POST,
                "/api/v1/users",
                r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1","role":"user"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let sam_id = v["id"].as_str().unwrap().to_string();

        {
            let conn = state.db.lock().unwrap();
            crate::db::insert_grant(
                &conn,
                "g-sam",
                &sam_id,
                "photos",
                grant_path,
                permission,
            )
            .unwrap();
        }

        let member_token =
            login_and_token(app, "sam", "hunter22hunter1", "Sam's laptop").await;
        (admin_token, member_token, sam_id)
    }

    #[tokio::test]
    async fn dav_accepts_device_token_as_basic_password() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app, _state) = test_app(mount.path());
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
        let (_dir, app, _state) = test_app(mount.path());
        let _token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/",
                Some(&basic("max", "hunter22hunter1")),
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
        let (_dir, app, _state) = test_app(mount.path());
        let token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(Method::GET, "/dav/photos/", Some(&basic(&token, ""))),
        )
        .await;
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
        assert_ne!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn dav_member_with_write_grant_can_read_granted_path() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        std::fs::write(mount.path().join("family/hi.txt"), b"hello").unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("secret/nope.txt"), b"nope").unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let (_admin, member_token, _) =
            setup_admin_member_grant(&app, &state, "family", "write").await;

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/family/hi.txt",
                Some(&basic("sam", &member_token)),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        assert_eq!(&body[..], b"hello");

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/secret/nope.txt",
                Some(&basic("sam", &member_token)),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn dav_member_read_grant_rejects_put() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let (_admin, member_token, _) =
            setup_admin_member_grant(&app, &state, "family", "read").await;

        let res = call(
            &app,
            req_body(
                Method::PUT,
                "/dav/photos/family/new.txt",
                Some(&basic("sam", &member_token)),
                b"data",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn dav_member_without_grant_forbidden() {
        let mount = tempfile::tempdir().unwrap();
        let (_dir, app, _state) = test_app(mount.path());
        let _admin = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/auth/login",
                r#"{"username":"max","password":"hunter22hunter1"}"#,
                None,
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let cookie = format!("{session}; luna_csrf={csrf}");
        let res = call(
            &app,
            json_req(
                Method::POST,
                "/api/v1/users",
                r#"{"username":"sam","display_name":"Sam","password":"hunter22hunter1","role":"user"}"#,
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let member_token =
            login_and_token(&app, "sam", "hunter22hunter1", "Sam no grant").await;

        let res = call(
            &app,
            req(Method::GET, "/dav/photos/", Some(&basic("sam", &member_token))),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("don't have access") || text.contains("access"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn dav_admin_still_sees_whole_drive() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::write(mount.path().join("anywhere.txt"), b"yes").unwrap();
        let (_dir, app, _state) = test_app(mount.path());
        let token = setup_admin_and_token(&app).await;

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/anywhere.txt",
                Some(&basic("max", &token)),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn dav_deep_grant_lists_ancestors_hides_siblings() {
        let mount = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(mount.path().join("family/photos")).unwrap();
        std::fs::create_dir_all(mount.path().join("secret")).unwrap();
        std::fs::write(mount.path().join("family/photos/a.txt"), b"a").unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let (_admin, member_token, _) =
            setup_admin_member_grant(&app, &state, "family/photos", "read").await;

        // PROPFIND is the usual list; GET on a directory may 405 — use PROPFIND.
        let res = call(
            &app,
            req(
                Method::from_bytes(b"PROPFIND").unwrap(),
                "/dav/photos/",
                Some(&basic("sam", &member_token)),
            ),
        )
        .await;
        assert!(
            res.status().is_success() || res.status() == StatusCode::MULTI_STATUS,
            "root propfind {}",
            res.status()
        );
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("family"),
            "ancestor folder should appear: {text}"
        );
        assert!(
            !text.contains("secret"),
            "sibling outside grant must be hidden: {text}"
        );

        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/family/photos/a.txt",
                Some(&basic("sam", &member_token)),
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[test]
    fn hashed_device_token_is_not_the_household_password() {
        assert_ne!(hash_device_token("hunter22hunter1"), hash_device_token(""));
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
        std::fs::create_dir_all(mount.path().join("family")).unwrap();
        symlink(outside.path(), mount.path().join("family/escape")).unwrap();
        std::fs::write(mount.path().join("family/ok.txt"), b"ok").unwrap();
        let (_dir, app, state) = test_app(mount.path());
        let (_admin, member_token, _) =
            setup_admin_member_grant(&app, &state, "family", "write").await;
        let res = call(
            &app,
            req(
                Method::GET,
                "/dav/photos/family/escape/secret.txt",
                Some(&basic("sam", &member_token)),
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
