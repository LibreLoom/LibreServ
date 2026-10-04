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

/// Short-lived bridge token for Document Server file fetch/save.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeClaims {
    pub typ: String,
    pub sub: String,
    pub drive_id: String,
    pub path: String,
    pub write: bool,
    pub exp: i64,
    /// Bundle key this token may serve — set on scoped session tokens so a
    /// token minted for one document can't read or write another's bundle.
    #[serde(default)]
    pub key: Option<String>,
    /// Per-open bundle credential path — two opens sharing one document key
    /// get different bundle URLs and cookie paths.
    #[serde(default)]
    pub bundle_id: Option<String>,
    /// Share link this token was minted through (guest sessions).
    #[serde(default)]
    pub link_id: Option<String>,
    /// blake3 of the link's password hash at mint time — rotating or removing
    /// the password invalidates every outstanding guest office token.
    #[serde(default)]
    pub link_revision: Option<String>,
}

/// Proof that a guest supplied a password-protected link's password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkClaims {
    pub typ: String,
    pub lid: String,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceTokenContext {
    pub token_id: String,
    pub last_used_at: i64,
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
    #[error("Only an Admin can do that.")]
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
    db: Arc<crate::Db>,
    secret: Arc<Mutex<Vec<u8>>>,
    data_dir: std::path::PathBuf,
}

