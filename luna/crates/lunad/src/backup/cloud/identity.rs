//! This Luna's cloud identity: its random id and the signing key that vouches for it.
//!
//! Luna mints the id itself at the first cloud setup and never mints another, so every
//! recovery phrase keeps deriving the same keys. The signing key lives in the system DB.

use std::sync::MutexGuard;

use anyhow::{Result, bail};
use rusqlite::Connection;

use super::crypto::{SigBytes, SigPublic, Signer};
use crate::db;
use crate::net::connect::ConnectService;

const ID_PREFIX: &str = "luna-";
/// RFC 4648 base32 alphabet, lowercase.
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// This Luna's id and its signing key.
pub struct Identity {
    pub luna_id: String,
    signer: Signer,
}

impl Identity {
    pub fn luna_id(&self) -> &str {
        &self.luna_id
    }

    /// The signing public key, which Connect and browsers check signatures with.
    pub fn public(&self) -> SigPublic {
        self.signer.public()
    }

    /// Sign `msg` under `domain`. See `crypto::Signer::sign`.
    pub fn sign(&self, domain: &str, msg: &[u8]) -> SigBytes {
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

/// The stored identity, or a new one minted and saved in the system DB.
pub fn load_or_create(conn: &Connection, now: i64) -> Result<Identity> {
    if let Some(identity) = load(conn)? {
        return Ok(identity);
    }
    let luna_id = mint_luna_id();
    let signer = Signer::generate();
    db::set_cloud_identity(conn, &luna_id, &signer.seed(), now)?;
    Ok(Identity { luna_id, signer })
}

/// Load or mint the local identity, then register its public key with Connect
/// on a best-effort basis. The DB lock is released before contacting Connect.
pub fn load_or_create_connected(
    db: &crate::Db,
    connect: &ConnectService,
    now: i64,
) -> Result<Identity> {
    let identity = {
        let conn = lock(db);
        load_or_create(&conn, now)?
    };
    ensure_registered(db, connect, &identity);
    Ok(identity)
}

fn lock(db: &crate::Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|p| p.into_inner())
}

/// Meta key holding the Luna id whose signing key Luna Connect has accepted.
const REGISTERED_KEY: &str = "cloud_identity_registered";

/// Make sure Luna Connect has this Luna's signing key. A Luna id made while Connect was off
/// is registered on the first load after Connect becomes reachable, and then never again
/// for that id. No DB lock is held across the network call.
fn ensure_registered(db: &crate::Db, connect: &ConnectService, identity: &Identity) {
    if !connect.is_connect_active() {
        return;
    }
    let registered = {
        let conn = lock(db);
        db::get_meta(&conn, REGISTERED_KEY).ok().flatten()
    };
    if registered.as_deref() == Some(identity.luna_id.as_str()) {
        return;
    }
    if let Err(e) = acknowledge_registration(db, connect, identity) {
        tracing::warn!(error = %e, "could not register this Luna's signing key with Luna Connect");
    }
}

/// Ask Connect to accept this Luna's existing key even if an earlier request succeeded.
pub(super) fn acknowledge_registration(
    db: &crate::Db,
    connect: &ConnectService,
    identity: &Identity,
) -> Result<(), crate::net::connect::ConnectError> {
    let hex: String = identity
        .public()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    connect.register_signing_public(&identity.luna_id, &hex)?;
    let conn = lock(db);
    if let Err(e) = db::set_meta(&conn, REGISTERED_KEY, &identity.luna_id) {
        tracing::warn!(error = %e, "could not remember that this Luna's signing key is registered");
    }
    Ok(())
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
    use crate::drives::drive_db;
    use crate::net::connect::{CONNECT_CREDENTIAL_FILE, DEVICE_UID_FILE, PAIRING_CODE_FILE};
    use std::path::Path;
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

    /// A fake Luna Connect on localhost that accepts registrations and records requests.
    fn fake_connect(count: usize) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
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
                let body = r#"{"ok":true}"#;
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
    fn fake_connect_probing(count: usize, db: Arc<crate::Db>) -> (String, Arc<Mutex<Vec<bool>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let probes = Arc::new(Mutex::new(Vec::new()));
        let log = probes.clone();
        std::thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
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
                let body = r#"{"ok":true}"#;
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

    /// A bound Connect client under `dir`, pointed at `base_url`.
    fn connect_to(dir: &Path, base_url: &str) -> ConnectService {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(DEVICE_UID_FILE), "7K4M2Q9XR8N36T5W1PZH\n").unwrap();
        std::fs::write(dir.join(PAIRING_CODE_FILE), "A3F91C\n").unwrap();
        std::fs::write(
            dir.join(CONNECT_CREDENTIAL_FILE),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
        )
        .unwrap();
        let service = ConnectService::new(dir, Some(base_url.to_string()));
        service
            .save(&serde_json::json!({
                "state": "bound",
                "bound": true,
                "paired": true,
            }))
            .unwrap();
        service
    }

    #[test]
    fn legacy_drive_copy_is_ignored_and_left_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let owner_conn = db::open(&dir.path().join("owner.db")).unwrap();
        let owner = load_or_create(&owner_conn, 1).unwrap();
        let seed = owner.signer.seed();

        let fresh = db_at(&dir.path().join("fresh.db"));
        let root = dir.path().join("drive");
        connected_drive(&lock(&fresh), &root, "d1");
        let drive = drive_db::open(&root).unwrap();
        drive
            .execute_batch(
                "CREATE TABLE cloud_signing_keys (
                luna_id TEXT PRIMARY KEY NOT NULL,
                seed BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );",
            )
            .unwrap();
        drive
            .execute(
                "INSERT INTO cloud_signing_keys VALUES (?1, ?2, 1)",
                rusqlite::params![owner.luna_id(), &seed[..]],
            )
            .unwrap();
        drop(drive);

