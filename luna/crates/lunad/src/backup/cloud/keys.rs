//! Cloud backup keys and recipients: which users can read a shared backup, the versioned backup
//! key that protects it, and the sealed copies and signed recipient list Connect keeps for it.
//!
//! A new key version starts whenever the recipient set changes (someone added or removed) or a
//! recipient's recovery keys change (they set a new phrase).
//! Each recipient gets their own sealed copy of the version's keys, and one signed record lists
//! who the version was sealed to, so a browser can check it before trusting anything.

use anyhow::{bail, Context, Result};
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
/// Meta key prefix for the recipient list each key version was created for.
const META_PREFIX: &str = "cloud_recipients";

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

/// Signed bytes for the recipient list: the same binding as the key copies, plus the sorted list.
fn recipients_message(luna_id: &str, protection_id: &str, version: i64, users: &[String]) -> Vec<u8> {
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
            .map(|keys| keys.x25519_public.iter().map(|b| format!("{b:02x}")).collect::<String>())
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
        let sealed = crypto::seal(&public, &aad, &plain);
        store.put_record(
            KEYS_KIND,
            &key_record_name(protection_id, key.version, user),
            &sealed,
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

/// Open one sealed key copy. Returns `(key, dedup_key)`.
pub fn open_key(
    sealed: &[u8],
    user_secret: &[u8; 32],
    luna_id: &str,
    protection_id: &str,
    version: i64,
    user_id: &str,
) -> Result<([u8; 32], [u8; 32])> {
    let aad = key_aad(luna_id, protection_id, version, user_id);
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
        publish_key(store, signer, LUNA, PROTECTION, key, recipients, |u| pubs.get(u).copied())
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
    fn removing_or_adding_a_user_starts_a_new_version() {
        let (_dir, conn) = conn();
        let v1 = ensure_key(&conn, PROTECTION, &set(&["a", "b"]), 10).unwrap();
        let removed = ensure_key(&conn, PROTECTION, &set(&["a"]), 20).unwrap();
        assert_eq!(removed.version, 2);
        assert_ne!(removed.key, v1.key);
        assert_ne!(removed.dedup_key, v1.dedup_key);
        let added = ensure_key(&conn, PROTECTION, &set(&["a", "c"]), 30).unwrap();
        assert_eq!(added.version, 3);
        assert_eq!(db::latest_backup_key(&conn, PROTECTION).unwrap(), Some(added));
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
        assert_eq!(ensure_key(&conn, PROTECTION, &set(&["alice"]), 20).unwrap(), v1);

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
        let (key, dedup) =
            open_key(&sealed, &alice.x25519_secret, LUNA, PROTECTION, 2, "alice").unwrap();
        assert_eq!(key.to_vec(), v2.key);
        assert_eq!(dedup.to_vec(), v2.dedup_key);

        assert!(store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 2, "bob"))
            .unwrap()
            .is_none());
        // Bob's old copy stays for version 1 only.
        let old = store
            .get_record(KEYS_KIND, &key_record_name(PROTECTION, 1, "bob"))
            .unwrap()
            .unwrap();
        assert!(open_key(&old, &bob.x25519_secret, LUNA, PROTECTION, 1, "bob").is_ok());
        // A copy cannot be opened under another version or user id.
        assert!(open_key(&old, &bob.x25519_secret, LUNA, PROTECTION, 2, "bob").is_err());
        assert!(open_key(&sealed, &bob.x25519_secret, LUNA, PROTECTION, 2, "alice").is_err());
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
        assert!(verify_recipients(altered.as_bytes(), &signer.public(), LUNA, PROTECTION, 1).is_none());
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
        assert!(part.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