impl AuthService {
    pub fn new(db: Arc<crate::Db>, secret: Vec<u8>, data_dir: std::path::PathBuf) -> Self {
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
        if let Err(err) = crate::hibp::ensure_password_not_breached(password) {
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
    pub fn resolve_auth_from_headers(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<(CurrentUser, Option<DeviceTokenContext>)>, AuthError> {
        let Some(raw) = token_from_headers(headers) else {
            return Ok(None);
        };
        if let Ok(user) = self.verify(&raw) {
            return Ok(Some((user, None)));
        }
        if let Ok(Some((user, dt_ctx))) = self.verify_device_token_ctx(&raw) {
            return Ok(Some((user, Some(dt_ctx))));
        }
        Ok(None)
    }

    pub fn resolve_from_headers(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<CurrentUser>, AuthError> {
        self.resolve_auth_from_headers(headers)
            .map(|opt| opt.map(|(u, _)| u))
    }

    /// Resolve a device token context without immediately recording generic activity.
    pub fn verify_device_token_ctx(
        &self,
        token: &str,
    ) -> Result<Option<(CurrentUser, DeviceTokenContext)>, AuthError> {
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
        Ok(Some((
            CurrentUser {
                id: user.id.clone(),
                username: user.username.clone(),
                role: user.role.clone(),
            },
            DeviceTokenContext {
                token_id: dt.id,
                last_used_at: dt.last_used_at,
            },
        )))
    }

    /// Resolve a device token (from `Authorization: Bearer <token>`). Device
    /// tokens share the same surface as session JWTs but are stored by their
    /// blake3 hash in SQLite and can be revoked without touching the user's
    /// password. Returns None when the token is unknown.
    pub fn verify_device_token(
        &self,
        token: &str,
    ) -> Result<Option<(CurrentUser, String)>, AuthError> {
        let res = self.verify_device_token_ctx(token)?;
        if let Some((_, dt_ctx)) = &res
            && let Ok(conn) = self.db.lock()
        {
            let _ = db::note_device_token_activity(&conn, &dt_ctx.token_id, dt_ctx.last_used_at);
        }
        Ok(res.map(|(user, dt_ctx)| (user, dt_ctx.token_id)))
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

    /// Mint a short-lived token for Document Server to fetch/save a file.
    pub fn issue_office_token(
        &self,
        user_id: &str,
        drive_id: &str,
        path: &str,
        write: bool,
        ttl_secs: i64,
    ) -> Result<String, AuthError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let claims = OfficeClaims {
            typ: "luna_office".into(),
            sub: user_id.to_string(),
            drive_id: drive_id.to_string(),
            path: path.to_string(),
            write,
            exp: now + ttl_secs.max(60),
            key: None,
            bundle_id: None,
            link_id: None,
            link_revision: None,
        };
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(&self.signing_key()),
        )
        .map_err(|e| AuthError::Token(e.to_string()))
    }

    /// Mint an office token carrying its full scope (bundle key, link id,
    /// password revision). Used by the session endpoints so every bundle and
    /// socket check can re-validate against the *current* grant.
    pub fn issue_scoped_office_token(
        &self,
        mut claims: OfficeClaims,
        ttl_secs: i64,
    ) -> Result<String, AuthError> {
        claims.typ = "luna_office".into();
        claims.exp = crate::db::now_unix() + ttl_secs.max(1);
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(&self.signing_key()),
        )
        .map_err(|e| AuthError::Token(e.to_string()))
    }

    /// Validate an office bridge token from Document Server.
    pub fn verify_office_token(&self, token: &str) -> Result<OfficeClaims, AuthError> {
        let data = jsonwebtoken::decode::<OfficeClaims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(&self.signing_key()),
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        )
        .map_err(|e| AuthError::Token(e.to_string()))?;
        if data.claims.typ != "luna_office" {
            return Err(AuthError::Token("wrong token type".into()));
        }
        if data.claims.drive_id.trim().is_empty() || data.claims.path.trim().is_empty() {
            return Err(AuthError::Token("incomplete office token".into()));
        }
        Ok(data.claims)
    }

    /// Mint a proof that a guest supplied a share link's password. The SPA
    /// stores it in a `luna_link_<id>` cookie so <img>/<a> media requests —
    /// which cannot set headers — stay authenticated for its TTL.
    pub fn issue_link_proof(&self, link_id: &str, ttl_secs: i64) -> Result<String, AuthError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let claims = LinkClaims {
            typ: "luna_link".into(),
            lid: link_id.to_string(),
            exp: now + ttl_secs.max(60),
        };
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(&self.signing_key()),
        )
        .map_err(|e| AuthError::Token(e.to_string()))
    }

    /// True when `proof` is a live link-proof token minted for `link_id`.
    pub fn verify_link_proof(&self, link_id: &str, proof: &str) -> bool {
        let Ok(data) = jsonwebtoken::decode::<LinkClaims>(
            proof,
            &jsonwebtoken::DecodingKey::from_secret(&self.signing_key()),
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        ) else {
            return false;
        };
        data.claims.typ == "luna_link" && data.claims.lid == link_id
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
        // The person's private folders stay on their drives, walled off from
        // everyone. An Admin clears them later from Users → Private folders.
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
    /// Local-console recovery only: set a new password for an admin by
    /// username. Never exposed on the network. Does **not** enforce the
    /// normal password policy — recovery is headless and should accept
    /// whatever the user types so they can get back in.
    pub fn reset_user_password(
        &self,
        username: &str,
        password: &str,
    ) -> Result<UserRow, AuthError> {
        if password.is_empty() {
            return Err(AuthError::PasswordPolicy(
                "Password cannot be empty.".into(),
            ));
        }
        let hash = hash_password_unchecked(password)?;
        let username = username.trim().to_lowercase();
        let conn = self
            .db
            .lock()
            .map_err(|_| AuthError::Db(anyhow::anyhow!("db busy")))?;

        let user = if username.is_empty() {
            let admins = db::list_admins(&conn).map_err(AuthError::Db)?;
            match admins.len() {
                0 => {
                    return Err(AuthError::PasswordPolicy(
                        "No admin accounts have been created yet. Complete setup in your browser first.".into(),
                    ));
                }
                1 => admins.into_iter().next().unwrap(),
                _ => {
                    let names = admins
                        .iter()
                        .map(|a| a.username.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(AuthError::PasswordPolicy(format!(
                        "Multiple admin accounts exist. Specify one: {names}"
                    )));
                }
            }
        } else {
            match db::get_user_by_username(&conn, &username).map_err(AuthError::Db)? {
                Some(u) if u.role == "admin" => u,
                Some(_) => {
                    return Err(AuthError::PasswordPolicy(format!(
                        "'{username}' is a standard user, not an admin. Only an admin password can be reset this way."
                    )));
                }
                None => {
                    let admins = db::list_admins(&conn).map_err(AuthError::Db)?;
                    if admins.is_empty() {
                        return Err(AuthError::PasswordPolicy(
                            "No admin accounts have been created yet. Complete setup in your browser first.".into(),
                        ));
                    }
                    let names = admins
                        .iter()
                        .map(|a| a.username.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(AuthError::PasswordPolicy(format!(
                        "No admin account named '{username}'. Admin accounts on this Luna: {names}"
                    )));
                }
            }
        };

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
        if let Err(err) = crate::hibp::ensure_password_not_breached(password) {
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
    // Only an absent Authorization header means cookie auth — Bearer AND
    // Basic (WebDAV clients) are non-browser credentials that send no CSRF
    // cookie and must not fail the double-submit check.
    headers.get(axum::http::header::AUTHORIZATION).is_none()
        && token_from_headers(headers).is_some()
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
/// false or unset).
pub fn setup_wizard_open_conn(conn: &rusqlite::Connection) -> bool {
    let completed = crate::db::get_meta(conn, "setup")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("setup_completed").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    !completed
}

/// Used to keep network/connect endpoints reachable during setup even when a dev
/// database already has an account.
pub(crate) fn setup_wizard_open(state: &AppState) -> bool {
    let Ok(conn) = state.db.lock() else {
        return false;
    };
    setup_wizard_open_conn(&conn)
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
    let path = req.uri().path().to_string();
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
            return json_error(
                StatusCode::FORBIDDEN,
                "Luna blocked this request because it came from another website.",
            )
            .into_response();
        }
    }
    let mut is_public = path == "/health"
        || path == "/api/v1/health"
        || path.starts_with("/api/v1/auth/")
        || path.starts_with("/api/v1/setup")
        || path.starts_with("/api/v1/public/")
        || path.starts_with("/s/")
        || !path.starts_with("/api/");
    if !is_public && path.starts_with("/api/v1/network/") {
        let wizard_open = state.auth.count_users().unwrap_or(1) == 0 || setup_wizard_open(&state);
        is_public = wizard_open;
    }
    if !is_public && (path == "/api/v1/connect/status" || path == "/api/v1/connect/device-token") {
        let wizard_open = state.auth.count_users().unwrap_or(1) == 0 || setup_wizard_open(&state);
        is_public = wizard_open;
    }

    // Prefer the session JWT; fall back to a device token so the mobile and
    // desktop clients can authenticate with a revocable, long-lived token.
    let mut req = req;
    if let Ok(Some((user, device_token_ctx))) = state.auth.resolve_auth_from_headers(req.headers())
    {
        req.extensions_mut().insert(user);
        if let Some(token_ctx) = device_token_ctx {
            let client = client_app_name(req.headers());
            let addr = req
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|c| c.0);
            let origin = client_origin_label(addr.as_ref(), req.headers(), state.connect.wan_ip());
            let (action, detail) = categorize_api_request(&method, &path);

            if let Ok(conn) = state.db.lock() {
                let _ = crate::db::note_device_token_activity_rich(
                    &conn,
                    &token_ctx.token_id,
                    token_ctx.last_used_at,
                    &action,
                    &detail,
                    &client,
                    &origin,
                );
            }
        }
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

pub fn client_app_name(headers: &HeaderMap) -> String {
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();

    if ua.is_empty() {
        return "App or script".to_string();
    }

    let ua_lower = ua.to_ascii_lowercase();

    if ua_lower.contains("webdavfs") || ua_lower.contains("darwin") {
        return "macOS Finder".to_string();
    }
    if ua_lower.contains("microsoft-webdav")
        || ua_lower.contains("microsoft-server-activesync")
        || ua_lower.contains("miniredir")
    {
        return "Windows Explorer".to_string();
    }
    if ua_lower.contains("gvfs") || ua_lower.contains("gio") {
        return "Linux Files (GNOME)".to_string();
    }
    if ua_lower.contains("lunadesktop")
        || ua_lower.contains("luna-desktop")
        || ua_lower.contains("luna desktop")
        || ua_lower.contains("ureq")
    {
        return "Luna Desktop".to_string();
    }
    if ua_lower.contains("luna-android")
        || (ua_lower.contains("luna") && ua_lower.contains("android"))
    {
        return "Luna for Android".to_string();
    }
    if ua_lower.contains("luna-ios")
        || (ua_lower.contains("luna") && (ua_lower.contains("iphone") || ua_lower.contains("ipad")))
    {
        return "Luna for iOS".to_string();
    }
    if ua_lower.contains("cyberduck") {
        return "Cyberduck".to_string();
    }
    if ua_lower.contains("rclone") {
        return "rclone".to_string();
    }
    if ua_lower.contains("curl") {
        return "curl".to_string();
    }
    if ua_lower.contains("python") {
        return "Python script".to_string();
    }

    if ua.len() <= 32 && ua.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
        return ua.to_string();
    }

    "App or script".to_string()
}

pub fn client_origin_label(
    addr: Option<&std::net::SocketAddr>,
    headers: &HeaderMap,
    local_wan: Option<std::net::IpAddr>,
) -> String {
    let mut ip_opt = None;
    if let Some(ip) = headers
        .get("cf-connecting-ip")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
    {
        ip_opt = Some(ip);
    } else if let Some(ip) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .and_then(|s| s.trim().parse::<std::net::IpAddr>().ok())
    {
        ip_opt = Some(ip);
    } else if let Some(a) = addr {
        ip_opt = Some(a.ip());
    }

    let is_tunnel = headers.get("cf-connecting-ip").is_some()
        || headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .map(|h| h.contains(".luna.servers.libreloom.org"))
            .unwrap_or(false);

    match ip_opt {
        Some(ip) => {
            let private = match ip {
                std::net::IpAddr::V4(v4) => {
                    v4.is_loopback() || v4.is_private() || v4.is_link_local()
                }
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00
                }
            };
            let matches_local_wan = local_wan.map(|w| w == ip).unwrap_or(false);

            if is_tunnel {
                if matches_local_wan {
                    format!("Home network (via Connect tunnel · {ip})")
                } else if private {
                    format!("Home network ({ip})")
                } else {
                    format!("Remote via Connect ({ip})")
                }
            } else if private || matches_local_wan {
                format!("Home network ({ip})")
            } else {
                format!("Remote ({ip})")
            }
        }
        None => {
            if is_tunnel {
                "Remote via Connect".to_string()
            } else {
                "Home network".to_string()
            }
        }
    }
}

pub fn categorize_api_request(method: &axum::http::Method, path: &str) -> (String, String) {
    if path.starts_with("/api/v1/uploads") {
        return ("File upload".to_string(), "Uploaded files".to_string());
    }
    if path.starts_with("/api/v1/gallery") {
        if *method == axum::http::Method::POST || *method == axum::http::Method::PUT {
            return ("Photos".to_string(), "Uploaded photos".to_string());
        }
        return ("Photos".to_string(), "Browsed photos".to_string());
    }
    if path.starts_with("/api/v1/files") {
        if path.ends_with("/content") || path.ends_with("/download") {
            return ("File download".to_string(), "Downloaded file".to_string());
        }
        if *method == axum::http::Method::POST || *method == axum::http::Method::PUT {
            return ("File upload".to_string(), "Uploaded file".to_string());
        }
        if *method == axum::http::Method::DELETE {
            return ("File changes".to_string(), "Deleted file".to_string());
        }
        return ("Files".to_string(), "Browsed files".to_string());
    }
    if path.starts_with("/api/v1/search") {
        return ("Search".to_string(), "Searched files".to_string());
    }
    if path.starts_with("/api/v1/drives") {
        return ("Drives check".to_string(), "Checked drives".to_string());
    }
    ("API access".to_string(), "".to_string())
}

/// The user's effective capability bits on `drive_id`/`path`.
///
/// Admins hold everything. Path members match the exact path or anything
/// beneath it (`member = "family"` allows `family/photos`). After the lexical
/// check, the canonical path must still sit under the (canonical) member
/// prefix so a symlink inside the granted folder cannot walk the rest of
/// the drive.
pub fn caps_on_path(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
) -> crate::access::Caps {
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point);
    // Trash paths inherit the grants of where the item came from — the same
    // origin-ACL model the trash listing uses to decide what a member may
    // see or change. An entry with no metadata maps to nothing and grants
    // on `.luna-trash` itself never exist, so it simply gets no caps.
    let origin;
    let path = if crate::files::is_trash_api(path) {
        // A private item in the trash answers to its own owner and never to
        // the Admin role — whether a live row says so (the item itself was
        // private) or its trash_meta provenance does (it was an ordinary
        // child deleted from inside a private folder, whose boundary may
        // since have moved or vanished).
        if let Some(b) = private_boundary(mount.as_deref(), path) {
            let rows = db::list_access_members_for_user(conn, &user.id).unwrap_or_default();
            return private_caps(user, &rows, drive_id, path, &b, &|o| {
                crate::private::owner_state(conn, o)
            });
        }
        if let Ok(Some(meta)) = crate::files::trash_private_meta(conn, drive_id, path) {
            let rows = db::list_access_members_for_user(conn, &user.id).unwrap_or_default();
            let b = crate::private::Boundary {
                path: meta.private_path,
                owner: meta.private_owner,
            };
            return private_caps(user, &rows, drive_id, path, &b, &|o| {
                crate::private::owner_state(conn, o)
            });
        }
        match crate::files::trash_original_path(conn, drive_id, path) {
            Ok(Some(o)) => {
                origin = o;
                origin.as_str()
            }
            _ => path,
        }
    } else {
        path
    };
    if let Some(b) = private_boundary(mount.as_deref(), path) {
        let rows = db::list_access_members_for_user(conn, &user.id).unwrap_or_default();
        return private_caps(user, &rows, drive_id, path, &b, &|o| {
            crate::private::owner_state(conn, o)
        });
    }
    if user.role == "admin" {
        return crate::access::CAP_MANAGE;
    }
    member_row_caps(user, conn, drive_id, path, mount.as_deref())
}

/// The nearest private item at or above `path`, if the drive has any.
fn private_boundary(mount: Option<&str>, path: &str) -> Option<crate::private::Boundary> {
    let root = std::path::Path::new(mount?);
    let norm = crate::access::normalize_subject_path(path);
    let real = crate::files::real_rel(root, &norm);
    crate::private::boundary_for(root, &real)
}

/// Access inside a private item: the owner holds everything; anyone else
/// only what grant rows between the boundary and the target give them. Grants
/// above the boundary and the Admin role do not reach in.
fn private_caps(
    user: &CurrentUser,
    rows: &[db::AccessMemberRow],
    drive_id: &str,
    path: &str,
    b: &crate::private::Boundary,
    owner_known: &dyn Fn(&str) -> crate::private::OwnerState,
) -> crate::access::Caps {
    if b.owner == crate::private::SEALED
        || owner_known(&b.owner) == crate::private::OwnerState::Deleted
    {
        return 0;
    }
    if b.owner == user.id {
        return crate::access::CAP_MANAGE;
    }
    // Nobody here owns it (it came from another Luna): an Admin can reach
    // it, to give it to someone.
    if user.role == "admin" && owner_known(&b.owner) == crate::private::OwnerState::Foreign {
        return crate::access::CAP_MANAGE;
    }
    let path = crate::access::normalize_subject_path(path);
    rows.iter()
        .filter(|r| r.subject_kind == crate::access::KIND_PATH && r.drive_id == drive_id)
        .filter(|r| {
            let row = crate::access::normalize_subject_path(&r.path);
            crate::access::path_contains(&row, &path) && crate::access::path_contains(&b.path, &row)
        })
        .fold(0, |caps, r| caps | r.caps)
}

/// Does `path` hold private items this user may not change? Deleting or
/// moving such a folder would destroy or carry someone else's items.
pub fn holds_unreachable_private(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
) -> bool {
    let Some(mount) = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point)
    else {
        return false;
    };
    let root = std::path::Path::new(&mount);
    let norm = crate::access::normalize_subject_path(path);
    let real = crate::files::real_rel(root, &norm);
    crate::private::under(root, &real)
        .iter()
        .any(|item| !has_cap(user, conn, drive_id, &item.path, crate::access::CAP_EDIT))
}

