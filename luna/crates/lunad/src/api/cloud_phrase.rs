//! Cloud recovery phrase: who has one, its public keys, and proof that the signed-in person
//! still knows it (plan §5 "Recovery phrase", "Auth key").
//!
//! The phrase itself never reaches Luna. The browser derives the keys from it and sends only
//! the public parts, plus a signature made with the auth key when it proves the phrase.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::{crypto, identity};
use crate::db::{self, UserKeys};

/// How long a challenge stays good after it is issued.
const CHALLENGE_TTL: i64 = 5 * 60;
/// Domain the browser signs the challenge under. Must match the web side.
const CHECK_DOMAIN: &str = "phrase-check";

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

/// One outstanding challenge: its 32 random bytes and the time it stops counting.
#[derive(Clone, Copy)]
struct Challenge {
    bytes: [u8; 32],
    expires_at: i64,
}

/// Outstanding challenges by user id. Lost on restart, which only means asking again.
fn challenges() -> &'static Mutex<HashMap<String, Challenge>> {
    static CHALLENGES: OnceLock<Mutex<HashMap<String, Challenge>>> = OnceLock::new();
    CHALLENGES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Issue a fresh challenge for `user_id`, replacing any earlier one.
fn issue_challenge(user_id: &str, now: i64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    let mut map = challenges().lock().unwrap_or_else(|p| p.into_inner());
    map.insert(user_id.to_string(), Challenge { bytes, expires_at: now + CHALLENGE_TTL });
    bytes
}

/// Remove and return the user's challenge if it has not expired. A challenge is single-use:
/// taking it always removes it, whether or not the caller goes on to use it.
fn take_challenge(user_id: &str, now: i64) -> Option<[u8; 32]> {
    let mut map = challenges().lock().unwrap_or_else(|p| p.into_inner());
    let challenge = map.remove(user_id)?;
    (now < challenge.expires_at).then_some(challenge.bytes)
}

#[derive(Deserialize)]
struct SetBody {
    x25519_public: String,
    auth_public: String,
    self_sealed: String,
    /// Required when keys already exist: the challenge signed with the current auth key.
    signature: Option<String>,
}

#[derive(Deserialize)]
struct CheckBody {
    signature: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cloud/phrase", get(status).put(set_phrase))
        .route("/api/v1/cloud/phrase/challenge", post(challenge))
        .route("/api/v1/cloud/phrase/check", post(check))
}

async fn status(State(state): State<AppState>, Extension(user): Extension<CurrentUser>) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let keys = db::get_user_keys(&conn, &user.id).map_err(|_| read_failed())?;
    let luna_id = identity::load_or_create(&conn, db::now_unix())
        .map_err(|_| read_failed())?
        .luna_id;
    Ok(Json(json!({
        "set": keys.is_some(),
        "set_at": keys.as_ref().map(|k| k.phrase_set_at),
        "luna_id": luna_id,
    })))
}

async fn set_phrase(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<SetBody>,
) -> ApiResult {
    let x25519_public = decode_key(&body.x25519_public)?;
    let auth_public = decode_key(&body.auth_public)?;
    let self_sealed = STANDARD
        .decode(body.self_sealed.trim())
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(bad_keys)?;
    let now = db::now_unix();

    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let current = db::get_user_keys(&conn, &user.id).map_err(|_| read_failed())?;
    // Replacing a phrase needs proof of the old one. A first-time set needs no proof.
    let last_checked_at = match &current {
        None => 0,
        Some(old) => {
            let signature = body.signature.as_deref().and_then(decode_signature);
            let challenge = take_challenge(&user.id, now);
            let proven = match (challenge, signature, <[u8; 32]>::try_from(old.auth_public.as_slice())) {
                (Some(challenge), Some(sig), Ok(old_auth)) => {
                    crypto::verify(&old_auth, CHECK_DOMAIN, &challenge, &sig)
                }
                _ => false,
            };
            if !proven {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "Enter your current recovery phrase first.",
                ));
            }
            now
        }
    };

    db::set_user_keys(
        &conn,
        &UserKeys {
            user_id: user.id.clone(),
            x25519_public: x25519_public.to_vec(),
            auth_public: auth_public.to_vec(),
            self_sealed,
            phrase_set_at: now,
            last_checked_at,
        },
    )
    .map_err(|_| save_failed())?;
    Ok(Json(json!({ "set": true, "set_at": now })))
}

