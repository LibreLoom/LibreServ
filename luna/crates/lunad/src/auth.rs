//! Authentication: argon2 password hashing + signed session JWTs.
//!
//! Luna is LAN-first, but every data API still requires a session. Public
//! paths are limited to health, login/register-when-empty, setup state, and
//! the SPA shell.

use std::sync::{Arc, Mutex};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;
use crate::api::response::json_error;
use crate::db::{self, UserRow};

pub const SESSION_COOKIE: &str = "luna_session";
pub const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub exp: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentUser {
    pub id: String,
    pub username: String,
    pub role: String,
}

impl CurrentUser {
    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("That username or password is wrong.")]
    BadLogin,
    #[error("Usernames are 3-32 letters, numbers, dots, dashes, or underscores.")]
    BadUsername,
    #[error("Passwords need at least 8 characters.")]
    BadPassword,
    #[error("That username is already taken.")]
    Taken,
    #[error("Only an admin can do that.")]
    Forbidden,
    #[error("Sign in to Luna first.")]
    Unauthenticated,
    #[error("{0}")]
    Db(#[source] anyhow::Error),
    #[error("{0}")]
    Token(String),
}

#[derive(Clone)]
pub struct AuthService {
    db: Arc<Mutex<Connection>>,
    secret: Vec<u8>,
}

impl AuthService {
    pub fn new(db: Arc<Mutex<Connection>>, secret: Vec<u8>) -> Self {
        Self { db, secret }
    }

    /// Generate (or load) the JWT signing secret, persisted in SQLite meta.
    pub fn ensure_secret(conn: &Connection) -> anyhow::Result<String> {
        if let Some(existing) = db::get_meta(conn, "jwt_secret")?
            && !existing.is_empty()
        {
            return Ok(existing);
        }
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        db::set_meta(conn, "jwt_secret", &encoded)?;
        Ok(encoded)
    }