/// Does a private item with an owner sit at or above `norm`? That is the
/// wall the Admin role does not cross.
fn walls_off_admin(conn: &Connection, drive_id: &str, norm: &str) -> bool {
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point);
    private_boundary(mount.as_deref(), norm)
        .is_some_and(|b| crate::private::owner_known(conn, &b.owner))
}

/// Is `norm` a private item, or inside one? For trash paths, recorded
/// provenance counts too: a child deleted out of a private folder stays
/// private even after the folder's row is gone.
pub fn inside_private(conn: &Connection, drive_id: &str, norm: &str) -> bool {
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point);
    if private_boundary(mount.as_deref(), norm).is_some() {
        return true;
    }
    crate::files::is_trash_api(norm)
        && crate::files::trash_private_meta(conn, drive_id, norm)
            .ok()
            .flatten()
            .is_some()
}

/// [`caps_on_path`] with the caller's member rows already fetched — for
/// stamping capabilities onto a whole listing without one user-row query
/// per entry. `path` is a plain rel (no `.luna-trash` alias mapping).
pub fn caps_on_path_rows(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    rows: &[db::AccessMemberRow],
) -> crate::access::Caps {
    let mount = drive_mount(conn, drive_id);
    caps_on_path_rows_at(user, conn, drive_id, path, rows, mount.as_deref())
}

