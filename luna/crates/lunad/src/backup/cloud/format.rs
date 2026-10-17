//! Cloud backup format: content-defined chunks, sealed packs, encrypted trees and signed snapshot
//! records. Everything here is pure (no I/O beyond the reader passed in), so the browser port can
//! follow the same layout. Layouts are fixed by the version bytes and AAD labels below.

use std::collections::HashMap;
use std::io::Read;

use anyhow::{anyhow, bail, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::crypto::{self, Signer};

/// Smallest chunk FastCDC will cut.
pub const CHUNK_MIN: u32 = 256 * 1024;
/// Average chunk size, which sets the cut points.
pub const CHUNK_AVG: u32 = 1024 * 1024;
/// Largest chunk FastCDC will cut.
pub const CHUNK_MAX: u32 = 4 * 1024 * 1024;
/// A pack is sealed once its plain chunks reach this many bytes.
pub const PACK_TARGET: usize = 32 * 1024 * 1024;

/// Pack layout version, the first byte of every pack.
const PACK_VERSION: u8 = 1;
/// AAD for the pack body (the chunks), under the pack's own key.
const PACK_BODY_AAD: &[u8] = b"luna-pack-v1";
/// AAD for the encrypted pack index, under the pack's own key.
const PACK_INDEX_AAD: &[u8] = b"luna-pack-index-v1";
/// AAD for a pack key wrapped by the caller (the caller picks the wrapping key).
const TREE_AAD: &[u8] = b"luna-tree-v1";
/// AAD for the encrypted snapshot metadata, under the backup key.
const META_AAD: &[u8] = b"luna-meta-v1";
/// Domain for snapshot record signatures.
const SNAPSHOT_DOMAIN: &str = "snapshot";

/// Split `data` into content-defined chunks and hand each one to `f`, in order. Reads as it goes,
/// so a whole file is never held in memory.
pub fn chunks(data: &mut impl Read, mut f: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    let chunker = fastcdc::v2020::StreamCDC::new(data, CHUNK_MIN, CHUNK_AVG, CHUNK_MAX);
    for chunk in chunker {
        let chunk = chunk.map_err(|e| anyhow!("Could not split a file into pieces for backup: {e}"))?;
        f(&chunk.data)?;
    }
    Ok(())
}

/// Collects plain chunks into one pack. Nothing is encrypted until `finish`.
pub struct PackBuilder {
    scope_id: [u8; 32],
    plain: Vec<u8>,
    entries: Vec<([u8; 32], u64, u32)>,
}

impl PackBuilder {
    pub fn new(scope_id: [u8; 32]) -> Self {
        Self { scope_id, plain: Vec::new(), entries: Vec::new() }
    }

    /// Append one chunk and return where it sits in the pack's plain body.
    /// Chunks come from `chunks`, so they are at most `CHUNK_MAX` (4 MiB) and always fit in a u32.
    pub fn add(&mut self, chunk_id: [u8; 32], plain: &[u8]) -> (u64, u32) {
        let offset = self.plain.len() as u64;
        let len = u32::try_from(plain.len()).expect("chunks are at most 4 MiB");
        self.plain.extend_from_slice(plain);
        self.entries.push((chunk_id, offset, len));
        (offset, len)
    }

    /// Plain bytes buffered so far. Callers finish the pack once this reaches `PACK_TARGET`.
    pub fn len(&self) -> usize {
        self.plain.len()
    }

    pub fn is_empty(&self) -> bool {
        self.plain.is_empty()
    }

    /// Seal the pack under a fresh random key. `pack_key_wrap` turns that key into the bytes stored
    /// in the header (the caller seals it to the backup key).
    pub fn finish(self, pack_key_wrap: impl Fn(&[u8; 32]) -> Vec<u8>) -> SealedPack {
        let mut pack_key = [0u8; 32];
        OsRng.fill_bytes(&mut pack_key);

        let wrapped = pack_key_wrap(&pack_key);
        let index = encode_index(&self.scope_id, &self.entries);
        let sealed_index = crypto::encrypt(&pack_key, PACK_INDEX_AAD, &index);
        let body = crypto::encrypt(&pack_key, PACK_BODY_AAD, &self.plain);

        // Layout: version (1) ‖ wrapped key len (u32 BE) ‖ wrapped key ‖ index len (u32 BE) ‖
        // sealed index ‖ sealed body (the body runs to the end of the pack).
        let mut bytes = Vec::with_capacity(1 + 4 + wrapped.len() + 4 + sealed_index.len() + body.len());
        bytes.push(PACK_VERSION);
        push_len(&mut bytes, wrapped.len());
        bytes.extend_from_slice(&wrapped);
        push_len(&mut bytes, sealed_index.len());
        bytes.extend_from_slice(&sealed_index);
        bytes.extend_from_slice(&body);

        let id = crypto::pack_id(&bytes);
        let entries = self.entries;
        SealedPack { id, bytes, entries }
    }
}

/// A sealed pack, ready to upload. `entries` stays on the Luna side (it is the local plain index).
pub struct SealedPack {
    /// SHA-256 of `bytes`.
    pub id: [u8; 32],
    pub bytes: Vec<u8>,
    /// (chunk id, offset in the plain body, length).
    pub entries: Vec<([u8; 32], u64, u32)>,
}

/// A pack opened with its key. Holds the plain body and the index.
pub struct OpenedPack {
    scope_id: [u8; 32],
    plain: Vec<u8>,
    index: HashMap<[u8; 32], (u64, u32)>,
}

impl OpenedPack {
    /// The scope the pack was sealed for (from the encrypted index).
    pub fn scope_id(&self) -> [u8; 32] {
        self.scope_id
    }

    /// The plain bytes of one chunk, or `None` if this pack does not hold it.
    pub fn chunk(&self, chunk_id: &[u8; 32]) -> Option<&[u8]> {
        let &(offset, len) = self.index.get(chunk_id)?;
        let start = usize::try_from(offset).ok()?;
        let end = start.checked_add(len as usize)?;
        self.plain.get(start..end)
    }
}

/// Open a pack: check its bytes hash to `id`, unwrap its key, then decrypt the index and body.
pub fn open_pack(
    bytes: &[u8],
    id: &[u8; 32],
    unwrap_key: impl Fn(&[u8]) -> Result<[u8; 32]>,
) -> Result<OpenedPack> {
    if crypto::pack_id(bytes) != *id {
        bail!("This backup file does not match its fingerprint. It was changed or replaced.");
    }
    let mut rest = bytes;
    let version = take(&mut rest, 1)?[0];
    if version != PACK_VERSION {
        bail!("This backup file uses a format this Luna does not understand.");
    }
    let wrapped_len = take_len(&mut rest)?;
    let wrapped = take(&mut rest, wrapped_len)?;
    let pack_key = unwrap_key(wrapped)?;
    let index_len = take_len(&mut rest)?;
    let sealed_index = take(&mut rest, index_len)?;

    let index = crypto::decrypt(&pack_key, PACK_INDEX_AAD, sealed_index)?;
    let (scope_id, entries) = decode_index(&index)?;
    let plain = crypto::decrypt(&pack_key, PACK_BODY_AAD, rest)?;

    let mut map = HashMap::with_capacity(entries.len());
    for (chunk_id, offset, len) in entries {
        let end = offset.checked_add(len as u64);
        if end.is_none_or(|end| end > plain.len() as u64) {
            bail!("This backup file's index points past the end of its data.");
        }
        map.insert(chunk_id, (offset, len));
    }
    Ok(OpenedPack { scope_id, plain, index: map })
}

fn encode_index(scope_id: &[u8; 32], entries: &[([u8; 32], u64, u32)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + 4 + entries.len() * 44);
    out.extend_from_slice(scope_id);
    push_len(&mut out, entries.len());
    for (chunk_id, offset, len) in entries {
        out.extend_from_slice(chunk_id);
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&len.to_be_bytes());
    }
    out
}

