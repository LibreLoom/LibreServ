//! Private items in the cloud: rebuilding private backups after the local database is lost.
//!
//! The browser decrypts the scope's dedup key and the snapshot trees, then hands them here.
//! Luna checks every record against its own signing key and writes the index rows in one
//! transaction, so a failure leaves nothing half-written. Recovered scopes are read-only;
//! the next private run starts a fresh scope.

use std::collections::HashSet;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};

use super::format::{SignedRecord, Tree};
use super::private::{
    self, PRIVATE_SNAPSHOT_DOMAIN, PSCOPES_KIND, PSNAPSHOTS_KIND, ScopeRecord, SignedScope,
};
use super::store::CloudStore;
use crate::backup::access_list::{self, PrivateSource};
use crate::db;

const RECOVERED_RUN: &str = "recovered";
const STOPPED_REASON: &str = "This folder is no longer a private item.";

/// The plain details of one private backup, decrypted by the browser.
#[derive(Debug, Clone, PartialEq)]
pub struct PlainMeta {
    pub name: String,
    pub source_drive: String,
    pub source_path: String,
}

/// One private snapshot to restore: its signed record, its details and its decrypted file list.
#[derive(Debug, Clone)]
pub struct PrivateSnapshotIn {
    pub snapshot_id: String,
    pub protection_id: String,
    pub record: Vec<u8>,
    pub meta: PlainMeta,
    pub tree: Tree,
}

/// The scope records on Connect that belong to this caller. A record that fails its
/// signature (or cannot be read) is left out, so it never reaches the index.
pub fn caller_scopes(
    store: &dyn CloudStore,
    luna_public: &[u8; 32],
    caller_public: &super::crypto::SealPublic,
) -> Result<Vec<ScopeRecord>> {
    let mut out = Vec::new();
    for name in store.list_records(PSCOPES_KIND)? {
        let Some(bytes) = store.get_record(PSCOPES_KIND, &name)? else {
            continue;
        };
        let Ok(record) = SignedScope::from_bytes(&bytes).and_then(|s| s.verify(luna_public)) else {
            continue;
        };
        if &record.seal_public == caller_public {
            out.push(record);
        }
    }
    Ok(out)
}

/// The hex ids of the tree packs of every verified snapshot in `scopes`.
pub fn caller_tree_packs(
    store: &dyn CloudStore,
    luna_public: &[u8; 32],
    scopes: &[ScopeRecord],
) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    for scope in scopes {
        let prefix = format!("{}.", scope.scope);
        for name in store.list_records(PSNAPSHOTS_KIND)? {
            if !name.starts_with(&prefix) {
                continue;
            }
            let Some(bytes) = store.get_record(PSNAPSHOTS_KIND, &name)? else {
                continue;
            };
            let Ok(signed) = SignedRecord::from_bytes(&bytes) else {
                continue;
            };
            let Ok(record) = signed.verify_with(luna_public, PRIVATE_SNAPSHOT_DOMAIN) else {
                continue;
            };
            if name != private::psnapshot_name(&scope.scope, &record.snapshot_id) {
                continue;
            }
            out.insert(hex(&record.tree_pack_id));
        }
    }
    Ok(out)
}