/// [`caps_on_path_rows`] with the drive's mount point already looked up too.
fn caps_on_path_rows_at(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    rows: &[db::AccessMemberRow],
    mount: Option<&str>,
) -> crate::access::Caps {
    if let Some(b) = private_boundary(mount, path) {
        return private_caps(user, rows, drive_id, path, &b, &|o| {
            crate::private::owner_state(conn, o)
        });
    }
    if user.role == "admin" {
        return crate::access::CAP_MANAGE;
    }
    member_row_caps_rows(rows, drive_id, path, mount)
}

fn drive_mount(conn: &Connection, drive_id: &str) -> Option<String> {
    db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point)
}

fn member_row_caps(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    mount: Option<&str>,
) -> crate::access::Caps {
    let Ok(rows) = db::list_access_members_for_user(conn, &user.id) else {
        return 0;
    };
    member_row_caps_rows(&rows, drive_id, path, mount)
}

/// `rows` must already belong to the user (the caller fetched
/// `list_access_members_for_user` once for a batch).
fn member_row_caps_rows(
    rows: &[db::AccessMemberRow],
    drive_id: &str,
    path: &str,
    mount: Option<&str>,
) -> crate::access::Caps {
    let mut caps: crate::access::Caps = 0;
    for row in rows {
        if row.subject_kind != crate::access::KIND_PATH || row.drive_id != drive_id {
            continue;
        }
        if !crate::access::path_contains(&row.path, path) {
            continue;
        }
        let covers = match mount {
            Some(root) => grant_covers_canonical(
                root,
                &crate::access::normalize_subject_path(&row.path),
                &crate::access::normalize_subject_path(path),
            ),
            None => true,
        };
        if covers {
            caps |= row.caps;
        }
    }
    caps
}