    /// Create a user. The first user is always an admin, regardless of caller.
    pub fn register(
        &self,
        username: &str,
        display_name: &str,
        password: &str,
        requested_role: &str,
    ) -> Result<UserRow, AuthError> {
        let username = normalize_username(username)?;
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.len() > 80 {
            return Err(AuthError::BadUsername);
        }
        if password.len() < 8 {
            return Err(AuthError::BadPassword);
        }

        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        if db::get_user_by_username(&conn, &username)
            .map_err(AuthError::Db)?
            .is_some()
        {
            return Err(AuthError::Taken);
        }
        let role = if db::count_users(&conn).map_err(AuthError::Db)? == 0 {
            "admin".to_string()
        } else {
            match requested_role {
                "admin" | "user" => requested_role.to_string(),
                _ => "user".to_string(),
            }
        };
        let hash = hash_password(password)?;
        let id = Uuid::new_v4().to_string();
        db::insert_user(&conn, &id, &username, display_name, &hash, &role)
            .map_err(AuthError::Db)?;
        db::get_user(&conn, &id)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::Db(anyhow::anyhow!(
                "user not found after insert"
            )))
    }

    pub fn login(&self, username: &str, password: &str) -> Result<(UserRow, String), AuthError> {
        let username = username.trim().to_lowercase();
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let user = db::get_user_by_username(&conn, &username)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::BadLogin)?;
        let parsed = PasswordHash::new(&user.password_hash).map_err(|_| AuthError::BadLogin)?;
        verify_password_hash(password, &parsed)?;
        let token = self.issue(&user)?;
        Ok((user, token))
    }

    pub fn verify(&self, token: &str) -> Result<CurrentUser, AuthError> {
        let data = jsonwebtoken::decode::<Claims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(&self.secret),
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        )
        .map_err(|e| AuthError::Token(e.to_string()))?;
        Ok(CurrentUser {
            id: data.claims.sub,
            username: data.claims.username,
            role: data.claims.role,
        })
    }

    /// Resolve a request's credentials (Bearer/Basic token or session cookie)
    /// to a current user. Returns `Ok(None)` when no usable credential is
    /// present or the credential is unknown.
    pub fn resolve_from_headers(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<CurrentUser>, AuthError> {
        let Some(raw) = token_from_headers(headers) else {
            return Ok(None);
        };
        if let Ok(user) = self.verify(&raw) {
            // Re-check every session JWT against the DB so a deleted user loses
            // access immediately (not after their 30-day token expires) and a
            // role change takes effect without waiting for re-login.
            let conn = self
                .db
                .lock()
                .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
            return Ok(
                match db::get_user(&conn, &user.id).map_err(AuthError::Db)? {
                    Some(row) => Some(CurrentUser {
                        id: row.id,
                        username: row.username,
                        role: row.role,
                    }),
                    None => None,
                },
            );
        }
        if let Ok(Some((user, _))) = self.verify_device_token(&raw) {
            return Ok(Some(user));
        }
        Ok(None)
    }

    /// Resolve a device token (from `Authorization: Bearer <token>`). Device
    /// tokens share the same surface as session JWTs but are stored by their
    /// blake3 hash in SQLite and can be revoked without touching the user's
    /// password. Returns None when the token is unknown.
    pub fn verify_device_token(
        &self,
        token: &str,
    ) -> Result<Option<(CurrentUser, String)>, AuthError> {
        let token_hash = hash_device_token(token);
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let Some(dt) = db::get_device_token_by_hash(&conn, &token_hash).map_err(AuthError::Db)?
        else {
            return Ok(None);
        };
        if dt.revoked_at.is_some() {
            return Ok(None);
        }
        let Some(user) = db::get_user(&conn, &dt.user_id).map_err(AuthError::Db)? else {
            return Ok(None);
        };
        let _ = db::touch_device_token(&conn, &dt.id);
        Ok(Some((
            CurrentUser {
                id: user.id.clone(),
                username: user.username.clone(),
                role: user.role.clone(),
            },
            dt.id,
        )))
    }

    pub fn issue(&self, user: &UserRow) -> Result<String, AuthError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let claims = Claims {
            sub: user.id.clone(),
            username: user.username.clone(),
            role: user.role.clone(),
            exp: now + SESSION_TTL_SECONDS,
        };
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(&self.secret),
        )
        .map_err(|e| AuthError::Token(e.to_string()))
    }

    pub fn user(&self, id: &str) -> Result<Option<UserRow>, AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::get_user(&conn, id).map_err(AuthError::Db)
    }

    pub fn list_users(&self) -> Result<Vec<UserRow>, AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::list_users(&conn).map_err(AuthError::Db)
    }

    pub fn delete_user(&self, id: &str) -> Result<(), AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::delete_user(&conn, id).map_err(AuthError::Db)?;
        Ok(())
    }

    pub fn count_users(&self) -> Result<i64, AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::count_users(&conn).map_err(AuthError::Db)
    }
}

pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}"
    )
}

pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
        // WebDAV clients (Finder, Explorer, davfs2, gio) authenticate with
        // HTTP Basic auth. The username is ignored; the password carries the
        // same session or device token a Bearer header would.
        if let Some(encoded) = auth.strip_prefix("Basic ") {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .ok()?;
            let text = std::str::from_utf8(&decoded).ok()?;
            let (_, password) = text.split_once(':')?;
            return Some(password.to_string());
        }
        return None;
    }
    let cookie = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE).then(|| value.to_string())
    })
}

/// Global auth guard: health, auth, setup, and the SPA shell stay public;
/// every `/api/` data endpoint requires a valid session. The first-run setup
/// wizard must reach the network endpoints before any account exists, so they
/// stay public for exactly as long as the user table is empty.
///
/// A valid session (cookie, Bearer, or device token) is resolved and attached
/// to the request even on public paths. Without that, `/api/v1/auth/me` can
/// never report an existing session — it always reads an empty extension —
/// and the web UI loses the sign-in state on every refresh of the auth
/// context (after finishing setup, and after every login).
pub async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let mut is_public = path == "/health"
        || path == "/api/v1/health"
        || path.starts_with("/api/v1/auth/")
        || path.starts_with("/api/v1/setup")
        || path.starts_with("/s/")
        || !path.starts_with("/api/");
    if !is_public && path.starts_with("/api/v1/network/") {
        let setup_mode = state.auth.count_users().unwrap_or(1) == 0;
        is_public = setup_mode;
    }

    // Prefer the session JWT; fall back to a device token so the mobile and
    // desktop clients can authenticate with a revocable, long-lived token.
    let mut req = req;
    if let Ok(Some(user)) = state.auth.resolve_from_headers(req.headers()) {
        req.extensions_mut().insert(user);
    }

    if is_public {
        return next.run(req).await;
    }
    if req.extensions().get::<CurrentUser>().is_some() {
        return next.run(req).await;
    }
    json_error(StatusCode::UNAUTHORIZED, "Sign in to Luna first.").into_response()
}

