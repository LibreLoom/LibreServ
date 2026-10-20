//! Cloud backup storage: the `CloudStore` trait the backup code talks to, an HTTP client for
//! Luna Connect's `/api/v1/storage` API (see the phase 2 storage contract), and an in-memory
//! store for tests. Every method blocks; async callers wrap them in `spawn_blocking`.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::crypto::{Signer, pack_id};

/// Largest pack Connect accepts.
pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
/// Largest small record (snapshot, sealed key, user list) Connect accepts.
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
/// Largest JSON reply Luna reads from Connect.
const MAX_JSON_REPLY_BYTES: u64 = 4 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Small calls: records, usage, listings.
const JSON_TIMEOUT: Duration = Duration::from_secs(20);
/// Pack uploads and downloads can be up to 64 MB on a slow line.
const PACK_TIMEOUT: Duration = Duration::from_secs(300);

const UNREACHABLE_MSG: &str = "Luna could not reach Luna Connect. Check this Luna's internet connection. Luna will try again.";
const SERVER_MSG: &str =
    "Luna Connect could not save or load your backup right now. Luna will try again.";
const REFUSED_MSG: &str = "Luna Connect refused that request.";
const PACK_TOO_BIG_MSG: &str = "A backup piece is larger than Luna Connect accepts (64 MB).";
const RECORD_TOO_BIG_MSG: &str = "A backup record is larger than Luna Connect accepts (1 MB).";
const CHECKSUM_MSG: &str = "Luna sent a backup piece that does not match its checksum.";
const NAME_MSG: &str = "Luna used a name for a backup record that Luna Connect does not accept.";
const SCOPE_MSG: &str = "Luna used a backup label that Luna Connect does not accept.";

/// Storage quota and use for this Luna's account. `quota_bytes` 0 means no quota is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Usage {
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error("Your cloud storage is full.")]
    Full,
    #[error("That item is not in your cloud storage.")]
    NotFound,
    /// Network trouble or a server-side failure. The message is ready to show.
    #[error("{0}")]
    Unavailable(String),
    /// Luna Connect refused the request. The message is Connect's own sentence.
    #[error("{0}")]
    Rejected(String),
}

pub trait CloudStore: Send + Sync {
    fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError>;
    fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError>;
    fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError>;
    fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError>;
    fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError>;
    fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError>;
    fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError>;
    fn usage(&self) -> Result<Usage, StoreError>;
}

/// Checks shared by both stores, so a bad request fails the same way everywhere.
fn check_pack(id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
    if bytes.len() > MAX_PACK_BYTES {
        return Err(StoreError::Rejected(PACK_TOO_BIG_MSG.into()));
    }
    if pack_id(bytes) != *id {
        return Err(StoreError::Rejected(CHECKSUM_MSG.into()));
    }
    if let Some(scope) = scope
        && !valid_token(scope, 64)
    {
        return Err(StoreError::Rejected(SCOPE_MSG.into()));
    }
    Ok(())
}

fn check_record(kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
    if !valid_token(kind, 128) || !valid_token(name, 128) {
        return Err(StoreError::Rejected(NAME_MSG.into()));
    }
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(StoreError::Rejected(RECORD_TOO_BIG_MSG.into()));
    }
    Ok(())
}

/// `[a-z0-9._-]` for record names and kinds, `[a-z0-9-]` for scopes; both capped at `max` chars.
fn valid_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_'))
}

