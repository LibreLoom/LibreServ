//! Private items in the cloud: scope records, sealing and signatures for private backups.
//!
//! Each private scope has its own key pair (X25519 and ML-KEM). Pack keys, trees, metadata and the
//! scope's dedup key are sealed to the scope's public key. The scope's secret half is sealed to its
//! owner's sealing key (`sealed_scope_secret`), so only the owner's recovery phrase can open the scope.
//! Luna keeps only the public half and that sealed copy, never the secret. Every sealed value binds its
//! purpose, Luna and scope through `aad`.

use anyhow::{Result, anyhow, bail};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::backup::cloud::crypto::{self, SealPublic, SealSecret, SigBytes, SigPublic, Signer};
use crate::backup::cloud::format::{self, BackupMeta, Tree};
use crate::backup::cloud::store::CloudStore;
use crate::db;

pub const PSCOPES_KIND: &str = "pscopes";
pub const PSNAPSHOTS_KIND: &str = "psnapshots";
pub const SCOPE_RECORD_DOMAIN: &str = "private-scope";
pub const PRIVATE_SNAPSHOT_DOMAIN: &str = "private-snapshot";
pub const PRIVATE_OPEN_DOMAIN: &str = "private-open";
pub const OLD_PHRASE_GRACE: i64 = 30 * 24 * 60 * 60;
pub const PACK_KEY_PURPOSE: &str = "luna-private-pack-key-v1";
pub const TREE_PURPOSE: &str = "luna-private-tree-v1";
pub const META_PURPOSE: &str = "luna-private-meta-v1";
pub const DEDUP_PURPOSE: &str = "luna-private-dedup-v1";
pub const SCOPE_SECRET_PURPOSE: &str = "luna-private-scope-secret-v1";

/// The associated data every private seal is bound to.
pub fn aad(purpose: &str, luna_id: &str, scope: &str) -> Vec<u8> {
    crypto::canonical(&[
        ("purpose", purpose.as_bytes()),
        ("luna_id", luna_id.as_bytes()),
        ("scope", scope.as_bytes()),
    ])
}

/// The scope id and its public name (the first 16 bytes of the id, as 32 hex characters).
pub fn scope_of(dedup: &[u8; 32]) -> ([u8; 32], String) {
    let id = crypto::chunk_id(dedup, b"luna-scope-v1");
    let scope: String = id[..16].iter().map(|b| format!("{b:02x}")).collect();
    (id, scope)
}

pub fn seal_pack_key(
    owner: &SealPublic,
    luna_id: &str,
    scope: &str,
    pack_key: &[u8; 32],
) -> Result<Vec<u8>> {
    crypto::seal(owner, &aad(PACK_KEY_PURPOSE, luna_id, scope), pack_key)
}

pub fn seal_tree(owner: &SealPublic, luna_id: &str, scope: &str, tree: &Tree) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(tree)?;
    crypto::seal(owner, &aad(TREE_PURPOSE, luna_id, scope), &json)
}

pub fn seal_meta(
    owner: &SealPublic,
    luna_id: &str,
    scope: &str,
    meta: &BackupMeta,
) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(meta)?;
    crypto::seal(owner, &aad(META_PURPOSE, luna_id, scope), &json)
}

pub fn seal_dedup(
    owner: &SealPublic,
    luna_id: &str,
    scope: &str,
    dedup: &[u8; 32],
) -> Result<Vec<u8>> {
    crypto::seal(owner, &aad(DEDUP_PURPOSE, luna_id, scope), dedup)
}

/// Seal a scope's secret key to its owner's sealing key.
pub fn seal_scope_secret(
    owner: &SealPublic,
    luna_id: &str,
    scope: &str,
    secret: &SealSecret,
) -> Result<Vec<u8>> {
    crypto::seal(owner, &aad(SCOPE_SECRET_PURPOSE, luna_id, scope), secret)
}

