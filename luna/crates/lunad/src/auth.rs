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
pub const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 7;
pub const CSRF_COOKIE: &str = "luna_csrf";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub role: String,
    pub exp: i64,
    /// Bumped in SQLite to invalidate every browser session for that person.
    #[serde(default)]
    pub tv: i64,
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
    #[error("{0}")]
    PasswordPolicy(String),
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
    secret: Arc<Mutex<Vec<u8>>>,
    data_dir: std::path::PathBuf,
}

impl AuthService {
    pub fn new(db: Arc<Mutex<Connection>>, secret: Vec<u8>, data_dir: std::path::PathBuf) -> Self {
        Self {
            db,
            secret: Arc::new(Mutex::new(secret)),
            data_dir,
        }
    }

    fn signing_key(&self) -> Vec<u8> {
        self.secret.lock().unwrap().clone()
    }
    pub fn reload_secret(&self, secret: Vec<u8>) {
        *self.secret.lock().unwrap() = secret;
    }
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
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
        if let Err(err) = crate::password::validate_password(password) {
            return Err(AuthError::PasswordPolicy(err.message().into()));
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
            &jsonwebtoken::DecodingKey::from_secret(&self.signing_key()),
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        )
        .map_err(|e| AuthError::Token(e.to_string()))?;
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let Some(row) = db::get_user(&conn, &data.claims.sub).map_err(AuthError::Db)? else {
            return Err(AuthError::Unauthenticated);
        };
        if row.token_version != data.claims.tv {
            return Err(AuthError::Unauthenticated);
        }
        Ok(CurrentUser {
            id: row.id,
            username: row.username,
            role: row.role,
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
            return Ok(Some(user));
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
        if let Some(exp) = dt.expires_at
            && crate::db::now_unix() > exp
        {
            return Ok(None);
        }
        let Some(user) = db::get_user(&conn, &dt.user_id).map_err(AuthError::Db)? else {
            return Ok(None);
        };
        let _ = db::touch_device_token(&conn, &dt.id);
        let _ = db::insert_device_token_usage(&conn, &dt.id, "auth", "api");
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
            tv: user.token_version,
        };
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(&self.signing_key()),
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

    /// Sign out every browser for this person. This device's cookie is still
    /// cleared separately. Device tokens (phones/computers) are not touched.
    pub fn revoke_sessions(&self, user_id: &str) -> Result<(), AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::bump_user_token_version(&conn, user_id).map_err(AuthError::Db)
    }

    /// Stop every phone and computer backup token for this person.
    pub fn revoke_all_device_tokens(&self, user_id: &str) -> Result<(), AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::revoke_device_tokens_for_user(&conn, user_id).map_err(AuthError::Db)
    }

    pub fn verify_password_for_user(&self, user_id: &str, password: &str) -> Result<(), AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let user = db::get_user(&conn, user_id)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::BadLogin)?;
        verify_password_hash(
            password,
            &PasswordHash::new(&user.password_hash).map_err(|_| AuthError::BadLogin)?,
        )
    }
    pub fn reset_user_password(
        &self,
        username: &str,
        password: &str,
    ) -> Result<UserRow, AuthError> {
        if let Err(err) = crate::password::validate_password(password) {
            return Err(AuthError::PasswordPolicy(err.message().into()));
        }
        let hash = hash_password(password)?;
        let username = username.trim().to_lowercase();
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let user = db::get_user_by_username(&conn, &username)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::BadLogin)?;
        if user.role != "admin" {
            return Err(AuthError::Forbidden);
        }
        db::set_user_password_hash(&conn, &user.id, &hash).map_err(AuthError::Db)?;
        db::bump_user_token_version(&conn, &user.id).map_err(AuthError::Db)?;
        db::revoke_device_tokens_for_user(&conn, &user.id).map_err(AuthError::Db)?;
        db::get_user(&conn, &user.id)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::Db(anyhow::anyhow!("user missing")))
    }
    pub fn rotate_session(&self, user: &UserRow) -> Result<String, AuthError> {
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        db::bump_user_token_version(&conn, &user.id).map_err(AuthError::Db)?;
        let refreshed = db::get_user(&conn, &user.id)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::Unauthenticated)?;
        self.issue(&refreshed)
    }

    /// Local-console recovery only: set a new password for the first admin.
    /// Never exposed on the network.
    pub fn reset_admin_password(&self, password: &str) -> Result<UserRow, AuthError> {
        if let Err(err) = crate::password::validate_password(password) {
            return Err(AuthError::PasswordPolicy(err.message().into()));
        }
        let hash = hash_password(password)?;
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;
        let admin = db::first_admin(&conn)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::Unauthenticated)?;
        db::set_user_password_hash(&conn, &admin.id, &hash).map_err(AuthError::Db)?;
        // Forgotten password: any stolen browser session or phone backup
        // token for this admin must stop working.
        db::bump_user_token_version(&conn, &admin.id).map_err(AuthError::Db)?;
        db::revoke_device_tokens_for_user(&conn, &admin.id).map_err(AuthError::Db)?;
        db::get_user(&conn, &admin.id)
            .map_err(AuthError::Db)?
            .ok_or(AuthError::Db(anyhow::anyhow!("admin missing after reset")))
    }
}