fn hex_id(id: &[u8; 32]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

/// In-memory store with the same rules as Connect. Optional quota for testing `Full`.
#[derive(Default)]
pub struct MemoryStore {
    quota_bytes: u64,
    inner: Mutex<MemoryInner>,
}

#[derive(Default)]
struct MemoryInner {
    packs: HashMap<[u8; 32], (Option<String>, Vec<u8>)>,
    records: BTreeMap<(String, String), Vec<u8>>,
}

impl MemoryInner {
    fn used(&self) -> u64 {
        let packs: usize = self.packs.values().map(|(_, b)| b.len()).sum();
        let records: usize = self.records.values().map(Vec::len).sum();
        (packs + records) as u64
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that answers `Full` once `quota_bytes` would be exceeded.
    pub fn with_quota(quota_bytes: u64) -> Self {
        Self {
            quota_bytes,
            inner: Mutex::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fits(&self, used: u64, adding: u64) -> bool {
        self.quota_bytes == 0 || used + adding <= self.quota_bytes
    }
}

impl CloudStore for MemoryStore {
    fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
        check_pack(id, scope, bytes)?;
        let mut inner = self.lock();
        if inner.packs.contains_key(id) {
            return Ok(());
        }
        if !self.fits(inner.used(), bytes.len() as u64) {
            return Err(StoreError::Full);
        }
        inner
            .packs
            .insert(*id, (scope.map(str::to_string), bytes.to_vec()));
        Ok(())
    }

    fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
        self.lock()
            .packs
            .get(id)
            .map(|(_, b)| b.clone())
            .ok_or(StoreError::NotFound)
    }

    fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
        self.lock()
            .packs
            .remove(id)
            .map(|_| ())
            .ok_or(StoreError::NotFound)
    }

    fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
        check_record(kind, name, bytes)?;
        let mut inner = self.lock();
        let key = (kind.to_string(), name.to_string());
        let replaced = inner.records.get(&key).map_or(0, Vec::len) as u64;
        if !self.fits(inner.used() - replaced, bytes.len() as u64) {
            return Err(StoreError::Full);
        }
        inner.records.insert(key, bytes.to_vec());
        Ok(())
    }

    fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if !valid_token(kind, 128) || !valid_token(name, 128) {
            return Err(StoreError::Rejected(NAME_MSG.into()));
        }
        Ok(self
            .lock()
            .records
            .get(&(kind.to_string(), name.to_string()))
            .cloned())
    }

    fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
        if !valid_token(kind, 128) || !valid_token(name, 128) {
            return Err(StoreError::Rejected(NAME_MSG.into()));
        }
        self.lock()
            .records
            .remove(&(kind.to_string(), name.to_string()));
        Ok(())
    }

    fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
        Ok(self
            .lock()
            .records
            .keys()
            .filter(|(k, _)| k == kind)
            .map(|(_, n)| n.clone())
            .collect())
    }

    fn usage(&self) -> Result<Usage, StoreError> {
        Ok(Usage {
            used_bytes: self.lock().used(),
            quota_bytes: self.quota_bytes,
        })
    }
}

/// Talks to Luna Connect's storage API with this Luna's device token.
pub struct HttpStore {
    base_url: String,
    device_token: String,
    luna_id: String,
    /// Luna's own signing key. When set, every request is signed so Connect can
    /// check the request really comes from this Luna.
    signer: Option<Signer>,
}

/// Signing domain for the per-request signature. Connect checks it with the same name.
const REQUEST_SIGN_DOMAIN: &str = "move";

/// Adds this Luna's id and, when the store is signed, the time and signature headers.
/// The signature covers the luna id bytes, a zero byte, and the timestamp in decimal.
trait IdentifyRequest: Sized {
    fn identify(self, store: &HttpStore) -> Self;
}

impl<M> IdentifyRequest for ureq::RequestBuilder<M> {
    fn identify(self, store: &HttpStore) -> Self {
        let req = self.header("X-Luna-Id", store.luna_id.as_str());
        let Some(signer) = &store.signer else {
            return req;
        };
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .to_string();
        let mut msg = store.luna_id.as_bytes().to_vec();
        msg.push(0);
        msg.extend_from_slice(ts.as_bytes());
        let sig: String = signer
            .sign(REQUEST_SIGN_DOMAIN, &msg)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        req.header("X-Luna-Ts", ts).header("X-Luna-Sig", sig)
    }
}

/// A finished HTTP exchange: status and the body, already read.
struct Reply {
    status: u16,
    body: Vec<u8>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Deserialize)]
struct NamesBody {
    names: Vec<String>,
}

impl HttpStore {
    /// `base_url` is Connect's address (e.g. `https://connect.luna.libreloom.org`).
    pub fn new(base_url: &str, device_token: &str, luna_id: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            device_token: device_token.to_string(),
            luna_id: luna_id.to_string(),
            signer: None,
        }
    }

    /// Signs every request with Luna's own key, so Connect can check that the
    /// request comes from this Luna.
    pub fn signed_by(mut self, signer: Signer) -> Self {
        self.signer = Some(signer);
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1/storage{path}", self.base_url)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.device_token)
    }
}

/// Reads the whole reply. A network failure while reading is `Unavailable`.
fn finish(
    result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    body_limit: u64,
) -> Result<Reply, StoreError> {
    let mut response = result.map_err(|_| StoreError::Unavailable(UNREACHABLE_MSG.into()))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(body_limit)
        .read_to_vec()
        .map_err(|_| StoreError::Unavailable(UNREACHABLE_MSG.into()))?;
    Ok(Reply { status, body })
}