/// Open a scope's secret key with the owner's secret sealing key.
pub fn open_scope_secret(
    owner_secret: &SealSecret,
    luna_id: &str,
    scope: &str,
    sealed: &[u8],
) -> Result<SealSecret> {
    let bytes = crypto::open(
        owner_secret,
        &aad(SCOPE_SECRET_PURPOSE, luna_id, scope),
        sealed,
    )?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("This private backup's key could not be read. It may be damaged."))
}

fn fixed<const N: usize>(bytes: Vec<u8>, what: &str) -> Result<[u8; N]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("This private backup's {what} could not be read. It may be damaged."))
}

pub fn open_pack_key(
    secret: &SealSecret,
    luna_id: &str,
    scope: &str,
    wrapped: &[u8],
) -> Result<[u8; 32]> {
    let bytes = crypto::open(secret, &aad(PACK_KEY_PURPOSE, luna_id, scope), wrapped)?;
    fixed(bytes, "key")
}

pub fn open_tree(secret: &SealSecret, luna_id: &str, scope: &str, sealed: &[u8]) -> Result<Tree> {
    let json = crypto::open(secret, &aad(TREE_PURPOSE, luna_id, scope), sealed)?;
    serde_json::from_slice(&json)
        .map_err(|_| anyhow!("This backup's file list could not be read. It may be damaged."))
}

pub fn open_meta(
    secret: &SealSecret,
    luna_id: &str,
    scope: &str,
    sealed: &[u8],
) -> Result<BackupMeta> {
    let json = crypto::open(secret, &aad(META_PURPOSE, luna_id, scope), sealed)?;
    serde_json::from_slice(&json)
        .map_err(|_| anyhow!("This backup's details could not be read. It may be damaged."))
}

pub fn open_dedup(
    secret: &SealSecret,
    luna_id: &str,
    scope: &str,
    sealed: &[u8],
) -> Result<[u8; 32]> {
    let bytes = crypto::open(secret, &aad(DEDUP_PURPOSE, luna_id, scope), sealed)?;
    fixed(bytes, "key")
}

/// The record name of a private snapshot: `<scope>.<snapshot id>`.
pub fn psnapshot_name(scope: &str, snapshot_id: &str) -> String {
    format!("{scope}.{snapshot_id}")
}

/// Where a snapshot's record lives on Connect: `("psnapshots", "<scope>.<id>")` for a private
/// snapshot, `("snapshots", "<id>")` otherwise.
pub fn snapshot_record_ref(conn: &Connection, snapshot_id: &str) -> Result<(&'static str, String)> {
    match db::private_scope_of_snapshot(conn, snapshot_id)? {
        Some(scope) => Ok((PSNAPSHOTS_KIND, psnapshot_name(&scope, snapshot_id))),
        None => Ok(("snapshots", snapshot_id.to_string())),
    }
}

/// What `pscopes/<scope>` says about one owner's scope. Signed by Luna's signing key.
/// `seal_public` and `auth_public` are the owner's; `scope_public` is the scope's own sealing key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScopeRecord {
    pub luna_id: String,
    pub scope: String,
    pub user_id: String,
    #[serde(with = "format::hex_fixed")]
    pub seal_public: SealPublic,
    #[serde(with = "format::hex_fixed")]
    pub auth_public: SigPublic,
    pub created_at: i64,
    #[serde(with = "format::hex_fixed")]
    pub scope_public: SealPublic,
    #[serde(with = "format::hex_fixed")]
    pub sealed_scope_secret: Vec<u8>,
    #[serde(with = "format::hex_fixed")]
    pub sealed_dedup: Vec<u8>,
}

impl ScopeRecord {
    pub fn signed_bytes(&self) -> Vec<u8> {
        crypto::canonical(&[
            ("luna_id", self.luna_id.as_bytes()),
            ("scope", self.scope.as_bytes()),
            ("user_id", self.user_id.as_bytes()),
            ("seal_public", &self.seal_public[..]),
            ("auth_public", &self.auth_public[..]),
            ("created_at", &self.created_at.to_be_bytes()[..]),
            ("scope_public", &self.scope_public[..]),
            ("sealed_scope_secret", &self.sealed_scope_secret[..]),
            ("sealed_dedup", &self.sealed_dedup[..]),
        ])
    }

