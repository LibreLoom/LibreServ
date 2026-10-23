//! Cloud backup keys and recipients: which users can read a shared backup, the versioned backup
//! key that protects it, and the sealed copies and signed recipient list Connect keeps for it.
//!
//! A new key version starts whenever the recipient set changes (someone added or removed) or a
//! recipient's recovery keys change (they set a new phrase).
//! Each recipient gets their own sealed copy of the version's keys, and one signed record lists
//! who the version was sealed to, so a browser can check it before trusting anything.
//!
//! Replacing a phrase has two parts. An unexposed replacement only swaps the saved public key in
//! each reader list (`replace_reader`), so no new version starts. An exposed one also marks each
//! backup to rotate (`mark_rotate`), and `ensure_key` then starts the next version on the next run.
//! The person's copies of every version they are on are then re-sealed (`reseal_user`).

use anyhow::{Context, Result, anyhow, bail};
use rand_core::{OsRng, RngCore};
use rusqlite::{Connection, params};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::crypto::{self, SealPublic, SealSecret, SigBytes, SigPublic};
use super::identity;
use super::store::CloudStore;
use crate::db::{self, BackupKey};

/// Record kind for sealed key copies, one per recipient per key version.
const KEYS_KIND: &str = "keys";
/// Record kind for the signed recipient list, one per key version.
const RECIPIENTS_KIND: &str = "recipients";
/// Signature domain for the recipient list.
const RECIPIENTS_DOMAIN: &str = "recipients";

/// Signing domain for one sealed key copy. Luna signs each copy, so Connect cannot swap one out.
const KEY_COPY_DOMAIN: &str = "key-copy";

/// Length of the Ed25519 signature stored after each sealed key copy.
const KEY_COPY_SIG_LEN: usize = crypto::SIG_LEN;
/// Meta key prefix for the recipient list each key version was created for.
const META_PREFIX: &str = "cloud_recipients";
/// Meta key prefix for a backup's pending rotation, `cloud_rotate:<backup>`.
const ROTATE_META_PREFIX: &str = "cloud_rotate";
/// Value of a rotation mark: start the next version and keep the dedup key.
const ROTATE_VALUE: &str = "keep_dedup";
/// Meta key prefix for a user's pending re-seal, `cloud_reseal:<user part>`.
const RESEAL_META_PREFIX: &str = "cloud_reseal";
/// Glob that matches every saved reader list in meta.
const READERS_META_GLOB: &str = "cloud_recipients:*";
/// Record kind for the signed list of every user's recovery keys on this Luna.
pub(crate) const USERS_KIND: &str = "users";
/// Record name for that list. There is one per Luna.
pub(crate) const USERS_LIST_NAME: &str = "list";
/// Signature domain for the user list.
const USERS_DOMAIN: &str = "users";

/// One user as given to `publish_user_list`: `(user id, sealing public key, auth public key, self-sealed signing key)`.
type UserListEntry = (String, SealPublic, SigPublic, Vec<u8>);

/// The users who may read a shared backup, sorted and without duplicates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipients {
    /// Sorted user ids.
    pub users: Vec<String>,
}

impl Recipients {
    /// Sort and de-duplicate `users`, so equal sets always compare equal.
    pub fn new(mut users: Vec<String>) -> Self {
        users.sort();
        users.dedup();
        Self { users }
    }
}

/// Record name for a user's sealed copy: a user id can contain characters a record name cannot,
/// so it is stored as the hex of the first 16 bytes of its SHA-256 (32 lowercase hex characters).
pub fn user_record_part(user_id: &str) -> String {
    let digest = Sha256::digest(user_id.as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Record name for one user's sealed copy of one key version: `<protection>.<version>.<user part>`.
pub fn key_record_name(protection_id: &str, version: i64, user_id: &str) -> String {
    format!("{protection_id}.{version}.{}", user_record_part(user_id))
}

/// Record name for the signed recipient list of one key version: `<protection>.<version>`.
pub fn recipients_record_name(protection_id: &str, version: i64) -> String {
    format!("{protection_id}.{version}")
}

fn recipients_meta_key(protection_id: &str, version: i64) -> String {
    format!("{META_PREFIX}:{protection_id}:{version}")
}

fn rotate_meta_key(protection_id: &str) -> String {
    format!("{ROTATE_META_PREFIX}:{protection_id}")
}

/// Pending re-seal for one user. The user id is hashed so the key is always a safe name; the value
/// holds the real user id and the sealing key the re-seal was queued for.
fn reseal_meta_key(user_id: &str) -> String {
    format!("{RESEAL_META_PREFIX}:{}", user_record_part(user_id))
}

/// Associated data for a sealed key copy. It binds the copy to this Luna, backup, version and user,
/// so a copy cannot be moved to another backup or user and still open.
fn key_aad(luna_id: &str, protection_id: &str, version: i64, user_id: &str) -> Vec<u8> {
    crypto::canonical(&[
        ("luna_id", luna_id.as_bytes()),
        ("protection_id", protection_id.as_bytes()),
        ("version", version.to_string().as_bytes()),
        ("user_id", user_id.as_bytes()),
    ])
}

/// Signed bytes for one key copy: the association data plus the sealed bytes.
fn key_copy_message(aad: &[u8], sealed: &[u8]) -> Vec<u8> {
    crypto::canonical(&[("aad", aad), ("sealed", sealed)])
}

/// Signed bytes for the recipient list: the same binding as the key copies, plus the sorted list.
fn recipients_message(
    luna_id: &str,
    protection_id: &str,
    version: i64,
    users: &[String],
) -> Vec<u8> {
    crypto::canonical(&[
        ("luna_id", luna_id.as_bytes()),
        ("protection_id", protection_id.as_bytes()),
        ("version", version.to_string().as_bytes()),
        ("users", json!(users).to_string().as_bytes()),
    ])
}

fn random_32() -> [u8; 32] {
    let mut out = [0u8; 32];
    OsRng.fill_bytes(&mut out);
    out
}

/// The recipient list as saved in meta: each user with the hex of their sealing public key (X25519 and ML-KEM).
/// A user with no recovery phrase gets an empty key, so a change to "no phrase" also counts.
fn readers_json(conn: &Connection, recipients: &Recipients) -> Result<serde_json::Value> {
    let mut readers = Vec::with_capacity(recipients.users.len());
    for user in &recipients.users {
        let public = db::get_user_keys(conn, user)?
            .map(|keys| {
                keys.seal_public
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            })
            .unwrap_or_default();
        readers.push(json!({ "user_id": user, "seal_public": public }));
    }
    Ok(serde_json::Value::Array(readers))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Run `f` inside a savepoint: its writes all land, or none do. Works inside a caller's transaction too.
fn savepoint<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("SAVEPOINT cloud_keys")?;
    match f() {
        Ok(value) => {
            conn.execute_batch("RELEASE cloud_keys")?;
            Ok(value)
        }
        Err(err) => {
            // Undo this savepoint's writes. Nothing more to do if the rollback itself fails.
            let _ = conn.execute_batch("ROLLBACK TO cloud_keys; RELEASE cloud_keys");
            Err(err)
        }
    }
}

fn delete_meta(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])?;
    Ok(())
}

/// The reader list saved for one version, or `None` when the version has no record.
fn saved_readers(
    conn: &Connection,
    protection_id: &str,
    version: i64,
) -> Result<Option<serde_json::Value>> {
    let Some(text) = db::get_meta(conn, &recipients_meta_key(protection_id, version))? else {
        return Ok(None);
    };
    let saved =
        serde_json::from_str(&text).context("The saved list of backup readers is damaged.")?;
    Ok(Some(saved))
}

/// The user ids in a saved reader list, in the order they were saved.
fn reader_ids(readers: &serde_json::Value) -> Vec<String> {
    readers
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("user_id")?.as_str().map(str::to_string))
        .collect()
}