impl Reply {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    fn error(&self) -> StoreError {
        match self.status {
            507 => StoreError::Full,
            404 => StoreError::NotFound,
            400..=499 => StoreError::Rejected(connect_sentence(&self.body)),
            _ => StoreError::Unavailable(SERVER_MSG.into()),
        }
    }

    fn json<T: for<'de> Deserialize<'de>>(&self) -> Result<T, StoreError> {
        serde_json::from_slice(&self.body).map_err(|_| StoreError::Unavailable(SERVER_MSG.into()))
    }
}

/// Connect's `{"error": "..."}` sentence, or a plain fallback when the body has none.
fn connect_sentence(body: &[u8]) -> String {
    serde_json::from_slice::<ErrorBody>(body)
        .map(|b| b.error)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| REFUSED_MSG.into())
}

impl CloudStore for HttpStore {
    fn put_pack(&self, id: &[u8; 32], scope: Option<&str>, bytes: &[u8]) -> Result<(), StoreError> {
        check_pack(id, scope, bytes)?;
        let url = self.url(&format!("/packs/{}", hex_id(id)));
        let mut req = ureq::put(&url)
            .config()
            .http_status_as_error(false)
            .timeout_global(Some(PACK_TIMEOUT))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .build()
            .header("Authorization", self.auth())
            .identify(self);
        if let Some(scope) = scope {
            req = req.header("X-Luna-Scope", scope);
        }
        let reply = finish(req.send(bytes), MAX_JSON_REPLY_BYTES)?;
        if reply.is_success() {
            Ok(())
        } else {
            Err(reply.error())
        }
    }

    fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
        let url = self.url(&format!("/packs/{}", hex_id(id)));
        let reply = finish(
            ureq::get(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(PACK_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_PACK_BYTES as u64,
        )?;
        if reply.is_success() {
            Ok(reply.body)
        } else {
            Err(reply.error())
        }
    }

    fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
        let url = self.url(&format!("/packs/{}", hex_id(id)));
        let reply = finish(
            ureq::delete(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_JSON_REPLY_BYTES,
        )?;
        if reply.is_success() {
            Ok(())
        } else {
            Err(reply.error())
        }
    }

    fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
        check_record(kind, name, bytes)?;
        let url = self.url(&format!("/records/{kind}/{name}"));
        let reply = finish(
            ureq::put(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .send(bytes),
            MAX_JSON_REPLY_BYTES,
        )?;
        if reply.is_success() {
            Ok(())
        } else {
            Err(reply.error())
        }
    }

    fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        if !valid_token(kind, 128) || !valid_token(name, 128) {
            return Err(StoreError::Rejected(NAME_MSG.into()));
        }
        let url = self.url(&format!("/records/{kind}/{name}"));
        let reply = finish(
            ureq::get(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_RECORD_BYTES as u64,
        )?;
        match reply.status {
            404 => Ok(None),
            _ if reply.is_success() => Ok(Some(reply.body)),
            _ => Err(reply.error()),
        }
    }

    fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
        if !valid_token(kind, 128) || !valid_token(name, 128) {
            return Err(StoreError::Rejected(NAME_MSG.into()));
        }
        let url = self.url(&format!("/records/{kind}/{name}"));
        let reply = finish(
            ureq::delete(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_JSON_REPLY_BYTES,
        )?;
        // A record that is already gone counts as deleted.
        if reply.is_success() || reply.status == 404 {
            Ok(())
        } else {
            Err(reply.error())
        }
    }

    fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
        if !valid_token(kind, 128) {
            return Err(StoreError::Rejected(NAME_MSG.into()));
        }
        let url = self.url(&format!("/records/{kind}"));
        let reply = finish(
            ureq::get(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_JSON_REPLY_BYTES,
        )?;
        if !reply.is_success() {
            return Err(reply.error());
        }
        Ok(reply.json::<NamesBody>()?.names)
    }

    fn usage(&self) -> Result<Usage, StoreError> {
        let url = self.url("/usage");
        let reply = finish(
            ureq::get(&url)
                .config()
                .http_status_as_error(false)
                .timeout_global(Some(JSON_TIMEOUT))
                .timeout_connect(Some(CONNECT_TIMEOUT))
                .build()
                .header("Authorization", self.auth())
                .identify(self)
                .call(),
            MAX_JSON_REPLY_BYTES,
        )?;
        if !reply.is_success() {
            return Err(reply.error());
        }
        reply.json::<Usage>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    const LUNA: &str = "luna-test-1";
    const TOKEN: &str = "ABCD-EFGH-JKMN-PQRS-TVWX";

    fn id_of(bytes: &[u8]) -> [u8; 32] {
        pack_id(bytes)
    }

    /// Answers one request per `(status, json body)` in order. Returns each request's
    /// head (request line and headers) plus its body length, for assertions.
    fn serve(replies: Vec<(u16, &'static str)>) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in replies {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                let mut head = String::new();
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                    head.push_str(&line);
                }
                let mut sent = vec![0u8; len];
                reader.read_exact(&mut sent).unwrap();
                seen.push(format!("{head}body={len}"));
                let mut stream = reader.into_inner();
                write!(
                    stream,
                    "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                stream.flush().unwrap();
            }
            seen
        });
        (base, handle)
    }

