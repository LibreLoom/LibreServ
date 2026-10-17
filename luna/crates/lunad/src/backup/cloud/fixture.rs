//! Test-only: writes and checks fixture.json, which the browser decryptors read.

use std::collections::HashMap;

use anyhow::{anyhow, ensure, Result};
use serde_json::{json, Map, Value};

use super::crypto::{self, Signer};
use super::format::{
    self, BackupMeta, ChunkRef, OpenedPack, PackBuilder, SignedRecord, SnapshotRecord, Tree,
    TreeEntry,
};
use super::keys::{self, Recipients};
use super::run::PACK_KEY_WRAP_AAD;
use super::store::{CloudStore, MemoryStore};
use crate::db::BackupKey;

const LUNA_ID: &str = "luna-fixture-1";
const PROTECTION: &str = "11111111-2222-4333-8444-555555555555";
const VERSION: i64 = 2;
const SNAPSHOT_ID: &str = "0123456789abcdef0123456789abcdef";
const BACKUP_KEY: [u8; 32] = [0x11; 32];
const DEDUP_KEY: [u8; 32] = [0x22; 32];
const FIXTURE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/backup/cloud/fixture.json");

fn alice_entropy() -> [u8; 16] {
    std::array::from_fn(|i| i as u8)
}

fn bob_entropy() -> [u8; 16] {
    std::array::from_fn(|i| 100 + i as u8)
}

fn signer() -> Signer {
    Signer::from_seed(std::array::from_fn(|i| 0x40 + i as u8))
}

fn file_contents() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("docs/a.txt", b"hello from the fixture\n".to_vec()),
        ("b.bin", (0..70_000usize).map(|i| (i * 7 % 251) as u8).collect()),
    ]
}

fn self_aad() -> Vec<u8> {
    crypto::canonical(&[
        ("luna_id", LUNA_ID.as_bytes()),
        ("user_id", b"alice"),
        ("purpose", b"signing-public"),
    ])
}

fn wrap_key(pack_key: &[u8; 32]) -> Vec<u8> {
    crypto::encrypt(&BACKUP_KEY, PACK_KEY_WRAP_AAD, pack_key)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    ensure!(s.len() % 2 == 0, "odd-length hex in fixture");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| anyhow!("bad hex: {e}")))
        .collect()
}

fn unhex32(s: &str) -> Result<[u8; 32]> {
    unhex(s)?.try_into().map_err(|_| anyhow!("expected 32 bytes in fixture"))
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| anyhow!("fixture is missing {key}"))
}

/// The bytes of one stored record in the fixture's `records` section.
fn record(fx: &Value, kind: &str, name: &str) -> Result<Vec<u8>> {
    let list = fx["records"][kind].as_array().ok_or_else(|| anyhow!("fixture has no {kind}"))?;
    let item = list
        .iter()
        .find(|r| r["name"] == name)
        .ok_or_else(|| anyhow!("fixture has no {kind} record {name}"))?;
    unhex(field(item, "data")?)
}