/// True when the user holds every capability bit in `cap` on this path.
pub fn has_cap(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    cap: crate::access::Caps,
) -> bool {
    caps_on_path(user, conn, drive_id, path) & cap == cap
}

/// Back-compat boolean form: `write = false` needs CAP_VIEW, `true` needs
/// CAP_EDIT (rename/delete/move — the destructive half of "full access").
pub fn can_access(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    write: bool,
) -> bool {
    has_cap(
        user,
        conn,
        drive_id,
        path,
        if write {
            crate::access::CAP_EDIT
        } else {
            crate::access::CAP_VIEW
        },
    )
}

fn grant_covers_canonical(root: &str, grant_rel: &str, request_rel: &str) -> bool {
    use crate::files::resolve_child;
    use luna_core::path::is_under_prefix;
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
            // Upload/create: the request may span several missing folders, so
            // resolve the nearest existing ancestor — everything below it is
            // created fresh and cannot be a pre-existing symlink escape.
            let mut rel = request_rel;
            loop {
                rel = std::path::Path::new(rel)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or_default();
                match resolve_child(root, rel) {
                    Ok(p) => break p,
                    Err(luna_core::path::PathError::NotFound(_)) if !rel.is_empty() => continue,
                    Err(_) => return false,
                }
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
    if !owned_private_paths(conn, &user.id, drive_id).is_empty() {
        return true;
    }
    let Ok(rows) = db::list_access_members_for_user(conn, &user.id) else {
        return false;
    };
    rows.iter()
        .any(|r| r.subject_kind == crate::access::KIND_PATH && r.drive_id == drive_id)
}

/// Real paths of the private items this person owns on a drive. Owning one
/// is a way into the drive even with no folder shared with them.
pub(crate) fn owned_private_paths(conn: &Connection, user_id: &str, drive_id: &str) -> Vec<String> {
    let Some(mount) = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .filter(|d| !d.mount_point.is_empty())
        .map(|d| d.mount_point)
    else {
        return Vec::new();
    };
    crate::private::under(std::path::Path::new(&mount), "")
        .into_iter()
        .filter(|i| i.owner == user_id)
        .map(|i| i.path)
        .collect()
}

/// True if the user may change anything on this drive (upload or edit,
/// whole drive or a folder).
pub fn has_write_on_drive(user: &CurrentUser, conn: &Connection, drive_id: &str) -> bool {
    if user.role == "admin" {
        return true;
    }
    if !owned_private_paths(conn, &user.id, drive_id).is_empty() {
        return true;
    }
    let Ok(rows) = db::list_access_members_for_user(conn, &user.id) else {
        return false;
    };
    rows.iter().any(|r| {
        r.subject_kind == crate::access::KIND_PATH
            && r.drive_id == drive_id
            && r.caps & (crate::access::CAP_UPLOAD | crate::access::CAP_EDIT) != 0
    })
}

/// True if WebDAV (or a file browser) may list/walk `path` on this drive.
///
/// Broader than [`can_access`]: a member row on `family/photos` lets the user
/// walk `""` → `family` → `family/photos` so Finder can reach the granted
/// folder. Sibling folders outside the member's scope stay hidden. Writes
/// still use capability checks.
pub fn can_browse_path(user: &CurrentUser, conn: &Connection, drive_id: &str, path: &str) -> bool {
    let norm = crate::access::normalize_subject_path(path);
    if can_access(user, conn, drive_id, &norm, false) {
        return true;
    }
    if user.role == "admin" && !walls_off_admin(conn, drive_id, &norm) {
        return true;
    }
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .map(|d| d.mount_point);
    if private_boundary(mount.as_deref(), &norm).is_some_and(|b| {
        crate::private::owner_state(conn, &b.owner) == crate::private::OwnerState::Deleted
    }) {
        return false;
    }
    // The way down to a private item you own stays open.
    if owned_private_paths(conn, &user.id, drive_id)
        .iter()
        .any(|p| crate::access::path_contains(&norm, p))
    {
        return true;
    }
    let Ok(rows) = db::list_access_members_for_user(conn, &user.id) else {
        return false;
    };
    browse_rows_walk(drive_id, &norm, &rows)
}

/// The row-walk half of [`can_browse_path`]: may any `CAP_VIEW` row on this
/// drive see `norm`, directly or as an ancestor of the grant?
fn browse_rows_walk(drive_id: &str, norm: &str, rows: &[db::AccessMemberRow]) -> bool {
    rows.iter().any(|r| {
        if r.subject_kind != crate::access::KIND_PATH || r.drive_id != drive_id {
            return false;
        }
        // Upload-only rows are browse-blind: PUT lands on a known path, but
        // nothing under or above the grant opens for walking.
        if r.caps & crate::access::CAP_VIEW == 0 {
            return false;
        }
        let member_path = crate::access::normalize_subject_path(&r.path);
        // A whole-drive view row was already handled by the caps check;
        // reaching here it covers nothing extra.
        if member_path.is_empty() {
            return norm.is_empty();
        }
        // Empty path is the drive root — always an ancestor of any member row.
        if norm.is_empty() {
            return true;
        }
        // path is a proper prefix of the member's scope (ancestor walk).
        crate::access::path_contains(norm, &member_path)
    })
}

/// [`caps_on_path`] for batch evaluators (DAV PROPFIND) that preload the
/// per-request context once instead of re-reading the member rows and the
/// drive row for every entry.
///
/// `path` is a raw drive-relative path; unlike [`caps_on_path`] no
/// `.luna-trash` origin remap runs — callers on raw rels don't need it.
pub fn caps_on_path_preloaded(
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
    rows: &[db::AccessMemberRow],
    mount: Option<&str>,
    owner_known: &dyn Fn(&str) -> crate::private::OwnerState,
) -> crate::access::Caps {
    if let Some(b) = private_boundary(mount, path) {
        return private_caps(user, rows, drive_id, path, &b, owner_known);
    }
    if user.role == "admin" {
        return crate::access::CAP_MANAGE;
    }
    member_row_caps_rows(rows, drive_id, path, mount)
}

/// [`can_browse_path`] with the per-request context preloaded — see
/// [`caps_on_path_preloaded`]. `caps` must be the result of evaluating
/// [`caps_on_path_preloaded`] (or [`caps_on_path`]) on the same path.
#[allow(clippy::too_many_arguments)]
pub fn can_browse_path_preloaded(
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
    caps: crate::access::Caps,
    rows: &[db::AccessMemberRow],
    owned: &[String],
    mount: Option<&str>,
    owner_known: &dyn Fn(&str) -> crate::private::OwnerState,
) -> bool {
    let norm = crate::access::normalize_subject_path(path);
    if caps & crate::access::CAP_VIEW == crate::access::CAP_VIEW {
        return true;
    }
    if user.role == "admin"
        && !private_boundary(mount, &norm)
            .is_some_and(|b| owner_known(&b.owner) != crate::private::OwnerState::Foreign)
    {
        return true;
    }
    if private_boundary(mount, &norm)
        .is_some_and(|b| owner_known(&b.owner) == crate::private::OwnerState::Deleted)
    {
        return false;
    }
    // The way down to a private item you own stays open.
    if owned.iter().any(|p| crate::access::path_contains(&norm, p)) {
        return true;
    }
    browse_rows_walk(drive_id, &norm, rows)
}

/// Stricter than [`can_browse_path`], for the member HTTP files API: true
/// when the user holds `CAP_VIEW` on `path`, when `path` is exactly a member
/// row's own path (any caps — an upload-only member still resolves their
/// drop folder as a landing), or when `path` is the drive root and the user
/// holds any member row on the drive.
///
/// Unlike `can_browse_path` it never opens the ancestors of a deep grant:
/// `docs/reports/2024/file.pdf` does not make `docs` listable or statable.
/// Directory structure outside the grant is not the member's to see. WebDAV
/// keeps the wider ancestor walk in [`can_browse_path`] — this gate is only
/// for the HTTP surface.
pub fn can_inspect_path(user: &CurrentUser, conn: &Connection, drive_id: &str, path: &str) -> bool {
    can_inspect_path_in(user, conn, &InspectCtx::new(user, conn, drive_id), path)
}

/// What [`can_inspect_path`] looks up once per drive: the mount point and the
/// user's grant rows. Build it once and test many paths (a folder listing).
pub struct InspectCtx<'a> {
    drive_id: &'a str,
    mount: Option<String>,
    rows: Option<Vec<db::AccessMemberRow>>,
}

