//! Cloud recovery phrase: who has one, its public keys, and proof that the signed-in person
//! still knows it (plan §5 "Recovery phrase", "Auth key").
//!
//! The phrase itself never reaches Luna. The browser derives the keys from it and sends only
//! the public parts, plus a signature made with the auth key when it proves the phrase.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::auth::login_user_key;
use crate::api::cloud_backups::connect_store;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::{crypto, identity, keys, ops, private, rewrap};
use crate::db::{self, UserKeys};

/// How long a challenge stays good after it is issued.
const CHALLENGE_TTL: i64 = 5 * 60;
/// Domain the browser signs the challenge under. Must match the web side.
pub(crate) const CHECK_DOMAIN: &str = "phrase-check";
/// Domain the browser signs a replacement challenge under. A different domain from
/// `CHECK_DOMAIN`, so a phrase-check signature can never be replayed as a replacement.
pub(crate) const REPLACE_DOMAIN: &str = "phrase-replace";

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
    map.insert(
        user_id.to_string(),
        Challenge {
            bytes,
            expires_at: now + CHALLENGE_TTL,
        },
    );
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
    seal_public: String,
    auth_public: String,
    self_sealed: String,
    /// How the person proves it is them. Needed whenever a phrase is already set.
    #[serde(default)]
    proof: Option<String>,
    /// "Could someone else have your phrase?" Needed whenever a phrase is already set.
    #[serde(default)]
    exposed: Option<bool>,
    /// For `old_signature`: the old auth key's signature over the replacement challenge.
    #[serde(default)]
    signature: Option<String>,
    /// For `password`: the person's Luna password.
    #[serde(default)]
    password: Option<String>,
    /// For `old_signature`: each private scope's secret key, re-sealed to the new phrase (plan §5).
    #[serde(default)]
    rescoped: Vec<RescopedBody>,
    /// How many words the phrase has: 12 or 24. Left out when unknown, which stores 0.
    #[serde(default)]
    words: Option<u8>,
}

#[derive(Deserialize)]
struct RescopedBody {
    scope: String,
    sealed_scope_secret: String,
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
        .route("/api/v1/cloud/phrase/scopes", get(scopes))
        .route("/api/v1/cloud/phrase/kept-scopes", get(kept_scopes))
}

/// The signed-in person's private scopes, each with its secret key sealed to their phrase. The
/// browser opens each with the old phrase and re-seals it to the new one when a phrase is changed.
async fn scopes(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let scopes = db::list_private_scopes(&conn, Some(&user.id)).map_err(|_| read_failed())?;
    let out: Vec<Value> = scopes
        .iter()
        .map(|scope| {
            json!({
                "scope": scope.scope,
                "sealed_scope_secret": STANDARD.encode(&scope.sealed_scope_secret),
            })
        })
        .collect();
    Ok(Json(json!({ "scopes": out })))
}

/// The signed-in person's kept copies of earlier scope secrets (30 days after a phrase change made
/// with the old phrase, when no one else could have it). A restore with the old phrase tries these
/// when the current copy does not open. Only the owner's own copies are ever returned.
async fn kept_scopes(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let kept =
        db::list_kept_scope_secrets(&conn, &user.id, db::now_unix()).map_err(|_| read_failed())?;
    let out: Vec<Value> = kept
        .iter()
        .map(|k| {
            json!({
                "scope": k.scope,
                "seal_public": STANDARD.encode(&k.seal_public),
                "sealed_scope_secret": STANDARD.encode(&k.sealed_scope_secret),
                "expires_at": k.expires_at,
            })
        })
        .collect();
    Ok(Json(json!({ "kept": out })))
}

/// Length of a sealed copy of a scope's secret key.
const SEALED_SCOPE_SECRET_LEN: usize = crypto::sealed_len(crypto::SEAL_SECRET_LEN);

/// Decodes the `rescoped` list: one entry per scope, each a sealed scope secret of the right size.
fn parse_rescoped(entries: &[RescopedBody]) -> Result<Vec<(String, Vec<u8>)>, ApiError> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let sealed = STANDARD
            .decode(entry.sealed_scope_secret.trim())
            .ok()
            .filter(|bytes| bytes.len() == SEALED_SCOPE_SECRET_LEN)
            .ok_or_else(bad_keys)?;
        if !seen.insert(entry.scope.clone()) {
            return Err(bad_keys());
        }
        out.push((entry.scope.clone(), sealed));
    }
    Ok(out)
}

/// How long a recovery phrase can go unchecked before Luna asks the person to check it again.
const CHECK_DUE_AFTER: i64 = 90 * 86_400;

/// Whether the person should check their recovery phrase again: it is set, and neither setting
/// it nor the last check is within the last 90 days.
fn phrase_check_due(keys: Option<&UserKeys>, now: i64) -> bool {
    keys.is_some_and(|k| now - k.phrase_set_at.max(k.last_checked_at) >= CHECK_DUE_AFTER)
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    let keys = db::get_user_keys(&conn, &user.id).map_err(|_| read_failed())?;
    // Null until cloud backup is set up on this Luna. Setup never happens on a read.
    let identity = identity::load(&conn).map_err(|_| read_failed())?;
    let old_copies = old_phrase_copies(&conn, &user.id).map_err(|_| read_failed())?;
    let resealing = keys::resealing_pending(&conn, &user.id).map_err(|_| read_failed())?;
    let now = db::now_unix();
    Ok(Json(json!({
        "set": keys.is_some(),
        "set_at": keys.as_ref().map(|k| k.phrase_set_at),
        "check_due": phrase_check_due(keys.as_ref(), now),
        // 0 means the phrase has never been checked (or is not set).
        "last_checked_at": keys.as_ref().map_or(0, |k| k.last_checked_at),
        // 12 or 24 once the phrase has been saved with its length; 0 when unknown.
        "phrase_words": keys.as_ref().map_or(0, |k| k.phrase_words),
        "old_phrase_copies": {
            "count": old_copies.count,
            "removed_at": old_copies.removed_at,
        },
        // True while Luna is still re-sealing this person's cloud backup keys to the new phrase.
        "resealing": resealing,
        // `{percent, paused_full}` while any backup's older packs are moving to the newest key, else null.
        "moving": rewrap::status_for_luna(&conn, &user),
        "luna_id": identity.as_ref().map(|i| i.luna_id()),
        // The browser seals this key with its self key, so Connect can never swap it.
        "signing_public": identity.as_ref().map(|i| STANDARD.encode(i.public())),
    })))
}

/// Private copies a person still holds from before they changed their phrase.
struct OldPhraseCopies {
    count: usize,
    /// When the first of them is removed, or `None` when there are none (or no removal time).
    removed_at: Option<i64>,
}

/// Counts `owner`'s old-phrase copies and finds the earliest removal time. Reads only the
/// owner's own scopes, the same source the backup rows use for `old_phrase_copies`.
fn old_phrase_copies(conn: &Connection, owner: &str) -> anyhow::Result<OldPhraseCopies> {
    let mut copies = OldPhraseCopies {
        count: 0,
        removed_at: None,
    };
    let scopes = db::list_private_scopes(conn, Some(owner))?;
    for scope in scopes.iter().filter(|s| s.state == "old_phrase") {
        let n = db::private_snapshot_ids(conn, &scope.scope)?.len();
        if n == 0 {
            continue;
        }
        copies.count += n;
        // A retire time of 0 means the sweep has no removal time for this scope.
        if scope.retire_after > 0 {
            copies.removed_at = Some(
                copies
                    .removed_at
                    .map_or(scope.retire_after, |at| at.min(scope.retire_after)),
            );
        }
    }
    Ok(copies)
}

