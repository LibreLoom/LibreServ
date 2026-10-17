//! Brings back Luna's cloud backup list after its database is lost (plan §5 "Luna loses its
//! database").
//!
//! The browser does the work that needs the recovery phrase. It reads the sealed records through
//! these routes, checks each signature against the key the phrase sealed, opens the copies, and
//! POSTs the plain backup keys back. The phrase never reaches Luna. Luna only serves public keys,
//! sealed records, and the backup keys the browser has already opened and checked.

use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::cloud_backups::connect_store;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::identity::{self, Identity};
use crate::backup::cloud::recover::{self, Recovered};
use crate::backup::cloud::store::CloudStore;
use crate::db;

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

/// The record kinds the browser may read back to rebuild its index.
const RECORD_KINDS: [&str; 3] = ["self", "recipients", "keys"];
/// Snapshot records are the ones that say which backups exist.
const SNAPSHOT_KIND: &str = "snapshots";
/// Most backup keys one restore may send.
const MAX_KEYS: usize = 10_000;
/// Longest old account id that may be re-linked.
const MAX_OLD_USER_ID: usize = 128;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cloud/restore", get(status).post(restore))
        .route("/api/v1/cloud/restore/records/{kind}", get(records))
}

/// Body the browser sends once it has opened the backup keys.
#[derive(Deserialize)]
struct RestoreBody {
    keys: Vec<KeyIn>,
    /// Account ids that made backups before this Luna lost its database.
    #[serde(default)]
    old_user_ids: Vec<String>,
}

#[derive(Deserialize)]
struct KeyIn {
    protection_id: String,
    version: i64,
    /// Base64 of the 32-byte backup key.
    key: String,
    /// Base64 of the 32-byte dedup key.
    dedup_key: String,
}

fn require_admin(user: &CurrentUser) -> Result<(), ApiError> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(json_error(StatusCode::FORBIDDEN, "Only an Admin can bring back cloud backups."))
    }
}

fn not_set_up() -> ApiError {
    json_error(StatusCode::CONFLICT, "Set up Luna Connect first, in Settings → Luna Connect.")
}

fn unreachable_connect(err: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %err, "could not reach Luna Connect for a cloud restore");
    json_error(
        StatusCode::BAD_GATEWAY,
        "Could not reach Luna Connect. Check your connection, then try again.",
    )
}

fn read_failed(err: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %err, "could not read the cloud backup index");
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Luna could not read its cloud backup index. Try again.")
}

fn unreadable_keys() -> ApiError {
    json_error(
        StatusCode::BAD_REQUEST,
        "These backup keys can't be read. Start again from Settings → Cloud backup.",
    )
}

fn finish(joined: Result<Result<Value, ApiError>, tokio::task::JoinError>) -> ApiResult {
    match joined {
        Ok(Ok(value)) => Ok(Json(value)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(json_error(StatusCode::INTERNAL_SERVER_ERROR, "Luna could not finish that. Try again.")),
    }
}

fn valid_kind(kind: &str) -> Result<(), ApiError> {
    if RECORD_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(json_error(StatusCode::BAD_REQUEST, "Luna can't share that kind of backup record."))
    }
}

async fn status(State(state): State<AppState>, Extension(user): Extension<CurrentUser>) -> ApiResult {
    require_admin(&user)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        // Without Connect there is nothing to restore from.
        let Some(store) = connect_store(&connect, &db) else {
            return Ok(json!({
                "needed": false,
                "luna_id": null,
                "signing_public": null,
                "cloud_snapshots": 0,
                "indexed_snapshots": 0,
            }));
        };
        let cloud = store.list_records(SNAPSHOT_KIND).map_err(unreachable_connect)?.len() as i64;
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        let indexed: i64 = conn
            .query_row("SELECT COUNT(*) FROM cloud_snapshots", [], |r| r.get(0))
            .map_err(read_failed)?;
        let identity = identity::load(&conn).map_err(read_failed)?;
        let (luna_id, signing_public) = match &identity {
            Some(id) => (json!(id.luna_id()), json!(STANDARD.encode(id.public()))),
            None => (Value::Null, Value::Null),
        };
        Ok(json!({
            "needed": cloud > indexed,
            "luna_id": luna_id,
            "signing_public": signing_public,
            "cloud_snapshots": cloud,
            "indexed_snapshots": indexed,
        }))
    })
    .await;
    finish(answer)
}

async fn records(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(kind): Path<String>,
) -> ApiResult {
    require_admin(&user)?;
    valid_kind(&kind)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        records_with_store(&store, &kind)
    })
    .await;
    finish(answer)
}

async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<RestoreBody>,
) -> ApiResult {
    require_admin(&user)?;
    parse_keys(&body, 0)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        // The store is read while the DB lock is held. A restore is rare and Admin-only, and
        // rebuild_snapshot_index needs one connection for its transactions.
        let mut conn = db.lock().unwrap_or_else(|p| p.into_inner());
        let identity = identity::load(&conn)
            .map_err(read_failed)?
            .ok_or_else(|| json_error(StatusCode::CONFLICT, "Luna has no cloud backup identity yet."))?;
        let r = restore_with_store(&mut conn, &store, &identity, &user_id, &body, db::now_unix())?;
        Ok(json!({
            "snapshots": r.snapshots,
            "already_indexed": r.already_indexed,
            "skipped": r.skipped,
        }))
    })
    .await;
    finish(answer)
}

