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
use crate::net::connect::ConnectService;

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

    /// The signer itself, for functions that take one (such as `keys::publish_user_list`).
    pub fn signer(&self) -> &Signer {
        &self.signer
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
/// A new identity is copied to every connected drive. Use `load_or_create_known`
/// when the Luna id is already known, so a key on a drive is never replaced.
pub fn load_or_create(conn: &Connection, now: i64) -> Result<Identity> {
    load_or_create_known(conn, None, now)
}

/// Like `load_or_create`, but when `known_luna_id` is given and this Luna has no
/// identity yet, the signing key is taken back from a drive copy tagged with that
/// id (`recover_from_drives`). A key is never minted for a known id: when no drive
/// holds it, this fails so the existing identity is not replaced.
pub fn load_or_create_known(
    conn: &Connection,
    known_luna_id: Option<&str>,
    now: i64,
) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    if let Some(luna_id) = known_luna_id {
        return match recover_from_drives(conn, luna_id)? {
            Some(identity) => Ok(identity),
            None => bail!(
                "Luna can't find this Luna's cloud signing key. Connect the drive that holds a copy of it, then try again."
            ),
        };
    }
    let luna_id = mint_luna_id();
    let signer = Signer::generate();
    db::set_cloud_identity(conn, &luna_id, &signer.seed(), now)?;
    let identity = Identity { luna_id, signer };
    copy_to_drives(conn, &identity, now);
    Ok(identity)
}

/// The stored identity, or a new one minted and saved now, after asking Luna Connect
/// which Luna id this device owns. A Luna that lost its system DB gets its old id and
/// key back from a drive copy instead of minting a new one.
///
/// A new identity is registered with Connect. A failure there is logged, not returned.
pub fn load_or_create_connected(
    conn: &Connection,
    connect: &ConnectService,
    now: i64,
) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    let known = known_luna_id(conn, connect)?;
    let identity = load_or_create_known(conn, known.as_deref(), now)?;
    register_public(connect, &identity);
    Ok(identity)
}

/// The Luna id this Luna must keep, or None when it has none yet (so a new one is minted).
/// Connect's list decides when it answers with a usable answer. Otherwise the drive copies decide.
fn known_luna_id(conn: &Connection, connect: &ConnectService) -> Result<Option<String>> {
    match connect.list_luna_ids() {
        Ok(rows) if rows.len() == 1 => return Ok(Some(rows[0].luna_id.clone())),
        Ok(rows) if rows.len() > 1 => bail!(AMBIGUOUS_MSG),
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = %e, "could not ask Luna Connect which Luna id this device has");
        }
    }
    let mut from_drives = drive_luna_ids(conn);
    match from_drives.len() {
        0 => Ok(None),
        1 => Ok(from_drives.pop()),
        _ => bail!(AMBIGUOUS_MSG),
    }
}

const AMBIGUOUS_MSG: &str = "Luna can't tell which cloud identity is its own, because Luna Connect or the drives list more than one. Contact your Admin.";

/// Every Luna id that has a signing key copy on a connected drive, without repeats.
fn drive_luna_ids(conn: &Connection) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    for root in connected_roots(conn) {
        let found = drive_db::open(&root).and_then(|drive| {
            let mut stmt = drive.prepare("SELECT luna_id FROM cloud_signing_keys")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        });
        match found {
            Ok(rows) => ids.extend(rows),
            Err(e) => {
                tracing::warn!(error = %e, root = %root.display(), "could not list the cloud signing keys on a drive");
            }
        }
    }
    ids.into_iter().collect()
}