    pub fn sign(self, signer: &Signer) -> SignedScope {
        let signature = signer.sign(SCOPE_RECORD_DOMAIN, &self.signed_bytes());
        SignedScope {
            record: self,
            signature,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignedScope {
    pub record: ScopeRecord,
    #[serde(with = "format::hex_fixed")]
    pub signature: SigBytes,
}

impl SignedScope {
    /// Check the signature against Luna's public signing key and return the record.
    pub fn verify(&self, luna_public: &SigPublic) -> Result<ScopeRecord> {
        if !crypto::verify(
            luna_public,
            SCOPE_RECORD_DOMAIN,
            &self.record.signed_bytes(),
            &self.signature,
        ) {
            bail!("This private backup's record was changed, or signed by a different Luna.");
        }
        Ok(self.record.clone())
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a signed scope always serializes to JSON")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        serde_json::from_slice(bytes).map_err(|e| {
            anyhow!(
                "TEMPDIAG This private backup's record could not be read. It may be damaged. {e}"
            )
        })
    }
}

/// The owner's active scope, made if missing. A new scope gets its own key pair; the secret half is
/// sealed to the owner and then dropped. Returns `(scope, true)` when a new scope was made.
/// A scope is never retired because the owner's keys changed: a save retires it on purpose.
pub fn ensure_scope(
    conn: &Connection,
    luna_id: &str,
    owner: &str,
    owner_public: &SealPublic,
    now: i64,
) -> Result<(db::PrivateScope, bool)> {
    if let Some(active) = db::active_private_scope(conn, owner)? {
        return Ok((active, false));
    }

    let mut dedup = [0u8; 32];
    getrandom::getrandom(&mut dedup).map_err(|e| anyhow!("{e}"))?;
    let (_, scope) = scope_of(&dedup);
    let (scope_secret, scope_public) = crypto::new_scope_keys();
    let sealed_scope_secret = seal_scope_secret(owner_public, luna_id, &scope, &scope_secret)?;
    let made = db::PrivateScope {
        scope,
        owner: owner.to_string(),
        seal_public: owner_public.to_vec(),
        scope_public: scope_public.to_vec(),
        sealed_scope_secret,
        dedup_key: dedup.to_vec(),
        state: "active".to_string(),
        retire_after: 0,
        created_at: now,
    };
    db::insert_private_scope(conn, &made)?;
    Ok((made, true))
}

/// What a phrase replacement did to the owner's private scopes.
#[derive(Debug, Default, PartialEq)]
pub struct Settled {
    /// Scopes the browser re-sealed to the new phrase; their records need publishing again.
    pub resealed: Vec<String>,
    /// Live scopes the browser did not re-seal. They keep their 30 days, then go.
    pub failed: usize,
}

/// Re-seals the owner's scopes to `new_public` when the browser sent them in `rescoped` (old
/// phrase proof), and keeps history (plan §5). A scope the browser could not re-seal retires with
/// the 30-day grace. With `exposed`, an active scope that was re-sealed becomes `history`: it is
/// kept, and no longer new data goes into it. `old_phrase` scopes are left as they are once they
/// are re-sealed.
pub fn settle_scopes(
    conn: &Connection,
    owner: &str,
    new_public: &SealPublic,
    rescoped: &[(String, Vec<u8>)],
    exposed: bool,
    now: i64,
) -> Result<Settled> {
    // Every re-sealed scope must be this owner's: one bad entry refuses the whole save.
    for (name, _) in rescoped {
        match db::get_private_scope(conn, name)? {
            Some(row) if row.owner == owner => {}
            _ => bail!("A private backup in the re-seal list is not this person's."),
        }
    }
    let mut settled = Settled::default();
    for scope in db::list_private_scopes(conn, Some(owner))? {
        let fresh = rescoped.iter().find(|(name, _)| *name == scope.scope);
        match (scope.state.as_str(), fresh) {
            // Retiring with grace already, and the browser could not re-seal it: leave it be.
            ("old_phrase", None) => {}
            (_, Some((_, sealed))) => {
                db::set_private_scope_seal(conn, &scope.scope, new_public, sealed)?;
                if exposed && scope.state == "active" {
                    db::set_private_scope_state(conn, &scope.scope, "history", 0)?;
                }
                settled.resealed.push(scope.scope.clone());
            }
            (_, None) => {
                db::set_private_scope_state(
                    conn,
                    &scope.scope,
                    "old_phrase",
                    now + OLD_PHRASE_GRACE,
                )?;
                settled.failed += 1;
            }
        }
    }
    Ok(settled)
}

/// A replacement proven with the Luna password: the browser cannot open the old scopes, so none is
/// kept. Each live scope retires with the 30-day grace, or at once when `exposed`.
pub fn retire_scopes_without_key(
    conn: &Connection,
    owner: &str,
    exposed: bool,
    now: i64,
) -> Result<()> {
    let retire_after = if exposed { now } else { now + OLD_PHRASE_GRACE };
    for scope in db::list_private_scopes(conn, Some(owner))? {
        if scope.state != "old_phrase" {
            db::set_private_scope_state(conn, &scope.scope, "old_phrase", retire_after)?;
        }
    }
    Ok(())
}

/// Put `pscopes/<scope>` on Connect. Safe to repeat: the same scope writes the same record name.
pub fn publish_scope(
    store: &dyn CloudStore,
    signer: &Signer,
    luna_id: &str,
    scope: &db::PrivateScope,
    auth_public: &SigPublic,
) -> Result<()> {
    let owner_public: SealPublic = scope.seal_public.as_slice().try_into().map_err(|_| {
        anyhow!("This private backup's key is the wrong length. It may be damaged.")
    })?;
    let scope_public: SealPublic = scope.scope_public.as_slice().try_into().map_err(|_| {
        anyhow!("This private backup's key is the wrong length. It may be damaged.")
    })?;
    let dedup: [u8; 32] = scope.dedup_key.as_slice().try_into().map_err(|_| {
        anyhow!("This private backup's key is the wrong length. It may be damaged.")
    })?;
    let sealed_dedup = seal_dedup(&scope_public, luna_id, &scope.scope, &dedup)?;
    let record = ScopeRecord {
        luna_id: luna_id.to_string(),
        scope: scope.scope.clone(),
        user_id: scope.owner.clone(),
        seal_public: owner_public,
        auth_public: *auth_public,
        created_at: scope.created_at,
        scope_public,
        sealed_scope_secret: scope.sealed_scope_secret.clone(),
        sealed_dedup,
    };
    let bytes = record.sign(signer).to_bytes();
    store
        .put_record(PSCOPES_KIND, &scope.scope, &bytes)
        .map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

/// The message an owner's auth key signs (domain `private-open`) to open a private scope on Connect.
pub fn open_message(luna_id: &str, scope: &str, challenge: &[u8; 32]) -> Vec<u8> {
    crypto::canonical(&[
        ("luna_id", luna_id.as_bytes()),
        ("scope", scope.as_bytes()),
        ("challenge", &challenge[..]),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::cloud::store::MemoryStore;

    fn keys() -> crypto::UserKeys {
        crypto::derive(&[0u8; 16], "luna-x")
    }

    fn sample_meta() -> BackupMeta {
        BackupMeta {
            name: "Photos".into(),
            source_drive: "Drive A".into(),
            source_path: "/Photos".into(),
            started_by: "owner".into(),
            started_by_name: "Owner".into(),
        }
    }

    fn sample_scope_record(sealed_dedup: Vec<u8>) -> ScopeRecord {
        let keys = keys();
        let (_, scope_public) = crypto::scope_keys_from_seed(&[6u8; 32]);
        ScopeRecord {
            luna_id: "luna-x".into(),
            scope: scope_of(&[9u8; 32]).1,
            user_id: "owner".into(),
            seal_public: keys.seal_public,
            auth_public: keys.auth_public,
            created_at: 1_760_000_000,
            scope_public,
            sealed_scope_secret: vec![8u8; crypto::sealed_len(crypto::SEAL_SECRET_LEN)],
            sealed_dedup,
        }
    }

    #[test]
    fn seal_and_open_round_trip() {
        let keys = keys();
        let (secret, public) = (keys.seal_secret, keys.seal_public);
        let scope = scope_of(&[1u8; 32]).1;

        let pack_key = [3u8; 32];
        let wrapped = seal_pack_key(&public, "luna-x", &scope, &pack_key).unwrap();
        assert_eq!(
            open_pack_key(&secret, "luna-x", &scope, &wrapped).unwrap(),
            pack_key
        );

        let tree = Tree { entries: vec![] };
        let sealed_tree = seal_tree(&public, "luna-x", &scope, &tree).unwrap();
        assert_eq!(
            open_tree(&secret, "luna-x", &scope, &sealed_tree).unwrap(),
            tree
        );

        let meta = sample_meta();
        let sealed_meta = seal_meta(&public, "luna-x", &scope, &meta).unwrap();
        assert_eq!(
            open_meta(&secret, "luna-x", &scope, &sealed_meta).unwrap(),
            meta
        );

        let dedup = [4u8; 32];
        let sealed_dedup = seal_dedup(&public, "luna-x", &scope, &dedup).unwrap();
        assert_eq!(
            open_dedup(&secret, "luna-x", &scope, &sealed_dedup).unwrap(),
            dedup
        );
    }

    #[test]
    fn wrong_scope_fails_to_open() {
        let keys = keys();
        let scope_a = scope_of(&[1u8; 32]).1;
        let scope_b = scope_of(&[2u8; 32]).1;
        let wrapped = seal_pack_key(&keys.seal_public, "luna-x", &scope_a, &[3u8; 32]).unwrap();
        assert!(open_pack_key(&keys.seal_secret, "luna-x", &scope_b, &wrapped).is_err());
        assert!(open_pack_key(&keys.seal_secret, "luna-y", &scope_a, &wrapped).is_err());
    }

    #[test]
    fn scope_record_signs_and_verifies() {
        let signer = Signer::generate();
        let sealed = seal_dedup(
            &keys().seal_public,
            "luna-x",
            &scope_of(&[9u8; 32]).1,
            &[9u8; 32],
        )
        .unwrap();
        let signed = sample_scope_record(sealed).sign(&signer);

        let verified = signed.verify(&signer.public()).unwrap();
        assert_eq!(verified, signed.record);

        let mut tampered = signed.clone();
        tampered.record.sealed_dedup[0] ^= 1;
        assert!(tampered.verify(&signer.public()).is_err());

        let round_tripped = SignedScope::from_bytes(&signed.to_bytes()).unwrap();
        assert_eq!(round_tripped, signed);
    }

    #[test]
    fn ensure_scope_reuses_and_keeps_its_scope_when_owner_keys_change() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let first_keys = keys();
        let other_keys = crypto::derive(&[1u8; 16], "luna-x");

        let (first, is_new) =
            ensure_scope(&conn, "luna-x", "owner", &first_keys.seal_public, 1_000).unwrap();
        assert!(is_new);
        assert_eq!(first.state, "active");
        assert_eq!(first.scope_public.len(), crypto::SEAL_PUBLIC_LEN);

        let (again, is_new_again) =
            ensure_scope(&conn, "luna-x", "owner", &first_keys.seal_public, 2_000).unwrap();
        assert!(!is_new_again);
        assert_eq!(again.scope, first.scope);

        // A new phrase does not retire the scope by itself: the save decides that.
        let (same, is_new_same) =
            ensure_scope(&conn, "luna-x", "owner", &other_keys.seal_public, 3_000).unwrap();
        assert!(!is_new_same);
        assert_eq!(same.scope, first.scope);
        assert_eq!(same.state, "active");
    }

    #[test]
    fn scope_secret_opens_only_with_the_owners_key() {
        let owner = keys();
        let other = crypto::derive(&[1u8; 16], "luna-x");
        let (scope_secret, _) = crypto::scope_keys_from_seed(&[7u8; 32]);
        let scope = scope_of(&[3u8; 32]).1;
        let sealed =
            seal_scope_secret(&owner.seal_public, "luna-x", &scope, &scope_secret).unwrap();
        assert_eq!(
            open_scope_secret(&owner.seal_secret, "luna-x", &scope, &sealed).unwrap(),
            scope_secret
        );
        assert!(open_scope_secret(&other.seal_secret, "luna-x", &scope, &sealed).is_err());
        assert!(
            open_scope_secret(
                &owner.seal_secret,
                "luna-x",
                &scope_of(&[4u8; 32]).1,
                &sealed
            )
            .is_err()
        );
    }

    #[test]
    fn snapshot_record_ref_picks_the_kind() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = db::open(&dir.path().join("luna.db")).unwrap();
        let scope = scope_of(&[5u8; 32]).1;
        let snap = db::SnapshotInsert {
            id: "snap-1".into(),
            protection_id: "prot-1".into(),
            created_at: 1,
            key_version: 0,
            tree_pack_id: "tree-pack".into(),
            record: vec![],
        };
        db::commit_private_snapshot_tx(&mut conn, &snap, &[], &scope, b"{}").unwrap();

        assert_eq!(
            snapshot_record_ref(&conn, "snap-1").unwrap(),
            (PSNAPSHOTS_KIND, format!("{scope}.snap-1"))
        );
        assert_eq!(
            snapshot_record_ref(&conn, "snap-2").unwrap(),
            ("snapshots", "snap-2".to_string())
        );
    }

    #[test]
    fn publish_scope_writes_one_record() {
        let store = MemoryStore::new();
        let signer = Signer::generate();
        let keys = keys();
        let dedup = [5u8; 32];
        let (scope_secret, scope_public) = crypto::new_scope_keys();
        let scope_name = scope_of(&dedup).1;
        let scope = db::PrivateScope {
            scope: scope_name.clone(),
            owner: "owner".into(),
            seal_public: keys.seal_public.to_vec(),
            scope_public: scope_public.to_vec(),
            sealed_scope_secret: seal_scope_secret(
                &keys.seal_public,
                "luna-x",
                &scope_name,
                &scope_secret,
            )
            .unwrap(),
            dedup_key: dedup.to_vec(),
            state: "active".into(),
            retire_after: 0,
            created_at: 42,
        };

        publish_scope(&store, &signer, "luna-x", &scope, &keys.auth_public).unwrap();

        assert_eq!(
            store.list_records(PSCOPES_KIND).unwrap(),
            vec![scope.scope.clone()]
        );
        let bytes = store
            .get_record(PSCOPES_KIND, &scope.scope)
            .unwrap()
            .unwrap();
        let record = SignedScope::from_bytes(&bytes)
            .unwrap()
            .verify(&signer.public())
            .unwrap();
        assert_eq!(record.user_id, "owner");
        assert_eq!(record.created_at, 42);
        assert_eq!(record.scope_public, scope_public);
        // The dedup key opens with the scope's secret, not the owner's.
        assert_eq!(
            open_dedup(&scope_secret, "luna-x", &scope.scope, &record.sealed_dedup).unwrap(),
            dedup
        );
        assert!(
            open_dedup(
                &keys.seal_secret,
                "luna-x",
                &scope.scope,
                &record.sealed_dedup
            )
            .is_err()
        );
        assert_eq!(
            open_scope_secret(
                &keys.seal_secret,
                "luna-x",
                &scope.scope,
                &record.sealed_scope_secret
            )
            .unwrap(),
            scope_secret
        );
    }

    #[test]
    fn open_message_binds_luna_scope_and_challenge() {
        let challenge = [7u8; 32];
        let message = open_message("luna-x", "scope-a", &challenge);
        assert_ne!(message, open_message("luna-y", "scope-a", &challenge));
        assert_ne!(message, open_message("luna-x", "scope-b", &challenge));
        assert_ne!(message, open_message("luna-x", "scope-a", &[8u8; 32]));
    }
}