/// Makes this Luna's cloud identity if it has none yet, and returns it. Any signed-in person may
/// call it: a fresh Luna has no identity until someone sets up cloud backup.
async fn mint_identity(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
) -> ApiResult {
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

/// How a replacement is proven: the old phrase's signature, or the Luna password.
enum Proof {
    OldSignature(Box<crypto::SigBytes>),
    Password(String),
}

/// What the old phrase signs to replace itself: the challenge and every new value in the request.
/// Binding the new keys means a request copied off the network can't be sent again with someone
/// else's keys under the same signature. The web side builds the same bytes in `cloudPhrase.js`.
pub(crate) fn replace_message(
    challenge: &[u8],
    seal_public: &[u8],
    auth_public: &[u8],
    self_sealed: &[u8],
    exposed: bool,
    rescoped: &[(String, Vec<u8>)],
) -> Vec<u8> {
    crypto::canonical(&[
        ("challenge", challenge),
        ("seal_public", seal_public),
        ("auth_public", auth_public),
        ("self_sealed_hash", &crypto::pack_id(self_sealed)),
        ("exposed", &[u8::from(exposed)]),
        ("rescoped_hash", &rescoped_hash(rescoped)),
    ])
}

/// A hash of the re-sealed private scopes, sorted by scope, so dropping or swapping one changes
/// what the old phrase signed. The web side builds the same bytes in `cloudPhrase.js`.
fn rescoped_hash(rescoped: &[(String, Vec<u8>)]) -> [u8; 32] {
    let mut sorted: Vec<&(String, Vec<u8>)> = rescoped.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut fields: Vec<(&str, &[u8])> = Vec::with_capacity(sorted.len() * 2);
    for (scope, sealed) in sorted {
        fields.push(("scope", scope.as_bytes()));
        fields.push(("sealed_scope_secret", sealed));
    }
    crypto::pack_id(&crypto::canonical(&fields))
}

fn proof_refused() -> ApiError {
    json_error(
        StatusCode::FORBIDDEN,
        "Luna could not confirm it is you. Check your old phrase or password and try again.",
    )
}

async fn set_phrase(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<SetBody>,
) -> ApiResult {
    if !matches!(body.words, None | Some(12) | Some(24)) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "A recovery phrase has 12 or 24 words.",
        ));
    }
    let seal_public: crypto::SealPublic = decode_key(&body.seal_public)?;
    let auth_public: crypto::SigPublic = decode_key(&body.auth_public)?;
    let rescoped = parse_rescoped(&body.rescoped)?;
    if !rescoped.is_empty() && body.proof.as_deref() != Some("old_signature") {
        // Only the old phrase can open the scopes, so only that proof can re-seal them.
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only re-seal private backups when you prove the old phrase.",
        ));
    }
    let self_sealed = STANDARD
        .decode(body.self_sealed.trim())
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(bad_keys)?;
    let now = db::now_unix();
    crypto::check_public_key(&seal_public).map_err(|_| bad_keys())?;

    // Prove it is the same person before anything else changes. The old keys are read first and
    // the lock is dropped, because the password check takes the lock itself.
    let old_keys = {
        let conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::get_user_keys(&conn, &user.id).map_err(|_| read_failed())?
    };
    let mut exposed = false;
    if let Some(old) = &old_keys {
        exposed = body.exposed.ok_or_else(|| {
            json_error(
                StatusCode::BAD_REQUEST,
                "Say whether someone else could have your old phrase.",
            )
        })?;
        let proof = match body.proof.as_deref() {
            Some("old_signature") => Proof::OldSignature(Box::new(
                body.signature
                    .as_deref()
                    .and_then(decode_signature)
                    .ok_or_else(proof_refused)?,
            )),
            Some("password") => Proof::Password(body.password.clone().unwrap_or_default()),
            // No proof, or an unknown one, is the same refusal as a wrong one.
            _ => return Err(proof_refused()),
        };
        match proof {
            Proof::OldSignature(signature) => {
                // Taking the challenge removes it, so a second try needs a fresh one. A missing or
                // used challenge is refused like a wrong signature.
                let challenge = take_challenge(&user.id, now).ok_or_else(proof_refused)?;
                let old_auth = crypto::SigPublic::try_from(old.auth_public.as_slice())
                    .map_err(|_| bad_keys())?;
                let message = replace_message(
                    &challenge,
                    &seal_public,
                    &auth_public,
                    &self_sealed,
                    exposed,
                    &rescoped,
                );
                if !crypto::verify(&old_auth, REPLACE_DOMAIN, &message, &signature) {
                    return Err(proof_refused());
                }
            }
            Proof::Password(password) => {
                // The same per-account tries as signing in, so this can't be used to guess.
                if !state.login_limiter.allow(&login_user_key(&user.username)) {
                    return Err(json_error(
                        StatusCode::TOO_MANY_REQUESTS,
                        "Too many tries. Wait a few minutes and try again.",
                    ));
                }
                let auth = state.auth.clone();
                let user_id = user.id.clone();
                tokio::task::spawn_blocking(move || {
                    auth.verify_password_for_user(&user_id, &password)
                })
                .await
                .map_err(|_| save_failed())?
                .map_err(|_| proof_refused())?;
            }
        }
    }

    // A fresh Luna has no identity yet; setting the phrase is the first thing that needs one.
    ensure_identity(&state).await?;

    let mut conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
    // Two accounts with the same key would share sealed copies, so a key can belong to only one user.
    let key_taken = db::list_user_keys(&conn)
        .map_err(|_| read_failed())?
        .iter()
        .any(|keys| keys.user_id != user.id && keys.seal_public == seal_public);
    if key_taken {
        return Err(json_error(
            StatusCode::CONFLICT,
            "This recovery key is already used by another account. Set up the recovery phrase again.",
        ));
    }
    // All or nothing: the new keys, the readers' lists, the rotation marks, the re-seal job and the
    // private scopes move together.
    let (marked, rescope_failed) = (|| -> anyhow::Result<(Vec<String>, usize)> {
        let tx = conn.transaction()?;
        db::set_user_keys(
            &tx,
            &UserKeys {
                user_id: user.id.clone(),
                seal_public: seal_public.to_vec(),
                auth_public: auth_public.to_vec(),
                self_sealed,
                phrase_set_at: now,
                last_checked_at: 0,
                phrase_words: i64::from(body.words.unwrap_or(0)),
            },
        )?;
        let mut marked = Vec::new();
        let mut settled = private::Settled::default();
        if old_keys.is_some() {
            if exposed {
                marked = keys::current_backups_of(&tx, &user.id)?;
            }
            keys::replace_reader(&tx, &user.id, &seal_public)?;
            for backup in &marked {
                keys::mark_rotate(&tx, backup)?;
            }
            keys::queue_reseal(&tx, &user.id)?;
            // Private scopes: with the old phrase they are re-sealed and kept; with the password
            // the browser cannot open them, so they retire (at once when someone may have the phrase).
            if body.proof.as_deref() == Some("old_signature") {
                settled =
                    private::settle_scopes(&tx, &user.id, &seal_public, &rescoped, exposed, now)?;
                ops::queue_scope_publish(&tx, &settled.resealed)?;
            } else {
                private::retire_scopes_without_key(&tx, &user.id, exposed, now)?;
            }
            if exposed && body.proof.as_deref() != Some("old_signature") {
                ops::retire_old_phrase_now(&tx, &user.id, now)?;
            }
        }
        tx.commit()?;
        let failed = settled.failed;
        Ok((marked, failed))
    })()
    .map_err(|err| {
        tracing::warn!(error = %err, "could not save the recovery phrase");
        save_failed()
    })?;
    let resealing = keys::resealing_pending(&conn, &user.id).unwrap_or(false);
    drop(conn);

    // Two background jobs, so the save never waits on the network. The first starts a run for each
    // backup marked to rotate, so new files are shut off from the old phrase within minutes, and is
    // not held up by the second's retries. The second sends the new keys to Luna Connect and
    // finishes the re-seal. A failure in either is only logged: the next run retries.
    {
        let connect = state.connect.clone();
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || {
            let Some(store) = connect_store(&connect, &db) else {
                return;
            };
            ops::run_marked(&db, &store, &connect, &marked, db::now_unix());
        });
    }
    let connect = state.connect.clone();
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let Some(store) = connect_store(&connect, &db) else {
            return;
        };
        if let Err(err) = ops::publish_users(&db, &store, &connect, now) {
            tracing::warn!(error = %err, "could not send recovery keys to Luna Connect");
        }
        // Every re-sealed scope (active, history, old phrase) is sent; one failing scope does not
        // stop the others, and what is left stays pending for the next sweep.
        if !ops::publish_scopes_until_done(&db, &store, 5, std::time::Duration::from_secs(30)) {
            tracing::warn!(
                "some re-sealed private scopes are not at Luna Connect yet; they will be tried again"
            );
        }
        // Retried while a backup is copying: the re-seal waits for it, so a run can never write a
        // copy sealed to the old phrase after this. The next run retries it too.
        ops::reseal_until_done(&db, &store, 20, std::time::Duration::from_secs(30));
    });
    Ok(Json(json!({
        "set": true,
        "set_at": now,
        "resealing": resealing,
        // Private backups that were not re-sealed to the new phrase. They keep 30 days, then go.
        "rescope_failed": rescope_failed,
    })))
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
            json_error(
                StatusCode::BAD_REQUEST,
                "No recovery phrase is set for your account yet.",
            )
        })?;
    let auth_public =
        crypto::SigPublic::try_from(keys.auth_public.as_slice()).map_err(|_| bad_keys())?;
    let proven = decode_signature(&body.signature)
        .is_some_and(|sig| crypto::verify(&auth_public, CHECK_DOMAIN, &challenge, &sig));
    if !proven {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "That doesn't match the recovery phrase set for your account.",
        ));
    }
    db::set_user_keys(
        &conn,
        &UserKeys {
            last_checked_at: now,
            ..keys
        },
    )
    .map_err(|_| save_failed())?;
    // The new phrase is checked, so the old one no longer needs to open earlier private backups.
    db::clear_kept_scope_secrets(&conn, &user.id).map_err(|_| save_failed())?;
    Ok(Json(json!({ "ok": true })))
}