    fn http(base: &str) -> HttpStore {
        HttpStore::new(base, TOKEN, LUNA)
    }

    #[test]
    fn memory_pack_round_trip() {
        let store = MemoryStore::new();
        let bytes = b"sealed pack";
        let id = id_of(bytes);
        store.put_pack(&id, Some("photos"), bytes).unwrap();
        assert_eq!(store.get_pack(&id).unwrap(), bytes);
        store.put_pack(&id, None, bytes).unwrap(); // same id again is fine
        store.delete_pack(&id).unwrap();
        assert_eq!(store.get_pack(&id), Err(StoreError::NotFound));
        assert_eq!(store.delete_pack(&id), Err(StoreError::NotFound));
    }

    #[test]
    fn memory_rejects_wrong_id_and_bad_scope() {
        let store = MemoryStore::new();
        let bytes = b"sealed pack";
        let wrong = id_of(b"something else");
        assert!(matches!(
            store.put_pack(&wrong, None, bytes),
            Err(StoreError::Rejected(_))
        ));
        let id = id_of(bytes);
        assert!(matches!(
            store.put_pack(&id, Some("Bad Scope"), bytes),
            Err(StoreError::Rejected(_))
        ));
    }

    #[test]
    fn memory_quota_gives_full() {
        let store = MemoryStore::with_quota(10);
        let a = b"12345678";
        let b = b"abcdefgh";
        store.put_pack(&id_of(a), None, a).unwrap();
        assert_eq!(store.put_pack(&id_of(b), None, b), Err(StoreError::Full));
        assert_eq!(
            store.usage().unwrap(),
            Usage {
                used_bytes: 8,
                quota_bytes: 10
            }
        );
    }

    #[test]
    fn memory_records_overwrite_list_and_delete() {
        let store = MemoryStore::new();
        store.put_record("snapshot", "b.json", b"two").unwrap();
        store.put_record("snapshot", "a.json", b"one").unwrap();
        store.put_record("keys", "k1", b"key").unwrap();
        store.put_record("snapshot", "a.json", b"uno").unwrap();
        assert_eq!(
            store.get_record("snapshot", "a.json").unwrap(),
            Some(b"uno".to_vec())
        );
        assert_eq!(
            store.list_records("snapshot").unwrap(),
            vec!["a.json".to_string(), "b.json".to_string()]
        );
        store.delete_record("snapshot", "a.json").unwrap();
        assert_eq!(store.get_record("snapshot", "a.json").unwrap(), None);
        assert!(matches!(
            store.put_record("Snapshot", "x", b"x"),
            Err(StoreError::Rejected(_))
        ));
    }

