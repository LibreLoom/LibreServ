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
use crate::api::cloud_backups::connect_store;
use crate::backup::cloud::{crypto, identity, ops};
use crate::db::{self, UserKeys};

/// How long a challenge stays good after it is issued.
const CHALLENGE_TTL: i64 = 5 * 60;
/// Domain the browser signs the challenge under. Must match the web side.
pub(crate) const CHECK_DOMAIN: &str = "phrase-check";

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
pub(crate) fn issue_challenge(user_id: &str, now: i64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    let mut map = challenges().lock().unwrap_or_else(|p| p.into_inner());
    map.insert(user_id.to_string(), Challenge { bytes, expires_at: now + CHALLENGE_TTL });
    bytes
}

/// Remove and return the user's challenge if it has not expired. A challenge is single-use:
/// taking it always removes it, whether or not the caller goes on to use it.
pub(crate) fn take_challenge(user_id: &str, now: i64) -> Option<[u8; 32]> {
    let mut map = challenges().lock().unwrap_or_else(|p| p.into_inner());
    let challenge = map.remove(user_id)?;
    (now < challenge.expires_at).then_some(challenge.bytes)
}

#[derive(Deserialize)]
struct SetBody {
    x25519_public: String,
    auth_public: String,
    self_sealed: String,
}

#[derive(Deserialize)]
struct CheckBody {
    signature: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cloud/phrase", get(status).put(set_phrase))
        .route("/api/v1/cloud/identity", post(mint_identity))
        .route("/api/v1/cloud/phrase/challenge", post(challenge))
        .route("/api/v1/cloud/phrase/check", post(check))
}

async fn status(State(state): State<AppState>, Extension(user): Extension<CurrentUser>) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let keys = db::get_user_keys(&conn, &user.id).map_err(|_| read_failed())?;
    // Null until cloud backup is set up on this Luna. Setup never happens on a read.
    let identity = identity::load(&conn).map_err(|_| read_failed())?;
    Ok(Json(json!({
        "set": keys.is_some(),
        "set_at": keys.as_ref().map(|k| k.phrase_set_at),
        "luna_id": identity.as_ref().map(|i| i.luna_id()),
        // The browser seals this key with its self key, so Connect can never swap it.
        "signing_public": identity.as_ref().map(|i| STANDARD.encode(i.public())),
    })))
}

/// Makes this Luna's cloud identity if it has none yet, and returns it. Any signed-in person may
/// call it: a fresh Luna has no identity until someone sets up cloud backup.
async fn mint_identity(State(state): State<AppState>, Extension(_user): Extension<CurrentUser>) -> ApiResult {
    let identity = ensure_identity(&state).await?;
    Ok(Json(json!({
        "luna_id": identity.luna_id(),
        "signing_public": STANDARD.encode(identity.public()),
    })))
}

