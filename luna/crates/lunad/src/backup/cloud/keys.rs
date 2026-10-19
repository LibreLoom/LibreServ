//! Cloud backup keys and recipients: which users can read a shared backup, the versioned backup
//! key that protects it, and the sealed copies and signed recipient list Connect keeps for it.
//!
//! A new key version starts whenever the recipient set changes (someone added or removed) or a
//! recipient's recovery keys change (they set a new phrase).
//! Each recipient gets their own sealed copy of the version's keys, and one signed record lists
//! who the version was sealed to, so a browser can check it before trusting anything.

use anyhow::{Context, Result, bail};
use rand_core::{OsRng, RngCore};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::crypto;
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
const KEY_COPY_SIG_LEN: usize = 64;
/// Meta key prefix for the recipient list each key version was created for.
const META_PREFIX: &str = "cloud_recipients";
/// Record kind for the signed list of every user's recovery keys on this Luna.
pub(crate) const USERS_KIND: &str = "users";
/// Record name for that list. There is one per Luna.
pub(crate) const USERS_LIST_NAME: &str = "list";
/// Signature domain for the user list.
const USERS_DOMAIN: &str = "users";

/// One user as given to `publish_user_list`: `(user id, X25519 public key, auth public key, self-sealed signing key)`.
type UserListEntry = (String, [u8; 32], [u8; 32], Vec<u8>);

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

/// The recipient list as saved in meta: each user with the hex of their X25519 public key.
/// A user with no recovery phrase gets an empty key, so a change to "no phrase" also counts.
fn readers_json(conn: &Connection, recipients: &Recipients) -> Result<serde_json::Value> {
    let mut readers = Vec::with_capacity(recipients.users.len());
    for user in &recipients.users {
        let public = db::get_user_keys(conn, user)?
            .map(|keys| {
                keys.x25519_public
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            })
            .unwrap_or_default();
        readers.push(json!({ "user_id": user, "x25519_public": public }));
    }
    Ok(serde_json::Value::Array(readers))
}

/// Return the latest key version for `protection_id` if it was created for exactly `recipients`
/// with the same recovery keys. Otherwise create the next version with fresh random keys.
/// A changed recovery phrase counts as a change: the old copies are sealed to the old key.
/// The recipient list and their keys are recorded in the meta table for the new version, so the
/// next call can compare against it.
///
/// Nothing is published here; call `publish_key` with the returned key.
pub fn ensure_key(
    conn: &Connection,
    protection_id: &str,
    recipients: &Recipients,
    now: i64,
) -> Result<BackupKey> {
    let readers = readers_json(conn, recipients)?;
    if let Some(latest) = db::latest_backup_key(conn, protection_id)? {
        // A version with no recipient record is never reused: nothing shows who it was made for.
        let recorded = db::get_meta(conn, &recipients_meta_key(protection_id, latest.version))?;
        if let Some(text) = recorded {
            let saved: serde_json::Value = serde_json::from_str(&text)
                .context("The saved list of backup readers is damaged.")?;
            if saved == readers {
                return Ok(latest);
            }
        }
    }
    let version = db::latest_backup_key(conn, protection_id)?.map_or(1, |k| k.version + 1);
    let key = BackupKey {
        protection_id: protection_id.to_string(),
        version,
        key: random_32().to_vec(),
        dedup_key: random_32().to_vec(),
        created_at: now,
    };
    db::insert_backup_key(conn, &key)?;
    db::set_meta(
        conn,
        &recipients_meta_key(protection_id, version),
        &readers.to_string(),
    )?;
    Ok(key)
}