/// `Secure` only when this request is HTTPS (or a proxy says so). LAN HTTP
/// must keep working — never set Secure on every cookie.
pub fn request_is_https(headers: &HeaderMap) -> bool {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        let first = proto.split(',').next().unwrap_or("").trim();
        if first.eq_ignore_ascii_case("https") {
            return true;
        }
    }
    headers
        .get("forwarded")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .any(|part| part.trim().eq_ignore_ascii_case("proto=https"))
        })
}

pub fn session_cookie(token: &str, secure: bool) -> String {
    let secure_flag = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECONDS}{secure_flag}"
    )
}

pub fn csrf_cookie(token: &str, secure: bool) -> String {
    let secure_flag = if secure { "; Secure" } else { "" };
    format!(
        "{CSRF_COOKIE}={token}; Path=/; SameSite=Strict; Max-Age={SESSION_TTL_SECONDS}{secure_flag}"
    )
}
fn csrf_from_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == CSRF_COOKIE).then(|| value.to_string())
    })
}
fn csrf_from_request(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}
fn csrf_valid(headers: &HeaderMap) -> bool {
    let Some(cookie) = csrf_from_cookie(headers) else {
        return false;
    };
    let Some(got) = csrf_from_request(headers) else {
        return false;
    };
    cookie.len() == got.len()
        && cookie
            .bytes()
            .zip(got.bytes())
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            == 0
}
fn uses_session_cookie(headers: &HeaderMap) -> bool {
    token_from_headers(headers).is_some()
        && headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| !v.starts_with("Bearer "))
}
fn new_csrf_token() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
pub fn fresh_csrf_cookie(secure: bool) -> String {
    csrf_cookie(&new_csrf_token(), secure)
}
fn maybe_attach_csrf(response: Response, issue: bool, secure: bool) -> Response {
    if !issue {
        return response;
    }
    let token = new_csrf_token();
    let (mut parts, body) = response.into_parts();
    parts.headers.append(
        axum::http::header::SET_COOKIE,
        csrf_cookie(&token, secure).parse().unwrap(),
    );
    Response::from_parts(parts, body)
}

pub fn clear_session_cookie(secure: bool) -> String {
    let secure_flag = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0{secure_flag}")
}

/// CSRF origin comparison mirroring Luna Connect's `originGuard`: parse the
/// Origin as a URL and compare its authority (host plus explicit port) with
/// the request's Host header. Textual prefix-stripping mishandles explicit
/// ports and bracketed IPv6 hosts, and garbage Origins must fail closed.
fn origin_matches_host(origin: &str, host_header: Option<&str>) -> bool {
    let Some(host_header) = host_header else {
        return false;
    };
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        // Garbage origins fail closed; real browsers always send a URL.
        return false;
    };
    // A bare hostname parses as authority-form with no scheme — Go's
    // url.Parse treats it as a path instead, so Luna Connect rejects it.
    // Require http/https to keep the two guards identical.
    if !matches!(uri.scheme_str(), Some("http") | Some("https")) {
        return false;
    }
    uri.authority()
        .is_some_and(|authority| authority.as_str().eq_ignore_ascii_case(host_header))
}

pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
        // WebDAV clients (Finder, Explorer, davfs2, gio) use HTTP Basic.
        // Password is a session JWT or device token — never the household
        // password. If the password is empty, the username may be the token.
        if let Some(encoded) = auth.strip_prefix("Basic ") {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .ok()?;
            let text = std::str::from_utf8(&decoded).ok()?;
            let (user, password) = text.split_once(':')?;
            if !password.is_empty() {
                return Some(password.to_string());
            }
            if !user.is_empty() {
                return Some(user.to_string());
            }
            return None;
        }
        return None;
    }
    let cookie = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == SESSION_COOKIE).then(|| value.to_string())
    })
}