fn decode_index(mut rest: &[u8]) -> Result<([u8; 32], Vec<([u8; 32], u64, u32)>)> {
    let scope_id: [u8; 32] = take(&mut rest, 32)?.try_into().expect("take returns 32 bytes");
    let count = take_len(&mut rest)?;
    let mut entries = Vec::with_capacity(count.min(1 << 20));
    for _ in 0..count {
        let chunk_id: [u8; 32] = take(&mut rest, 32)?.try_into().expect("take returns 32 bytes");
        let offset = u64::from_be_bytes(take(&mut rest, 8)?.try_into().expect("take returns 8 bytes"));
        let len = u32::from_be_bytes(take(&mut rest, 4)?.try_into().expect("take returns 4 bytes"));
        entries.push((chunk_id, offset, len));
    }
    if !rest.is_empty() {
        bail!("This backup file's index has extra data at the end.");
    }
    Ok((scope_id, entries))
}

fn push_len(out: &mut Vec<u8>, len: usize) {
    let len = u32::try_from(len).expect("pack fields are under 4 GiB");
    out.extend_from_slice(&len.to_be_bytes());
}

fn take<'a>(rest: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if rest.len() < n {
        bail!("This backup file is cut short. It may be damaged.");
    }
    let (head, tail) = rest.split_at(n);
    *rest = tail;
    Ok(head)
}