/// Seal `key` and `dedup_key` to every recipient and store the copies, then store the signed
/// recipient list. `user_pub` gives each user's X25519 public key, or `None` if they have none.
pub fn publish_key(
    store: &dyn CloudStore,
    signer: &crypto::Signer,
    luna_id: &str,
    protection_id: &str,
    key: &BackupKey,
    recipients: &Recipients,
    user_pub: impl Fn(&str) -> Option<[u8; 32]>,
) -> Result<()> {
    if key.key.len() != 32 || key.dedup_key.len() != 32 {
        bail!("The backup key is damaged and cannot be shared.");
    }
    let mut plain = Vec::with_capacity(64);
    plain.extend_from_slice(&key.key);
    plain.extend_from_slice(&key.dedup_key);

    for user in &recipients.users {
        let public = user_pub(user)
            .with_context(|| format!("User {user} has not set a recovery phrase yet."))?;
        let aad = key_aad(luna_id, protection_id, key.version, user);
        let sealed = crypto::seal(&public, &aad, &plain)?;
        let signature = signer.sign(KEY_COPY_DOMAIN, &key_copy_message(&aad, &sealed));
        let mut record = sealed;
        record.extend_from_slice(&signature);
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
    user_secret: &[u8; 32],
    luna_public: &[u8; 32],
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
    public: &[u8; 32],
    luna_id: &str,
    protection_id: &str,
    version: i64,
) -> Option<Vec<String>> {
    let body: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let users: Vec<String> = serde_json::from_value(body.get("users")?.clone()).ok()?;
    let hex = body.get("signature")?.as_str()?;
    let sig = decode_hex_64(hex)?;
    let message = recipients_message(luna_id, protection_id, version, &users);
    crypto::verify(public, RECIPIENTS_DOMAIN, &message, &sig).then_some(users)
}

fn decode_hex_64(hex: &str) -> Option<[u8; 64]> {
    if hex.len() != 128 {
        return None;
    }
    let mut out = [0u8; 64];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
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

/// One user as listed in the signed user list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedUser {
    pub user_id: String,
    pub x25519_public: [u8; 32],
    pub auth_public: [u8; 32],
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

/// Store the signed list of every user's recovery keys, so a browser on Connect can check it.
/// `users` holds `(user id, X25519 public key, auth public key, self-sealed signing key)`.
/// The list is one record, keyed by each user's X25519 public key. Two users may not share one.
///
/// Connect keeps this record and the next cloud run republishes it, so a failure here is only
/// a delay, not a loss.
pub fn publish_user_list(
    store: &dyn CloudStore,
    signer: &crypto::Signer,
    luna_id: &str,
    users: &[UserListEntry],
) -> Result<()> {
    let mut map = serde_json::Map::new();
    for (user_id, x25519_public, auth_public, self_sealed) in users {
        if self_sealed.is_empty() {
            bail!("The recovery copy for user {user_id} is empty.");
        }
        let key = hex_encode(x25519_public);
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
    store.put_record(USERS_KIND, USERS_LIST_NAME, body.to_string().as_bytes())?;
    Ok(())
}

/// Check a signed user list read back from the store. Returns the listed users, sorted by user id,
/// if the signature is valid for this Luna and `public`, and `None` otherwise.
pub fn verify_user_list(bytes: &[u8], public: &[u8; 32], luna_id: &str) -> Option<Vec<ListedUser>> {
    let body: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let users_value = body.get("users")?.clone();
    let sig = decode_hex_64(body.get("signature")?.as_str()?)?;
    let message = user_list_message(luna_id, &users_value.to_string());
    if !crypto::verify(public, USERS_DOMAIN, &message, &sig) {
        return None;
    }
    let mut listed = Vec::new();
    for (key, entry) in users_value.as_object()? {
        let x25519_public: [u8; 32] = hex_decode(key)?.try_into().ok()?;
        let auth_public: [u8; 32] = hex_decode(entry.get("auth_public")?.as_str()?)?
            .try_into()
            .ok()?;
        let self_sealed = hex_decode(entry.get("self_sealed")?.as_str()?)?;
        if self_sealed.is_empty() {
            return None;
        }
        listed.push(ListedUser {
            user_id: entry.get("user_id")?.as_str()?.to_string(),
            x25519_public,
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
    use crate::backup::cloud::store::MemoryStore;
    use std::collections::HashMap;

    const LUNA: &str = "luna-test-1";
    const PROTECTION: &str = "prot-1";

    fn conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        (dir, conn)
    }

    fn user_keys(name: &str) -> crypto::UserKeys {
        let entropy: [u8; 16] = std::array::from_fn(|i| name.as_bytes()[i % name.len()] ^ i as u8);
        crypto::derive(&entropy, LUNA)
    }

    fn set(names: &[&str]) -> Recipients {
        Recipients::new(names.iter().map(|s| s.to_string()).collect())
    }

    fn publish(
        store: &MemoryStore,
        signer: &crypto::Signer,
        key: &BackupKey,
        recipients: &Recipients,
        pubs: &HashMap<String, [u8; 32]>,
    ) -> Result<()> {
        publish_key(store, signer, LUNA, PROTECTION, key, recipients, |u| {
            pubs.get(u).copied()
        })
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
            x25519_public: v1_keys.x25519_public.to_vec(),
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

        // Same user, new phrase (new X25519 key): new version.
        alice_row.x25519_public = user_keys("alice-new").x25519_public.to_vec();
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
            ("alice".to_string(), alice.x25519_public),
            ("bob".to_string(), bob.x25519_public),
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
            &alice.x25519_secret,
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
                &bob.x25519_secret,
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
                &bob.x25519_secret,
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
                &bob.x25519_secret,
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
        let pubs = HashMap::from([("alice".to_string(), alice.x25519_public)]);
        let recipients = set(&["alice"]);
        let key = ensure_key(&conn, PROTECTION, &recipients, 10).unwrap();
        publish(&store, &signer, &key, &recipients, &pubs).unwrap();
        let name = key_record_name(PROTECTION, 1, "alice");
        let record = store.get_record(KEYS_KIND, &name).unwrap().unwrap();
        let open = |bytes: &[u8], public: &[u8; 32]| {
            open_key(
                bytes,
                &alice.x25519_secret,
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
        let pubs = HashMap::from([("alice".to_string(), alice.x25519_public)]);
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
                alice.x25519_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
            (
                "bob".to_string(),
                bob.x25519_public,
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
        assert_eq!(listed[0].x25519_public, alice.x25519_public);
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
                alice.x25519_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
            (
                "alice-again".to_string(),
                alice.x25519_public,
                alice.auth_public,
                vec![7u8; 48],
            ),
        ];
        assert!(publish_user_list(&store, &signer, LUNA, &users).is_err());
    }
}