impl<'a> InspectCtx<'a> {
    pub fn new(user: &CurrentUser, conn: &Connection, drive_id: &'a str) -> Self {
        Self {
            drive_id,
            // The mount point `can_inspect_path` has always used, empty or not.
            mount: db::get_drive(conn, drive_id)
                .ok()
                .flatten()
                .map(|d| d.mount_point),
            rows: db::list_access_members_for_user(conn, &user.id).ok(),
        }
    }
}

/// [`caps_on_path`] against a prebuilt [`InspectCtx`] — same answer, without
/// the per-call drive and grant-row lookups.
pub fn caps_on_path_in(
    user: &CurrentUser,
    conn: &Connection,
    ctx: &InspectCtx<'_>,
    path: &str,
) -> crate::access::Caps {
    if crate::files::is_trash_api(path) {
        return caps_on_path(user, conn, ctx.drive_id, path);
    }
    let live_mount = ctx.mount.as_deref().filter(|m| !m.is_empty());
    let rows = ctx.rows.as_deref().unwrap_or(&[]);
    caps_on_path_rows_at(user, conn, ctx.drive_id, path, rows, live_mount)
}

/// [`can_inspect_path`] against a prebuilt [`InspectCtx`].
pub fn can_inspect_path_in(
    user: &CurrentUser,
    conn: &Connection,
    ctx: &InspectCtx<'_>,
    path: &str,
) -> bool {
    let drive_id = ctx.drive_id;
    let norm = crate::access::normalize_subject_path(path);
    // Trash paths map to where the item came from; leave that to the
    // single-path code.
    if crate::files::is_trash_api(path) {
        return can_inspect_path_slow(user, conn, drive_id, path, &norm);
    }
    let live_mount = ctx.mount.as_deref().filter(|m| !m.is_empty());
    let caps = match &ctx.rows {
        Some(rows) => caps_on_path_rows_at(user, conn, drive_id, path, rows, live_mount),
        None => 0,
    };
    if caps & crate::access::CAP_VIEW == crate::access::CAP_VIEW {
        return true;
    }
    if user.role == "admin"
        && !private_boundary(live_mount, &norm)
            .is_some_and(|b| crate::private::owner_known(conn, &b.owner))
    {
        return true;
    }
    inspect_by_grant(
        user,
        conn,
        drive_id,
        &norm,
        ctx.mount.as_deref(),
        ctx.rows.as_deref(),
    )
}