/// True while the first-run setup wizard is still open (`setup_completed` is
/// false or unset). Used to keep network/connect endpoints reachable during
/// setup even when a dev database already has an account.
pub(crate) fn setup_wizard_open(state: &AppState) -> bool {
    let Ok(conn) = state.db.lock() else {
        return false;
    };
    let completed = crate::db::get_meta(&conn, "setup")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("setup_completed").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    !completed
}

/// Global auth guard: health, auth, setup, and the SPA shell stay public;
/// every `/api/` data endpoint requires a valid session. The first-run setup
/// wizard must reach the network endpoints before setup is finished, so they
/// stay public while the user table is empty or setup is still incomplete.
///
/// A valid session (cookie, Bearer, or device token) is resolved and attached
/// to the request even on public paths. Without that, `/api/v1/auth/me` can
/// never report an existing session — it always reads an empty extension —
/// and the web UI loses the sign-in state on every refresh of the auth
/// context (after finishing setup, and after every login).
pub async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let method = req.method().clone();
    let headers = req.headers().clone();
    let secure = request_is_https(&headers);
    let issue_csrf = matches!(method, axum::http::Method::GET | axum::http::Method::HEAD)
        && csrf_from_cookie(&headers).is_none();
    if matches!(
        method,
        axum::http::Method::POST
            | axum::http::Method::PUT
            | axum::http::Method::PATCH
            | axum::http::Method::DELETE
    ) && uses_session_cookie(&headers)
        && !path.starts_with("/api/v1/auth/login")
        && !path.starts_with("/api/v1/auth/register")
        && !csrf_valid(&headers)
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "This page expired. Refresh Luna and try again.",
        )
        .into_response();
    }
    // CSRF: cookie-authenticated mutations must come from our own origin.
    // Browsers attach Origin to every unsafe request, so a mismatched Origin
    // marks a cross-site request even with SameSite=Lax. Non-browser clients
    // (device tokens, curl, WebDAV) send no Origin and pass through untouched.
    if matches!(
        method,
        axum::http::Method::POST
            | axum::http::Method::PUT
            | axum::http::Method::PATCH
            | axum::http::Method::DELETE
    ) && let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let host_matches = origin_matches_host(
            origin,
            headers
                .get(axum::http::header::HOST)
                .and_then(|v| v.to_str().ok()),
        );
        if !host_matches {
            return json_error(StatusCode::FORBIDDEN, "Cross-site request blocked.")
                .into_response();
        }
    }
    let mut is_public = path == "/health"
        || path == "/api/v1/health"
        || path.starts_with("/api/v1/auth/")
        || path.starts_with("/api/v1/setup")
        || path.starts_with("/s/")
        || !path.starts_with("/api/");
    if !is_public && path.starts_with("/api/v1/network/") {
        let wizard_open = state.auth.count_users().unwrap_or(1) == 0 || setup_wizard_open(&state);
        is_public = wizard_open;
    }
    if !is_public && (path == "/api/v1/connect/status" || path == "/api/v1/connect/setup-code") {
        let wizard_open = state.auth.count_users().unwrap_or(1) == 0 || setup_wizard_open(&state);
        is_public = wizard_open;
    }

    // Prefer the session JWT; fall back to a device token so the mobile and
    // desktop clients can authenticate with a revocable, long-lived token.
    let mut req = req;
    if let Ok(Some(user)) = state.auth.resolve_from_headers(req.headers()) {
        req.extensions_mut().insert(user);
    }

    if is_public {
        return maybe_attach_csrf(next.run(req).await, issue_csrf, secure);
    }
    if req.extensions().get::<CurrentUser>().is_some() {
        return maybe_attach_csrf(next.run(req).await, issue_csrf, secure);
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
/// beneath it (`grant = "family"` allows `family/photos`). After the lexical
/// check, the canonical path must still sit under the (canonical) grant
/// prefix so a symlink inside the granted folder cannot walk the rest of
/// the drive.
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
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point);
    grants.into_iter().any(|g| {
        if g.drive_id != drive_id {
            return false;
        }
        if write && g.permission != "write" {
            return false;
        }
        if !(g.path.is_empty() || path == g.path || path.starts_with(&format!("{}/", g.path))) {
            return false;
        }
        match mount.as_deref() {
            Some(root) => grant_covers_canonical(root, &g.path, path),
            None => true,
        }
    })
}