        let (url, seen) = fake_connect(1);
        let connect = connect_to(&dir.path().join("connect"), &url);
        let made = load_or_create_connected(&fresh, &connect, 9).unwrap();
        assert_ne!(made.luna_id(), owner.luna_id());
        assert_ne!(made.public(), owner.public());
        let stored = load(&lock(&fresh)).unwrap().unwrap();
        assert_eq!(stored.luna_id(), made.luna_id());
        assert_eq!(stored.public(), made.public());
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [format!(
                "POST /api/v1/storage/luna-ids/{}/signing-public HTTP/1.1",
                made.luna_id()
            )]
        );

        let drive = drive_db::open(&root).unwrap();
        let mut stmt = drive
            .prepare("SELECT luna_id, seed, created_at FROM cloud_signing_keys")
            .unwrap();
        let copies = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(copies, vec![(owner.luna_id, seed.to_vec(), 1)]);
    }

    #[test]
    fn registration_runs_with_the_database_lock_free() {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(db_at(&dir.path().join("luna.db")));
        let (url, probes) = fake_connect_probing(1, db.clone());
        let connect = connect_to(&dir.path().join("connect"), &url);

        load_or_create_connected(&db, &connect, 1).unwrap();
        assert_eq!(probes.lock().unwrap().as_slice(), [true]);
    }

    #[test]
    fn an_identity_made_while_connect_was_unreachable_registers_on_the_next_load() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_at(&dir.path().join("luna.db"));
        let unreachable = connect_to(&dir.path().join("connect"), &unreachable_url());
        let made = load_or_create_connected(&db, &unreachable, 1).unwrap();

        // Connect is reachable now: the next load registers the key it never received.
        let (url, seen) = fake_connect(1);
        let reachable = connect_to(&dir.path().join("connect"), &url);
        let again = load_or_create_connected(&db, &reachable, 2).unwrap();
        assert_eq!(again.luna_id, made.luna_id);
        let posts = |seen: &Arc<Mutex<Vec<String>>>| {
            seen.lock()
                .unwrap()
                .iter()
                .filter(|l| l.starts_with("POST") && l.contains("/signing-public"))
                .count()
        };
        assert_eq!(posts(&seen), 1, "{:?}", seen.lock().unwrap());

        // Once registered, later loads don't send it again.
        load_or_create_connected(&db, &reachable, 3).unwrap();
        assert_eq!(posts(&seen), 1, "{:?}", seen.lock().unwrap());
    }

    #[test]
    fn no_bound_credential_means_no_registration_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let db = db_at(&dir.path().join("luna.db"));
        let (url, seen) = fake_connect(1);
        // Connect is off: pairing material alone is not a bound credential.
        std::fs::create_dir_all(dir.path().join("connect")).unwrap();
        let off = ConnectService::new(&dir.path().join("connect"), Some(url));
        load_or_create_connected(&db, &off, 1).unwrap();
        load_or_create_connected(&db, &off, 2).unwrap();
        assert!(
            seen.lock().unwrap().is_empty(),
            "{:?}",
            seen.lock().unwrap()
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
