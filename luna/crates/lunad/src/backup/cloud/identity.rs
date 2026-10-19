//! This Luna's cloud identity: its random id and the signing key that vouches for it.
//!
//! Luna mints the id itself at the first cloud setup and never mints another, so every
//! recovery phrase keeps deriving the same keys. The signing key lives in the system DB.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};

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
    Ok(Some(Identity {
        luna_id: row.luna_id,
        signer: Signer::from_seed(seed),
    }))
}

/// The stored identity, or a new one minted and saved now. A new identity is copied
/// to every connected drive.
pub fn load_or_create(conn: &Connection, now: i64) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    let luna_id = mint_luna_id();
    let signer = Signer::generate();
    db::set_cloud_identity(conn, &luna_id, &signer.seed(), now)?;
    let identity = Identity { luna_id, signer };
    copy_to_drives(&connected_roots(conn), &identity, now);
    Ok(identity)
}

/// The stored identity, or a new one minted and saved now, after asking Luna Connect
/// which Luna id this device owns. A Luna that lost its system DB gets its old id and
/// key back from a drive copy instead of minting a new one.
///
/// `db` is locked only for the local reads and writes. Connect and the drives are
/// reached with no lock held, so a slow Connect never stalls other requests.
/// A new identity is copied to the drives and registered with Connect, both best-effort.
pub fn load_or_create_connected(
    db: &crate::Db,
    connect: &ConnectService,
    now: i64,
) -> Result<Identity> {
    let roots = {
        let conn = lock(db);
        if let Some(identity) = load(&conn)? {
            return Ok(identity);
        }
        connected_roots(&conn)
    };

    // No DB lock from here to the store below.
    let known = known_luna_id(&roots, connect)?;
    let recovered = match known {
        Some(luna_id) => {
            let (seed, created_at) =
                find_drive_copy(&roots, &luna_id).ok_or_else(|| anyhow::anyhow!(NO_KEY_MSG))?;
            Some((luna_id, seed, created_at))
        }
        None => None,
    };

    let (identity, minted) = {
        let conn = lock(db);
        // Another request may have set this Luna up while the lock was free.
        if let Some(identity) = load(&conn)? {
            return Ok(identity);
        }
        match recovered {
            Some((luna_id, seed, created_at)) => {
                db::set_cloud_identity(&conn, &luna_id, &seed, created_at)?;
                (
                    Identity {
                        luna_id,
                        signer: Signer::from_seed(seed),
                    },
                    false,
                )
            }
            None => {
                let luna_id = mint_luna_id();
                let signer = Signer::generate();
                db::set_cloud_identity(&conn, &luna_id, &signer.seed(), now)?;
                (Identity { luna_id, signer }, true)
            }
        }
    };

    if minted {
        copy_to_drives(&roots, &identity, now);
    }
    register_public(connect, &identity);
    Ok(identity)
}

/// The Luna id this Luna must keep, or None when it has none yet (so a new one is minted).
/// Only ids with a key copy on a connected drive are candidates: Connect's list is for the
/// whole account, so an id that exists only there is never adopted. One candidate is used.
/// Several are narrowed to the ids Connect also lists. Still several (or Connect cannot
/// answer) is an error. None left means no candidate is this Luna's, so a new one is minted.
fn known_luna_id(roots: &[PathBuf], connect: &ConnectService) -> Result<Option<String>> {
    let candidates = drive_luna_ids(roots);
    match candidates.len() {
        0 => return Ok(None),
        1 => return Ok(candidates.into_iter().next()),
        _ => {}
    }
    let account_ids = match connect.list_luna_ids() {
        Ok(rows) => rows
            .into_iter()
            .map(|row| row.luna_id)
            .collect::<BTreeSet<_>>(),
        Err(e) => {
            tracing::warn!(error = %e, "could not ask Luna Connect which Luna ids are on this account");
            bail!(AMBIGUOUS_MSG);
        }
    };
    let mut both: Vec<String> = candidates
        .into_iter()
        .filter(|id| account_ids.contains(id))
        .collect();
    match both.len() {
        0 => Ok(None),
        1 => Ok(both.pop()),
        _ => bail!(AMBIGUOUS_MSG),
    }
}

const AMBIGUOUS_MSG: &str = "Luna can't tell which cloud identity is its own, because Luna Connect or the drives list more than one. Contact your Admin.";
const NO_KEY_MSG: &str = "Luna can't find this Luna's cloud signing key. Connect the drive that holds a copy of it, then try again.";