fn take_len(rest: &mut &[u8]) -> Result<usize> {
    let raw = take(rest, 4)?;
    Ok(u32::from_be_bytes(raw.try_into().expect("take returns 4 bytes")) as usize)
}

/// A directory tree for one protection in one run: every file, its size, time and chunks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tree {
    pub entries: Vec<TreeEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    /// The file's chunks, in order. Each one says where its bytes live, so a restore
    /// after the local database is lost can read the data packs straight from the tree.
    pub chunks: Vec<ChunkRef>,
}

/// One chunk of a file: its id, and the pack and place where its bytes are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    #[serde(with = "hex_fixed")]
    pub id: [u8; 32],
    #[serde(with = "hex_fixed")]
    pub pack: [u8; 32],
    pub offset: u64,
    pub len: u32,
}

/// Encrypt a tree as JSON under `key`. Output is `crypto::encrypt` layout (nonce ‖ ciphertext).
pub fn encrypt_tree(tree: &Tree, key: &[u8; 32]) -> Vec<u8> {
    let json = serde_json::to_vec(tree).expect("a tree always serializes to JSON");
    crypto::encrypt(key, TREE_AAD, &json)
}

pub fn decrypt_tree(sealed: &[u8], key: &[u8; 32]) -> Result<Tree> {
    let json = crypto::decrypt(key, TREE_AAD, sealed)?;
    serde_json::from_slice(&json).map_err(|_| anyhow!("This backup's file list could not be read. It may be damaged."))
}

/// What a recovery needs to rebuild a backup's row: its name, where it came from, and who started it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupMeta {
    pub name: String,
    pub source_drive: String,
    pub source_path: String,
    pub started_by: String,
    /// The starter's display name when the backup was made, for the Connect page. Empty if unknown.
    #[serde(default)]
    pub started_by_name: String,
}

/// Encrypt backup metadata as JSON under the backup key. Output is `crypto::encrypt` layout.
pub fn encrypt_meta(meta: &BackupMeta, key: &[u8; 32]) -> Vec<u8> {
    let json = serde_json::to_vec(meta).expect("backup metadata always serializes to JSON");
    crypto::encrypt(key, META_AAD, &json)
}