/// Checks the keys the browser sent and turns them into backup keys.
fn parse_keys(body: &RestoreBody, now: i64) -> Result<Vec<db::BackupKey>, ApiError> {
    if body.keys.is_empty() || body.keys.len() > MAX_KEYS {
        return Err(unreadable_keys());
    }
    body.keys
        .iter()
        .map(|k| {
            let id_ok = !k.protection_id.is_empty()
                && k.protection_id.len() <= 64
                && k.protection_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !id_ok || k.version < 1 {
                return Err(unreadable_keys());
            }
            Ok(db::BackupKey {
                protection_id: k.protection_id.clone(),
                version: k.version,
                key: decode_32(&k.key)?,
                dedup_key: decode_32(&k.dedup_key)?,
                created_at: now,
            })
        })
        .collect()
}

fn decode_32(s: &str) -> Result<Vec<u8>, ApiError> {
    match STANDARD.decode(s) {
        Ok(bytes) if bytes.len() == 32 => Ok(bytes),
        _ => Err(unreadable_keys()),
    }
}

/// Lists the records of one kind on the store, sorted by name, as base64.
fn records_with_store(store: &dyn CloudStore, kind: &str) -> Result<Value, ApiError> {
    valid_kind(kind)?;
    let mut names = store.list_records(kind).map_err(unreachable_connect)?;
    names.sort();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        match store.get_record(kind, &name).map_err(unreachable_connect)? {
            Some(bytes) => out.push(json!({ "name": name, "data": STANDARD.encode(bytes) })),
            None => {}
        }
    }
    Ok(json!({ "records": out }))
}