/// Write one recovered scope and its snapshots into the local index. Returns how many
/// snapshots were newly written; snapshots already in the index are skipped.
#[allow(clippy::too_many_arguments)]
pub fn write_private_index(
    conn: &mut Connection,
    luna_public: &[u8; 32],
    caller: &str,
    caller_public: &super::crypto::SealPublic,
    scope: &ScopeRecord,
    dedup_key: &[u8; 32],
    snapshots: Vec<PrivateSnapshotIn>,
    now: i64,
) -> Result<usize> {
    if private::scope_of(dedup_key).1 != scope.scope {
        bail!("These private backups don't match the key your browser sent. Start again.");
    }
    if &scope.seal_public != caller_public {
        bail!("These private backups belong to another recovery phrase.");
    }

    let tx = conn.transaction()?;
    if db::get_private_scope(&tx, &scope.scope)?.is_none() {
        db::insert_private_scope(
            &tx,
            &db::PrivateScope {
                scope: scope.scope.clone(),
                owner: caller.to_string(),
                seal_public: scope.seal_public.to_vec(),
                dedup_key: dedup_key.to_vec(),
                state: "recovered".to_string(),
                retire_after: 0,
                created_at: scope.created_at,
            },
        )?;
    }

    let mut written = 0;
    for snap in &snapshots {
        let signed = SignedRecord::from_bytes(&snap.record)?;
        let record = signed.verify_with(luna_public, PRIVATE_SNAPSHOT_DOMAIN)?;
        if record.snapshot_id != snap.snapshot_id {
            bail!("A private backup's record is for another backup. It may be damaged.");
        }
        if record.protection_id != snap.protection_id {
            bail!("A private backup's record is for another item. It may be damaged.");
        }
        if record.key_version != 0 {
            bail!("A private backup's record uses a key version Luna does not know.");
        }

        let already: Option<()> = tx
            .query_row(
                "SELECT 1 FROM cloud_snapshots WHERE id = ?1",
                params![snap.snapshot_id],
                |_| Ok(()),
            )
            .optional()?;
        if already.is_some() {
            continue;
        }

        if db::get_protection(&tx, &snap.protection_id)?.is_none() {
            let owned = matches!(
                access_list::private_source(&tx, &snap.meta.source_drive, &snap.meta.source_path),
                PrivateSource::OwnItem { ref owner } if owner == caller
            );
            db::insert_protection(
                &tx,
                &db::NewProtection {
                    id: &snap.protection_id,
                    kind: db::PROTECTION_CLOUD,
                    source_drive: &snap.meta.source_drive,
                    source_path: &snap.meta.source_path,
                    target_drive: "",
                    private_owner: caller,
                    created_by: caller,
                    created_at: record.created_at,
                },
            )?;
            let access = serde_json::json!({ "users": [caller], "admins": false }).to_string();
            db::set_protection_access(&tx, &snap.protection_id, &access)?;
            if !owned {
                db::set_protection_state(&tx, &snap.protection_id, "stopped", STOPPED_REASON)?;
            }
        }

        let tree_pack_id = hex(&record.tree_pack_id);
        db::insert_cloud_snapshot(
            &tx,
            &db::SnapshotInsert {
                id: snap.snapshot_id.clone(),
                protection_id: snap.protection_id.clone(),
                created_at: record.created_at,
                key_version: 0,
                tree_pack_id: tree_pack_id.clone(),
                record: snap.record.clone(),
            },
        )?;

        // The tree pack, then every data pack the tree names. Each pack is live, so the
        // next cleanup keeps it.
        let mut pack_sizes: std::collections::HashMap<[u8; 32], i64> =
            std::collections::HashMap::new();
        for chunk in snap.tree.entries.iter().flat_map(|e| e.chunks.iter()) {
            let end = (chunk.offset + u64::from(chunk.len)) as i64;
            let size = pack_sizes.entry(chunk.pack).or_insert(0);
            *size = (*size).max(end);
        }
        tx.execute(
            "INSERT OR IGNORE INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
             VALUES (?1, ?2, 'live', ?3, 0, 0, ?4)",
            params![tree_pack_id, scope.scope, RECOVERED_RUN, now],
        )?;
        tx.execute(
            "UPDATE cloud_packs SET state = 'live', marked_at = 0 WHERE id = ?1",
            params![tree_pack_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
            params![snap.snapshot_id, tree_pack_id],
        )?;
        for chunk in snap.tree.entries.iter().flat_map(|e| e.chunks.iter()) {
            let pack_id = hex(&chunk.pack);
            let size = pack_sizes.get(&chunk.pack).copied().unwrap_or(0);
            tx.execute(
                "INSERT OR IGNORE INTO cloud_packs (id, scope, state, run_id, size, marked_at, created_at)
                 VALUES (?1, ?2, 'live', ?3, ?4, 0, ?5)",
                params![pack_id, scope.scope, RECOVERED_RUN, size, now],
            )?;
            tx.execute(
                "UPDATE cloud_packs SET state = 'live', marked_at = 0 WHERE id = ?1",
                params![pack_id],
            )?;
            db::insert_chunk(
                &tx,
                &scope.scope,
                &chunk.id,
                &pack_id,
                chunk.offset as i64,
                i64::from(chunk.len),
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO cloud_snapshot_packs (snapshot_id, pack_id) VALUES (?1, ?2)",
                params![snap.snapshot_id, pack_id],
            )?;
        }

        tx.execute(
            "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
            params![
                snap.snapshot_id,
                scope.scope,
                serde_json::to_vec(&snap.tree)?
            ],
        )?;
        written += 1;
    }

    tx.commit()?;
    Ok(written)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::format::{self, OpenedPack};
    use crate::backup::cloud::identity;
    use crate::backup::cloud::store::MemoryStore;
    use serde_json::Value;

    const NOW: i64 = 1_800_000_000;
    const LUNA_ID: &str = "luna-fixture-1";

    fn fixture() -> Value {
        let text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/backup/cloud/fixture.json"
        ));
        serde_json::from_str(text).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn unhex32(s: &str) -> [u8; 32] {
        unhex(s).try_into().unwrap()
    }

    fn fixture_record(fx: &Value, kind: &str, name: &str) -> Vec<u8> {
        let item = fx["records"][kind]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .unwrap();
        unhex(item["data"].as_str().unwrap())
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        (dir, conn)
    }

    /// Everything the browser would decrypt for the fixture's private backup.
    struct Decrypted {
        luna_public: [u8; 32],
        alice: crypto::UserKeys,
        scope: ScopeRecord,
        dedup: [u8; 32],
        snapshot: PrivateSnapshotIn,
    }

    fn decrypt_fixture() -> Decrypted {
        let fx = fixture();
        let p = &fx["private"];
        let luna_public = unhex32(fx["signing_public"].as_str().unwrap());
        let scope_id = p["scope"].as_str().unwrap();
        let snapshot_id = p["snapshot_id"].as_str().unwrap();
        let entropy: [u8; 16] = unhex(fx["alice_entropy"].as_str().unwrap())
            .try_into()
            .unwrap();
        let alice = crypto::derive(&entropy, LUNA_ID);

        let scope = SignedScope::from_bytes(&fixture_record(&fx["private"], "pscopes", scope_id))
            .unwrap()
            .verify(&luna_public)
            .unwrap();
        let dedup = private::open_dedup(&alice.seal_secret, LUNA_ID, scope_id, &scope.sealed_dedup)
            .unwrap();

        let raw = fixture_record(
            &fx["private"],
            "psnapshots",
            &private::psnapshot_name(scope_id, snapshot_id),
        );
        let signed = SignedRecord::from_bytes(&raw).unwrap();
        let snap = signed
            .verify_with(&luna_public, PRIVATE_SNAPSHOT_DOMAIN)
            .unwrap();

        let unwrap = |w: &[u8]| private::open_pack_key(&alice.seal_secret, LUNA_ID, scope_id, w);
        let tree_pack_id = unhex32(p["tree_pack_id"].as_str().unwrap());
        let pack_bytes = unhex(p["packs"][hex(&tree_pack_id)].as_str().unwrap());
        let tree_pack: OpenedPack = format::open_pack(&pack_bytes, &tree_pack_id, unwrap).unwrap();
        let tree_bytes = tree_pack.chunk(&snap.tree_hash).unwrap();
        let tree = private::open_tree(&alice.seal_secret, LUNA_ID, scope_id, tree_bytes).unwrap();
        let meta = private::open_meta(&alice.seal_secret, LUNA_ID, scope_id, &snap.meta).unwrap();

        Decrypted {
            luna_public,
            alice,
            scope,
            dedup,
            snapshot: PrivateSnapshotIn {
                snapshot_id: snapshot_id.to_string(),
                protection_id: snap.protection_id.clone(),
                record: raw,
                meta: PlainMeta {
                    name: meta.name,
                    source_drive: meta.source_drive,
                    source_path: meta.source_path,
                },
                tree,
            },
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn fixture_index_is_written_as_recovered() {
        let d = decrypt_fixture();
        let (_dir, mut conn) = setup();
        let written = write_private_index(
            &mut conn,
            &d.luna_public,
            "alice",
            &d.alice.seal_public,
            &d.scope,
            &d.dedup,
            vec![d.snapshot.clone()],
            NOW,
        )
        .unwrap();
        assert_eq!(written, 1);
        assert_eq!(count(&conn, "cloud_snapshots"), 1);

        let scope = db::get_private_scope(&conn, &d.scope.scope)
            .unwrap()
            .unwrap();
        assert_eq!(scope.state, "recovered");
        assert_eq!(scope.owner, "alice");

        let protection = db::get_protection(&conn, &d.snapshot.protection_id)
            .unwrap()
            .unwrap();
        assert_eq!(protection.kind, db::PROTECTION_CLOUD);
        assert_eq!(protection.private_owner, "alice");
        assert_eq!(protection.created_by, "alice");
    }

    #[test]
    fn wrong_dedup_key_is_refused() {
        let d = decrypt_fixture();
        let (_dir, mut conn) = setup();
        let err = write_private_index(
            &mut conn,
            &d.luna_public,
            "alice",
            &d.alice.seal_public,
            &d.scope,
            &[0x44; 32],
            vec![d.snapshot.clone()],
            NOW,
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("don't match the key your browser sent")
        );
        assert_eq!(count(&conn, "cloud_snapshots"), 0);
        assert_eq!(count(&conn, "cloud_private_scopes"), 0);
    }

    #[test]
    fn other_phrase_is_refused() {
        let d = decrypt_fixture();
        let bob_entropy: [u8; 16] = unhex(fixture()["bob_entropy"].as_str().unwrap())
            .try_into()
            .unwrap();
        let bob = crypto::derive(&bob_entropy, LUNA_ID);
        let (_dir, mut conn) = setup();
        let err = write_private_index(
            &mut conn,
            &d.luna_public,
            "bob",
            &bob.seal_public,
            &d.scope,
            &d.dedup,
            vec![d.snapshot.clone()],
            NOW,
        )
        .unwrap_err();
        assert!(err.to_string().contains("another recovery phrase"));
        assert_eq!(count(&conn, "cloud_snapshots"), 0);
    }

    #[test]
    fn forged_record_is_refused() {
        let d = decrypt_fixture();
        let mut signed = SignedRecord::from_bytes(&d.snapshot.record).unwrap();
        signed.signature[0] ^= 0x01;
        let mut forged = d.snapshot.clone();
        forged.record = serde_json::to_vec(&signed).unwrap();
        let (_dir, mut conn) = setup();
        assert!(
            write_private_index(
                &mut conn,
                &d.luna_public,
                "alice",
                &d.alice.seal_public,
                &d.scope,
                &d.dedup,
                vec![forged],
                NOW,
            )
            .is_err()
        );
        assert_eq!(count(&conn, "cloud_snapshots"), 0);
        assert_eq!(count(&conn, "cloud_private_scopes"), 0);
    }

    #[test]
    fn next_run_starts_a_fresh_scope() {
        let d = decrypt_fixture();
        let (_dir, mut conn) = setup();
        write_private_index(
            &mut conn,
            &d.luna_public,
            "alice",
            &d.alice.seal_public,
            &d.scope,
            &d.dedup,
            vec![d.snapshot.clone()],
            NOW,
        )
        .unwrap();
        let (_, is_new) = private::ensure_scope(&conn, "alice", &d.alice.seal_public, NOW).unwrap();
        assert!(is_new);
    }

    #[test]
    fn stopped_protection_when_folder_is_not_private() {
        let d = decrypt_fixture();
        let (_dir, mut conn) = setup();
        write_private_index(
            &mut conn,
            &d.luna_public,
            "alice",
            &d.alice.seal_public,
            &d.scope,
            &d.dedup,
            vec![d.snapshot.clone()],
            NOW,
        )
        .unwrap();
        let protection = db::get_protection(&conn, &d.snapshot.protection_id)
            .unwrap()
            .unwrap();
        assert_eq!(protection.state, "stopped");
        assert_eq!(protection.stop_reason, STOPPED_REASON);
        assert_eq!(protection.private_owner, "alice");
        assert!(protection.access_json.contains("\"admins\":false"));
    }

    #[test]
    fn store_listing_keeps_only_the_callers_scopes() {
        let d = decrypt_fixture();
        let store = MemoryStore::new();
        let fx = fixture();
        let scope_id = fx["private"]["scope"].as_str().unwrap();
        store
            .put_record(
                PSCOPES_KIND,
                scope_id,
                &fixture_record(&fx["private"], "pscopes", scope_id),
            )
            .unwrap();
        let mine = caller_scopes(&store, &d.luna_public, &d.alice.seal_public).unwrap();
        assert_eq!(mine.len(), 1);
        let theirs = caller_scopes(
            &store,
            &d.luna_public,
            &[9u8; crate::backup::cloud::crypto::SEAL_PUBLIC_LEN],
        )
        .unwrap();
        assert!(theirs.is_empty());
        let _ = identity::load_or_create;
    }
}