/// Every `(backup id, version)` whose saved reader list names `user_id`, sorted.
/// A version the user was removed from is not listed, because its reader list does not name them.
fn reader_versions(conn: &Connection, user_id: &str) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE key GLOB ?1")?;
    let rows = stmt
        .query_map([READERS_META_GLOB], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for (key, text) in rows {
        let Some(rest) = key.strip_prefix(&format!("{META_PREFIX}:")) else {
            continue;
        };
        let Some((backup, version)) = rest.rsplit_once(':') else {
            continue;
        };
        let Ok(version) = version.parse::<i64>() else {
            continue;
        };
        // A deleted backup has no keys to re-seal. A reader list left behind must not count its
        // versions as missing, which would block every later re-seal.
        if db::get_protection(conn, backup)?.is_none()
            && db::get_meta(conn, &format!("deleted_backup:{backup}"))?.is_some()
        {
            continue;
        }
        let readers: serde_json::Value =
            serde_json::from_str(&text).context("The saved list of backup readers is damaged.")?;
        if reader_ids(&readers).iter().any(|id| id == user_id) {
            out.push((backup.to_string(), version));
        }
    }
    out.sort();
    Ok(out)
}

/// [`reader_versions`] for tests in other modules.
#[cfg(test)]
pub(crate) fn reader_versions_for_test(conn: &Connection, user_id: &str) -> Vec<(String, i64)> {
    reader_versions(conn, user_id).unwrap()
}

/// Return the latest key version for `protection_id` if it was created for exactly `recipients`
/// with the same recovery keys. Otherwise create the next version with fresh random keys.
/// A changed recovery phrase counts as a change: the old copies are sealed to the old key.
/// The recipient list and their keys are recorded in the meta table for the new version, so the
/// next call can compare against it.
///
/// A pending rotation (`mark_rotate`) always starts the next version. It keeps the latest version's
/// dedup key only while the same people are readers, so a newcomer or a removal gets a fresh one.
/// The rotation mark is cleared in the same savepoint as the new version.
///
/// Nothing is published here; call `publish_key` with the returned key.
pub fn ensure_key(
    conn: &Connection,
    protection_id: &str,
    recipients: &Recipients,
    now: i64,
) -> Result<BackupKey> {
    let readers = readers_json(conn, recipients)?;
    let latest = db::latest_backup_key(conn, protection_id)?;
    let rotate = db::get_meta(conn, &rotate_meta_key(protection_id))?.is_some();
    // A version with no recipient record is never reused: nothing shows who it was made for.
    let saved = match &latest {
        Some(latest) => saved_readers(conn, protection_id, latest.version)?,
        None => None,
    };
    if let (Some(latest), Some(saved)) = (&latest, &saved)
        && !rotate
        && *saved == readers
    {
        return Ok(latest.clone());
    }

    let same_people = saved
        .as_ref()
        .is_some_and(|saved| reader_ids(saved) == recipients.users);
    let dedup_key = match &latest {
        Some(latest) if rotate && same_people => latest.dedup_key.clone(),
        _ => random_32().to_vec(),
    };
    let version = latest.as_ref().map_or(1, |latest| latest.version + 1);
    let key = BackupKey {
        protection_id: protection_id.to_string(),
        version,
        key: random_32().to_vec(),
        dedup_key,
        created_at: now,
    };
    savepoint(conn, || {
        db::insert_backup_key(conn, &key)?;
        db::set_meta(
            conn,
            &recipients_meta_key(protection_id, version),
            &readers.to_string(),
        )?;
        delete_meta(conn, &rotate_meta_key(protection_id))
    })?;
    Ok(key)
}