/// Rebuilds the snapshot index from the store, then re-links backups made under old accounts.
fn restore_with_store(
    conn: &mut Connection,
    store: &dyn CloudStore,
    identity: &Identity,
    user_id: &str,
    body: &RestoreBody,
    now: i64,
) -> Result<Recovered, ApiError> {
    let keys = parse_keys(body, now)?;
    let r = recover::rebuild_snapshot_index(conn, store, identity, &keys, now).map_err(|err| {
        tracing::warn!(error = %err, "could not rebuild the cloud backup index");
        json_error(
            StatusCode::BAD_GATEWAY,
            "Luna could not read its cloud backups from Luna Connect. Try again.",
        )
    })?;
    // Only old accounts are re-linked. A current user's backups stay theirs.
    for old in &body.old_user_ids {
        if old.is_empty() || old.len() > MAX_OLD_USER_ID {
            continue;
        }
        if db::get_user(conn, old).map_err(read_failed)?.is_some() {
            continue;
        }
        conn.execute(
            "UPDATE protections SET created_by = ?1 WHERE created_by = ?2",
            params![user_id, old],
        )
        .map_err(read_failed)?;
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use rusqlite::params;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{KeyIn, RestoreBody, records_with_store, restore_with_store};
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::format::{self, BackupMeta, SnapshotRecord};
    use crate::backup::cloud::identity::{self, Identity};
    use crate::backup::cloud::store::{CloudStore, MemoryStore};
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    const NOW: i64 = 1_800_000_000;
    const SCOPE_ID: [u8; 32] = [7; 32];
    const TREE_KEY: [u8; 32] = [9; 32];
    /// Same bytes as backup::cloud::run::PACK_KEY_WRAP_AAD, which is private to that module.
    const PACK_KEY_WRAP_AAD: &[u8] = b"luna-pack-key-wrap-v1";

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
        member_id: String,
        admin_token: String,
        member_token: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth.register("Max", "Max", "hunter22hunter1", "admin").unwrap();
        let member = auth.register("Jamie", "Jamie", "hunter22hunter1", "user").unwrap();
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::guard))
            .with_state(state.clone());
        Fixture {
            admin_token: auth.issue(&admin).unwrap(),
            member_token: auth.issue(&member).unwrap(),
            admin_id: admin.id.clone(),
            member_id: member.id.clone(),
            _dir: dir,
            state,
            router,
        }
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = router.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// The keys the browser would POST for one backup key and dedup key.
    fn body(key: [u8; 32]) -> RestoreBody {
        RestoreBody {
            keys: vec![KeyIn {
                protection_id: "p1".into(),
                version: 1,
                key: STANDARD.encode(key),
                dedup_key: STANDARD.encode([3u8; 32]),
            }],
            old_user_ids: Vec::new(),
        }
    }

    /// Write one snapshot of an empty tree the way a backup run does: a sealed tree pack, then a
    /// signed record.
    fn put_snapshot(store: &MemoryStore, signer: &Identity, snapshot_id: &str) {
        let tree_bytes = format::encrypt_tree(&format::Tree { entries: Vec::new() }, &TREE_KEY);
        let tree_hash = format::sha256(&tree_bytes);
        let mut builder = format::PackBuilder::new(SCOPE_ID);
        builder.add(tree_hash, &tree_bytes);
        let pack = builder.finish(|pack_key| crypto::encrypt(&TREE_KEY, PACK_KEY_WRAP_AAD, pack_key));
        store.put_pack(&pack.id, Some("scope"), &pack.bytes).unwrap();
        let meta = BackupMeta {
            name: "Photos".into(),
            source_drive: "drive-a".into(),
            source_path: "/Photos".into(),
            started_by: "user-7".into(),
            started_by_name: String::new(),
        };
        let record = SnapshotRecord {
            luna_id: signer.luna_id().into(),
            protection_id: "p1".into(),
            snapshot_id: snapshot_id.into(),
            created_at: NOW,
            key_version: 1,
            tree_pack_id: pack.id,
            tree_hash,
            meta: format::encrypt_meta(&meta, &TREE_KEY),
        };
        let signed = record.sign(signer.signer()).to_bytes();
        store.put_record("snapshots", snapshot_id, &signed).unwrap();
    }

    fn insert_protection(conn: &rusqlite::Connection, id: &str, path: &str, created_by: &str) {
        conn.execute(
            "INSERT INTO protections (id, kind, source_drive, source_path, created_by, created_at)
             VALUES (?1, 'cloud', 'drive-a', ?2, ?3, ?4)",
            params![id, path, created_by, NOW],
        )
        .unwrap();
    }

    #[test]
    fn records_come_back_sorted_as_base64_and_unknown_kinds_are_refused() {
        let store = MemoryStore::new();
        store.put_record("self", "b-record", b"two").unwrap();
        store.put_record("self", "a-record", b"one").unwrap();

        let out = records_with_store(&store, "self").unwrap();
        let records = out["records"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["name"], "a-record");
        assert_eq!(records[1]["name"], "b-record");
        assert_eq!(STANDARD.decode(records[0]["data"].as_str().unwrap()).unwrap(), b"one");

        let refused = records_with_store(&store, "bogus").unwrap_err();
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn restore_counts_new_snapshots_then_indexed_and_skips_a_wrong_key() {
        let f = fixture();
        let mut conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        let id = identity::load_or_create(&conn, NOW).unwrap();
        let store = MemoryStore::new();
        put_snapshot(&store, &id, "snap-a");

        let wrong = restore_with_store(&mut conn, &store, &id, &f.admin_id, &body([1; 32]), NOW).unwrap();
        assert_eq!((wrong.snapshots, wrong.already_indexed, wrong.skipped), (0, 0, 1));

        let first = restore_with_store(&mut conn, &store, &id, &f.admin_id, &body(TREE_KEY), NOW).unwrap();
        assert_eq!((first.snapshots, first.already_indexed, first.skipped), (1, 0, 0));

        let again = restore_with_store(&mut conn, &store, &id, &f.admin_id, &body(TREE_KEY), NOW).unwrap();
        assert_eq!((again.snapshots, again.already_indexed, again.skipped), (0, 1, 0));
    }

    #[test]
    fn relinks_only_backups_from_accounts_that_no_longer_exist() {
        let f = fixture();
        let mut conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        let id = identity::load_or_create(&conn, NOW).unwrap();
        let store = MemoryStore::new();
        insert_protection(&conn, "old-row", "/Old", "old-user");
        insert_protection(&conn, "mine-row", "/Mine", &f.member_id);

        let mut restore = body(TREE_KEY);
        restore.old_user_ids = vec!["old-user".into(), "member-gone".into(), String::new()];
        restore_with_store(&mut conn, &store, &id, &f.admin_id, &restore, NOW).unwrap();

        let owner = |row: &str| -> String {
            conn.query_row("SELECT created_by FROM protections WHERE id = ?1", params![row], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(owner("old-row"), f.admin_id);
        assert_eq!(owner("mine-row"), f.member_id);
    }

    #[tokio::test]
    async fn members_are_refused_on_every_route() {
        let f = fixture();
        let (status, _) = send(&f.router, "GET", "/api/v1/cloud/restore", &f.member_token, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) =
            send(&f.router, "GET", "/api/v1/cloud/restore/records/self", &f.member_token, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let valid = json!({ "keys": [{
            "protection_id": "p1", "version": 1,
            "key": STANDARD.encode([9u8; 32]), "dedup_key": STANDARD.encode([3u8; 32]),
        }] });
        let (status, _) = send(&f.router, "POST", "/api/v1/cloud/restore", &f.member_token, Some(valid)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_key_that_is_not_32_bytes_is_refused() {
        let f = fixture();
        // "AAAA" decodes to three bytes.
        let bad = json!({ "keys": [{
            "protection_id": "p1", "version": 1,
            "key": "AAAA", "dedup_key": STANDARD.encode([3u8; 32]),
        }] });
        let (status, _) = send(&f.router, "POST", "/api/v1/cloud/restore", &f.admin_token, Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn status_says_no_restore_is_needed_without_connect() {
        let f = fixture();
        let (status, out) = send(&f.router, "GET", "/api/v1/cloud/restore", &f.admin_token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(out["needed"], false);
        assert_eq!(out["cloud_snapshots"], 0);
    }
}