/// Decode a base64 public key, which must be exactly `N` bytes.
fn decode_key<const N: usize>(text: &str) -> Result<[u8; N], ApiError> {
    STANDARD
        .decode(text.trim())
        .ok()
        .and_then(|bytes| <[u8; N]>::try_from(bytes.as_slice()).ok())
        .ok_or_else(bad_keys)
}

/// Decode a base64 signature, which must be exactly 64 bytes.
pub(crate) fn decode_signature(text: &str) -> Option<crypto::SigBytes> {
    let bytes = STANDARD.decode(text.trim()).ok()?;
    <crypto::SigBytes>::try_from(bytes.as_slice()).ok()
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

    use super::{
        CHALLENGE_TTL, CHECK_DOMAIN, REPLACE_DOMAIN, challenges, issue_challenge, phrase_check_due,
        replace_message, take_challenge,
    };
    use crate::backup::cloud::crypto::Signer;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // The same vectors are pinned in cloudPhrase.test.js: if either side drifts, both fail.
    #[test]
    fn rescoped_hash_and_replace_message_match_the_fixed_vectors() {
        let unsorted = vec![
            ("scope-b".to_string(), vec![2u8; 40]),
            ("scope-a".to_string(), vec![1u8; 40]),
        ];
        assert_eq!(hex(&super::rescoped_hash(&unsorted)), RESCOPED_HASH_TWO);
        assert_eq!(hex(&super::rescoped_hash(&[])), RESCOPED_HASH_EMPTY);
        let message = replace_message(
            &[7u8; 32], &[3u8; 32], &[4u8; 32], &[5u8; 48], true, &unsorted,
        );
        assert_eq!(hex(&message), REPLACE_MESSAGE_HEX);
    }

    const RESCOPED_HASH_TWO: &str =
        "57825ea6ce207824ca047b67d2b5856af1df29c15afeb41e83d1d3b4a5742f28";
    const RESCOPED_HASH_EMPTY: &str =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const REPLACE_MESSAGE_HEX: &str = "000000096368616c6c656e67650000002007070707070707070707070707070707070707070707070707070707070707070000000b7365616c5f7075626c69630000002003030303030303030303030303030303030303030303030303030303030303030000000b617574685f7075626c69630000002004040404040404040404040404040404040404040404040404040404040404040000001073656c665f7365616c65645f6861736800000020bae0441407d7f6e0fe664fd07f8d144340acea5f88820f2ad0c800671c9479e3000000076578706f73656400000001010000000d726573636f7065645f686173680000002057825ea6ce207824ca047b67d2b5856af1df29c15afeb41e83d1d3b4a5742f28";

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
        member_id: String,
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
            member_id: member.id.clone(),
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
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// A real sealing public key (X25519 and ML-KEM) for a recovery phrase made of `n` bytes.
    fn seal_key_b64(n: u8) -> String {
        let keys = crate::backup::cloud::crypto::derive(&[n; 16], "luna-test-1");
        STANDARD.encode(keys.seal_public)
    }

    /// A set-phrase body for `signer` (the auth key) and some made-up public keys.
    fn set_body(signer: &Signer, signature: Option<String>) -> Value {
        let mut body = json!({
            "seal_public": seal_key_b64(7),
            "auth_public": STANDARD.encode(signer.public()),
            "self_sealed": STANDARD.encode(b"sealed"),
        });
        if let Some(sig) = signature {
            body["signature"] = json!(sig);
        }
        body
    }

    async fn fetch_challenge(router: &Router, token: &str) -> Vec<u8> {
        let (status, body) = send(
            router,
            "POST",
            "/api/v1/cloud/phrase/challenge",
            token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        STANDARD
            .decode(body["challenge"].as_str().unwrap())
            .unwrap()
    }

    fn sign_challenge(signer: &Signer, challenge: &[u8]) -> String {
        STANDARD.encode(signer.sign("phrase-check", challenge))
    }

    #[tokio::test]
    async fn get_reports_unset_then_set() {
        let f = fixture();
        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            None,
        )
        .await;
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

        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(body["set"], json!(true));
        assert!(body["set_at"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn first_set_needs_no_signature_but_bad_keys_are_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        bad["auth_public"] = json!(STANDARD.encode([1u8; 5]));
        let (status, body) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(bad),
        )
        .await;
        assert_eq!(status, 400);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("could not be read")
        );
    }

    const PUT: &str = "/api/v1/cloud/phrase";

    /// A replacement body: new keys (sealing key made from `seal_n`, auth key `new`) plus a proof.
    fn replace_body(new: &Signer, seal_n: u8, proof: Value, exposed: Option<bool>) -> Value {
        let mut body = set_body(new, None);
        body["seal_public"] = json!(seal_key_b64(seal_n));
        if let Some(exposed) = exposed {
            body["exposed"] = json!(exposed);
        }
        for (key, value) in proof.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    }

    /// A replacement body whose proof is `signer`'s signature, made under `domain`, over the
    /// challenge and the new values in the body (what the browser sends).
    fn signed_replace_body(
        new: &Signer,
        seal_n: u8,
        signer: &Signer,
        domain: &str,
        challenge: &[u8],
        exposed: Option<bool>,
    ) -> Value {
        let mut body = replace_body(new, seal_n, json!({ "proof": "old_signature" }), exposed);
        let signature = sign_body(&body, signer, domain, challenge);
        body["signature"] = json!(signature);
        body
    }

    /// Sets the body's `rescoped` list and signs the body again, since the signature covers it.
    fn with_rescoped(mut body: Value, rescoped: Value, signer: &Signer, challenge: &[u8]) -> Value {
        body["rescoped"] = rescoped;
        body["signature"] = json!(sign_body(&body, signer, REPLACE_DOMAIN, challenge));
        body
    }

    /// Signature (base64) over the challenge and the values already in `body`.
    fn sign_body(body: &Value, signer: &Signer, domain: &str, challenge: &[u8]) -> String {
        let field = |name: &str| STANDARD.decode(body[name].as_str().unwrap()).unwrap();
        let rescoped: Vec<(String, Vec<u8>)> = body["rescoped"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| {
                (
                    e["scope"].as_str().unwrap().to_string(),
                    STANDARD
                        .decode(e["sealed_scope_secret"].as_str().unwrap())
                        .unwrap(),
                )
            })
            .collect();
        let message = replace_message(
            challenge,
            &field("seal_public"),
            &field("auth_public"),
            &field("self_sealed"),
            body["exposed"].as_bool().unwrap_or(false),
            &rescoped,
        );
        STANDARD.encode(signer.sign(domain, &message))
    }

    async fn set_first(f: &Fixture, token: &str, signer: &Signer, seal_n: u8) {
        let mut body = set_body(signer, None);
        body["seal_public"] = json!(seal_key_b64(seal_n));
        let (status, _) = send(&f.router, "PUT", PUT, token, Some(body)).await;
        assert_eq!(status, 200);
    }

    fn hex_of_seal(seal_n: u8) -> String {
        STANDARD
            .decode(seal_key_b64(seal_n))
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// A cloud backup at key version 1 whose readers are `readers` (user id, sealing key number).
    fn seed_backup(f: &Fixture, id: &str, readers: &[(&str, u8)]) {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id,
                kind: db::PROTECTION_CLOUD,
                source_drive: "d1",
                source_path: id,
                target_drive: "",
                private_owner: "",
                created_by: &f.admin_id,
                created_at: 0,
            },
        )
        .unwrap();
        db::insert_backup_key(
            &conn,
            &db::BackupKey {
                protection_id: id.to_string(),
                version: 1,
                key: vec![1; 32],
                dedup_key: vec![2; 32],
                created_at: 0,
            },
        )
        .unwrap();
        let list: Vec<Value> = readers
            .iter()
            .map(|(user, n)| json!({ "user_id": user, "seal_public": hex_of_seal(*n) }))
            .collect();
        db::set_meta(
            &conn,
            &format!("cloud_recipients:{id}:1"),
            &Value::Array(list).to_string(),
        )
        .unwrap();
    }

    fn seed_active_scope(f: &Fixture, owner: &str, scope: &str) {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_private_scope(
            &conn,
            &db::PrivateScope {
                scope: scope.to_string(),
                owner: owner.to_string(),
                seal_public: vec![0; 32],
                scope_public: vec![5; 32],
                sealed_scope_secret: vec![6; 16],
                dedup_key: vec![0; 32],
                state: "active".to_string(),
                retire_after: 0,
                created_at: 0,
            },
        )
        .unwrap();
    }

    fn seed_scope_with_state(
        f: &Fixture,
        owner: &str,
        scope: &str,
        state: &str,
        retire_after: i64,
    ) {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::insert_private_scope(
            &conn,
            &db::PrivateScope {
                scope: scope.to_string(),
                owner: owner.to_string(),
                seal_public: vec![0; 32],
                scope_public: vec![5; 32],
                sealed_scope_secret: vec![6; 16],
                dedup_key: vec![0; 32],
                state: state.to_string(),
                retire_after,
                created_at: 0,
            },
        )
        .unwrap();
    }

    fn scope_of(f: &Fixture, scope: &str) -> db::PrivateScope {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::get_private_scope(&conn, scope).unwrap().unwrap()
    }

    fn meta(f: &Fixture, key: &str) -> Option<String> {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::get_meta(&conn, key).unwrap()
    }

    fn stored_auth(f: &Fixture, user_id: &str) -> Vec<u8> {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::get_user_keys(&conn, user_id)
            .unwrap()
            .unwrap()
            .auth_public
    }

    #[tokio::test]
    async fn replacing_a_phrase_needs_a_proof_and_an_answer() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;

        // No proof at all.
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(replace_body(&new, 8, json!({}), Some(false))),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());

        // A proof but no answer to "could someone else have it?".
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &old,
                REPLACE_DOMAIN,
                &challenge,
                None,
            )),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
    }

    #[tokio::test]
    async fn old_phrase_signature_replaces_the_phrase_without_exposure() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_backup(&f, "b1", &[(&f.admin_id, 7)]);
        seed_active_scope(&f, &f.admin_id, "scope-1");

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, body) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &old,
                REPLACE_DOMAIN,
                &challenge,
                Some(false),
            )),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["resealing"], json!(true));
        assert_eq!(stored_auth(&f, &f.admin_id), new.public().to_vec());

        // The reader list names the new key, so no new version starts, and nothing is marked.
        let readers: Value =
            serde_json::from_str(&meta(&f, "cloud_recipients:b1:1").unwrap()).unwrap();
        assert_eq!(readers[0]["seal_public"], json!(hex_of_seal(8)));
        assert!(meta(&f, "cloud_rotate:b1").is_none());

        // Private copies stay 30 days.
        let scope = scope_of(&f, "scope-1");
        assert_eq!(scope.state, "old_phrase");
        let wait = scope.retire_after - db::now_unix();
        assert!((29 * 86_400..=30 * 86_400).contains(&wait), "{wait}");

        let status = status_of(&f.router, &f.admin_token).await;
        assert_eq!(status["resealing"], json!(true));
    }

    #[tokio::test]
    async fn exposed_replacement_marks_backups_and_retires_private_copies_at_once() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_backup(&f, "mine", &[(&f.admin_id, 7)]);
        // Someone else's backup: not touched.
        seed_backup(&f, "theirs", &[(&f.member_id, 9)]);
        seed_active_scope(&f, &f.admin_id, "scope-1");

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &old,
                REPLACE_DOMAIN,
                &challenge,
                Some(true),
            )),
        )
        .await;
        assert_eq!(status, 200);
        assert!(meta(&f, "cloud_rotate:mine").is_some());
        assert!(meta(&f, "cloud_rotate:theirs").is_none());
        let theirs: Value =
            serde_json::from_str(&meta(&f, "cloud_recipients:theirs:1").unwrap()).unwrap();
        assert_eq!(theirs[0]["seal_public"], json!(hex_of_seal(9)));

        // The browser sent no re-sealed scope, so it keeps the 30 days like any scope it cannot keep.
        let scope = scope_of(&f, "scope-1");
        assert_eq!(scope.state, "old_phrase");
        let wait = scope.retire_after - db::now_unix();
        assert!((29 * 86_400..=30 * 86_400).contains(&wait), "{wait}");
    }

    /// A `rescoped` entry: the scope's secret key sealed to the sealing key made from `seal_n`.
    fn rescoped_entry(scope: &str, seal_n: u8) -> Value {
        let owner = crate::backup::cloud::crypto::derive(&[seal_n; 16], "luna-test-1");
        let (secret, _) = crate::backup::cloud::crypto::new_scope_keys();
        let sealed = crate::backup::cloud::private::seal_scope_secret(
            &owner.seal_public,
            "luna-test-1",
            scope,
            &secret,
        )
        .unwrap();
        json!({ "scope": scope, "sealed_scope_secret": STANDARD.encode(sealed) })
    }

    /// The seal public key `seal_n` stands for, as stored on a scope row.
    fn seal_bytes(seal_n: u8) -> Vec<u8> {
        STANDARD.decode(seal_key_b64(seal_n)).unwrap()
    }

    #[tokio::test]
    async fn exposed_replacement_keeps_private_history_re_sealed_and_starts_no_new_scope() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        // Older history from an earlier change: not counted or touched by this save.
        seed_scope_with_state(&f, &f.admin_id, "scope-old", "old_phrase", 12_345);

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(true));
        body = with_rescoped(
            body,
            json!([rescoped_entry("scope-1", 8)]),
            &old,
            &challenge,
        );
        let (status, reply) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
        assert_eq!(reply["rescope_failed"], json!(0));

        let kept = scope_of(&f, "scope-1");
        assert_eq!(kept.state, "history");
        assert_eq!(kept.retire_after, 0);
        assert_eq!(kept.seal_public, seal_bytes(8));
        assert_eq!(kept.scope_public, vec![5; 32]);
        assert_ne!(kept.sealed_scope_secret, vec![6; 16]);
        // Nothing is active any more, so the next run starts a new scope for new data.
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            db::active_private_scope(&conn, &f.admin_id)
                .unwrap()
                .is_none()
        );
        drop(conn);
        let untouched = scope_of(&f, "scope-old");
        assert_eq!(untouched.state, "old_phrase");
        assert_eq!(untouched.retire_after, 12_345);
    }

    #[tokio::test]
    async fn change_without_exposure_keeps_the_active_scope_and_re_seals_it() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        body = with_rescoped(
            body,
            json!([rescoped_entry("scope-1", 8)]),
            &old,
            &challenge,
        );
        let (status, reply) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
        assert_eq!(reply["rescope_failed"], json!(0));

        let kept = scope_of(&f, "scope-1");
        assert_eq!(kept.state, "active");
        assert_eq!(kept.retire_after, 0);
        assert_eq!(kept.seal_public, seal_bytes(8));
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            db::active_private_scope(&conn, &f.admin_id)
                .unwrap()
                .unwrap()
                .scope,
            "scope-1"
        );
    }

    #[tokio::test]
    async fn a_scope_that_could_not_be_re_sealed_retires_with_the_grace_and_is_counted() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        seed_active_scope(&f, &f.admin_id, "scope-2");

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        body = with_rescoped(
            body,
            json!([rescoped_entry("scope-1", 8)]),
            &old,
            &challenge,
        );
        let (status, reply) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
        assert_eq!(reply["rescope_failed"], json!(1));

        assert_eq!(scope_of(&f, "scope-1").state, "active");
        let failed = scope_of(&f, "scope-2");
        assert_eq!(failed.state, "old_phrase");
        let wait = failed.retire_after - db::now_unix();
        assert!((29 * 86_400..=30 * 86_400).contains(&wait), "{wait}");
    }

    #[tokio::test]
    async fn bad_rescoped_entries_refuse_the_whole_save_and_change_nothing() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        seed_active_scope(&f, &f.member_id, "member-scope");

        // Someone else's scope in the list.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        body = with_rescoped(
            body,
            json!([
                rescoped_entry("scope-1", 8),
                rescoped_entry("member-scope", 8)
            ]),
            &old,
            &challenge,
        );
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_ne!(status, 200);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
        assert_eq!(scope_of(&f, "scope-1").seal_public, vec![0; 32]);
        assert_eq!(scope_of(&f, "member-scope").seal_public, vec![0; 32]);

        // A sealed secret of the wrong size.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        body = with_rescoped(
            body,
            json!([{ "scope": "scope-1", "sealed_scope_secret": STANDARD.encode([1u8; 10]) }]),
            &old,
            &challenge,
        );
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 400);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
        assert_eq!(scope_of(&f, "scope-1").state, "active");
    }

    #[tokio::test]
    async fn the_re_sealed_scopes_are_part_of_what_the_old_phrase_signed() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        seed_active_scope(&f, &f.admin_id, "scope-2");

        let both = json!([rescoped_entry("scope-1", 8), rescoped_entry("scope-2", 8)]);
        // Dropping an entry, or swapping one for another sealed secret, after signing is refused.
        let mut variants = Vec::new();
        let mut dropped = both.clone();
        dropped.as_array_mut().unwrap().truncate(1);
        variants.push(dropped);
        let mut swapped = both.clone();
        swapped[1] = rescoped_entry("scope-2", 8);
        variants.push(swapped);
        for altered in variants {
            let challenge = fetch_challenge(&f.router, &f.admin_token).await;
            let mut body =
                signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
            body = with_rescoped(body, both.clone(), &old, &challenge);
            body["rescoped"] = altered;
            let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
            assert_eq!(status, 403);
            assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
        }

        // The same list in another order is what was signed, so it is accepted.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        body = with_rescoped(body, both.clone(), &old, &challenge);
        body["rescoped"] = json!([both[1].clone(), both[0].clone()]);
        let (status, reply) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
    }

    #[tokio::test]
    async fn only_the_old_phrase_proof_can_re_seal_scopes() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");

        let mut body = replace_body(
            &new,
            8,
            json!({ "proof": "password", "password": "hunter22hunter1" }),
            Some(false),
        );
        body["rescoped"] = json!([rescoped_entry("scope-1", 8)]);
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 400);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
    }

    #[tokio::test]
    async fn lost_phrase_retires_private_scopes_with_the_grace_or_at_once() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        seed_scope_with_state(&f, &f.admin_id, "scope-h", "history", 0);

        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(replace_body(
                &new,
                8,
                json!({ "proof": "password", "password": "hunter22hunter1" }),
                Some(false),
            )),
        )
        .await;
        assert_eq!(status, 200);
        for id in ["scope-1", "scope-h"] {
            let wait = scope_of(&f, id).retire_after - db::now_unix();
            assert_eq!(scope_of(&f, id).state, "old_phrase");
            assert!((29 * 86_400..=30 * 86_400).contains(&wait), "{id}: {wait}");
        }
    }

    #[tokio::test]
    async fn scopes_endpoint_lists_only_the_callers_scopes_with_their_sealed_keys() {
        let f = fixture();
        seed_active_scope(&f, &f.admin_id, "scope-1");
        seed_active_scope(&f, &f.member_id, "member-scope");

        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase/scopes",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let scopes = body["scopes"].as_array().unwrap();
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0]["scope"], json!("scope-1"));
        assert_eq!(
            STANDARD
                .decode(scopes[0]["sealed_scope_secret"].as_str().unwrap())
                .unwrap(),
            vec![6u8; 16]
        );
    }

    #[tokio::test]
    async fn a_replacement_signature_is_single_use() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;

        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body.clone())).await;
        assert_eq!(status, 200);

        // Sending the very same request again fails: the challenge was used up.
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 403);
        assert_eq!(stored_auth(&f, &f.admin_id), new.public().to_vec());
    }

    #[tokio::test]
    async fn a_signature_made_for_one_set_of_new_keys_is_refused_for_another() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        let attacker = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_backup(&f, "b1", &[(&f.admin_id, 7)]);

        // Each change below keeps the observed signature and swaps one value in the request.
        type Tamper<'a> = Box<dyn Fn(&mut Value) + 'a>;
        let tampered: Vec<Tamper> = vec![
            Box::new(|b| b["seal_public"] = json!(seal_key_b64(9))),
            Box::new(|b| b["auth_public"] = json!(STANDARD.encode(attacker.public()))),
            Box::new(|b| b["self_sealed"] = json!(STANDARD.encode(b"other sealed"))),
            Box::new(|b| b["exposed"] = json!(true)),
        ];
        for tamper in tampered {
            let challenge = fetch_challenge(&f.router, &f.admin_token).await;
            let mut body =
                signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
            tamper(&mut body);
            let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
            assert_eq!(status, 403);
            assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
        }
        assert!(meta(&f, "cloud_rotate:b1").is_none());

        // The untouched request still works with a fresh challenge.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let body = signed_replace_body(&new, 8, &old, REPLACE_DOMAIN, &challenge, Some(false));
        let (status, _) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200);
        assert_eq!(stored_auth(&f, &f.admin_id), new.public().to_vec());
    }

    #[tokio::test]
    async fn a_wrong_or_other_domain_signature_is_refused_and_changes_nothing() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_backup(&f, "b1", &[(&f.admin_id, 7)]);

        // A phrase-check signature must not work as a replacement.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &old,
                CHECK_DOMAIN,
                &challenge,
                Some(true),
            )),
        )
        .await;
        assert_eq!(status, 403);

        // A signature from some other key.
        let stranger = Signer::generate();
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &stranger,
                REPLACE_DOMAIN,
                &challenge,
                Some(true),
            )),
        )
        .await;
        assert_eq!(status, 403);

        // No challenge was asked for (or it was already used).
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(signed_replace_body(
                &new,
                8,
                &old,
                REPLACE_DOMAIN,
                &[0u8; 32],
                Some(true),
            )),
        )
        .await;
        assert_eq!(status, 403);

        // Nothing moved.
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());
        assert!(meta(&f, "cloud_rotate:b1").is_none());
        assert!(
            !status_of(&f.router, &f.admin_token).await["resealing"]
                .as_bool()
                .unwrap()
        );
    }

    #[tokio::test]
    async fn the_luna_password_can_replace_a_lost_phrase() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;

        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(replace_body(
                &new,
                8,
                json!({ "proof": "password", "password": "not-it-at-all" }),
                Some(false),
            )),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());

        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(replace_body(
                &new,
                8,
                json!({ "proof": "password", "password": "hunter22hunter1" }),
                Some(false),
            )),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(stored_auth(&f, &f.admin_id), new.public().to_vec());
    }

    #[tokio::test]
    async fn guessing_the_password_locks_out_like_signing_in() {
        let f = fixture();
        let old = Signer::generate();
        let new = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;

        for _ in 0..10 {
            let (status, _) = send(
                &f.router,
                "PUT",
                PUT,
                &f.admin_token,
                Some(replace_body(
                    &new,
                    8,
                    json!({ "proof": "password", "password": "wrong-guess" }),
                    Some(false),
                )),
            )
            .await;
            assert_eq!(status, 403);
        }
        // Even the right password is refused while locked.
        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.admin_token,
            Some(replace_body(
                &new,
                8,
                json!({ "proof": "password", "password": "hunter22hunter1" }),
                Some(false),
            )),
        )
        .await;
        assert_eq!(status, 429);
        assert_eq!(stored_auth(&f, &f.admin_id), old.public().to_vec());

        // It is the same bucket as signing in, so the lockout is shared.
        assert!(
            !f.state
                .login_limiter
                .allow(&crate::api::auth::login_user_key("Max"))
        );
    }

    #[tokio::test]
    async fn a_member_replaces_only_their_own_phrase() {
        let f = fixture();
        let admin_old = Signer::generate();
        let member_old = Signer::generate();
        let member_new = Signer::generate();
        set_first(&f, &f.admin_token, &admin_old, 7).await;
        set_first(&f, &f.member_token, &member_old, 9).await;
        seed_backup(&f, "shared", &[(&f.admin_id, 7), (&f.member_id, 9)]);

        let (status, _) = send(
            &f.router,
            "PUT",
            PUT,
            &f.member_token,
            Some(replace_body(
                &member_new,
                11,
                json!({ "proof": "password", "password": "hunter22hunter1" }),
                Some(true),
            )),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(stored_auth(&f, &f.member_id), member_new.public().to_vec());
        assert_eq!(stored_auth(&f, &f.admin_id), admin_old.public().to_vec());

        let readers: Value =
            serde_json::from_str(&meta(&f, "cloud_recipients:shared:1").unwrap()).unwrap();
        assert_eq!(readers[0]["seal_public"], json!(hex_of_seal(7)));
        assert_eq!(readers[1]["seal_public"], json!(hex_of_seal(11)));
        assert!(meta(&f, "cloud_rotate:shared").is_some());
        // The Admin has nothing pending.
        assert!(
            !status_of(&f.router, &f.admin_token).await["resealing"]
                .as_bool()
                .unwrap()
        );
        assert!(
            status_of(&f.router, &f.member_token).await["resealing"]
                .as_bool()
                .unwrap()
        );
    }

    /// Changes the phrase with the old phrase's proof, re-sealing `scope-1`.
    async fn change_keeping_scope(f: &Fixture, old: &Signer, exposed: bool) -> Signer {
        let new = Signer::generate();
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let mut body = signed_replace_body(&new, 8, old, REPLACE_DOMAIN, &challenge, Some(exposed));
        body = with_rescoped(body, json!([rescoped_entry("scope-1", 8)]), old, &challenge);
        let (status, reply) = send(&f.router, "PUT", PUT, &f.admin_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
        new
    }

    async fn kept_list(f: &Fixture, token: &str) -> Vec<Value> {
        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase/kept-scopes",
            token,
            None,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        body["kept"].as_array().unwrap().clone()
    }

    #[tokio::test]
    async fn an_unexposed_change_keeps_the_previous_secret_for_30_days_for_its_owner_only() {
        let f = fixture();
        let old = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        let before = db::now_unix();
        change_keeping_scope(&f, &old, false).await;

        let kept = kept_list(&f, &f.admin_token).await;
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["scope"], json!("scope-1"));
        assert_eq!(
            kept[0]["sealed_scope_secret"],
            json!(STANDARD.encode(vec![6u8; 16]))
        );
        assert_eq!(
            kept[0]["seal_public"],
            json!(STANDARD.encode(vec![0u8; 32]))
        );
        let wait = kept[0]["expires_at"].as_i64().unwrap() - before;
        assert!((29 * 86_400..=30 * 86_400 + 5).contains(&wait), "{wait}");
        // The current copy is the new one, not the kept one.
        assert_ne!(scope_of(&f, "scope-1").sealed_scope_secret, vec![6; 16]);
        // Someone else never sees it.
        assert!(kept_list(&f, &f.member_token).await.is_empty());
    }

    #[tokio::test]
    async fn an_exposed_change_keeps_nothing_and_drops_copies_kept_earlier() {
        let f = fixture();
        let old = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::keep_scope_secret(
                &conn,
                &db::KeptScopeSecret {
                    scope: "scope-1".into(),
                    seal_public: vec![1; 32],
                    sealed_scope_secret: vec![9; 16],
                    expires_at: db::now_unix() + 1000,
                },
            )
            .unwrap();
        }
        change_keeping_scope(&f, &old, true).await;
        assert!(kept_list(&f, &f.admin_token).await.is_empty());
    }

    #[tokio::test]
    async fn checking_the_new_phrase_drops_the_kept_copy() {
        let f = fixture();
        let old = Signer::generate();
        set_first(&f, &f.admin_token, &old, 7).await;
        seed_active_scope(&f, &f.admin_id, "scope-1");
        let new = change_keeping_scope(&f, &old, false).await;
        assert_eq!(kept_list(&f, &f.admin_token).await.len(), 1);

        // A wrong phrase check leaves it.
        let wrong = Signer::generate();
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&wrong, &challenge) })),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(kept_list(&f, &f.admin_token).await.len(), 1);

        // The new phrase checked successfully: the kept copy goes.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&new, &challenge) })),
        )
        .await;
        assert_eq!(status, 200);
        assert!(kept_list(&f, &f.admin_token).await.is_empty());
    }

    #[test]
    fn kept_copies_expire_and_go_with_their_scope() {
        let conn = db::open(std::path::Path::new(":memory:")).unwrap();
        db::insert_user(&conn, "u", "u", "U", "x", "admin").unwrap();
        for scope in ["a", "b"] {
            db::insert_private_scope(
                &conn,
                &db::PrivateScope {
                    scope: scope.into(),
                    owner: "u".into(),
                    seal_public: vec![0; 32],
                    scope_public: vec![5; 32],
                    sealed_scope_secret: vec![6; 16],
                    dedup_key: vec![0; 32],
                    state: "active".into(),
                    retire_after: 0,
                    created_at: 0,
                },
            )
            .unwrap();
            db::keep_scope_secret(
                &conn,
                &db::KeptScopeSecret {
                    scope: scope.into(),
                    seal_public: vec![1; 32],
                    sealed_scope_secret: vec![9; 16],
                    expires_at: if scope == "a" { 100 } else { 500 },
                },
            )
            .unwrap();
        }
        assert_eq!(
            db::list_kept_scope_secrets(&conn, "u", 50).unwrap().len(),
            2
        );
        // Expired copies are not listed, and the sweep removes them.
        assert_eq!(
            db::list_kept_scope_secrets(&conn, "u", 100).unwrap().len(),
            1
        );
        db::clear_expired_kept_scope_secrets(&conn, 100).unwrap();
        db::delete_private_scope(&conn, "b").unwrap();
        assert!(
            db::list_kept_scope_secrets(&conn, "u", 0)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn check_accepts_right_and_refuses_wrong_words_and_expired_challenges() {
        let f = fixture();
        let signer = Signer::generate();
        send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&signer, None)),
        )
        .await;

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
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            json!("That doesn't match the recovery phrase set for your account.")
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
    async fn low_order_x25519_half_is_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        // The X25519 half is the identity point; the ML-KEM half is a real key.
        let mut key = STANDARD.decode(seal_key_b64(7)).unwrap();
        key[..32].fill(0);
        bad["seal_public"] = json!(STANDARD.encode(key));
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(bad),
        )
        .await;
        assert_eq!(status, 400);
        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(body["set"], json!(false));
    }

    #[tokio::test]
    async fn invalid_mlkem_key_is_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        // A key of the right length whose ML-KEM half fails the FIPS 203 check.
        let mut key = STANDARD.decode(seal_key_b64(7)).unwrap();
        key[32] = 0xff;
        key[33] |= 0x0f;
        bad["seal_public"] = json!(STANDARD.encode(key));
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(bad),
        )
        .await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn a_short_x25519_only_key_is_refused() {
        let f = fixture();
        let signer = Signer::generate();
        let mut bad = set_body(&signer, None);
        bad["seal_public"] = json!(STANDARD.encode([7u8; 32]));
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(bad),
        )
        .await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn sealing_key_already_used_by_another_user_is_refused() {
        let f = fixture();
        // set_body uses the same sealing key (7s) for everyone.
        let admin_signer = Signer::generate();
        send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&admin_signer, None)),
        )
        .await;

        let member_signer = Signer::generate();
        let (status, body) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.member_token,
            Some(set_body(&member_signer, None)),
        )
        .await;
        assert_eq!(status, 409);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .contains("already used by another account")
        );
    }

    #[tokio::test]
    async fn another_user_cannot_touch_your_phrase() {
        let f = fixture();
        let admin_signer = Signer::generate();
        send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&admin_signer, None)),
        )
        .await;

        // The member sees no phrase of their own, and writes only their own record.
        let (_, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(body["set"], json!(false));

        // The member's change attempt cannot use the admin's key: it is judged against the
        // member's own (empty) record, so it is a first set, and the admin keeps theirs.
        // The member uses their own sealing key: the admin's key is already registered.
        let member_signer = Signer::generate();
        let mut member_body = set_body(&member_signer, None);
        member_body["seal_public"] = json!(seal_key_b64(9));
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.member_token,
            Some(member_body),
        )
        .await;
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
        let (status, first) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/identity",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let luna_id = first["luna_id"].as_str().unwrap().to_string();
        assert!(!luna_id.is_empty());
        let public = STANDARD
            .decode(first["signing_public"].as_str().unwrap())
            .unwrap();
        assert_eq!(public.len(), crate::backup::cloud::crypto::SIG_PUBLIC_LEN);

        // A second call returns the same identity rather than minting another.
        let (status, second) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/identity",
            &f.admin_token,
            None,
        )
        .await;
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
            db::upsert_drive(
                &conn,
                "d1",
                "Photos",
                "as_is",
                "ext4",
                "d1",
                root.to_str().unwrap(),
            )
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
        let (status, _) = send(
            &router,
            "POST",
            "/api/v1/cloud/identity",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);

        // Step 2: the Admin sets the recovery phrase (keys) on a fresh Luna.
        let signer = Signer::generate();
        let (status, _) = send(
            &router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&signer, None)),
        )
        .await;
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

        let (status, list) = send(
            &router,
            "GET",
            "/api/v1/cloud/backups",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    /// Reads the status as `token`, asserting a 200.
    async fn status_of(router: &Router, token: &str) -> Value {
        let (status, body) = send(router, "GET", "/api/v1/cloud/phrase", token, None).await;
        assert_eq!(status, 200);
        body
    }

    /// Makes an old-phrase scope for `owner` with one copy per id in `snapshot_ids`.
    fn seed_old_copies(
        state: &AppState,
        owner: &str,
        scope: &str,
        retire_after: i64,
        snapshot_ids: &[&str],
    ) {
        let mut conn = state.db.lock().unwrap_or_else(|p| p.into_inner());
        let protection = format!("p-{scope}");
        db::insert_protection(
            &conn,
            &db::NewProtection {
                id: &protection,
                kind: db::PROTECTION_CLOUD,
                source_drive: "d1",
                // Unique per scope: the protections table allows one row per source path.
                source_path: &protection,
                target_drive: "",
                private_owner: owner,
                created_by: owner,
                created_at: 0,
            },
        )
        .unwrap();
        db::insert_private_scope(
            &conn,
            &db::PrivateScope {
                scope: scope.to_string(),
                owner: owner.to_string(),
                seal_public: vec![0; 32],
                scope_public: vec![5; 32],
                sealed_scope_secret: vec![6; 16],
                dedup_key: vec![0; 32],
                state: "old_phrase".to_string(),
                retire_after,
                created_at: 0,
            },
        )
        .unwrap();
        for id in snapshot_ids {
            db::commit_private_snapshot_tx(
                &mut conn,
                &db::SnapshotInsert {
                    id: id.to_string(),
                    protection_id: protection.clone(),
                    created_at: 0,
                    key_version: 0,
                    tree_pack_id: "tree-pack".to_string(),
                    record: Vec::new(),
                },
                &[],
                scope,
                b"{}",
            )
            .unwrap();
        }
    }

    #[tokio::test]
    async fn status_without_a_phrase_reports_never_checked_and_no_copies() {
        let f = fixture();
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(body["set"], json!(false));
        assert_eq!(body["last_checked_at"], json!(0));
        assert_eq!(body["phrase_words"], json!(0));
        assert_eq!(
            body["old_phrase_copies"],
            json!({ "count": 0, "removed_at": null })
        );
    }

    #[tokio::test]
    async fn status_after_setting_a_phrase_is_never_checked_until_checked() {
        let f = fixture();
        let signer = Signer::generate();
        send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(set_body(&signer, None)),
        )
        .await;
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(body["set"], json!(true));
        assert_eq!(body["last_checked_at"], json!(0));
        assert_eq!(body["phrase_words"], json!(0));

        // A passed check moves last_checked_at to the time of the check.
        let before = db::now_unix();
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&signer, &challenge) })),
        )
        .await;
        assert_eq!(status, 200);
        let after = db::now_unix();
        let body = status_of(&f.router, &f.admin_token).await;
        let checked = body["last_checked_at"].as_i64().unwrap();
        assert!(
            (before..=after).contains(&checked),
            "last_checked_at {checked} not within {before}..={after}"
        );
    }

    #[tokio::test]
    async fn words_is_stored_and_reported() {
        let f = fixture();
        let signer = Signer::generate();
        let mut body = set_body(&signer, None);
        body["words"] = json!(24);
        let (status, _) = send(
            &f.router,
            "PUT",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            Some(body),
        )
        .await;
        assert_eq!(status, 200);
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(body["phrase_words"], json!(24));

        // A passed check keeps the length.
        let challenge = fetch_challenge(&f.router, &f.admin_token).await;
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/phrase/check",
            &f.admin_token,
            Some(json!({ "signature": sign_challenge(&signer, &challenge) })),
        )
        .await;
        assert_eq!(status, 200);
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(body["phrase_words"], json!(24));
    }

    #[tokio::test]
    async fn words_other_than_12_or_24_are_refused() {
        let f = fixture();
        for words in [json!(0), json!(13), json!(11)] {
            let mut body = set_body(&Signer::generate(), None);
            body["words"] = words.clone();
            let (status, body) = send(
                &f.router,
                "PUT",
                "/api/v1/cloud/phrase",
                &f.admin_token,
                Some(body),
            )
            .await;
            assert_eq!(status, 400, "words {words} should be refused");
            assert_eq!(
                body["error"],
                json!("A recovery phrase has 12 or 24 words.")
            );
        }
        // Nothing was saved.
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(body["set"], json!(false));
    }

    #[tokio::test]
    async fn old_phrase_copies_are_counted_with_the_earliest_removal_time() {
        let f = fixture();
        let owner = f.admin_id.clone();
        seed_old_copies(
            &f.state,
            &owner,
            &"aa".repeat(16),
            1_900_000_000,
            &["s-a1", "s-a2"],
        );
        seed_old_copies(&f.state, &owner, &"bb".repeat(16), 1_800_000_000, &["s-b1"]);
        // A scope with no copies in it adds nothing.
        seed_old_copies(&f.state, &owner, &"cc".repeat(16), 1_700_000_000, &[]);
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(
            body["old_phrase_copies"],
            json!({ "count": 3, "removed_at": 1_800_000_000i64 })
        );
    }

    #[tokio::test]
    async fn old_phrase_copies_without_a_removal_time_report_null() {
        let f = fixture();
        let owner = f.admin_id.clone();
        seed_old_copies(&f.state, &owner, &"dd".repeat(16), 0, &["s-d1"]);
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(
            body["old_phrase_copies"],
            json!({ "count": 1, "removed_at": null })
        );
    }

    #[tokio::test]
    async fn old_phrase_copies_are_only_the_callers_own() {
        let f = fixture();
        let admin_id = f.admin_id.clone();
        let member_id = f.member_id.clone();
        seed_old_copies(
            &f.state,
            &admin_id,
            &"ee".repeat(16),
            1_900_000_000,
            &["s-e1"],
        );
        seed_old_copies(
            &f.state,
            &member_id,
            &"ff".repeat(16),
            1_800_000_000,
            &["s-f1", "s-f2"],
        );
        let body = status_of(&f.router, &f.admin_token).await;
        assert_eq!(
            body["old_phrase_copies"],
            json!({ "count": 1, "removed_at": 1_900_000_000i64 })
        );
        let body = status_of(&f.router, &f.member_token).await;
        assert_eq!(
            body["old_phrase_copies"],
            json!({ "count": 2, "removed_at": 1_800_000_000i64 })
        );
    }

    #[tokio::test]
    async fn status_refuses_with_a_read_error_when_the_keys_cannot_be_read() {
        let f = fixture();
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute_batch("DROP TABLE user_keys").unwrap();
        }
        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 500);
        assert_eq!(
            body["error"],
            json!("Could not read your recovery phrase details. Try again.")
        );
    }

    #[tokio::test]
    async fn status_refuses_with_a_read_error_when_old_copies_cannot_be_read() {
        let f = fixture();
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute_batch("DROP TABLE cloud_private_scopes")
                .unwrap();
        }
        let (status, body) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/phrase",
            &f.admin_token,
            None,
        )
        .await;
        assert_eq!(status, 500);
        assert_eq!(
            body["error"],
            json!("Could not read your recovery phrase details. Try again.")
        );
    }

    #[test]
    fn check_due_after_90_days() {
        let now = 100_000_000;
        let keys = |phrase_set_at: i64, last_checked_at: i64| db::UserKeys {
            user_id: "u1".into(),
            seal_public: vec![],
            auth_public: vec![],
            self_sealed: vec![],
            phrase_set_at,
            last_checked_at,
            phrase_words: 0,
        };
        // Set 91 days ago and never checked: due.
        assert!(phrase_check_due(Some(&keys(now - 91 * 86_400, 0)), now));
        // Checked a day ago: not due, even though the phrase is old.
        assert!(!phrase_check_due(
            Some(&keys(now - 91 * 86_400, now - 86_400)),
            now
        ));
        // Set just under 90 days ago and never checked: not due yet.
        assert!(!phrase_check_due(Some(&keys(now - 89 * 86_400, 0)), now));
    }

    #[test]
    fn check_not_due_when_no_phrase_is_set() {
        assert!(!phrase_check_due(None, 100_000_000));
    }
}