fn grant_covers_canonical(root: &str, grant_rel: &str, request_rel: &str) -> bool {
    use luna_core::path::{is_under_prefix, resolve_child};
    let root = std::path::Path::new(root);
    let grant_canon = match resolve_child(root, grant_rel) {
        Ok(p) => p,
        Err(_) => {
            // Grant folder missing: fall back to a lexical join under the
            // canonical root so a dangling grant does not open the drive.
            let Ok(canon_root) = root.canonicalize() else {
                return false;
            };
            if grant_rel.is_empty() {
                canon_root
            } else {
                canon_root.join(grant_rel)
            }
        }
    };
    let request_canon = match resolve_child(root, request_rel) {
        Ok(p) => p,
        Err(luna_core::path::PathError::NotFound(_)) => {
            // Upload/create: jail the parent that must already exist.
            let parent = std::path::Path::new(request_rel)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or("");
            match resolve_child(root, parent) {
                Ok(p) => p,
                Err(_) => return false,
            }
        }
        Err(_) => return false,
    };
    is_under_prefix(&grant_canon, &request_canon)
}

/// True if the user may see anything on this drive (whole drive or a folder).
pub fn has_drive_access(user: &CurrentUser, conn: &Connection, drive_id: &str) -> bool {
    if user.role == "admin" {
        return true;
    }
    let Ok(grants) = db::list_grants_for_user(conn, &user.id) else {
        return false;
    };
    grants.iter().any(|g| g.drive_id == drive_id)
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
    if let Err(err) = crate::password::validate_password(password) {
        return Err(AuthError::PasswordPolicy(err.message().into()));
    }
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AuthError::PasswordPolicy(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, AuthService) {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let conn = db::open(&data_dir.join("luna.db")).unwrap();
        let secret = crate::secrets::ensure_jwt_secret(&data_dir, &conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        (dir, AuthService::new(db, secret, data_dir))
    }

    #[test]
    fn first_user_is_admin_and_login_round_trips() {
        let (_dir, auth) = service();
        let user = auth
            .register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        assert_eq!(user.role, "admin");

        let (_, token) = auth.login("max", "hunter22hunter1").unwrap();
        let current = auth.verify(&token).unwrap();
        assert_eq!(current.username, "max");
        assert!(auth.login("max", "wrong-password").is_err());
    }

    #[test]
    fn reset_admin_password_lets_them_sign_in_again() {
        let (_dir, auth) = service();
        auth.register("Max", "Max", "old-password-1", "user")
            .unwrap();
        auth.reset_admin_password("new-password-1").unwrap();
        assert!(auth.login("max", "old-password-1").is_err());
        auth.login("max", "new-password-1").unwrap();
    }

    #[test]
    fn grants_scope_access_by_folder() {
        let (dir, auth) = service();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        let sam = auth
            .register("sam", "Sam", "hunter22hunter1", "user")
            .unwrap();
        let conn = auth.db.lock().unwrap();
        crate::db::insert_grant(&conn, "g1", &sam.id, "drive-a", "family", "read").unwrap();
        let sam_user = CurrentUser {
            id: sam.id.clone(),
            username: sam.username.clone(),
            role: "user".into(),
        };
        assert!(has_drive_access(&sam_user, &conn, "drive-a"));
        assert!(!has_drive_access(&sam_user, &conn, "drive-b"));
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

    #[cfg(unix)]
    #[test]
    fn grant_symlink_leaving_folder_is_denied() {
        use std::os::unix::fs::symlink;
        let (dir, auth) = service();
        let sam = {
            auth.register("Max", "Max", "hunter22hunter1", "user")
                .unwrap();
            auth.register("sam", "Sam", "hunter22hunter1", "user")
                .unwrap()
        };
        let mount = dir.path().join("drive-a");
        std::fs::create_dir_all(mount.join("family")).unwrap();
        std::fs::create_dir_all(mount.join("secret")).unwrap();
        std::fs::write(mount.join("secret/note.txt"), b"nope").unwrap();
        symlink(mount.join("secret"), mount.join("family/escape")).unwrap();
        let conn = auth.db.lock().unwrap();
        crate::db::upsert_drive(
            &conn,
            "drive-a",
            "A",
            "as_is",
            "ext4",
            "sda",
            mount.to_str().unwrap(),
        )
        .unwrap();
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
        assert!(
            !can_access(&sam_user, &conn, "drive-a", "family/escape", false),
            "symlink out of the granted folder must 403"
        );
        assert!(!can_access(
            &sam_user,
            &conn,
            "drive-a",
            "family/escape/note.txt",
            false
        ));
        drop(conn);
        drop((dir, auth));
    }

    #[test]
    fn device_token_round_trips_and_revokes() {
        let (_dir, auth) = service();
        let max = auth
            .register("Max", "Max", "hunter22hunter1", "user")
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
                None,
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
    fn bumping_token_version_invalidates_browser_sessions_only() {
        let (_dir, auth) = service();
        let max = auth
            .register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        let (_, session) = auth.login("max", "hunter22hunter1").unwrap();
        assert!(auth.verify(&session).is_ok());

        let device_raw = "phone-token-keep";
        {
            let conn = auth.db.lock().unwrap();
            crate::db::insert_device_token(
                &conn,
                "dt-keep",
                &max.id,
                "Phone",
                &hash_device_token(device_raw),
                None,
            )
            .unwrap();
            crate::db::bump_user_token_version(&conn, &max.id).unwrap();
        }
        assert!(auth.verify(&session).is_err());
        assert!(auth.verify_device_token(device_raw).unwrap().is_some());

        let (_, session2) = auth.login("max", "hunter22hunter1").unwrap();
        assert!(auth.verify(&session2).is_ok());
    }

    #[test]
    fn https_proxy_sets_secure_cookie_http_does_not() {
        let mut https = HeaderMap::new();
        https.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(request_is_https(&https));
        assert!(session_cookie("t", true).contains("Secure"));
        assert!(!session_cookie("t", false).contains("Secure"));
    }

    #[test]
    fn csrf_origin_parsing_matches_authority() {
        assert!(origin_matches_host(
            "https://luna.local",
            Some("luna.local")
        ));
        assert!(origin_matches_host(
            "http://localhost:8080",
            Some("localhost:8080")
        ));
        assert!(origin_matches_host(
            "https://[::1]:9000",
            Some("[::1]:9000")
        ));
        // Cross-origin and spoofed-host mismatches are refused.
        assert!(!origin_matches_host(
            "https://evil.example",
            Some("luna.local")
        ));
        // An explicit port differs from a portless Host — same rule as
        // Luna Connect's originGuard (plain authority comparison).
        assert!(!origin_matches_host("https://host:443", Some("host")));
        // Garbage and scheme-less origins fail closed; browsers always send
        // a scheme, so legitimate clients keep working.
        assert!(!origin_matches_host("not a url", Some("luna.local")));
        assert!(!origin_matches_host("luna.local", Some("luna.local")));
        assert!(!origin_matches_host("", Some("luna.local")));
        // No Host at all fails closed.
        assert!(!origin_matches_host("https://luna.local", None));
    }

    #[test]
    fn basic_auth_reads_token_from_password_or_username() {
        fn header(user: &str, password: &str) -> HeaderMap {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
            let mut h = HeaderMap::new();
            h.insert(
                axum::http::header::AUTHORIZATION,
                format!("Basic {encoded}").parse().unwrap(),
            );
            h
        }
        assert_eq!(
            token_from_headers(&header("max", "device-token-abc")).as_deref(),
            Some("device-token-abc")
        );
        assert_eq!(
            token_from_headers(&header("device-token-abc", "")).as_deref(),
            Some("device-token-abc")
        );
        assert!(token_from_headers(&header("", "")).is_none());
    }

    #[test]
    fn username_is_normalized_and_unique() {
        let (_dir, auth) = service();
        auth.register("Max", "Max", "hunter22hunter1", "user")
            .unwrap();
        assert!(matches!(
            auth.register("MAX", "Other", "hunter22hunter1", "user"),
            Err(AuthError::Taken)
        ));
        assert!(
            auth.register("x", "Bad", "hunter22hunter1", "user")
                .is_err()
        );
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
        let connect = std::sync::Arc::new(crate::connect::ConnectService::new(
            dir.path(),
            Some("http://127.0.0.1:1".into()),
        ));
        let state = crate::AppState::new(conn, drive_manager, dir.path()).with_connect(connect);
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
            .with_state(state);
        (dir, app)
    }

    fn req(method: Method, uri: &str, body: Option<&str>, cookie: Option<&str>) -> HttpReq<Body> {
        req_with_csrf(method, uri, body, cookie, None)
    }

    fn req_with_csrf(
        method: Method,
        uri: &str,
        body: Option<&str>,
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
        let mut http = builder
            .body(Body::from(body.map(|b| b.to_string()).unwrap_or_default()))
            .unwrap();
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

    fn cookie_header(session: &str, csrf: &str) -> String {
        if csrf.is_empty() {
            session.to_string()
        } else {
            format!("{session}; luna_csrf={csrf}")
        }
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
                Some(r#"{"username":"max","display_name":"Max","password":"hunter22hunter1"}"#),
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
                Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "login failed: {}", text(res).await);
        let (session, _csrf) = auth_cookies(&res);
        assert!(
            session.starts_with("luna_session="),
            "login must set session cookie, got {:?}",
            res.headers()
                .get_all(axum::http::header::SET_COOKIE)
                .iter()
                .map(|v| v.to_str().unwrap_or(""))
                .collect::<Vec<_>>()
        );

        // The session must be visible to /auth/me — this is what keeps the
        // web UI signed in after setup and across page reloads.
        let res = call(
            &app,
            req(Method::GET, "/api/v1/auth/me", None, Some(&session)),
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
                Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
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
                Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
                None,
            ),
        )
        .await;
        let (session, csrf) = auth_cookies(&res);
        let cookie = cookie_header(&session, &csrf);

        // Anonymous second account -> sign in first.
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"sam","password":"hunter22hunter1"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 401);

        // A signed-in admin can add a household member.
        let res = call(
            &app,
            req_with_csrf(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"sam","password":"hunter22hunter1"}"#),
                Some(&cookie),
                Some(&csrf),
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

    #[tokio::test]
    async fn setup_post_requires_admin_once_an_account_exists() {
        let (_dir, app) = test_app();
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"name":"Kitchen"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(
            res.status(),
            200,
            "first-run setup is open: {}",
            text(res).await
        );

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"setup_completed":false}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 401);

        let get = call(&app, req(Method::GET, "/api/v1/setup", None, None)).await;
        assert_eq!(get.status(), 401);
    }

    #[tokio::test]
    async fn network_status_public_while_setup_incomplete_even_with_user() {
        let (_dir, app) = test_app();

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/register",
                Some(r#"{"username":"devadmin","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "register failed: {}", text(res).await);

        let res = call(&app, req(Method::GET, "/api/v1/network/status", None, None)).await;
        assert_eq!(
            res.status(),
            200,
            "network status must stay public during setup: {}",
            text(res).await
        );
        let v: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
        assert!(v.get("ethernet_connected").is_some());

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"setup_completed":true}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 401);

        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/auth/login",
                Some(r#"{"username":"devadmin","password":"hunter22hunter"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200);
        let (session, csrf) = auth_cookies(&res);
        let cookie = cookie_header(&session, &csrf);

        // The CSRF guard (added after this test was written) requires the
        // double-submit token on cookie-authenticated mutations — pass it.
        let res = call(
            &app,
            req_with_csrf(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"setup_completed":true}"#),
                Some(&cookie),
                Some(&csrf),
            ),
        )
        .await;
        assert_eq!(res.status(), 200);

        let res = call(&app, req(Method::GET, "/api/v1/network/status", None, None)).await;
        assert_eq!(
            res.status(),
            401,
            "network status requires a session after setup: {}",
            text(res).await
        );
    }

    #[tokio::test]
    async fn setup_progress_saves_and_resumes_before_account() {
        let (_dir, app) = test_app();
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"current_step":"network","step_data":{"network_connected":false}}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "{}", text(res).await);

        let get = call(&app, req(Method::GET, "/api/v1/setup", None, None)).await;
        assert_eq!(get.status(), 200);
        let body: serde_json::Value = serde_json::from_str(&text(get).await).unwrap();
        assert_eq!(body["current_step"], "network");
        assert_eq!(body["step_data"]["network_connected"], false);
        assert_eq!(body["setup_completed"], false);
    }

    #[tokio::test]
    async fn setup_progress_rejects_unknown_step() {
        let (_dir, app) = test_app();
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(r#"{"current_step":"smtp"}"#),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 400);
    }

    #[tokio::test]
    async fn completing_setup_clears_step_data() {
        let (_dir, app) = test_app();
        let res = call(
            &app,
            req(
                Method::POST,
                "/api/v1/setup",
                Some(
                    r#"{"current_step":"name","step_data":{"account_completed":true},"name":"Kitchen","setup_completed":true}"#,
                ),
                None,
            ),
        )
        .await;
        assert_eq!(res.status(), 200, "{}", text(res).await);
        let body: serde_json::Value = serde_json::from_str(&text(res).await).unwrap();
        assert_eq!(body["setup_completed"], true);
        assert_eq!(body["current_step"], "done");
        assert_eq!(body["name"], "Kitchen");
        assert!(body["step_data"].as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn first_account_on_public_hostname_needs_setup_secret() {
        let (dir, _) = test_app();
        let connect =
            crate::connect::ConnectService::new(dir.path(), Some("http://127.0.0.1:1".into()));
        connect
            .apply_claimed(&serde_json::json!({
                "device_token": "tok",
                "hostname": "photos.luna.servers.libreloom.org",
                "tunnel_token": "mock",
                "setup_secret": "one-time-secret"
            }))
            .unwrap();
        let connect = std::sync::Arc::new(connect);
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state =
            crate::AppState::new(conn, drive_manager, dir.path()).with_connect(connect.clone());
        let app = api::router()
            .layer(axum::middleware::from_fn_with_state(state.clone(), guard))
            .with_state(state);

        let mut denied = req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        );
        denied
            .headers_mut()
            .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
        let res = call(&app, denied).await;
        assert_eq!(res.status(), 403, "{}", text(res).await);

        let mut via_query = req(
            Method::POST,
            "/api/v1/auth/register?setup=one-time-secret",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        );
        via_query
            .headers_mut()
            .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
        let res = call(&app, via_query).await;
        assert_eq!(
            res.status(),
            403,
            "setup secret in the URL must not pass: {}",
            text(res).await
        );

        let mut via_cookie = req(
            Method::POST,
            "/api/v1/auth/register",
            Some(r#"{"username":"max","password":"hunter22hunter1"}"#),
            None,
        );
        via_cookie
            .headers_mut()
            .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
        via_cookie
            .headers_mut()
            .insert("cookie", "luna_setup=one-time-secret".parse().unwrap());
        let res = call(&app, via_cookie).await;
        assert_eq!(
            res.status(),
            403,
            "setup secret in a cookie must not pass: {}",
            text(res).await
        );

        let mut ok = req(
            Method::POST,
            "/api/v1/auth/register",
            Some(
                r#"{"username":"max","password":"hunter22hunter1","setup_secret":"one-time-secret"}"#,
            ),
            None,
        );
        ok.headers_mut()
            .insert("host", "photos.luna.servers.libreloom.org".parse().unwrap());
        let res = call(&app, ok).await;
        assert_eq!(res.status(), 200, "{}", text(res).await);
        assert!(
            connect.first_user_secret().is_none(),
            "first-user secret must be one-time"
        );
    }

    #[tokio::test]
    async fn cross_origin_unsafe_requests_are_blocked() {
        let (_dir, app) = test_app();

        // Mismatched Origin on an unsafe method is refused before any auth
        // logic runs — this also covers login CSRF, since auth paths are just
        // as cookie-exposed as the data API.
        let mut r = req(Method::POST, "/api/v1/auth/login", Some("{}"), None);
        r.headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        r.headers_mut()
            .insert("host", "luna.local".parse().unwrap());
        let res = call(&app, r).await;
        assert_eq!(res.status(), 403, "cross-origin POST must be refused");

        // Same authority (scheme may differ, explicit port must match) makes
        // it through the guard and into the handler.
        let mut r = req(Method::POST, "/api/v1/auth/login", Some("{}"), None);
        r.headers_mut()
            .insert("origin", "http://luna.local".parse().unwrap());
        r.headers_mut()
            .insert("host", "luna.local".parse().unwrap());
        let res = call(&app, r).await;
        assert_ne!(res.status(), 403, "same-origin POST must reach the handler");

        // Unsafe method without any Origin (curl, device tokens, WebDAV)
        // passes through untouched.
        let res = call(
            &app,
            req(Method::POST, "/api/v1/auth/login", Some("{}"), None),
        )
        .await;
        assert_ne!(res.status(), 403, "Origin-less POST must reach the handler");

        // Safe methods are never Origin-checked.
        let res = call(&app, req(Method::GET, "/api/v1/auth/me", None, None)).await;
        assert_eq!(res.status(), 200);
    }
}