/// Extract the authenticated user (handlers are behind the guard).
pub fn current_user(req: &axum::extract::Request) -> Option<&CurrentUser> {
    req.extensions().get::<CurrentUser>()
}

/// Does `user` have `read` or `write` access to `drive_id`/`path`?
///
/// Admins see everything. Scoped grants match the exact path or anything
/// beneath it (`grant = "family"` allows `family/photos`).
pub fn can_access(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    write: bool,
) -> bool {
    if user.role == "admin" {
        return true;
    }
    let Ok(grants) = db::list_grants_for_user(conn, &user.id) else {
        return false;
    };
    grants.into_iter().any(|g| {
        if g.drive_id != drive_id {
            return false;
        }
        if write && g.permission != "write" {
            return false;
        }
        g.path.is_empty() || path == g.path || path.starts_with(&format!("{}/", g.path))
    })
}

pub fn require_admin(req: &axum::extract::Request) -> Result<&CurrentUser, AuthError> {
    let user = current_user(req).ok_or(AuthError::Unauthenticated)?;
    if user.role != "admin" {
        return Err(AuthError::Forbidden);
    }
    Ok(user)
}

pub(crate) fn verify_password_hash(
    password: &str,
    parsed: &PasswordHash<'_>,
) -> Result<(), AuthError> {
    argon2::Argon2::default()
        .verify_password(password.as_bytes(), parsed)
        .map_err(|_| AuthError::BadLogin)
}

fn normalize_username(username: &str) -> Result<String, AuthError> {
    let username = username.trim().to_lowercase();
    let valid = !username.is_empty()
        && username.len() <= 32
        && username.len() >= 3
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid {
        return Err(AuthError::BadUsername);
    }
    Ok(username)
}

pub(crate) fn hash_device_token(input: &str) -> String {
    // Hash device tokens before storage so a leaked database never yields a
    // usable bearer token. blake3 is already a workspace dependency (used for
    // file scrub hashes), and base64 is already imported above.
    let digest = blake3::hash(input.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest.as_bytes())
}

pub(crate) fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AuthError::BadPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, AuthService) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let secret = AuthService::ensure_secret(&conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        (dir, AuthService::new(db, secret.into_bytes()))
    }

    #[test]
    fn first_user_is_admin_and_login_round_trips() {
        let (_dir, auth) = service();
        let user = auth
            .register("Max", "Max", "hunter22hunter", "user")
            .unwrap();
        assert_eq!(user.role, "admin");

        let (_, token) = auth.login("max", "hunter22hunter").unwrap();
        let current = auth.verify(&token).unwrap();
        assert_eq!(current.username, "max");
        assert!(auth.login("max", "wrong-password").is_err());
    }

    #[test]
    fn grants_scope_access_by_folder() {
        let (dir, auth) = service();
        let admin = auth
            .register("Max", "Max", "hunter22hunter", "user")
            .unwrap();
        let sam = auth
            .register("sam", "Sam", "hunter22hunter", "user")
            .unwrap();
        let conn = auth.db.lock().unwrap();
        crate::db::insert_grant(&conn, "g1", &sam.id, "drive-a", "family", "read").unwrap();
        let sam_user = CurrentUser {
            id: sam.id.clone(),
            username: sam.username.clone(),
            role: "user".into(),
        };
        assert!(can_access(
            &sam_user,
            &conn,
            "drive-a",
            "family/photos",
            false
        ));
        assert!(!can_access(&sam_user, &conn, "drive-a", "other", false));
        assert!(
            !can_access(&sam_user, &conn, "drive-a", "family", true),
            "read grant is not write"
        );
        assert!(can_access(
            &CurrentUser {
                id: admin.id.clone(),
                username: admin.username.clone(),
                role: "admin".into()
            },
            &conn,
            "drive-a",
            "anything",
            true
        ));
        drop(conn);
        drop((dir, auth));
    }

    #[test]
    fn device_token_round_trips_and_revokes() {
        let (_dir, auth) = service();
        let max = auth
            .register("Max", "Max", "hunter22hunter", "user")
            .unwrap();

        let token = {
            let conn = auth.db.lock().unwrap();
            let raw_token = "secret-device-token-value";
            crate::db::insert_device_token(
                &conn,
                "dt1",
                &max.id,
                "My phone",
                &hash_device_token(raw_token),
            )
            .unwrap();
            raw_token.to_string()
        };

        let (who, id) = auth.verify_device_token(&token).unwrap().unwrap();
        assert_eq!(who.id, max.id);
        assert_eq!(id, "dt1");

        // Unknown token -> None, and a revoked token -> None.
        assert!(auth.verify_device_token("nope").unwrap().is_none());
        {
            let conn = auth.db.lock().unwrap();
            crate::db::revoke_device_token(&conn, "dt1").unwrap();
        }
        assert!(auth.verify_device_token(&token).unwrap().is_none());
    }

    #[test]
    fn username_is_normalized_and_unique() {
        let (_dir, auth) = service();
        auth.register("Max", "Max", "hunter22hunter", "user")
            .unwrap();
        assert!(matches!(
            auth.register("MAX", "Other", "hunter22hunter", "user"),
            Err(AuthError::Taken)
        ));
        assert!(auth.register("x", "Bad", "hunter22hunter", "user").is_err());
    }
}