/// Swap `user_id`'s sealing public key in every saved reader list that names them. Call this inside
/// the caller's transaction. It writes nothing else, so the next `ensure_key` sees the same readers
/// and starts no new version. Returns how many lists changed.
pub fn replace_reader(conn: &Connection, user_id: &str, new_seal_public: &[u8]) -> Result<usize> {
    let public = hex_encode(new_seal_public);
    let rows = {
        let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE key GLOB ?1")?;
        stmt.query_map([READERS_META_GLOB], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut changed = 0;
    for (key, text) in rows {
        let mut readers: serde_json::Value =
            serde_json::from_str(&text).context("The saved list of backup readers is damaged.")?;
        let mut touched = false;
        for reader in readers.as_array_mut().into_iter().flatten() {
            let names_user = reader.get("user_id").and_then(|v| v.as_str()) == Some(user_id);
            let same_key =
                reader.get("seal_public").and_then(|v| v.as_str()) == Some(public.as_str());
            if names_user && !same_key {
                reader["seal_public"] = json!(public);
                touched = true;
            }
        }
        if touched {
            conn.execute(
                "UPDATE meta SET value = ?1 WHERE key = ?2",
                params![readers.to_string(), key],
            )?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// The backups whose newest key version names `user_id` as a reader. These are the ones a leaked
/// phrase of theirs still opens new data for, so they are the ones to rotate.
pub fn current_backups_of(conn: &Connection, user_id: &str) -> Result<Vec<String>> {
    let mut newest: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for (backup, version) in reader_versions(conn, user_id)? {
        let entry = newest.entry(backup).or_insert(version);
        *entry = (*entry).max(version);
    }
    let mut out = Vec::new();
    for (backup, version) in newest {
        let latest = db::list_backup_keys(conn, &backup)?
            .iter()
            .map(|k| k.version)
            .max();
        if latest == Some(version) {
            out.push(backup);
        }
    }
    Ok(out)
}

/// Ask for a new key version on `backup_id` at its next run. `ensure_key` consumes the mark. The
/// save never creates the version itself, so the run publishes it to every recipient.
pub fn mark_rotate(conn: &Connection, backup_id: &str) -> Result<()> {
    db::set_meta(conn, &rotate_meta_key(backup_id), ROTATE_VALUE)
}
/// Seal one key copy for one user: the key and dedup key, sealed to `public`, then signed by Luna.
/// `aad` must be `key_aad` for the same backup, version and user.
fn seal_copy(
    signer: &crypto::Signer,
    public: &SealPublic,
    aad: &[u8],
    key: &[u8],
    dedup_key: &[u8],
) -> Result<Vec<u8>> {
    if key.len() != 32 || dedup_key.len() != 32 {
        bail!("The backup key is damaged and cannot be shared.");
    }
    let mut plain = Vec::with_capacity(64);
    plain.extend_from_slice(key);
    plain.extend_from_slice(dedup_key);
    let sealed = crypto::seal(public, aad, &plain)?;
    let signature = signer.sign(KEY_COPY_DOMAIN, &key_copy_message(aad, &sealed));
    let mut record = sealed;
    record.extend_from_slice(&signature);
    Ok(record)
}

/// Seal `key` and `dedup_key` to every recipient and store the copies, then store the signed
/// recipient list. `user_pub` gives each user's sealing public key (X25519 and ML-KEM), or `None` if they have none.
pub fn publish_key(
    store: &dyn CloudStore,
    signer: &crypto::Signer,
    luna_id: &str,
    protection_id: &str,
    key: &BackupKey,
    recipients: &Recipients,
    user_pub: impl Fn(&str) -> Option<SealPublic>,
) -> Result<()> {
    if key.key.len() != 32 || key.dedup_key.len() != 32 {
        bail!("The backup key is damaged and cannot be shared.");
    }

    for user in &recipients.users {
        let public = user_pub(user)
            .with_context(|| format!("User {user} has not set a recovery phrase yet."))?;
        let aad = key_aad(luna_id, protection_id, key.version, user);
        let record = seal_copy(signer, &public, &aad, &key.key, &key.dedup_key)?;
        store.put_record(
            KEYS_KIND,
            &key_record_name(protection_id, key.version, user),
            &record,
        )?;
    }

    let message = recipients_message(luna_id, protection_id, key.version, &recipients.users);
    let signature = signer.sign(RECIPIENTS_DOMAIN, &message);
    let body = json!({
        "users": recipients.users,
        "signature": signature.iter().map(|b| format!("{b:02x}")).collect::<String>(),
    });
    store.put_record(
        RECIPIENTS_KIND,
        &recipients_record_name(protection_id, key.version),
        body.to_string().as_bytes(),
    )?;
    Ok(())
}

/// Open one stored key copy (sealed bytes followed by Luna's signature). Returns `(key, dedup_key)`.
/// The signature is checked first, against `luna_public`, so a copy that was changed or not made
/// by this Luna is refused before anything is decrypted.
pub fn open_key(
    record: &[u8],
    user_secret: &SealSecret,
    luna_public: &SigPublic,
    luna_id: &str,
    protection_id: &str,
    version: i64,
    user_id: &str,
) -> Result<([u8; 32], [u8; 32])> {
    let aad = key_aad(luna_id, protection_id, version, user_id);
    if record.len() <= KEY_COPY_SIG_LEN {
        bail!("This backup key copy is damaged.");
    }
    let (sealed, sig_bytes) = record.split_at(record.len() - KEY_COPY_SIG_LEN);
    let mut signature = [0u8; KEY_COPY_SIG_LEN];
    signature.copy_from_slice(sig_bytes);
    if !crypto::verify(
        luna_public,
        KEY_COPY_DOMAIN,
        &key_copy_message(&aad, sealed),
        &signature,
    ) {
        bail!("This backup key copy was not made by this Luna. It may have been changed.");
    }
    let plain = crypto::open(user_secret, &aad, sealed)?;
    if plain.len() != 64 {
        bail!("This backup key copy is damaged.");
    }
    let mut key = [0u8; 32];
    let mut dedup = [0u8; 32];
    key.copy_from_slice(&plain[..32]);
    dedup.copy_from_slice(&plain[32..]);
    Ok((key, dedup))
}

/// Check a signed recipient list read back from the store. Returns the listed user ids if the
/// signature is valid for this Luna, backup and version, and `None` otherwise.
pub fn verify_recipients(
    bytes: &[u8],
    public: &SigPublic,
    luna_id: &str,
    protection_id: &str,
    version: i64,
) -> Option<Vec<String>> {
    let body: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let users: Vec<String> = serde_json::from_value(body.get("users")?.clone()).ok()?;
    let hex = body.get("signature")?.as_str()?;
    let sig = decode_hex_sig(hex)?;
    let message = recipients_message(luna_id, protection_id, version, &users);
    crypto::verify(public, RECIPIENTS_DOMAIN, &message, &sig).then_some(users)
}

fn decode_hex_sig(hex: &str) -> Option<SigBytes> {
    if hex.len() != crypto::SIG_LEN * 2 {
        return None;
    }
    let mut out = [0u8; crypto::SIG_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// One user as listed in the signed user list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedUser {
    pub user_id: String,
    pub seal_public: SealPublic,
    pub auth_public: SigPublic,
    /// The browser's sealed copy of the user's signing public key.
    pub self_sealed: Vec<u8>,
}

/// Signed bytes for the user list: this Luna plus the list as JSON text.
fn user_list_message(luna_id: &str, users_text: &str) -> Vec<u8> {
    crypto::canonical(&[
        ("luna_id", luna_id.as_bytes()),
        ("users", users_text.as_bytes()),
    ])
}

/// Build the signed user list record as bytes. `users` holds `(user id, sealing public key, auth public key, self-sealed signing key)`.
fn user_list_record(
    signer: &crypto::Signer,
    luna_id: &str,
    users: &[UserListEntry],
) -> Result<Vec<u8>> {
    let mut map = serde_json::Map::new();
    for (user_id, seal_public, auth_public, self_sealed) in users {
        if self_sealed.is_empty() {
            bail!("The recovery copy for user {user_id} is empty.");
        }
        let key = hex_encode(seal_public);
        if map.contains_key(&key) {
            bail!("Two users share the same recovery key.");
        }
        map.insert(
            key,
            json!({
                "user_id": user_id,
                "auth_public": hex_encode(auth_public),
                "self_sealed": hex_encode(self_sealed),
            }),
        );
    }
    let users_value = serde_json::Value::Object(map);
    let message = user_list_message(luna_id, &users_value.to_string());
    let signature = signer.sign(USERS_DOMAIN, &message);
    let body = json!({
        "users": users_value,
        "signature": hex_encode(&signature),
    });
    Ok(body.to_string().into_bytes())
}

/// Store the signed list of every user's recovery keys, so a browser on Connect can check it.
/// `users` holds `(user id, sealing public key, auth public key, self-sealed signing key)`.
/// The list is one record, keyed by each user's sealing public key (X25519 and ML-KEM together).
/// Signing the list therefore also signs every ML-KEM key in it. Two users may not share one.
///
/// Connect keeps this record and the next cloud run republishes it, so a failure here is only
/// a delay, not a loss.
pub fn publish_user_list(
    store: &dyn CloudStore,
    signer: &crypto::Signer,
    luna_id: &str,
    users: &[UserListEntry],
) -> Result<()> {
    let body = user_list_record(signer, luna_id, users)?;
    store.put_record(USERS_KIND, USERS_LIST_NAME, &body)?;
    Ok(())
}

/// Every user with a phrase, as the entries the signed user list needs.
fn listed_users(conn: &Connection) -> Result<Vec<UserListEntry>> {
    db::list_user_keys(conn)?
        .into_iter()
        .map(|user| {
            let seal_public: SealPublic =
                user.seal_public.as_slice().try_into().map_err(|_| {
                    anyhow!("The recovery key for user {} is damaged.", user.user_id)
                })?;
            let auth_public: SigPublic =
                user.auth_public.as_slice().try_into().map_err(|_| {
                    anyhow!("The recovery key for user {} is damaged.", user.user_id)
                })?;
            Ok((user.user_id, seal_public, auth_public, user.self_sealed))
        })
        .collect()
}

/// Queue a re-seal of every version `user_id` is on, to their current phrase. Call this after the
/// new phrase is saved. Runs retry it until it is done. The value holds the sealing key it is for.
pub fn queue_reseal(conn: &Connection, user_id: &str) -> Result<()> {
    let keys = db::get_user_keys(conn, user_id)?
        .with_context(|| format!("User {user_id} has no recovery phrase yet."))?;
    let value = json!({
        "user_id": user_id,
        "seal_public": hex_encode(&keys.seal_public),
    });
    db::set_meta(conn, &reseal_meta_key(user_id), &value.to_string())
}

/// True while `user_id` has a re-seal that has not finished.
pub fn resealing_pending(conn: &Connection, user_id: &str) -> Result<bool> {
    Ok(db::get_meta(conn, &reseal_meta_key(user_id))?.is_some())
}

/// The user ids with a re-seal still pending.
fn pending_resealers(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key GLOB ?1")?;
    let texts = stmt
        .query_map([format!("{RESEAL_META_PREFIX}:*")], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    texts
        .into_iter()
        .map(|text| {
            let value: serde_json::Value =
                serde_json::from_str(&text).context("The saved re-seal job is damaged.")?;
            let user = value
                .get("user_id")
                .and_then(|v| v.as_str())
                .context("The saved re-seal job is damaged.")?;
            Ok(user.to_string())
        })
        .collect()
}

/// The outcome of one user's re-seal run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResealReport {
    pub user_id: String,
    /// True once every copy and the user list are stored and the job is cleared.
    pub done: bool,
    /// Key copies written in this run.
    pub copies: usize,
    /// `(backup id, version)` pairs whose key row is missing. Nothing is written while any are missing.
    pub missing: Vec<(String, i64)>,
    /// Backups that were copying right now. Nothing is written while any are busy; the job stays
    /// pending and is tried again, so a run can never write a copy sealed to the old key after this.
    pub busy: Vec<String>,
}

/// Re-seal every version key `user_id` is a reader on, to their current phrase. Each copy is
/// signed by Luna and bound to the same association data as `publish_key`, and it overwrites the
/// old phrase's copy under the same name. Versions they were removed from are skipped. The user
/// list is then republished.
///
/// Fails closed: if any listed version has no key row, nothing is written and the job stays
/// pending. The job is cleared only if the phrase did not change while it ran. A failed store write
/// leaves it pending, and the next run writes the same names again.
///
/// The database lock is held only for reads and the final clear, never for store calls.
pub fn reseal_user(db: &crate::Db, store: &dyn CloudStore, user_id: &str) -> Result<ResealReport> {
    reseal_user_holding(db, store, user_id, None)
}

/// Like [`reseal_user`], for a caller that already holds the run slot of `held` (a running backup
/// that re-seals at its start). Every other backup the user is on is locked here, the same lock a
/// run takes, for the whole re-seal. A run therefore cannot publish a copy sealed to the old key
/// after the re-seal wrote the new one. If any of those backups is copying, nothing is written.
pub(crate) fn reseal_user_holding(
    db: &crate::Db,
    store: &dyn CloudStore,
    user_id: &str,
    held: Option<&str>,
) -> Result<ResealReport> {
    let backups: std::collections::BTreeSet<String> = {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        if db::get_meta(&conn, &reseal_meta_key(user_id))?.is_none() {
            return Ok(ResealReport {
                user_id: user_id.to_string(),
                done: true,
                copies: 0,
                missing: Vec::new(),
                busy: Vec::new(),
            });
        }
        reader_versions(&conn, user_id)?
            .into_iter()
            .map(|(backup, _)| backup)
            .filter(|backup| Some(backup.as_str()) != held)
            .collect()
    };
    let mut slots = Vec::new();
    let mut busy = Vec::new();
    for backup in &backups {
        match super::run::RunSlot::take(db, backup) {
            // A run, delete or restore holds the drive-backup lock before it takes the cloud one.
            Some(_) if crate::backup::drive_backup::is_running(backup) => busy.push(backup.clone()),
            Some(slot) => slots.push(slot),
            None => busy.push(backup.clone()),
        }
    }
    if !busy.is_empty() {
        return Ok(ResealReport {
            user_id: user_id.to_string(),
            done: false,
            copies: 0,
            missing: Vec::new(),
            busy,
        });
    }
    // `slots` stays alive until the copies are written and the job is cleared.
    let report = reseal_user_locked(db, store, user_id);
    drop(slots);
    report
}

fn reseal_user_locked(
    db: &crate::Db,
    store: &dyn CloudStore,
    user_id: &str,
) -> Result<ResealReport> {
    let (records, list, pending) = {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = db::get_meta(&conn, &reseal_meta_key(user_id))? else {
            return Ok(ResealReport {
                user_id: user_id.to_string(),
                done: true,
                copies: 0,
                missing: Vec::new(),
                busy: Vec::new(),
            });
        };
        let keys = db::get_user_keys(&conn, user_id)?
            .with_context(|| format!("User {user_id} has no recovery phrase yet."))?;
        let seal_public: SealPublic = keys
            .seal_public
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("The recovery key for user {user_id} is damaged."))?;
        let identity =
            identity::load(&conn)?.ok_or_else(|| anyhow!("Luna's cloud identity is missing."))?;

        let mut records = Vec::new();
        let mut missing = Vec::new();
        for (backup, version) in reader_versions(&conn, user_id)? {
            let key = db::list_backup_keys(&conn, &backup)?
                .into_iter()
                .find(|k| k.version == version);
            let Some(key) = key else {
                missing.push((backup, version));
                continue;
            };
            let aad = key_aad(identity.luna_id(), &backup, version, user_id);
            let record = seal_copy(
                identity.signer(),
                &seal_public,
                &aad,
                &key.key,
                &key.dedup_key,
            )?;
            records.push((key_record_name(&backup, version, user_id), record));
        }
        if !missing.is_empty() {
            return Ok(ResealReport {
                user_id: user_id.to_string(),
                done: false,
                copies: 0,
                missing,
                busy: Vec::new(),
            });
        }
        let list = user_list_record(identity.signer(), identity.luna_id(), &listed_users(&conn)?)?;
        (records, list, pending)
    };

    let copies = records.len();
    for (name, bytes) in &records {
        store
            .put_record(KEYS_KIND, name, bytes)
            .map_err(|e| anyhow!("{e}"))?;
    }
    store
        .put_record(USERS_KIND, USERS_LIST_NAME, &list)
        .map_err(|e| anyhow!("{e}"))?;

    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
    // A phrase saved while this ran queued a new job with a new value. Keep that one.
    if db::get_meta(&conn, &reseal_meta_key(user_id))?.as_deref() == Some(pending.as_str()) {
        delete_meta(&conn, &reseal_meta_key(user_id))?;
    }
    Ok(ResealReport {
        user_id: user_id.to_string(),
        done: true,
        copies,
        missing: Vec::new(),
        busy: Vec::new(),
    })
}

/// Retry every pending re-seal. A failure for one user does not stop the others. Each result is
/// returned so the caller can report the ones that are not done.
pub fn reseal_pending(db: &crate::Db, store: &dyn CloudStore) -> Vec<Result<ResealReport>> {
    reseal_pending_holding(db, store, None)
}

/// [`reseal_pending`] for a caller that already holds the run slot of backup `held`.
pub(crate) fn reseal_pending_holding(
    db: &crate::Db,
    store: &dyn CloudStore,
    held: Option<&str>,
) -> Vec<Result<ResealReport>> {
    let listed = pending_resealers(&db.lock().unwrap_or_else(|p| p.into_inner()));
    match listed {
        Ok(users) => users
            .iter()
            .map(|user| reseal_user_holding(db, store, user, held))
            .collect(),
        Err(err) => vec![Err(err)],
    }
}

/// Check a signed user list read back from the store. Returns the listed users, sorted by user id,
/// if the signature is valid for this Luna and `public`, and `None` otherwise.
pub fn verify_user_list(
    bytes: &[u8],
    public: &SigPublic,
    luna_id: &str,
) -> Option<Vec<ListedUser>> {
    let body: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let users_value = body.get("users")?.clone();
    let sig = decode_hex_sig(body.get("signature")?.as_str()?)?;
    let message = user_list_message(luna_id, &users_value.to_string());
    if !crypto::verify(public, USERS_DOMAIN, &message, &sig) {
        return None;
    }
    let mut listed = Vec::new();
    for (key, entry) in users_value.as_object()? {
        let seal_public: SealPublic = hex_decode(key)?.try_into().ok()?;
        let auth_public: SigPublic = hex_decode(entry.get("auth_public")?.as_str()?)?
            .try_into()
            .ok()?;
        let self_sealed = hex_decode(entry.get("self_sealed")?.as_str()?)?;
        if self_sealed.is_empty() {
            return None;
        }
        listed.push(ListedUser {
            user_id: entry.get("user_id")?.as_str()?.to_string(),
            seal_public,
            auth_public,
            self_sealed,
        });
    }
    listed.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    Some(listed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::store::{MemoryStore, StoreError, Usage};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LUNA: &str = "luna-test-1";
    const PROTECTION: &str = "prot-1";

    fn conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        (dir, conn)
    }

    /// A database with this Luna's identity, for the re-seal tests, which read it.
    fn shared_db() -> (tempfile::TempDir, crate::Db) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        identity::load_or_create(&conn, 1).unwrap();
        (dir, crate::Db::new(conn))
    }

    fn locked(db: &crate::Db) -> std::sync::MutexGuard<'_, Connection> {
        db.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn user_keys(name: &str) -> crypto::UserKeys {
        let entropy: [u8; 16] = std::array::from_fn(|i| name.as_bytes()[i % name.len()] ^ i as u8);
        crypto::derive(&entropy, LUNA)
    }

    /// Give `name` a phrase with these keys, as `set_user_keys` does when a phrase is saved.
    fn set_phrase(conn: &Connection, name: &str, keys: &crypto::UserKeys) {
        db::set_user_keys(
            conn,
            &db::UserKeys {
                user_id: name.into(),
                seal_public: keys.seal_public.to_vec(),
                auth_public: keys.auth_public.to_vec(),
                self_sealed: vec![3; 48],
                phrase_set_at: 1,
                last_checked_at: 0,
            },
        )
        .unwrap();
    }

    fn set(names: &[&str]) -> Recipients {
        Recipients::new(names.iter().map(|s| s.to_string()).collect())
    }

    fn publish(
        store: &MemoryStore,
        signer: &crypto::Signer,
        key: &BackupKey,
        recipients: &Recipients,
        pubs: &HashMap<String, SealPublic>,
    ) -> Result<()> {
        publish_key(store, signer, LUNA, PROTECTION, key, recipients, |u| {
            pubs.get(u).copied()
        })
    }

    /// Publish under this database's own Luna id, as a real run does.
    fn publish_for(
        store: &dyn CloudStore,
        identity: &identity::Identity,
        key: &BackupKey,
        recipients: &Recipients,
        pubs: &HashMap<String, SealPublic>,
    ) -> Result<()> {
        publish_key(
            store,
            identity.signer(),
            identity.luna_id(),
            PROTECTION,
            key,
            recipients,
            |u| pubs.get(u).copied(),
        )
    }

    /// A store that fails the `fail_at`-th `put_record` (1-based; 0 never fails) and delegates otherwise.
    struct FlakyStore {
        inner: MemoryStore,
        puts: AtomicUsize,
        fail_at: usize,
    }

    impl CloudStore for FlakyStore {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            let n = self.puts.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_at != 0 && n == self.fail_at {
                return Err(StoreError::Rejected("The store is unavailable.".into()));
            }
            self.inner.put_record(kind, name, bytes)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    #[test]
    fn same_recipients_keep_the_same_version() {
        let (_dir, conn) = conn();
        let first = ensure_key(&conn, PROTECTION, &set(&["a", "b"]), 10).unwrap();
        let again = ensure_key(&conn, PROTECTION, &set(&["b", "a"]), 20).unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(again, first);
    }

    #[test]
    fn a_missing_recipient_record_starts_a_new_version() {
        let (_dir, conn) = conn();
        let v1 = ensure_key(&conn, PROTECTION, &set(&["a"]), 10).unwrap();
        let record = recipients_meta_key(PROTECTION, 1);
        conn.execute("DELETE FROM meta WHERE key = ?1", [record.as_str()])
            .unwrap();

        let v2 = ensure_key(&conn, PROTECTION, &set(&["a"]), 20).unwrap();
        assert_eq!(v2.version, 2);
        assert_ne!(v2.key, v1.key);
        // The new version records its recipients, so the next call keeps it.
        assert_eq!(ensure_key(&conn, PROTECTION, &set(&["a"]), 30).unwrap(), v2);
    }

    #[test]
    fn removing_or_adding_a_user_starts_a_new_version() {
        let (_dir, conn) = conn();
        let v1 = ensure_key(&conn, PROTECTION, &set(&["a", "b"]), 10).unwrap();
        let removed = ensure_key(&conn, PROTECTION, &set(&["a"]), 20).unwrap();
        assert_eq!(removed.version, 2);
        assert_ne!(removed.key, v1.key);
        assert_ne!(removed.dedup_key, v1.dedup_key);
        let added = ensure_key(&conn, PROTECTION, &set(&["a", "c"]), 30).unwrap();
        assert_eq!(added.version, 3);
        assert_eq!(
            db::latest_backup_key(&conn, PROTECTION).unwrap(),
            Some(added)
        );
    }

    #[test]
    fn a_changed_recovery_phrase_starts_a_new_version() {
        let (_dir, conn) = conn();
        let v1_keys = user_keys("alice");
        let mut alice_row = db::UserKeys {
            user_id: "alice".into(),
            seal_public: v1_keys.seal_public.to_vec(),
            auth_public: vec![2; 32],
            self_sealed: vec![3; 48],
            phrase_set_at: 5,
            last_checked_at: 0,
        };
        db::set_user_keys(&conn, &alice_row).unwrap();
        let v1 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 10).unwrap();

        // Same user, same phrase: same version.
        assert_eq!(
            ensure_key(&conn, PROTECTION, &set(&["alice"]), 20).unwrap(),
            v1
        );

        // Same user, new phrase (new sealing key): new version.
        alice_row.seal_public = user_keys("alice-new").seal_public.to_vec();
        db::set_user_keys(&conn, &alice_row).unwrap();
        let v2 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 30).unwrap();
        assert_eq!(v2.version, 2);
        assert_ne!(v2.key, v1.key);
    }

    #[test]
    fn a_user_opens_their_copy_and_a_removed_user_has_no_new_copy() {
        let (_dir, conn) = conn();
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let pubs = HashMap::from([
            ("alice".to_string(), alice.seal_public),
            ("bob".to_string(), bob.seal_public),
        ]);

        let v1_recipients = set(&["alice", "bob"]);
        let v1 = ensure_key(&conn, PROTECTION, &v1_recipients, 10).unwrap();
        publish(&store, &signer, &v1, &v1_recipients, &pubs).unwrap();

        let v2_recipients = set(&["alice"]);
        let v2 = ensure_key(&conn, PROTECTION, &v2_recipients, 20).unwrap();
        publish(&store, &signer, &v2, &v2_recipients, &pubs).unwrap();

        let sealed = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 2, "alice"))
            .unwrap()
            .unwrap();
        let (key, dedup) = open_key(
            &sealed,
            &alice.seal_secret,
            &signer.public(),
            LUNA,
            PROTECTION,
            2,
            "alice",
        )
        .unwrap();
        assert_eq!(key.to_vec(), v2.key);
        assert_eq!(dedup.to_vec(), v2.dedup_key);

        assert!(
            store
                .get_record(KEYS_KIND, &key_record_name(PROTECTION, 2, "bob"))
                .unwrap()
                .is_none()
        );
        // Bob's old copy stays for version 1 only.
        let old = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        assert!(
            open_key(
                &old,
                &bob.seal_secret,
                &signer.public(),
                LUNA,
                PROTECTION,
                1,
                "bob"
            )
            .is_ok()
        );
        // A copy cannot be opened under another version or user id.
        assert!(
            open_key(
                &old,
                &bob.seal_secret,
                &signer.public(),
                LUNA,
                PROTECTION,
                2,
                "bob"
            )
            .is_err()
        );
        assert!(
            open_key(
                &sealed,
                &bob.seal_secret,
                &signer.public(),
                LUNA,
                PROTECTION,
                2,
                "alice"
            )
            .is_err()
        );
    }

    #[test]
    fn key_copies_must_carry_a_luna_signature() {
        let (_dir, conn) = conn();
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let alice = user_keys("alice");
        let pubs = HashMap::from([("alice".to_string(), alice.seal_public)]);
        let recipients = set(&["alice"]);
        let key = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();
        publish(&store, &signer, &key, &recipients, &pubs).unwrap();
        let name = key_record_name(PROTECTION, 1, "alice");
        let record = store.get_record(KEYS_KIND, &name).unwrap().unwrap();
        let open = |bytes: &[u8], public: &SigPublic| {
            open_key(
                bytes,
                &alice.seal_secret,
                public,
                LUNA,
                PROTECTION,
                1,
                "alice",
            )
        };

        // The stored copy opens with Luna's public key.
        assert!(open(&record, &signer.public()).is_ok());
        // A changed byte in the sealed copy is refused.
        let mut changed = record.clone();
        changed[40] ^= 1;
        assert!(open(&changed, &signer.public()).is_err());
        // A copy with its signature stripped is refused.
        assert!(open(&record[..record.len() - 64], &signer.public()).is_err());
        // A copy signed by another Luna is refused.
        let other = crypto::Signer::generate();
        assert!(open(&record, &other.public()).is_err());
    }

    #[test]
    fn recipients_record_verifies_and_fails_when_altered() {
        let (_dir, conn) = conn();
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let alice = user_keys("alice");
        let pubs = HashMap::from([("alice".to_string(), alice.seal_public)]);
        let recipients = set(&["alice"]);
        let key = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();
        publish(&store, &signer, &key, &recipients, &pubs).unwrap();

        let name = recipients_record_name(PROTECTION, 1);
        let bytes = store.get_record(RECIPIENTS_KIND, &name).unwrap().unwrap();
        assert_eq!(
            verify_recipients(&bytes, &signer.public(), LUNA, PROTECTION, 1),
            Some(vec!["alice".to_string()])
        );
        // Wrong version, wrong Luna, wrong key: all fail.
        assert!(verify_recipients(&bytes, &signer.public(), LUNA, PROTECTION, 2).is_none());
        assert!(verify_recipients(&bytes, &signer.public(), "other-luna", PROTECTION, 1).is_none());
        let other = crypto::Signer::generate();
        assert!(verify_recipients(&bytes, &other.public(), LUNA, PROTECTION, 1).is_none());
        // Altered user list fails.
        let altered = String::from_utf8(bytes.clone())
            .unwrap()
            .replace("\"alice\"", "\"mallory\"");
        assert!(
            verify_recipients(altered.as_bytes(), &signer.public(), LUNA, PROTECTION, 1).is_none()
        );
    }

    #[test]
    fn missing_public_key_stops_publishing() {
        let (_dir, conn) = conn();
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let recipients = set(&["ghost"]);
        let key = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();
        let err = publish(&store, &signer, &key, &recipients, &HashMap::new()).unwrap_err();
        assert!(err.to_string().contains("ghost"));
    }

    #[test]
    fn user_part_is_a_safe_record_name() {
        let part = user_record_part("Alice Smith@example");
        assert_eq!(part.len(), 32);
        assert!(
            part.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    #[test]
    fn user_list_verifies_and_fails_when_altered() {
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let users = vec![
            (
                "alice".to_string(),
                alice.seal_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
            (
                "bob".to_string(),
                bob.seal_public,
                bob.auth_public,
                vec![8u8; 48],
            ),
        ];
        publish_user_list(&store, &signer, LUNA, &users).unwrap();

        let bytes = store
            .get_record(USERS_KIND, USERS_LIST_NAME)
            .unwrap()
            .unwrap();
        let listed = verify_user_list(&bytes, &signer.public(), LUNA).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].user_id, "alice");
        assert_eq!(listed[0].seal_public, alice.seal_public);
        assert_eq!(listed[0].auth_public, alice.auth_public);
        assert_eq!(listed[0].self_sealed, vec![7u8; 48]);
        assert_eq!(listed[1].user_id, "bob");

        // Wrong Luna and wrong key fail.
        assert!(verify_user_list(&bytes, &signer.public(), "other-luna").is_none());
        let other = crypto::Signer::generate();
        assert!(verify_user_list(&bytes, &other.public(), LUNA).is_none());

        // Altered user id, altered sealed copy, and an extra user all fail.
        let text = String::from_utf8(bytes.clone()).unwrap();
        let renamed = text.replace("\"alice\"", "\"mallory\"");
        assert!(verify_user_list(renamed.as_bytes(), &signer.public(), LUNA).is_none());
        let swapped = text.replace(&hex_encode(&[7u8; 48]), &hex_encode(&[9u8; 48]));
        assert!(verify_user_list(swapped.as_bytes(), &signer.public(), LUNA).is_none());
        let mut body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        body["users"]
            .as_object_mut()
            .unwrap()
            .insert(hex_encode(&[1u8; 32]), json!({ "user_id": "eve", "auth_public": hex_encode(&[1u8; 32]), "self_sealed": hex_encode(&[1u8; 48]) }));
        assert!(verify_user_list(body.to_string().as_bytes(), &signer.public(), LUNA).is_none());
    }

    #[test]
    fn user_list_refuses_two_users_with_one_recovery_key() {
        let store = MemoryStore::new();
        let signer = crypto::Signer::generate();
        let alice = user_keys("alice");
        let users = vec![
            (
                "alice".to_string(),
                alice.seal_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
            (
                "alice-again".to_string(),
                alice.seal_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
        ];
        assert!(publish_user_list(&store, &signer, LUNA, &users).is_err());
    }

    #[test]
    fn unexposed_replacement_keeps_the_same_version() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        set_phrase(&conn, "alice", &alice);
        set_phrase(&conn, "bob", &bob);
        let recipients = set(&["alice", "bob"]);
        let v1 = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();

        // Bob sets a new phrase and nothing is exposed: only the saved reader lists change.
        set_phrase(&conn, "bob", &bob_new);
        assert_eq!(
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap(),
            1
        );
        assert_eq!(ensure_key(&conn, PROTECTION, &recipients, 20).unwrap(), v1);
        // Replacing again with the same key changes nothing.
        assert_eq!(
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap(),
            0
        );
    }

    #[test]
    fn replace_reader_leaves_lists_without_the_user_alone() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        set_phrase(&conn, "alice", &alice);
        ensure_key(&conn, PROTECTION, &set(&["alice"]), 10).unwrap();
        let before = db::get_meta(&conn, &recipients_meta_key(PROTECTION, 1)).unwrap();
        assert_eq!(replace_reader(&conn, "bob", &[9u8; 32]).unwrap(), 0);
        assert_eq!(
            db::get_meta(&conn, &recipients_meta_key(PROTECTION, 1)).unwrap(),
            before
        );
    }

    #[test]
    fn exposed_mark_starts_the_next_version_with_the_same_dedup_key() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        set_phrase(&conn, "alice", &alice);
        set_phrase(&conn, "bob", &bob);
        let recipients = set(&["alice", "bob"]);
        let v1 = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();

        set_phrase(&conn, "bob", &bob_new);
        replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
        mark_rotate(&conn, PROTECTION).unwrap();
        let v2 = ensure_key(&conn, PROTECTION, &recipients, 20).unwrap();
        assert_eq!(v2.version, 2);
        assert_ne!(v2.key, v1.key);
        assert_eq!(v2.dedup_key, v1.dedup_key);
        // The mark is consumed in the same savepoint as the new version.
        assert!(
            db::get_meta(&conn, &rotate_meta_key(PROTECTION))
                .unwrap()
                .is_none()
        );
        // The next call is stable: no mark, same readers, same version.
        assert_eq!(ensure_key(&conn, PROTECTION, &recipients, 30).unwrap(), v2);
    }

    #[test]
    fn exposed_mark_with_a_newcomer_gets_a_fresh_dedup_key() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        set_phrase(&conn, "alice", &alice);
        set_phrase(&conn, "bob", &bob);
        let v1 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 10).unwrap();

        mark_rotate(&conn, PROTECTION).unwrap();
        let v2 = ensure_key(&conn, PROTECTION, &set(&["alice", "bob"]), 20).unwrap();
        assert_eq!(v2.version, 2);
        assert_ne!(v2.key, v1.key);
        assert_ne!(v2.dedup_key, v1.dedup_key);
    }

    #[test]
    fn a_mark_on_a_backup_with_no_version_starts_version_one() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        set_phrase(&conn, "alice", &alice);
        mark_rotate(&conn, PROTECTION).unwrap();
        let v1 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 10).unwrap();
        assert_eq!(v1.version, 1);
        assert!(
            db::get_meta(&conn, &rotate_meta_key(PROTECTION))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_failed_rotation_keeps_the_mark_and_no_version() {
        let (_dir, conn) = conn();
        let alice = user_keys("alice");
        set_phrase(&conn, "alice", &alice);
        let v1 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 10).unwrap();
        mark_rotate(&conn, PROTECTION).unwrap();
        // Make saving the new version's readers fail, after its key row was written.
        conn.execute_batch(
            "CREATE TRIGGER fail_readers BEFORE INSERT ON meta
             WHEN NEW.key LIKE 'cloud_recipients:%'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
        assert!(ensure_key(&conn, PROTECTION, &set(&["alice"]), 20).is_err());
        // Nothing of the rotation was kept: the mark is still there and version 1 is still the latest.
        assert!(
            db::get_meta(&conn, &rotate_meta_key(PROTECTION))
                .unwrap()
                .is_some()
        );
        assert_eq!(
            db::latest_backup_key(&conn, PROTECTION)
                .unwrap()
                .unwrap()
                .version,
            1
        );
        // Once the failure is gone, the same call rotates.
        conn.execute_batch("DROP TRIGGER fail_readers").unwrap();
        let v2 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 30).unwrap();
        assert_eq!(v2.version, 2);
        assert_eq!(v1.version, 1);
    }

    #[test]
    fn reseal_covers_only_the_versions_the_user_is_on() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        let identity = identity::load(&locked(&db)).unwrap().unwrap();
        let pubs = HashMap::from([
            ("alice".to_string(), alice.seal_public),
            ("bob".to_string(), bob.seal_public),
        ]);

        let (v1, v2) = {
            let conn = locked(&db);
            set_phrase(&conn, "alice", &alice);
            set_phrase(&conn, "bob", &bob);
            let v1 = ensure_key(&conn, PROTECTION, &set(&["alice", "bob"]), 10).unwrap();
            let v2 = ensure_key(&conn, PROTECTION, &set(&["alice"]), 20).unwrap();
            (v1, v2)
        };
        publish_for(&store, &identity, &v1, &set(&["alice", "bob"]), &pubs).unwrap();
        publish_for(&store, &identity, &v2, &set(&["alice"]), &pubs).unwrap();

        // Bob (removed from version 2) sets a new phrase.
        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob_new);
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
            queue_reseal(&conn, "bob").unwrap();
            assert!(resealing_pending(&conn, "bob").unwrap());
        }
        let results = reseal_pending(&db, &store);
        assert_eq!(results.len(), 1);
        let report = results.into_iter().next().unwrap().unwrap();
        assert!(report.done);
        assert_eq!(report.copies, 1);
        assert!(report.missing.is_empty());

        // The version-1 copy now opens with the new phrase and not the old one.
        let copy = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        let (key, dedup) = open_key(
            &copy,
            &bob_new.seal_secret,
            &identity.signer().public(),
            identity.luna_id(),
            PROTECTION,
            1,
            "bob",
        )
        .unwrap();
        assert_eq!(key.to_vec(), v1.key);
        assert_eq!(dedup.to_vec(), v1.dedup_key);
        assert!(
            open_key(
                &copy,
                &bob.seal_secret,
                &identity.signer().public(),
                identity.luna_id(),
                PROTECTION,
                1,
                "bob"
            )
            .is_err()
        );
        // Copies are bound to this Luna: another Luna's id does not open them.
        assert!(
            open_key(
                &copy,
                &bob_new.seal_secret,
                &identity.signer().public(),
                "other-luna",
                PROTECTION,
                1,
                "bob"
            )
            .is_err()
        );
        // No copy for version 2, which Bob was removed from.
        assert!(
            store
                .get_record(KEYS_KIND, &key_record_name(PROTECTION, 2, "bob"))
                .unwrap()
                .is_none()
        );
        // The user list now carries Bob's new sealing key.
        let list = store
            .get_record(USERS_KIND, USERS_LIST_NAME)
            .unwrap()
            .unwrap();
        let listed =
            verify_user_list(&list, &identity.signer().public(), identity.luna_id()).unwrap();
        let bob_listed = listed.iter().find(|u| u.user_id == "bob").unwrap();
        assert_eq!(bob_listed.seal_public, bob_new.seal_public);
        // The job is cleared, and a second run is a no-op.
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
        let again = reseal_user(&db, &store, "bob").unwrap();
        assert!(again.done);
        assert_eq!(again.copies, 0);
    }

    #[test]
    fn a_missing_key_row_writes_nothing_and_a_retry_finishes() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        let identity = identity::load(&locked(&db)).unwrap().unwrap();
        let pubs = HashMap::from([
            ("alice".to_string(), alice.seal_public),
            ("bob".to_string(), bob.seal_public),
        ]);
        let recipients = set(&["alice", "bob"]);
        let v1 = {
            let conn = locked(&db);
            set_phrase(&conn, "alice", &alice);
            set_phrase(&conn, "bob", &bob);
            ensure_key(&conn, PROTECTION, &recipients, 10).unwrap()
        };
        publish_for(&store, &identity, &v1, &recipients, &pubs).unwrap();

        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob_new);
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
            queue_reseal(&conn, "bob").unwrap();
            // Simulate a damaged database: the version 1 key row is gone.
            conn.execute(
                "DELETE FROM backup_keys WHERE protection_id = ?1 AND version = 1",
                [PROTECTION],
            )
            .unwrap();
        }
        let report = reseal_user(&db, &store, "bob").unwrap();
        assert!(!report.done);
        assert_eq!(report.missing, vec![(PROTECTION.to_string(), 1)]);
        assert_eq!(report.copies, 0);
        // Nothing was written for Bob: his version 1 copy is still the old phrase's, and the user list was not touched.
        let old_copy = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        assert!(
            open_key(
                &old_copy,
                &bob.seal_secret,
                &identity.signer().public(),
                identity.luna_id(),
                PROTECTION,
                1,
                "bob"
            )
            .is_ok()
        );
        assert!(
            store
                .get_record(USERS_KIND, USERS_LIST_NAME)
                .unwrap()
                .is_none()
        );
        assert!(resealing_pending(&locked(&db), "bob").unwrap());

        // The key row comes back, and the next run finishes the job.
        {
            let conn = locked(&db);
            db::insert_backup_key(&conn, &v1).unwrap();
        }
        let retry = reseal_user(&db, &store, "bob").unwrap();
        assert!(retry.done);
        assert_eq!(retry.copies, 1);
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
        let copy = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        assert!(
            open_key(
                &copy,
                &bob_new.seal_secret,
                &identity.signer().public(),
                identity.luna_id(),
                PROTECTION,
                1,
                "bob"
            )
            .is_ok()
        );
    }

    #[test]
    fn a_partial_failure_is_retried_to_the_same_result() {
        let (_dir, db) = shared_db();
        let alice = user_keys("alice");
        let bob = user_keys("bob");
        let carol = user_keys("carol");
        let bob_new = user_keys("bob-new");
        let identity = identity::load(&locked(&db)).unwrap().unwrap();
        let pubs = HashMap::from([
            ("alice".to_string(), alice.seal_public),
            ("bob".to_string(), bob.seal_public),
            ("carol".to_string(), carol.seal_public),
        ]);
        let inner = MemoryStore::new();
        let (v1, v2) = {
            let conn = locked(&db);
            set_phrase(&conn, "alice", &alice);
            set_phrase(&conn, "bob", &bob);
            set_phrase(&conn, "carol", &carol);
            let v1 = ensure_key(&conn, PROTECTION, &set(&["alice", "bob"]), 10).unwrap();
            let v2 = ensure_key(&conn, PROTECTION, &set(&["alice", "bob", "carol"]), 20).unwrap();
            (v1, v2)
        };
        publish_for(&inner, &identity, &v1, &set(&["alice", "bob"]), &pubs).unwrap();
        publish_for(
            &inner,
            &identity,
            &v2,
            &set(&["alice", "bob", "carol"]),
            &pubs,
        )
        .unwrap();
        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob_new);
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
            queue_reseal(&conn, "bob").unwrap();
        }

        // The second copy write fails: the first one is already stored.
        let flaky = FlakyStore {
            inner,
            puts: AtomicUsize::new(0),
            fail_at: 2,
        };
        assert!(reseal_user(&db, &flaky, "bob").is_err());
        assert!(resealing_pending(&locked(&db), "bob").unwrap());

        // The retry writes the same names again and finishes.
        let retry = FlakyStore {
            inner: flaky.inner,
            puts: AtomicUsize::new(0),
            fail_at: 0,
        };
        let report = reseal_user(&db, &retry, "bob").unwrap();
        assert!(report.done);
        assert_eq!(report.copies, 2);
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
        for version in [1, 2] {
            let copy = retry
                .inner
                .get_record(KEYS_KIND, &key_record_name(PROTECTION, version, "bob"))
                .unwrap()
                .unwrap();
            assert!(
                open_key(
                    &copy,
                    &bob_new.seal_secret,
                    &identity.signer().public(),
                    identity.luna_id(),
                    PROTECTION,
                    version,
                    "bob"
                )
                .is_ok()
            );
            assert!(
                open_key(
                    &copy,
                    &bob.seal_secret,
                    &identity.signer().public(),
                    identity.luna_id(),
                    PROTECTION,
                    version,
                    "bob"
                )
                .is_err()
            );
        }
    }

    /// A store whose first record write saves a newer phrase and queues it, as a save that lands
    /// while a re-seal is running would.
    struct SaveDuringRun<'a> {
        inner: MemoryStore,
        db: &'a crate::Db,
        newer: crypto::UserKeys,
        fired: AtomicUsize,
    }

    impl CloudStore for SaveDuringRun<'_> {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }
        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }
        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }
        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            if self.fired.fetch_add(1, Ordering::SeqCst) == 0 {
                let conn = locked(self.db);
                set_phrase(&conn, "bob", &self.newer);
                queue_reseal(&conn, "bob").unwrap();
            }
            self.inner.put_record(kind, name, bytes)
        }
        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }
        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }
        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }
        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    #[test]
    fn a_phrase_saved_during_the_run_keeps_the_job_pending() {
        let (_dir, db) = shared_db();
        let bob_new = user_keys("bob-new");
        let bob_newer = user_keys("bob-newer");
        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob_new);
            queue_reseal(&conn, "bob").unwrap();
        }
        let store = SaveDuringRun {
            inner: MemoryStore::new(),
            db: &db,
            newer: bob_newer,
            fired: AtomicUsize::new(0),
        };
        // The user list is the one record written, so the save lands during the run's first write.
        let report = reseal_user(&db, &store, "bob").unwrap();
        assert!(report.done);
        // The newer job is still queued, so the older run must not clear it.
        assert!(resealing_pending(&locked(&db), "bob").unwrap());
    }

    #[test]
    fn reseal_without_a_pending_job_writes_nothing() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let report = reseal_user(&db, &store, "bob").unwrap();
        assert!(report.done);
        assert_eq!(report.copies, 0);
        assert!(
            store
                .get_record(USERS_KIND, USERS_LIST_NAME)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn queueing_a_reseal_needs_a_phrase() {
        let (_dir, conn) = conn();
        assert!(queue_reseal(&conn, "ghost").is_err());
        assert!(!resealing_pending(&conn, "ghost").unwrap());
    }

    #[test]
    fn reseal_pending_reports_each_user_separately() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let bob = user_keys("bob");
        let carol = user_keys("carol");
        let identity = identity::load(&locked(&db)).unwrap().unwrap();
        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob);
            set_phrase(&conn, "carol", &carol);
            queue_reseal(&conn, "bob").unwrap();
            queue_reseal(&conn, "carol").unwrap();
        }
        // Both users have no version to copy, so both finish with an empty re-seal.
        let mut reports: Vec<String> = reseal_pending(&db, &store)
            .into_iter()
            .map(|r| r.unwrap().user_id)
            .collect();
        reports.sort();
        assert_eq!(reports, vec!["bob".to_string(), "carol".to_string()]);
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
        assert!(!resealing_pending(&locked(&db), "carol").unwrap());
        let list = store
            .get_record(USERS_KIND, USERS_LIST_NAME)
            .unwrap()
            .unwrap();
        assert!(verify_user_list(&list, &identity.signer().public(), identity.luna_id()).is_some());
    }

    #[test]
    fn reseal_waits_for_a_copying_backup_then_finishes() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        let identity = identity::load(&locked(&db)).unwrap().unwrap();
        let v1 = {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob);
            let v1 = ensure_key(&conn, PROTECTION, &set(&["bob"]), 10).unwrap();
            set_phrase(&conn, "bob", &bob_new);
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
            queue_reseal(&conn, "bob").unwrap();
            v1
        };
        // A run is copying this backup, so the re-seal writes nothing and stays pending.
        let slot = super::super::run::RunSlot::take(&db, PROTECTION).unwrap();
        let report = reseal_pending(&db, &store).pop().unwrap().unwrap();
        assert!(!report.done);
        assert_eq!(report.busy, vec![PROTECTION.to_string()]);
        assert!(resealing_pending(&locked(&db), "bob").unwrap());
        assert!(
            store
                .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
                .unwrap()
                .is_none()
        );
        // The running backup itself may re-seal at its start, since it already holds its own slot.
        let report = reseal_pending_holding(&db, &store, Some(PROTECTION))
            .pop()
            .unwrap()
            .unwrap();
        assert!(report.done);
        assert_eq!(report.copies, 1);
        drop(slot);
        // Once the backup is free, the slot is free again and nothing is left to do.
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
        assert!(super::super::run::RunSlot::take(&db, PROTECTION).is_some());
        let copy = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        assert!(
            open_key(
                &copy,
                &bob_new.seal_secret,
                &identity.signer().public(),
                identity.luna_id(),
                PROTECTION,
                1,
                "bob"
            )
            .is_ok()
        );
        assert_eq!(v1.version, 1);
    }

    #[test]
    fn reseal_until_done_retries_after_the_backup_frees_up() {
        let (_dir, db) = shared_db();
        let store = MemoryStore::new();
        let bob = user_keys("bob");
        let bob_new = user_keys("bob-new");
        {
            let conn = locked(&db);
            set_phrase(&conn, "bob", &bob);
            ensure_key(&conn, PROTECTION, &set(&["bob"]), 10).unwrap();
            set_phrase(&conn, "bob", &bob_new);
            replace_reader(&conn, "bob", &bob_new.seal_public).unwrap();
            queue_reseal(&conn, "bob").unwrap();
        }
        let slot = super::super::run::RunSlot::take(&db, PROTECTION).unwrap();
        assert!(!crate::backup::cloud::ops::reseal_until_done(
            &db,
            &store,
            2,
            std::time::Duration::from_millis(1)
        ));
        drop(slot);
        assert!(crate::backup::cloud::ops::reseal_until_done(
            &db,
            &store,
            2,
            std::time::Duration::from_millis(1)
        ));
        assert!(!resealing_pending(&locked(&db), "bob").unwrap());
    }
}
