//! This Luna's cloud identity: its random id and the signing key that vouches for it.
//!
//! Luna mints the id itself at the first cloud setup and never mints another, so every
//! recovery phrase keeps deriving the same keys. The signing key lives in the system DB.

use anyhow::{bail, Result};
use rusqlite::Connection;

use super::crypto::Signer;
use crate::db;

const ID_PREFIX: &str = "luna-";
/// RFC 4648 base32 alphabet, lowercase.
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// This Luna's id and its signing key. The secret half never leaves this process.
pub struct Identity {
    pub luna_id: String,
    signer: Signer,
}

impl Identity {
    pub fn luna_id(&self) -> &str {
        &self.luna_id
    }

    /// The signing public key, which Connect and browsers check signatures with.
    pub fn public(&self) -> [u8; 32] {
        self.signer.public()
    }

    /// Sign `msg` under `domain`. See `crypto::Signer::sign`.
    pub fn sign(&self, domain: &str, msg: &[u8]) -> [u8; 64] {
        self.signer.sign(domain, msg)
    }
}

/// The stored identity, if cloud setup has already minted one.
pub fn load(conn: &Connection) -> Result<Option<Identity>> {
    let Some(row) = db::get_cloud_identity(conn)? else {
        return Ok(None);
    };
    let Ok(seed) = <[u8; 32]>::try_from(row.signing_seed.as_slice()) else {
        bail!("The cloud signing key stored on this Luna is damaged. Contact your Admin.");
    };
    Ok(Some(Identity { luna_id: row.luna_id, signer: Signer::from_seed(seed) }))
}

/// The stored identity, or a new one minted and saved now.
pub fn load_or_create(conn: &Connection, now: i64) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    let luna_id = mint_luna_id();
    let signer = Signer::generate();
    db::set_cloud_identity(conn, &luna_id, &signer.seed(), now)?;
    Ok(Identity { luna_id, signer })
}

/// `luna-` plus 26 lowercase base32 characters of 16 random bytes (128 bits).
fn mint_luna_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    let mut out = String::from(ID_PREFIX);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 31) as usize] as char);
        }
    }
    // 128 bits leave 3 bits over; pad them with zeros to make the 26th character.
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::crypto;

    #[test]
    fn identity_is_stable_across_calls() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let first = load_or_create(&conn, 100).unwrap();
        let second = load_or_create(&conn, 200).unwrap();
        assert_eq!(first.luna_id(), second.luna_id());
        assert_eq!(first.public(), second.public());
        let stored = db::get_cloud_identity(&conn).unwrap().unwrap();
        assert_eq!(stored.created_at, 100, "a second call must not mint or re-stamp");
    }

    #[test]
    fn luna_id_format() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let id = load_or_create(&conn, 1).unwrap().luna_id;
        let rest = id.strip_prefix("luna-").expect("starts with luna-");
        assert_eq!(rest.len(), 26);
        assert!(rest.bytes().all(|b| BASE32.contains(&b)), "{rest} is not lowercase base32");
    }

    #[test]
    fn fresh_databases_get_different_ids() {
        let dir = tempfile::tempdir().unwrap();
        let a = db::open(&dir.path().join("a.db")).unwrap();
        let b = db::open(&dir.path().join("b.db")).unwrap();
        let id_a = load_or_create(&a, 1).unwrap();
        let id_b = load_or_create(&b, 1).unwrap();
        assert_ne!(id_a.luna_id(), id_b.luna_id());
        assert_ne!(id_a.public(), id_b.public());
    }

    #[test]
    fn signatures_check_against_public_key() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let identity = load_or_create(&conn, 1).unwrap();
        let sig = identity.sign("test-domain", b"hello");
        assert!(crypto::verify(&identity.public(), "test-domain", b"hello", &sig));
        assert!(!crypto::verify(&identity.public(), "other-domain", b"hello", &sig));
    }

    #[test]
    fn identity_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("luna.db");
        let (id, public) = {
            let conn = db::open(&path).unwrap();
            let made = load_or_create(&conn, 1).unwrap();
            (made.luna_id().to_string(), made.public())
        };
        let conn = db::open(&path).unwrap();
        let loaded = load(&conn).unwrap().expect("identity is stored");
        assert_eq!(loaded.luna_id, id);
        assert_eq!(loaded.public(), public);
    }

    #[test]
    fn factory_reset_clears_identity() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        load_or_create(&conn, 1).unwrap();
        db::factory_reset(&conn).unwrap();
        assert!(load(&conn).unwrap().is_none());
    }
}