/// Loads this Luna's identity, minting it on a fresh Luna. Runs off the async runtime because
/// it may call Luna Connect and the drives; no DB lock is held across those calls.
async fn ensure_identity(state: &AppState) -> Result<identity::Identity, ApiError> {
    let db = state.db.clone();
    let connect = state.connect.clone();
    let made = tokio::task::spawn_blocking(move || {
        identity::load_or_create_connected(&db, &connect, db::now_unix())
    })
    .await;
    match made {
        Ok(Ok(identity)) => Ok(identity),
        Ok(Err(err)) => {
            tracing::warn!(error = %err, "could not set up Luna's cloud identity");
            Err(json_error(
                StatusCode::CONFLICT,
                "Luna could not set up its backup identity. Try again, or contact your Admin.",
            ))
        }
        Err(_) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not set up its backup identity. Try again.",
        )),
    }
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
    crypto::check_public_key(&x25519_public).map_err(|_| bad_keys())?;
    // A fresh Luna has no identity yet; setting the phrase is the first thing that needs one.
    ensure_identity(&state).await?;

    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    // Two accounts with the same key would share sealed copies, so a key can belong to only one user.
    let key_taken = db::list_user_keys(&conn)
        .map_err(|_| read_failed())?
        .iter()
        .any(|keys| keys.user_id != user.id && keys.x25519_public == x25519_public);
    if key_taken {
        return Err(json_error(
            StatusCode::CONFLICT,
            "This recovery key is already used by another account. Set up the recovery phrase again.",
        ));
    }
    // Setting or replacing a phrase needs only this user's Luna sign-in. The phrase itself is not
    // checked here, so the new phrase counts as unchecked until the user checks it.
    // Sealed copies made for the old key stay unreadable: the next backup starts a new key version.
    db::set_user_keys(
        &conn,
        &UserKeys {
            user_id: user.id.clone(),
            x25519_public: x25519_public.to_vec(),
            auth_public: auth_public.to_vec(),
            self_sealed,
            phrase_set_at: now,
            last_checked_at: 0,
        },
    )
    .map_err(|_| save_failed())?;
    drop(conn);

    // Send the new keys to Luna Connect in the background, so the save never waits on the network.
    // A failure here is only logged: the next cloud backup sends them again.
    let connect = state.connect.clone();
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let Some(store) = connect_store(&connect, &db) else {
            return;
        };
        if let Err(err) = ops::publish_users(&db, &store, &connect, now) {
            tracing::warn!(error = %err, "could not send recovery keys to Luna Connect");
        }
    });
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
pub(crate) fn decode_signature(text: &str) -> Option<[u8; 64]> {
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
        // Reading the status must not mint a Luna id or signing key before backup is set up.
        assert!(body["luna_id"].is_null());
        assert!(body["signing_public"].is_null());

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
    async fn replacing_the_phrase_needs_only_a_luna_sign_in() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&old, None))).await;
        assert_eq!(status, 200);

        // No old-phrase signature is needed. The new keys replace the old ones.
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&new, None))).await;
        assert_eq!(status, 200);
        let stored = {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::get_user_keys(&conn, &f.admin_id).unwrap().unwrap()
        };
        assert_eq!(stored.auth_public, new.public().to_vec());
        assert_eq!(stored.last_checked_at, 0);
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
    async fn low_order_x25519_key_is_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        bad["x25519_public"] = json!(STANDARD.encode([0u8; 32]));
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(bad)).await;
        assert_eq!(status, 400);
        let (_, body) = send(&f.router, "GET", "/api/v1/cloud/phrase", &f.admin_token, None).await;
        assert_eq!(body["set"], json!(false));
    }

    #[tokio::test]
    async fn x25519_key_already_used_by_another_user_is_refused() {
        let f = fixture();
        // set_body uses the same x25519 key (7s) for everyone.
        let admin_signer = Signer::generate();
        send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&admin_signer, None))).await;

        let member_signer = Signer::generate();
        let (status, body) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.member_token, Some(set_body(&member_signer, None))).await;
        assert_eq!(status, 409);
        assert!(body["error"].as_str().unwrap().contains("already used by another account"));
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
        // The member uses their own X25519 key: the admin's key is already registered.
        let member_signer = Signer::generate();
        let mut member_body = set_body(&member_signer, None);
        member_body["x25519_public"] = json!(STANDARD.encode([9u8; 32]));
        let (status, _) = send(&f.router, "PUT", "/api/v1/cloud/phrase", &f.member_token, Some(member_body)).await;
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

    #[tokio::test]
    async fn identity_endpoint_mints_one_luna_id_and_signing_key_for_any_signed_in_user() {
        let f = fixture();
        let (status, first) = send(&f.router, "POST", "/api/v1/cloud/identity", &f.member_token, None).await;
        assert_eq!(status, 200);
        let luna_id = first["luna_id"].as_str().unwrap().to_string();
        assert!(!luna_id.is_empty());
        let public = STANDARD.decode(first["signing_public"].as_str().unwrap()).unwrap();
        assert_eq!(public.len(), 32);

        // A second call returns the same identity rather than minting another.
        let (status, second) = send(&f.router, "POST", "/api/v1/cloud/identity", &f.admin_token, None).await;
        assert_eq!(status, 200);
        assert_eq!(second["luna_id"], json!(luna_id));
        assert_eq!(second["signing_public"], first["signing_public"]);
    }

    #[tokio::test]
    async fn fresh_luna_can_set_a_phrase_and_create_a_cloud_backup_with_nothing_seeded() {
        let f = fixture();
        // A backup needs a drive to read from. Seed one the way a connected drive is recorded.
        let root = f._dir.path().join("drive-d1");
        std::fs::create_dir_all(&root).unwrap();
        let prefix = luna_core::marker::pick_prefix(&root).unwrap();
        drop(
            crate::drives::drive_db::create(
                &root,
                &luna_core::marker::Marker::new("d1".to_string(), "Photos"),
                &prefix,
            )
            .unwrap(),
        );
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::upsert_drive(&conn, "d1", "Photos", "as_is", "ext4", "d1", root.to_str().unwrap())
                .unwrap();
        }

        // The backups routes sit beside the phrase routes, as they do in the real app.
        let router = Router::new()
            .merge(super::router())
            .merge(crate::api::cloud_backups::router())
            .layer(axum::middleware::from_fn_with_state(
                f.state.clone(),
                crate::auth::guard,
            ))
            .with_state(f.state.clone());

        // Step 1: the app asks for an identity before anything else.
        let (status, _) = send(&router, "POST", "/api/v1/cloud/identity", &f.admin_token, None).await;
        assert_eq!(status, 200);

        // Step 2: the Admin sets the recovery phrase (keys) on a fresh Luna.
        let signer = Signer::generate();
        let (status, _) = send(&router, "PUT", "/api/v1/cloud/phrase", &f.admin_token, Some(set_body(&signer, None))).await;
        assert_eq!(status, 200);

        // Step 3: the first backup starts with no files, drives or Connect set up.
        let (status, body) = send(
            &router,
            "POST",
            "/api/v1/cloud/backups",
            &f.admin_token,
            Some(json!({ "source_drive_id": "d1", "source_path": "" })),
        )
        .await;
        assert_eq!(status, 200, "create refused: {body}");
        assert!(body["id"].as_str().is_some_and(|id| !id.is_empty()));

        let (status, list) = send(&router, "GET", "/api/v1/cloud/backups", &f.admin_token, None).await;
        assert_eq!(status, 200);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }
}