pub fn decrypt_meta(sealed: &[u8], key: &[u8; 32]) -> Result<BackupMeta> {
    let json = crypto::decrypt(key, META_AAD, sealed)?;
    serde_json::from_slice(&json).map_err(|_| anyhow!("This backup's details could not be read. It may be damaged."))
}

/// One signed record per snapshot. Luna signs it so Connect cannot roll back, swap or regroup backups.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub luna_id: String,
    pub protection_id: String,
    pub snapshot_id: String,
    /// Unix time in seconds.
    pub created_at: i64,
    pub key_version: u32,
    #[serde(with = "hex_fixed")]
    pub tree_pack_id: [u8; 32],
    #[serde(with = "hex_fixed")]
    pub tree_hash: [u8; 32],
    /// Backup metadata (name, started by), encrypted under the backup key.
    #[serde(with = "hex_fixed")]
    pub meta: Vec<u8>,
}

impl SnapshotRecord {
    /// The bytes the signature covers: every field, length-prefixed by `crypto::canonical`.
    pub fn signed_bytes(&self) -> Vec<u8> {
        crypto::canonical(&[
            ("luna_id", self.luna_id.as_bytes()),
            ("protection_id", self.protection_id.as_bytes()),
            ("snapshot_id", self.snapshot_id.as_bytes()),
            ("created_at", &self.created_at.to_be_bytes()),
            ("key_version", &self.key_version.to_be_bytes()),
            ("tree_pack_id", &self.tree_pack_id),
            ("tree_hash", &self.tree_hash),
            ("meta", &self.meta),
        ])
    }

    pub fn sign(self, signer: &Signer) -> SignedRecord {
        self.sign_with(signer, SNAPSHOT_DOMAIN)
    }

    /// Sign under `domain`. Private snapshots use their own domain so a shared signature never passes for one.
    pub fn sign_with(self, signer: &Signer, domain: &str) -> SignedRecord {
        let signature = signer.sign(domain, &self.signed_bytes());
        SignedRecord { record: self, signature }
    }
}

/// A snapshot record with its signature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignedRecord {
    pub record: SnapshotRecord,
    #[serde(with = "hex_fixed")]
    pub signature: [u8; 64],
}

impl SignedRecord {
    /// Check the signature against `public` and return the record only if it holds.
    pub fn verify(&self, public: &[u8; 32]) -> Result<SnapshotRecord> {
        self.verify_with(public, SNAPSHOT_DOMAIN)
    }

    /// Check the signature made under `domain` against `public`.
    pub fn verify_with(&self, public: &[u8; 32], domain: &str) -> Result<SnapshotRecord> {
        if !crypto::verify(public, domain, &self.record.signed_bytes(), &self.signature) {
            bail!("This snapshot's signature does not match. It was changed, or signed by a different key.");
        }
        Ok(self.record.clone())
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a signed record always serializes to JSON")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        serde_json::from_slice(bytes).map_err(|_| anyhow!("This snapshot record could not be read. It may be damaged."))
    }
}

/// Byte arrays and byte vectors as lowercase hex strings in JSON.
pub(crate) mod hex_fixed {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, T: AsRef<[u8]>>(value: &T, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::hex_encode(value.as_ref()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: TryFrom<Vec<u8>>>(d: D) -> Result<T, D::Error> {
        let text = String::deserialize(d)?;
        let bytes = super::hex_decode(&text).map_err(D::Error::custom)?;
        T::try_from(bytes).map_err(|_| D::Error::custom("a hex field has the wrong length"))
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode(text: &str) -> Result<Vec<u8>, &'static str> {
    if text.len() % 2 != 0 {
        return Err("a hex field has an odd number of characters");
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let hi = hex_digit(pair[0])?;
            let lo = hex_digit(pair[1])?;
            Ok((hi << 4) | lo)
        })
        .collect()
}

fn hex_digit(c: u8) -> Result<u8, &'static str> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err("a hex field has a character that is not hex"),
    }
}