#[cfg(test)]
mod guard_tests {
    //! Regression tests: the guard must attach a valid session to the request
    //! even on public paths, so `/api/v1/auth/me` can report who is signed in.
    //! (Before the fix, `me` always returned null, and the web UI lost its
    //! sign-in state after finishing setup and after every login.)

    use super::guard;
    use crate::api;
    use crate::drives::DriveManager;
    use crate::mount::shared_mock;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Method, Request as HttpReq};
    use tower::ServiceExt;

    const CLIENT: std::net::SocketAddr = std::net::SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7)),
        54321,
    );

    fn test_app() -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = crate::AppState::new(conn, drive_manager);
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
            .with_state(state);
        (dir, app)
    }

    fn req(method: Method, uri: &str, body: Option<&str>, cookie: Option<&str>) -> HttpReq<Body> {
        let mut builder = HttpReq::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(c) = cookie {
            builder = builder.header("cookie", c);
        }
        let mut http = builder
            .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
        http.extensions_mut().insert(ConnectInfo(CLIENT));
        http
    }

    async fn call(app: &axum::Router, r: HttpReq<Body>) -> axum::response::Response {
        app.clone().oneshot(r).await.unwrap()
    }

    async fn text(res: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn session_cookie(res: &axum::response::Response) -> String {
        res.headers()
            .get("set-cookie")
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn me_reports_the_signed_in_session() {
        let (_dir, app) = test_app();

        // No session -> null.
        let res = call(&app, req(Method::GET, "/api/v1/auth/me", None, None)).await;
        assert_eq!(res.status(), 200);
        assert_eq!(text(res).await, "null");

        // Create the first account (setup mode) and log in.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"max","display_name":"Max","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "register failed: {}", text(res).await);

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                Some(r#"{"username":"max","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "login failed: {}", text(res).await);
        let cookie = session_cookie(&res);

        // The session must be visible to /auth/me — this is what keeps the
        // web UI signed in after setup and across page reloads.
        let res = call(
            &app,
            req(Method::GET, "/api/v1/auth/me", None, Some(&cookie)),
        )
        .await;
        assert_eq!(res.status(), 200);
        let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
        assert_eq!(v["username"], "max");
        assert_eq!(v["role"], "admin");
    }

    #[tokio::test]
    async fn adding_users_requires_a_signed_in_admin() {
        let (_dir, app) = test_app();

        // First account is open (setup mode), then log in.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"max","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                Some(r#"{"username":"max","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        let cookie = session_cookie(&res);

        // Anonymous second account -> sign in first.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"sam","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 401);

        // A signed-in admin can add a household member.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"sam","password":"hunter22hunter"}"#),
                Some(&cookie),
            ),
        )
        .await;
        assert_eq!(
            res.status(),
            200,
            "admin register failed: {}",
            text(res).await
        );
        let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
        assert_eq!(v["role"], "user");
    }

    #[tokio::test]
    async fn data_endpoints_still_require_a_session() {
        let (_dir, app) = test_app();
        let res = call(&app, req(Method::GET, "/api/v1/users", None, None)).await;
        assert_eq!(res.status(), 401);
    }
}