    #[test]
    fn signed_requests_carry_a_timestamp_and_a_signature_connect_can_check() {
        let signer = Signer::from_seed([9u8; 32]);
        let public = signer.public();
        let (base, server) = serve(vec![(200, "{}")]);
        http(&base)
            .signed_by(signer)
            .get_pack(&id_of(b"pack"))
            .unwrap();
        let head = server.join().unwrap()[0].to_ascii_lowercase();
        let field = |name: &str| {
            head.lines()
                .find_map(|l| l.strip_prefix(&format!("{name}: ")))
                .unwrap()
                .trim()
                .to_string()
        };
        let ts = field("x-luna-ts");
        let sig_hex = field("x-luna-sig");
        let sig: crate::backup::cloud::crypto::SigBytes = (0..sig_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&sig_hex[i..i + 2], 16).unwrap())
            .collect::<Vec<u8>>()
            .try_into()
            .unwrap();
        let mut msg = LUNA.as_bytes().to_vec();
        msg.push(0);
        msg.extend_from_slice(ts.as_bytes());
        assert!(crate::backup::cloud::crypto::verify(
            &public, "move", &msg, &sig
        ));
        // The signature covers the timestamp, so a changed time must not verify.
        let mut later = LUNA.as_bytes().to_vec();
        later.push(0);
        later.extend_from_slice((ts.parse::<u64>().unwrap() + 1).to_string().as_bytes());
        assert!(!crate::backup::cloud::crypto::verify(
            &public, "move", &later, &sig
        ));
        // The timestamp is Luna's clock in seconds, close to now.
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(ts.parse::<u64>().unwrap().abs_diff(now) < 60);
    }

    #[test]
    fn unsigned_requests_carry_no_signature_headers() {
        let (base, server) = serve(vec![(200, "{}")]);
        http(&base).get_pack(&id_of(b"pack")).unwrap();
        let head = server.join().unwrap()[0].to_ascii_lowercase();
        assert!(head.contains(&format!("x-luna-id: {LUNA}")));
        assert!(!head.contains("x-luna-sig"));
        assert!(!head.contains("x-luna-ts"));
    }

    #[test]
    fn http_put_pack_sends_id_scope_and_luna_id() {
        let bytes = b"sealed pack";
        let id = id_of(bytes);
        let (base, server) = serve(vec![(200, "{}")]);
        http(&base).put_pack(&id, Some("photos"), bytes).unwrap();
        let seen = server.join().unwrap();
        let head = seen[0].to_ascii_lowercase();
        assert!(head.starts_with(&format!(
            "put /api/v1/storage/packs/{} http/1.1",
            hex_id(&id)
        )));
        assert!(head.contains("x-luna-scope: photos"));
        assert!(head.contains(&format!("x-luna-id: {LUNA}")));
        assert!(head.contains(&format!(
            "authorization: bearer {}",
            TOKEN.to_ascii_lowercase()
        )));
        assert!(seen[0].ends_with(&format!("body={}", bytes.len())));
    }

    #[test]
    fn http_507_is_full() {
        let bytes = b"sealed pack";
        let (base, server) = serve(vec![(507, r#"{"error":"Your cloud storage is full."}"#)]);
        let err = http(&base)
            .put_pack(&id_of(bytes), None, bytes)
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(err, StoreError::Full);
    }

    #[test]
    fn http_400_shows_connect_sentence() {
        let bytes = b"sealed pack";
        let (base, server) = serve(vec![(
            400,
            r#"{"error":"This pack's checksum does not match its contents."}"#,
        )]);
        let err = http(&base)
            .put_pack(&id_of(bytes), None, bytes)
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(
            err,
            StoreError::Rejected("This pack's checksum does not match its contents.".into())
        );
    }

    #[test]
    fn http_id_mismatch_is_rejected_before_sending() {
        let err = http("http://127.0.0.1:1")
            .put_pack(&id_of(b"other"), None, b"sealed pack")
            .unwrap_err();
        assert!(matches!(err, StoreError::Rejected(_)));
    }

    #[test]
    fn http_missing_record_is_none_and_round_trips() {
        let (base, server) = serve(vec![
            (404, r#"{"error":"Not found."}"#),
            (200, "{\"names\":[\"a.json\",\"b.json\"]}"),
        ]);
        let store = http(&base);
        assert_eq!(store.get_record("snapshot", "a.json").unwrap(), None);
        assert_eq!(
            store.list_records("snapshot").unwrap(),
            vec!["a.json".to_string(), "b.json".to_string()]
        );
        server.join().unwrap();
    }

    #[test]
    fn http_usage_parses_and_server_error_is_unavailable() {
        let (base, server) = serve(vec![
            (200, r#"{"used_bytes":5,"quota_bytes":0}"#),
            (503, r#"{"error":"Try later."}"#),
        ]);
        let store = http(&base);
        assert_eq!(
            store.usage().unwrap(),
            Usage {
                used_bytes: 5,
                quota_bytes: 0
            }
        );
        assert!(matches!(store.usage(), Err(StoreError::Unavailable(_))));
        server.join().unwrap();
    }

    #[test]
    fn http_unreachable_is_unavailable() {
        let err = http("http://127.0.0.1:1")
            .get_pack(&id_of(b"x"))
            .unwrap_err();
        assert!(matches!(err, StoreError::Unavailable(_)));
    }
}