/// SHA-256 helper for callers that hash a whole tree or file.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::private::PRIVATE_SNAPSHOT_DOMAIN;
    use std::io::Cursor;

    /// Deterministic pseudo-random bytes (xorshift), so chunk boundaries are repeatable.
    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    }

    fn split(data: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        chunks(&mut Cursor::new(data), |c| {
            out.push(c.to_vec());
            Ok(())
        })
        .unwrap();
        out
    }

    fn chunk_id(data: &[u8]) -> [u8; 32] {
        crypto::chunk_id(&[7u8; 32], data)
    }

    #[test]
    fn chunk_boundaries_survive_an_insert_near_the_start() {
        let original = noise(12 * 1024 * 1024, 42);
        let mut edited = b"a new paragraph inserted at the very start of the file".to_vec();
        edited.extend_from_slice(&original);

        let before: Vec<[u8; 32]> = split(&original).iter().map(|c| chunk_id(c)).collect();
        let after: Vec<[u8; 32]> = split(&edited).iter().map(|c| chunk_id(c)).collect();
        assert!(before.len() >= 4, "test data should make several chunks");

        // Only the first chunk or two should change; the rest are cut at the same places.
        let reused = after.iter().filter(|id| before.contains(id)).count();
        assert!(
            reused + 2 >= after.len(),
            "expected most chunks reused, got {reused} of {}",
            after.len()
        );
    }

    #[test]
    fn chunks_respect_size_limits() {
        let data = noise(9 * 1024 * 1024, 7);
        let pieces = split(&data);
        assert_eq!(pieces.concat(), data);
        for piece in &pieces[..pieces.len() - 1] {
            assert!(piece.len() >= CHUNK_MIN as usize && piece.len() <= CHUNK_MAX as usize);
        }
    }

    fn pack_key_wrap(key: &[u8; 32]) -> Vec<u8> {
        crypto::encrypt(&[9u8; 32], b"luna-test-pack-key", key)
    }

    fn pack_key_unwrap(wrapped: &[u8]) -> Result<[u8; 32]> {
        let key = crypto::decrypt(&[9u8; 32], b"luna-test-pack-key", wrapped)?;
        Ok(key.try_into().expect("wrapped key is 32 bytes"))
    }

    fn sample_pack() -> (SealedPack, Vec<([u8; 32], Vec<u8>)>) {
        let mut builder = PackBuilder::new([3u8; 32]);
        let mut pieces = Vec::new();
        for data in [noise(1000, 1), noise(5000, 2), noise(300, 3)] {
            let id = chunk_id(&data);
            builder.add(id, &data);
            pieces.push((id, data));
        }
        (builder.finish(pack_key_wrap), pieces)
    }

    #[test]
    fn pack_round_trip() {
        let (sealed, pieces) = sample_pack();
        assert_eq!(sealed.id, crypto::pack_id(&sealed.bytes));
        assert_eq!(sealed.entries.len(), pieces.len());

        let opened = open_pack(&sealed.bytes, &sealed.id, pack_key_unwrap).unwrap();
        assert_eq!(opened.scope_id(), [3u8; 32]);
        for (id, data) in &pieces {
            assert_eq!(opened.chunk(id), Some(data.as_slice()));
        }
        assert_eq!(opened.chunk(&[0u8; 32]), None);
    }

    #[test]
    fn pack_chunk_ids_do_not_appear_in_plain_bytes() {
        let (sealed, pieces) = sample_pack();
        for (id, _) in &pieces {
            assert!(!sealed.bytes.windows(32).any(|w| w == id));
        }
    }

    #[test]
    fn tampered_pack_fails() {
        let (sealed, _) = sample_pack();
        let mut bytes = sealed.bytes.clone();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(open_pack(&bytes, &sealed.id, pack_key_unwrap).is_err());

        // Even with a matching fingerprint, the AEAD tag must catch the change.
        let forged_id = crypto::pack_id(&bytes);
        assert!(open_pack(&bytes, &forged_id, pack_key_unwrap).is_err());
    }

    #[test]
    fn tree_round_trip() {
        let tree = Tree {
            entries: vec![TreeEntry {
                path: "Photos/cat.jpg".into(),
                size: 2048,
                mtime: 1_700_000_000,
                chunks: vec![
                    ChunkRef { id: [1u8; 32], pack: [9u8; 32], offset: 0, len: 1024 },
                    ChunkRef { id: [2u8; 32], pack: [9u8; 32], offset: 1024, len: 1024 },
                ],
            }],
        };
        let key = [5u8; 32];
        let sealed = encrypt_tree(&tree, &key);
        assert_eq!(decrypt_tree(&sealed, &key).unwrap(), tree);
        assert!(decrypt_tree(&sealed, &[6u8; 32]).is_err());
    }

    #[test]
    fn meta_round_trip_and_key_and_aad_are_checked() {
        let meta = BackupMeta {
            name: "Photos".into(),
            source_drive: "Main".into(),
            source_path: "Photos/2024".into(),
            started_by: "user-1".into(),
            started_by_name: "Max".into(),
        };
        let key = [7u8; 32];
        let sealed = encrypt_meta(&meta, &key);
        assert_eq!(decrypt_meta(&sealed, &key).unwrap(), meta);
        assert!(decrypt_meta(&sealed, &[8u8; 32]).is_err());
        // Metadata and the file list use different AADs, so one cannot be read as the other.
        let tree_sealed = encrypt_tree(&Tree { entries: vec![] }, &key);
        assert!(decrypt_meta(&tree_sealed, &key).is_err());
        assert!(decrypt_tree(&sealed, &key).is_err());
    }

    fn sample_record() -> SnapshotRecord {
        SnapshotRecord {
            luna_id: "luna-1".into(),
            protection_id: "prot-1".into(),
            snapshot_id: "snap-1".into(),
            created_at: 1_700_000_000,
            key_version: 2,
            tree_pack_id: [4u8; 32],
            tree_hash: [5u8; 32],
            meta: vec![8, 9, 10],
        }
    }

    #[test]
    fn signed_record_round_trip_and_verify() {
        let signer = Signer::generate();
        let signed = sample_record().sign(&signer);
        let bytes = signed.to_bytes();
        let parsed = SignedRecord::from_bytes(&bytes).unwrap();
        assert_eq!(parsed, signed);
        assert_eq!(parsed.verify(&signer.public()).unwrap(), sample_record());
    }

    #[test]
    fn signed_record_fails_when_any_field_changes() {
        let signer = Signer::generate();
        let public = signer.public();
        let signed = sample_record().sign(&signer);

        let changes: Vec<Box<dyn Fn(&mut SnapshotRecord)>> = vec![
            Box::new(|r| r.luna_id.push('x')),
            Box::new(|r| r.protection_id.push('x')),
            Box::new(|r| r.snapshot_id.push('x')),
            Box::new(|r| r.created_at += 1),
            Box::new(|r| r.key_version += 1),
            Box::new(|r| r.tree_pack_id[0] ^= 1),
            Box::new(|r| r.tree_hash[0] ^= 1),
            Box::new(|r| r.meta.push(0)),
        ];
        for change in changes {
            let mut tampered = signed.clone();
            change(&mut tampered.record);
            assert!(tampered.verify(&public).is_err());
        }

        // A different signer's key must fail too.
        assert!(signed.verify(&Signer::generate().public()).is_err());
    }

    #[test]
    fn private_snapshot_domain_is_not_a_shared_signature() {
        let signer = Signer::generate();
        let public = signer.public();
        let signed = sample_record().sign_with(&signer, PRIVATE_SNAPSHOT_DOMAIN);

        assert!(signed.verify(&public).is_err());
        assert_eq!(signed.verify_with(&public, PRIVATE_SNAPSHOT_DOMAIN).unwrap(), sample_record());
    }
}