async fn challenge(Extension(user): Extension<CurrentUser>) -> ApiResult {
    let bytes = issue_challenge(&user.id, db::now_unix());
    Ok(Json(json!({ "challenge": STANDARD.encode(bytes) })))
}

async fn check(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<CheckBody>,
) -> ApiResult {
    let now = db::now_unix();
    let challenge = take_challenge(&user.id, now).ok_or_else(|| {
        json_error(
            StatusCode::BAD_REQUEST,
            "That check took too long. Start it again.",
        )
    })?;
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let keys = db::get_user_keys(&conn, &user.id)
        .map_err(|_| read_failed())?
        .ok_or_else(|| {
            json_error(StatusCode::BAD_REQUEST, "No recovery phrase is set for your account yet.")
        })?;
    let auth_public = <[u8; 32]>::try_from(keys.auth_public.as_slice()).map_err(|_| bad_keys())?;
    let proven = decode_signature(&body.signature)
        .is_some_and(|sig| crypto::verify(&auth_public, CHECK_DOMAIN, &challenge, &sig));
    if !proven {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Those words don't match the recovery phrase set for your account.",
        ));
    }
    db::set_user_keys(&conn, &UserKeys { last_checked_at: now, ..keys })
        .map_err(|_| save_failed())?;
    Ok(Json(json!({ "ok": true })))
}

/// Decode a base64 public key, which must be exactly 32 bytes.
fn decode_key(text: &str) -> Result<[u8; 32], ApiError> {
    STANDARD
        .decode(text.trim())
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
        .ok_or_else(bad_keys)
}

/// Decode a base64 signature, which must be exactly 64 bytes.
fn decode_signature(text: &str) -> Option<[u8; 64]> {
    let bytes = STANDARD.decode(text.trim()).ok()?;
    <[u8; 64]>::try_from(bytes.as_slice()).ok()
}

fn bad_keys() -> ApiError {
    json_error(
        StatusCode::BAD_REQUEST,
        "The recovery phrase keys could not be read. Try setting the phrase again.",
    )
}

fn read_failed() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not read your recovery phrase details. Try again.",
    )
}