/// Build every piece from fixed inputs, using the real format and key functions.
fn build() -> Result<Value> {
    let alice = crypto::derive(&alice_entropy(), LUNA_ID);
    let bob = crypto::derive(&bob_entropy(), LUNA_ID);
    let signer = signer();
    let scope_id = crypto::chunk_id(&DEDUP_KEY, b"luna-scope-v1");
    let files = file_contents();

    // Data pack: one chunk per file.
    let mut data = PackBuilder::new(scope_id);
    let mut placed = Vec::new();
    for (path, content) in &files {
        let id = crypto::chunk_id(&DEDUP_KEY, content);
        let (offset, len) = data.add(id, content);
        placed.push((*path, content.len() as u64, id, offset, len));
    }
    let data_pack = data.finish(wrap_key);

    // Tree, sealed under the backup key, stored in its own pack.
    let mut entries = Vec::new();
    for (path, size, id, offset, len) in placed {
        entries.push(TreeEntry {
            path: path.to_string(),
            size,
            mtime: 1_700_000_000,
            chunks: vec![ChunkRef { id, pack: data_pack.id, offset, len }],
        });
    }
    let tree = Tree { entries };
    let tree_bytes = format::encrypt_tree(&tree, &BACKUP_KEY);
    let tree_hash = format::sha256(&tree_bytes);
    let mut tree_builder = PackBuilder::new(scope_id);
    tree_builder.add(tree_hash, &tree_bytes);
    let tree_pack = tree_builder.finish(wrap_key);

    // Metadata and the signed snapshot record.
    let meta = BackupMeta {
        name: "Photos".into(),
        source_drive: "drive-1".into(),
        source_path: "Photos".into(),
        started_by: "alice".into(),
        started_by_name: "Alice".into(),
    };
    let snapshot = SnapshotRecord {
        luna_id: LUNA_ID.into(),
        protection_id: PROTECTION.into(),
        snapshot_id: SNAPSHOT_ID.into(),
        created_at: 1_760_000_000,
        key_version: VERSION as u32,
        tree_pack_id: tree_pack.id,
        tree_hash,
        meta: format::encrypt_meta(&meta, &BACKUP_KEY),
    };
    let signed = snapshot.sign(&signer).to_bytes();

    // Key copies for alice and bob, and the signed recipient list.
    let store = MemoryStore::new();
    let backup = BackupKey {
        protection_id: PROTECTION.into(),
        version: VERSION,
        key: BACKUP_KEY.to_vec(),
        dedup_key: DEDUP_KEY.to_vec(),
        created_at: 0,
    };
    let recipients = Recipients::new(vec!["alice".into(), "bob".into()]);
    keys::publish_key(&store, &signer, LUNA_ID, PROTECTION, &backup, &recipients, |user| {
        Some(if user == "alice" { alice.x25519_public } else { bob.x25519_public })
    })?;
    let mut key_records = Vec::new();
    for user in ["alice", "bob"] {
        let name = keys::key_record_name(PROTECTION, VERSION, user);
        let data = store
            .get_record("keys", &name)
            .map_err(|e| anyhow!("{e:?}"))?
            .ok_or_else(|| anyhow!("no key copy for {user}"))?;
        key_records.push(json!({"name": name, "data": hex(&data)}));
    }
    let rec_name = keys::recipients_record_name(PROTECTION, VERSION);
    let rec_bytes = store
        .get_record("recipients", &rec_name)
        .map_err(|e| anyhow!("{e:?}"))?
        .ok_or_else(|| anyhow!("no recipient list"))?;

    // Alice's self record, sealed the way the browser does it.
    let self_data = crypto::encrypt(&alice.self_key, &self_aad(), &signer.public());

    let mut packs = Map::new();
    packs.insert(hex(&tree_pack.id), json!(hex(&tree_pack.bytes)));
    packs.insert(hex(&data_pack.id), json!(hex(&data_pack.bytes)));
    let mut expected_files = Map::new();
    for (path, content) in &files {
        expected_files.insert((*path).to_string(), json!(hex(content)));
    }

    Ok(json!({
        "luna_id": LUNA_ID,
        "alice_entropy": hex(&alice_entropy()),
        "alice_user_id": "alice",
        "bob_entropy": hex(&bob_entropy()),
        "bob_user_id": "bob",
        "signing_public": hex(&signer.public()),
        "protection_id": PROTECTION,
        "key_version": VERSION,
        "backup_key": hex(&BACKUP_KEY),
        "dedup_key": hex(&DEDUP_KEY),
        "scope_tag": hex(&scope_id[..16]),
        "records": {
            "snapshots": [{"name": SNAPSHOT_ID, "data": hex(&signed)}],
            "keys": key_records,
            "recipients": [{"name": rec_name, "data": hex(&rec_bytes)}],
            "self": [{"name": keys::user_record_part("alice"), "data": hex(&self_data)}]
        },
        "packs": packs,
        "tree_pack_id": hex(&tree_pack.id),
        "data_pack_id": hex(&data_pack.id),
        "expected": {
            "meta": serde_json::to_value(&meta)?,
            "files": expected_files
        }
    }))
}

