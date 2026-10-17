//! This Luna's cloud identity: its random id and the signing key that vouches for it.
//!
//! Luna mints the id itself at the first cloud setup and never mints another, so every
//! recovery phrase keeps deriving the same keys. The signing key lives in the system DB.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::crypto::Signer;
use crate::db;
use crate::drives::drive_db;

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
///
/// A new identity is copied to every connected drive. The caller must check the
/// drives for a copy under a known id first (`recover_from_drives`) when it
/// already knows the id, so a fresh Luna never mints over a recoverable key.
pub fn load_or_create(conn: &Connection, now: i64) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    let luna_id = mint_luna_id();
    let signer = Signer::generate();
    db::set_cloud_identity(conn, &luna_id, &signer.seed(), now)?;
    let identity = Identity { luna_id, signer };
    copy_to_drives(conn, &identity, now);
    Ok(identity)
}

/// Store a copy of this Luna's signing key in a drive DB, tagged with its id.
/// A copy already there under this id is kept; copies for other Lunas are never touched.
pub fn copy_to_drive(drive: &Connection, identity: &Identity, now: i64) -> Result<()> {
    drive.execute(
        "INSERT OR IGNORE INTO cloud_signing_keys (luna_id, seed, created_at)
         VALUES (?1, ?2, ?3)",
        params![identity.luna_id, &identity.signer.seed()[..], now],
    )?;
    Ok(())
}

/// Copy this Luna's signing key to the drive mounted at `root`.
pub fn copy_to_drive_at(root: &Path, identity: &Identity, now: i64) -> Result<()> {
    let drive = drive_db::open(root)?;
    copy_to_drive(&drive, identity, now)
}

/// Copy this Luna's signing key to every connected drive. Best-effort: a drive
/// that cannot be opened is logged and skipped.
pub fn copy_to_drives(conn: &Connection, identity: &Identity, now: i64) {
    for root in connected_roots(conn) {
        if let Err(e) = copy_to_drive_at(&root, identity, now) {
            tracing::warn!(error = %e, root = %root.display(), "could not copy the cloud signing key to a drive");
        }
    }
}

/// Look for a copy of the signing key tagged with exactly `luna_id` on any connected
/// drive. When one is found, it is saved in the system DB and returned.
pub fn recover_from_drives(conn: &Connection, luna_id: &str) -> Result<Option<Identity>> {
    for root in connected_roots(conn) {
        let found = drive_db::open(&root).and_then(|drive| {
            let row = drive
                .query_row(
                    "SELECT seed, created_at FROM cloud_signing_keys WHERE luna_id = ?1",
                    params![luna_id],
                    |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?;
            Ok(row)
        });
        let row = match found {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!(error = %e, root = %root.display(), "could not look for the cloud signing key on a drive");
                continue;
            }
        };
        let Some((seed, created_at)) = row else { continue };
        let Ok(seed) = <[u8; 32]>::try_from(seed.as_slice()) else {
            tracing::warn!(root = %root.display(), "a drive holds a damaged cloud signing key copy");
            continue;
        };
        if let Some(existing) = load(conn)? {
            if existing.luna_id != luna_id {
                bail!("This Luna already has a different cloud identity. Contact your Admin.");
            }
            return Ok(Some(existing));
        }
        db::set_cloud_identity(conn, luna_id, &seed, created_at)?;
        return load(conn);
    }
    Ok(None)
}

/// The roots of drives Luna has adopted and that are connected now.
fn connected_roots(conn: &Connection) -> Vec<PathBuf> {
    match db::list_drives(conn) {
        Ok(drives) => drives
            .into_iter()
            .filter(|d| d.state == "as_is" && !d.mount_point.is_empty())
            .map(|d| PathBuf::from(d.mount_point))
            .collect(),
        Err(e) => {
            tracing::warn!(error = %e, "could not list drives for the cloud signing key");
            Vec::new()
        }
    }
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

    /// A drive DB at `root` with one connected drive row pointing at it.
    fn connected_drive(conn: &Connection, root: &Path, id: &str) {
        std::fs::create_dir_all(root).unwrap();
        let prefix = luna_core::marker::pick_prefix(root).unwrap();
        drive_db::create(root, &luna_core::marker::Marker::new(id, "Photos"), &prefix).unwrap();
        db::upsert_drive(conn, id, "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
    }

    fn copies(root: &Path) -> Vec<String> {
        let drive = drive_db::open(root).unwrap();
        let mut stmt = drive.prepare("SELECT luna_id FROM cloud_signing_keys ORDER BY luna_id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn copy_is_written_on_create() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let root = dir.path().join("drive");
        connected_drive(&conn, &root, "d1");
        let identity = load_or_create(&conn, 5).unwrap();
        assert_eq!(copies(&root), vec![identity.luna_id.clone()]);
    }

    #[test]
    fn second_lunas_copy_is_kept_alongside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let first_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&first_conn, &root, "d1");
        let first = load_or_create(&first_conn, 1).unwrap();
        let second_conn = db::open(&dir.path().join("b.db")).unwrap();
        let second = load_or_create(&second_conn, 2).unwrap();
        // The second Luna has no drive connected, so its copy goes on by hand.
        copy_to_drive_at(&root, &second, 2).unwrap();
        copy_to_drive_at(&root, &first, 3).unwrap();
        let mut expected = vec![first.luna_id.clone(), second.luna_id.clone()];
        expected.sort();
        assert_eq!(copies(&root), expected);
        let drive = drive_db::open(&root).unwrap();
        let seed: Vec<u8> = drive
            .query_row(
                "SELECT seed FROM cloud_signing_keys WHERE luna_id = ?1",
                params![first.luna_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seed, first.signer.seed().to_vec(), "an existing copy is not overwritten");
    }

    #[test]
    fn recover_finds_only_the_matching_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();
        let other = db::open(&dir.path().join("b.db")).unwrap();
        let other_id = load_or_create(&other, 1).unwrap();
        copy_to_drive_at(&root, &other_id, 1).unwrap();

        // A fresh Luna that knows only the owner's id looks for it on the drive.
        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(&fresh, "d1", "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
        let recovered = recover_from_drives(&fresh, &owner.luna_id).unwrap().expect("found");
        assert_eq!(recovered.luna_id, owner.luna_id);
        assert_eq!(recovered.public(), owner.public());
        assert!(recover_from_drives(&fresh, "luna-unknownunknownunknownun")
            .unwrap()
            .is_none());
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