fn save_failed() -> ApiError {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Could not save your recovery phrase. Try again.",
    )
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{CHALLENGE_TTL, challenges, issue_challenge, take_challenge};
    use crate::backup::cloud::crypto::Signer;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
        admin_token: String,
        member_token: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Fixture {
            admin_token: auth.issue(&admin).unwrap(),
            member_token: auth.issue(&member).unwrap(),
            admin_id: admin.id.clone(),
            _dir: dir,
            state,
            router,
        }
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (axum::http::StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// A set-phrase body for `signer` (the auth key) and some made-up public keys.
    fn set_body(signer: &Signer, signature: Option<String>) -> Value {
        let mut body = json!({
            "x25519_public": STANDARD.encode([7u8; 32]),
            "auth_public": STANDARD.encode(signer.public()),
            "self_sealed": STANDARD.encode(b"sealed"),
        });
        if let Some(sig) = signature {
            body["signature"] = json!(sig);
        }
        body
    }

    async fn fetch_challenge(router: &Router, token: &str) -> Vec<u8> {
        let (status, body) = send(router, "POST", "/api/v1/cloud/phrase/challenge", token, None).await;
        assert_eq!(status, 200);
        STANDARD.decode(body["challenge"].as_str().unwrap()).unwrap()
    }

    fn sign_challenge(signer: &Signer, challenge: &[u8]) -> String {
        STANDARD.encode(signer.sign("phrase-check", challenge))
    }

    #[tokio::test]
    async fn get_reports_unset_then_set() {
        let f = fixture();
        let (status, body) = send(&f.router, "GET", "/api/v1/cloud/phrase", &f.admin_token, None).await;
        assert_eq!(status, 200);
        assert_eq!(body["set"], json!(false));
        assert!(body["set_at"].is_null());
        assert!(body["luna_id"].as_str().unwrap().starts_with("luna-"));

        let signer = Signer::generate();
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&signer, None)),
        )
        .await;
        assert_eq!(status, 200);

        let (_, body) = send(&f.router, "GET", "/api/v1/cloud/phrase", &f.admin_token, None).await;
        assert_eq!(body["set"], json!(true));
        assert!(body["set_at"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn first_set_needs_no_signature_but_bad_keys_are_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        bad["auth_public"] = json!(STANDARD.encode([1u8; 5]));
        let (status, body) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(bad)).await;
        assert_eq!(status, 400);
        assert!(body["error"].as_str().unwrap().contains("could not be read"));
    }

    #[tokio::test]
    async fn change_needs_a_valid_signature_from_the_old_key() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&old, None))).await;

        // No signature at all.
        let (status, body) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&new, None))).await;
        assert_eq!(status, 403);
        assert_eq!(body["error"], json!("Enter your current recovery phrase first."));

        // Signed with the new key instead of the old one.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let wrong = sign_challenge(&new, &challenge);
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&new, Some(wrong)))).await;
        assert_eq!(status, 403);

        // Signed with the old key: accepted, and the new keys are stored.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let right = sign_challenge(&old, &challenge);
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&new, Some(right)))).await;
        assert_eq!(status, 200);
        let stored = {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::get_user_keys(&conn, &f.admin_id).unwrap().unwrap()
        };
        assert_eq!(stored.auth_public, new.public().to_vec());
    }

    #[tokio::test]
    async fn check_accepts_right_and_refuses_wrong_words_and_expired_challenges() {
        let f = fixture();
        let signer = Signer::generate();
        send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&signer, None))).await;

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&signer, &challenge) })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body, json!({ "ok": true }));

        // Wrong key: refused, and the challenge is used up.
        let wrong_key = Signer::generate();
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, body) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&wrong_key, &challenge) })),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            json!("Those words don't match the recovery phrase set for your account.")
        );
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&signer, &challenge) })),
        )
        .await;
        assert_eq!(status, 400, "a used challenge cannot be reused");

        // Expired challenge: refused even with the right signature.
        let now = db::now_unix();
        let bytes = issue_challenge(&f.admin_id, now - CHALLENGE_TTL - 1);
        assert!(take_challenge(&f.admin_id, now).is_none());
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&signer, &bytes) })),
        )
        .await;
        assert_eq!(status, 400);
        challenges().lock().unwrap().remove(&f.admin_id);
    }

    #[tokio::test]
    async fn another_user_cannot_touch_your_phrase() {
        let f = fixture();
        let admin_signer = Signer::generate();
        send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&admin_signer, None))).await;

        // The member sees no phrase of their own, and writes only their own record.
        let (_, body) = send(&f.router, "GET", "/api/v1/cloud/phrase", &f.member_token, None).await;
        assert_eq!(body["set"], json!(false));

        // The member's change attempt cannot use the admin's key: it is judged against the
        // member's own (empty) record, so it is a first set, and the admin keeps theirs.
        let member_signer = Signer::generate();
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.member_token, Some(set_body(&member_signer, None))).await;
        assert_eq!(status, 200);

        // The member's challenge cannot prove the admin's phrase.
        let challenge = fetch_challenge(&f.router, &f.member_token).await;
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&member_signer, &challenge) })),
        )
        .await;
        assert_eq!(status, 400);
        let stored = {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::get_user_keys(&conn, &f.admin_id).unwrap().unwrap()
        };
        assert_eq!(stored.auth_public, admin_signer.public().to_vec());
    }
}