fn lock(db: &crate::Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

/// Every Luna id that has a signing key copy on one of `roots`, without repeats.
fn drive_luna_ids(roots: &[PathBuf]) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for root in roots {
        let found = drive_db::open(root).and_then(|drive| {
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
    let hex: String = identity
        .public()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
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

/// Copy this Luna's signing key to every drive in `roots`. Best-effort: a drive
/// that cannot be opened is logged and skipped.
pub fn copy_to_drives(roots: &[PathBuf], identity: &Identity, now: i64) {
    for root in roots {
        if let Err(e) = copy_to_drive_at(root, identity, now) {
            tracing::warn!(error = %e, root = %root.display(), "could not copy the cloud signing key to a drive");
        }
    }
}

/// The signing key copy tagged with exactly `luna_id` on the first of `roots` that holds
/// one, as its seed and creation time. A damaged copy is logged and skipped.
fn find_drive_copy(roots: &[PathBuf], luna_id: &str) -> Option<([u8; 32], i64)> {
    for root in roots {
        let found = drive_db::open(root).and_then(|drive| {
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
        let Some((seed, created_at)) = row else {
            continue;
        };
        let Ok(seed) = <[u8; 32]>::try_from(seed.as_slice()) else {
            tracing::warn!(root = %root.display(), "a drive holds a damaged cloud signing key copy");
            continue;
        };
        return Some((seed, created_at));
    }
    None
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
        assert_eq!(
            stored.created_at, 100,
            "a second call must not mint or re-stamp"
        );
    }

    #[test]
    fn luna_id_format() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let id = load_or_create(&conn, 1).unwrap().luna_id;
        let rest = id.strip_prefix("luna-").expect("starts with luna-");
        assert_eq!(rest.len(), 26);
        assert!(
            rest.bytes().all(|b| BASE32.contains(&b)),
            "{rest} is not lowercase base32"
        );
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
        assert!(crypto::verify(
            &identity.public(),
            "test-domain",
            b"hello",
            &sig
        ));
        assert!(!crypto::verify(
            &identity.public(),
            "other-domain",
            b"hello",
            &sig
        ));
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
        db::upsert_drive(
            conn,
            id,
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
    }

    fn copies(root: &Path) -> Vec<String> {
        let drive = drive_db::open(root).unwrap();
        let mut stmt = drive
            .prepare("SELECT luna_id FROM cloud_signing_keys ORDER BY luna_id")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
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
        assert_eq!(
            seed,
            first.signer.seed().to_vec(),
            "an existing copy is not overwritten"
        );
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
        let roots = [root.clone()];
        let (seed, created_at) = find_drive_copy(&roots, &owner.luna_id).expect("found");
        assert_eq!(seed, owner.signer().seed());
        assert_eq!(created_at, 1);
        assert!(find_drive_copy(&roots, "luna-unknownunknownunknownun").is_none());
    }

    #[test]
    fn known_id_recovers_the_drive_copy_instead_of_minting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();

        // The system DB was lost: a fresh Luna knows the id and finds the key on the drive.
        let fresh_path = dir.path().join("fresh.db");
        let fresh = db::open(&fresh_path).unwrap();
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        drop(fresh);
        let (url, _seen) = fake_connect(&listing(&[&owner.luna_id]), 2);
        let connect = connect_to(&dir.path().join("connect"), &url);
        let back = load_or_create_connected(&db_at(&fresh_path), &connect, 9).unwrap();
        assert_eq!(back.luna_id, owner.luna_id);
        assert_eq!(back.public(), owner.public());
        assert_eq!(
            load(&db_at(&fresh_path).lock().unwrap())
                .unwrap()
                .unwrap()
                .public(),
            owner.public()
        );
    }

    #[test]
    fn connect_only_id_without_a_drive_copy_is_not_adopted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("luna.db");
        db::open(&path).unwrap();
        // Connect lists an id for the account, but no drive holds its key copy.
        let (url, _seen) = fake_connect(&listing(&["luna-unknownunknownunknownun"]), 2);
        let connect = connect_to(&dir.path().join("connect"), &url);
        let minted = load_or_create_connected(&db_at(&path), &connect, 1).unwrap();
        assert_ne!(minted.luna_id, "luna-unknownunknownunknownun");
        let stored = load(&db_at(&path).lock().unwrap()).unwrap().unwrap();
        assert_eq!(stored.luna_id, minted.luna_id);
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
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..n])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                let body = if line.starts_with("GET") {
                    get_body.clone()
                } else {
                    "{\"ok\":true}".to_string()
                };
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

    /// A second connection to the file at `path`, as the lock-taking code under test uses.
    fn db_at(path: &Path) -> crate::Db {
        crate::Db::new(db::open(path).unwrap())
    }

    /// Like `fake_connect`, for `count` requests, but before answering each one it checks
    /// whether `db` can be locked. A lock held during the request shows up as `false`.
    fn fake_connect_probing(
        get_body: &str,
        count: usize,
        db: Arc<crate::Db>,
    ) -> (String, Arc<Mutex<Vec<bool>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let probes = Arc::new(Mutex::new(Vec::new()));
        let log = probes.clone();
        let get_body = get_body.to_string();
        std::thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let line = String::from_utf8_lossy(&buf[..n])
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                // Try the lock from another thread, so a held lock cannot block this thread for good.
                let (tx, rx) = std::sync::mpsc::channel();
                let probe = db.clone();
                std::thread::spawn(move || {
                    let _guard = probe.lock();
                    let _ = tx.send(());
                });
                let free = rx
                    .recv_timeout(std::time::Duration::from_millis(500))
                    .is_ok();
                log.lock().unwrap().push(free);
                let body = if line.starts_with("GET") {
                    get_body.clone()
                } else {
                    "{\"ok\":true}".to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        (format!("http://{addr}"), probes)
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
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        let (url, seen) = fake_connect(&listing(&[&owner.luna_id]), 2);
        let connect = connect_to(&dir.path().join("connect"), &url);

        let back =
            load_or_create_connected(&db_at(&dir.path().join("fresh.db")), &connect, 9).unwrap();
        assert_eq!(back.luna_id, owner.luna_id);
        assert_eq!(back.public(), owner.public());
        assert_eq!(load(&fresh).unwrap().unwrap().public(), owner.public());
        let lines = seen.lock().unwrap().clone();
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("POST") && l.contains("/signing-public")),
            "{lines:?}"
        );
    }

    #[test]
    fn ids_only_connect_lists_are_never_adopted() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let other = "luna-aaaaaaaaaaaaaaaaaaaaaaaaaa";
        let (url, _seen) = fake_connect(&listing(&[other, "luna-bbbbbbbbbbbbbbbbbbbbbbbbbb"]), 1);
        let connect = connect_to(&dir.path().join("connect"), &url);

        // No drive holds a key copy, so the account's ids are not this Luna's: a new one is minted.
        let made =
            load_or_create_connected(&db_at(&dir.path().join("luna.db")), &connect, 1).unwrap();
        assert_ne!(made.luna_id, other);
        assert_eq!(load(&conn).unwrap().unwrap().luna_id, made.luna_id);
    }

    #[test]
    fn several_drive_copies_are_narrowed_by_connect() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let first_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&first_conn, &root, "d1");
        let first = load_or_create(&first_conn, 1).unwrap();
        let second_conn = db::open(&dir.path().join("b.db")).unwrap();
        let second = load_or_create(&second_conn, 2).unwrap();
        copy_to_drive_at(&root, &second, 2).unwrap();

        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        let (url, _seen) = fake_connect(&listing(&[&second.luna_id]), 2);
        let connect = connect_to(&dir.path().join("connect"), &url);

        let back =
            load_or_create_connected(&db_at(&dir.path().join("fresh.db")), &connect, 9).unwrap();
        assert_eq!(back.luna_id, second.luna_id);
        assert_ne!(back.luna_id, first.luna_id);
    }

    #[test]
    fn unreachable_connect_uses_the_one_drive_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let owner_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&owner_conn, &root, "d1");
        let owner = load_or_create(&owner_conn, 1).unwrap();

        let fresh = db::open(&dir.path().join("fresh.db")).unwrap();
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let back =
            load_or_create_connected(&db_at(&dir.path().join("fresh.db")), &connect, 9).unwrap();
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
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let err = load_or_create_connected(&db_at(&dir.path().join("fresh.db")), &connect, 9)
            .err()
            .unwrap();
        assert!(err.to_string().contains("Contact your Admin"), "{err}");
        assert!(load(&fresh).unwrap().is_none());
        assert_ne!(first.luna_id, second.luna_id);
    }

    #[test]
    fn unreachable_connect_with_no_drive_copy_mints_a_first_identity() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let connect = connect_to(&dir.path().join("connect"), &unreachable_url());

        let made =
            load_or_create_connected(&db_at(&dir.path().join("luna.db")), &connect, 1).unwrap();
        assert_eq!(load(&conn).unwrap().unwrap().luna_id, made.luna_id);
    }

    #[test]
    fn connect_is_asked_with_the_database_lock_free() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("drive");
        let first_conn = db::open(&dir.path().join("a.db")).unwrap();
        connected_drive(&first_conn, &root, "d1");
        load_or_create(&first_conn, 1).unwrap();
        let second_conn = db::open(&dir.path().join("b.db")).unwrap();
        let second = load_or_create(&second_conn, 2).unwrap();
        copy_to_drive_at(&root, &second, 2).unwrap();
        let fresh = db::open(&dir.path().join("luna.db")).unwrap();
        db::upsert_drive(
            &fresh,
            "d1",
            "Photos",
            "as_is",
            "ext4",
            "sdb",
            root.to_str().unwrap(),
        )
        .unwrap();
        drop(fresh);

        // Two drive copies: one Connect lookup (to narrow them), then the registration.
        let db = Arc::new(db_at(&dir.path().join("luna.db")));
        let (url, probes) = fake_connect_probing(&listing(&[&second.luna_id]), 2, db.clone());
        let connect = connect_to(&dir.path().join("connect"), &url);

        let made = load_or_create_connected(&db, &connect, 1).unwrap();
        assert_eq!(made.luna_id, second.luna_id);
        let probes = probes.lock().unwrap().clone();
        assert_eq!(probes.len(), 2, "one lookup and one registration");
        assert!(
            probes.iter().all(|free| *free),
            "the DB lock was held during a Connect request: {probes:?}"
        );
        assert_eq!(
            load(&db.lock().unwrap()).unwrap().unwrap().luna_id,
            made.luna_id
        );
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