/// Send this Luna's signing public key to Luna Connect. Best-effort: a failure is logged only.
fn register_public(connect: &ConnectService, identity: &Identity) {
    let hex: String = identity.public().iter().map(|b| format!("{b:02x}")).collect();
    if let Err(e) = connect.register_signing_public(&identity.luna_id, &hex) {
        tracing::warn!(error = %e, "could not register this Luna's signing key with Luna Connect");
    }
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
    use crate::net::connect::DEVICE_TOKEN_FILE;
    use std::sync::{Arc, Mutex};

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
    fn known_id_recovers_the_drive_copy_instead_of_minting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();

        // The system DB was lost: a fresh Luna knows the id and finds the key on the drive.
        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(&fresh, "d1", "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
        let back = load_or_create_known(&fresh, Some(&owner.luna_id), 9).unwrap();
        assert_eq!(back.luna_id, owner.luna_id);
        assert_eq!(back.public(), owner.public());
        assert_eq!(load(&fresh).unwrap().unwrap().public(), owner.public());
    }

    #[test]
    fn known_id_without_a_drive_copy_is_refused_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let err = load_or_create_known(&conn, Some("luna-unknownunknownunknownun"), 1)
            .err()
            .unwrap();
        assert!(err.to_string().contains("Connect the drive"), "{err}");
        assert!(load(&conn).unwrap().is_none());
    }

    /// A fake Luna Connect on localhost. It answers the first request line `GET` with
    /// `get_body` and any other request with `{"ok":true}`, for `count` requests. It
    /// returns its base URL and the request lines it saw.
    fn fake_connect(get_body: &str, count: usize) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let get_body = get_body.to_string();
        std::thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
                let body = if line.starts_with("GET") { get_body.clone() } else { "{\"ok\":true}".to_string() };
                log.lock().unwrap().push(line);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        (format!("http://{addr}"), seen)
    }

    /// A base URL with nothing listening on it, so every request fails to connect.
    fn unreachable_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}")
    }

    /// A Connect client with a device token, under `dir`, pointed at `base_url`.
    fn connect_to(dir: &Path, base_url: &str) -> ConnectService {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(DEVICE_TOKEN_FILE), "ABCD-EFGH-JKMN-PQRS\n").unwrap();
        ConnectService::new(dir, Some(base_url.to_string()))
    }

    fn listing(ids: &[&str]) -> String {
        let rows: Vec<String> = ids
            .iter()
            .map(|id| format!(r#"{{"luna_id":"{id}","has_signing_key":true,"created_at":"2026-01-01T00:00:00Z"}}"#))
            .collect();
        format!(r#"{{"luna_ids":[{}]}}"#, rows.join(","))
    }

    #[test]
    fn empty_db_takes_back_the_key_the_drive_holds_for_the_id_connect_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();

        // The system DB was lost: the Luna is empty, but Connect and the drive still know it.
        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(&fresh, "d1", "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
        let (url, seen) = fake_connect(&listing(&[&owner.luna_id]), 2);
        let connect = connect_to(&dir.path().join("connect"), &url);

        let back = load_or_create_connected(&fresh, &connect, 9).unwrap();
        assert_eq!(back.luna_id, owner.luna_id);
        assert_eq!(back.public(), owner.public());
        assert_eq!(load(&fresh).unwrap().unwrap().public(), owner.public());
        let lines = seen.lock().unwrap().clone();
        assert!(
            lines.iter().any(|l| l.starts_with("POST") && l.contains("/signing-public")),
            "{lines:?}"
        );
    }

    #[test]
    fn two_ids_from_connect_mint_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let (url, _seen) = fake_connect(&listing(&["luna-aaaaaaaaaaaaaaaaaaaaaaaaaa", "luna-bbbbbbbbbbbbbbbbbbbbbbbbbb"]), 1);
        let connect = connect_to(&dir.path().join("connect"), &url);

        let err = load_or_create_connected(&conn, &connect, 1).err().unwrap();
        assert!(err.to_string().contains("Contact your Admin"), "{err}");
        assert!(load(&conn).unwrap().is_none());
    }

    #[test]
    fn unreachable_connect_uses_the_one_drive_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();

        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(&fresh, "d1", "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let back = load_or_create_connected(&fresh, &connect, 9).unwrap();
        assert_eq!(back.luna_id, owner.luna_id);
        assert_eq!(back.public(), owner.public());
    }

    #[test]
    fn unreachable_connect_with_two_drive_copies_mints_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let first_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&first_conn, &root, "d1");
        let first = load_or_create(&first_conn, 1).unwrap();
        let second_conn = db::open(&dir.path().join("b.db")).unwrap();
        let second = load_or_create(&second_conn, 2).unwrap();
        copy_to_drive_at(&root, &second, 2).unwrap();

        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(&fresh, "d1", "Photos", "as_is", "ext4", "sdb", root.to_str().unwrap())
            .unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let err = load_or_create_connected(&fresh, &connect, 9).err().unwrap();
        assert!(err.to_string().contains("Contact your Admin"), "{err}");
        assert!(load(&fresh).unwrap().is_none());
        assert_ne!(first.luna_id, second.luna_id);
    }

    #[test]
    fn unreachable_connect_with_no_drive_copy_mints_a_first_identity() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let made = load_or_create_connected(&conn, &connect, 1).unwrap();
        assert_eq!(load(&conn).unwrap().unwrap().luna_id, made.luna_id);
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