/// The last gate of [`can_inspect_path`]: a path no caps cover is still
/// listed when it is the exact folder of a grant, or the way down to one.
fn inspect_by_grant(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    norm: &str,
    mount: Option<&str>,
    rows: Option<&[db::AccessMemberRow]>,
) -> bool {
    if private_boundary(mount, norm).is_some_and(|b| {
        crate::private::owner_state(conn, &b.owner) == crate::private::OwnerState::Deleted
    }) {
        return false;
    }
    let Some(rows) = rows else {
        return false;
    };
    if norm.is_empty() {
        return !owned_private_paths(conn, &user.id, drive_id).is_empty()
            || rows
                .iter()
                .any(|r| r.subject_kind == crate::access::KIND_PATH && r.drive_id == drive_id);
    }
    rows.iter().any(|r| {
        r.subject_kind == crate::access::KIND_PATH
            && r.drive_id == drive_id
            && crate::access::normalize_subject_path(&r.path) == norm
    })
}

fn can_inspect_path_slow(
    user: &CurrentUser,
    conn: &Connection,
    drive_id: &str,
    path: &str,
    norm: &str,
) -> bool {
    if can_access(user, conn, drive_id, path, false) {
        return true;
    }
    if user.role == "admin" && !walls_off_admin(conn, drive_id, norm) {
        return true;
    }
    let mount = db::get_drive(conn, drive_id)
        .ok()
        .flatten()
        .map(|d| d.mount_point);
    let rows = db::list_access_members_for_user(conn, &user.id).ok();
    inspect_by_grant(
        user,
        conn,
        drive_id,
        norm,
        mount.as_deref(),
        rows.as_deref(),
    )
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

pub(crate) fn normalize_username(username: &str) -> Result<String, AuthError> {
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
    hash_password_unchecked(password)
}

/// Hash without the normal password policy. Recovery only.
pub(crate) fn hash_password_unchecked(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| {
            AuthError::PasswordPolicy(
                "Luna couldn't use that password. Try a different one.".into(),
            )
        })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod guard_tests;