/// Check the fixture the way the browser will: every step opens with Rust's own code.
fn check(fx: &Value) -> Result<()> {
    let luna_public = unhex32(field(fx, "signing_public")?)?;
    let backup_key = unhex32(field(fx, "backup_key")?)?;
    let dedup_key = unhex32(field(fx, "dedup_key")?)?;
    let protection = field(fx, "protection_id")?;
    let version = fx["key_version"].as_i64().ok_or_else(|| anyhow!("fixture has no key_version"))?;

    // Snapshot record: signature holds.
    let signed = SignedRecord::from_bytes(&record(fx, "snapshots", SNAPSHOT_ID)?)?;
    let snap = signed.verify(&luna_public)?;
    ensure!(snap.protection_id == protection, "snapshot is for another backup");

    // Key copies: alice and bob each open the same key.
    for (user, entropy_field) in [("alice", "alice_entropy"), ("bob", "bob_entropy")] {
        let entropy: [u8; 16] = unhex(field(fx, entropy_field)?)?
            .try_into()
            .map_err(|_| anyhow!("bad entropy in fixture"))?;
        let user_keys = crypto::derive(&entropy, LUNA_ID);
        let copy = record(fx, "keys", &keys::key_record_name(protection, version, user))?;
        let (key, dedup) = keys::open_key(
            &copy,
            &user_keys.x25519_secret,
            &luna_public,
            LUNA_ID,
            protection,
            version,
            user,
        )?;
        ensure!(key == backup_key && dedup == dedup_key, "{user} opened a different key");
    }

    // Recipient list: signed, lists alice and bob.
    let rec = record(fx, "recipients", &keys::recipients_record_name(protection, version))?;
    ensure!(
        keys::verify_recipients(&rec, &luna_public, LUNA_ID, protection, version)
            == Some(vec!["alice".to_string(), "bob".to_string()]),
        "recipient list did not verify"
    );

    // Packs: both open with the backup key.
    let unwrap = |wrapped: &[u8]| -> Result<[u8; 32]> {
        crypto::decrypt(&backup_key, PACK_KEY_WRAP_AAD, wrapped)?
            .try_into()
            .map_err(|_| anyhow!("bad pack key"))
    };
    let mut opened: HashMap<[u8; 32], OpenedPack> = HashMap::new();
    for pack_field in ["tree_pack_id", "data_pack_id"] {
        let id = unhex32(field(fx, pack_field)?)?;
        let bytes = unhex(field(&fx["packs"], &hex(&id))?)?;
        opened.insert(id, format::open_pack(&bytes, &id, &unwrap)?);
    }
    ensure!(snap.tree_pack_id == unhex32(field(fx, "tree_pack_id")?)?, "snapshot names another tree pack");

    // Tree: its hash matches the snapshot, and it lists the files.
    let tree_pack = &opened[&snap.tree_pack_id];
    let tree_bytes = tree_pack
        .chunk(&snap.tree_hash)
        .ok_or_else(|| anyhow!("tree pack does not hold the tree"))?;
    ensure!(format::sha256(tree_bytes) == snap.tree_hash, "tree hash does not match");
    let tree = format::decrypt_tree(tree_bytes, &backup_key)?;

    // Files: every chunk matches its id and the bytes equal the expected files.
    let expected = fx["expected"]["files"]
        .as_object()
        .ok_or_else(|| anyhow!("fixture has no expected files"))?;
    ensure!(tree.entries.len() == expected.len(), "file count differs");
    for entry in &tree.entries {
        let mut body = Vec::new();
        for chunk in &entry.chunks {
            let pack = opened
                .get(&chunk.pack)
                .ok_or_else(|| anyhow!("pack missing for {}", entry.path))?;
            let bytes = pack
                .chunk(&chunk.id)
                .ok_or_else(|| anyhow!("chunk missing for {}", entry.path))?;
            ensure!(crypto::chunk_id(&dedup_key, bytes) == chunk.id, "chunk id differs for {}", entry.path);
            body.extend_from_slice(bytes);
        }
        let want = expected
            .get(&entry.path)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("no expected contents for {}", entry.path))?;
        ensure!(hex(&body) == want, "contents of {} differ", entry.path);
    }

    // Self record: alice's copy holds Luna's signing public key.
    let alice = crypto::derive(&unhex32_16(field(fx, "alice_entropy")?)?, LUNA_ID);
    let self_record = record(fx, "self", &keys::user_record_part("alice"))?;
    ensure!(
        crypto::decrypt(&alice.self_key, &self_aad(), &self_record)? == luna_public,
        "self record does not hold the signing key"
    );

    // Metadata: decrypts to the expected values.
    let meta = format::decrypt_meta(&snap.meta, &backup_key)?;
    ensure!(serde_json::to_value(&meta)? == fx["expected"]["meta"], "metadata differs");
    Ok(())
}

fn unhex32_16(s: &str) -> Result<[u8; 16]> {
    unhex(s)?.try_into().map_err(|_| anyhow!("expected 16 bytes in fixture"))
}

#[test]
#[ignore]
fn write_fixture() {
    let value = build().expect("build the fixture");
    let text = serde_json::to_string_pretty(&value).expect("serialize the fixture") + "\n";
    std::fs::write(FIXTURE_PATH, text).expect("write fixture.json");
}

#[test]
fn fixture_opens() {
    let text = std::fs::read_to_string(FIXTURE_PATH).expect("run write_fixture first");
    let fx: Value = serde_json::from_str(&text).expect("fixture.json is JSON");
    check(&fx).expect("Rust opens the fixture");
}
