//! Private items: restoring private backups from the cloud after the local database is lost.
//!
//! The browser does the work that needs the recovery phrase. It reads the sealed private records
//! through these routes, opens them, and POSTs the plain dedup key and snapshot trees back. Luna
//! checks each record against its own signing key before it writes anything. Luna only serves
//! sealed records and tree packs that belong to the signed-in user's own private scopes.

use axum::extract::{Extension, Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::api::cloud_backups::connect_store;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::crypto::{SEAL_PUBLIC_LEN, SealPublic, SigPublic};
use crate::backup::cloud::format::Tree;
use crate::backup::cloud::identity;
use crate::backup::cloud::private::{PSCOPES_KIND, PSNAPSHOTS_KIND, ScopeRecord, SignedScope};
use crate::backup::cloud::private_recover::{
    PlainMeta, PrivateSnapshotIn, caller_scopes, caller_tree_packs, write_private_index,
};
use crate::backup::cloud::store::CloudStore;
use crate::db;

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;
/// The signed-in user's sealing public key and this Luna's signing public key.
type CallerKeys = (SealPublic, SigPublic);

/// Most snapshots one private restore may send.
const MAX_SNAPSHOTS: usize = 10_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/cloud/restore-private", get(status).post(restore))
        .route("/api/v1/cloud/restore-private/records/{kind}", get(records))
        .route("/api/v1/cloud/restore-private/packs/{id}", get(pack))
}

/// Body the browser sends once it has opened the private scope's dedup key.
#[derive(Deserialize)]
struct RestoreBody {
    scope: String,
    /// Base64 of the 32-byte dedup key, opened by the browser.
    dedup_key: String,
    snapshots: Vec<SnapshotIn>,
}

#[derive(Deserialize)]
struct SnapshotIn {
    snapshot_id: String,
    protection_id: String,
    /// Base64 of the signed snapshot record as it sits on Connect.
    record: String,
    meta: MetaIn,
    tree: Tree,
}

#[derive(Deserialize)]
struct MetaIn {
    name: String,
    source_drive: String,
    source_path: String,
}

/// A restore body that has been checked and decoded.
struct Parsed {
    scope: String,
    dedup: [u8; 32],
    snapshots: Vec<PrivateSnapshotIn>,
}

fn not_set_up() -> ApiError {
    json_error(
        StatusCode::CONFLICT,
        "Set up Luna Connect first, in Settings → About → Advanced.",
    )
}

fn no_phrase() -> ApiError {
    json_error(
        StatusCode::BAD_REQUEST,
        "Set up your recovery phrase on this Luna first.",
    )
}

fn unreachable_connect(err: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %err, "could not reach Luna Connect for a private cloud restore");
    json_error(
        StatusCode::BAD_GATEWAY,
        "Could not reach Luna Connect. Check your connection, then try again.",
    )
}

fn read_failed(err: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %err, "could not read the private backup index");
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Luna could not read its private backup index. Try again.",
    )
}

fn unreadable() -> ApiError {
    json_error(
        StatusCode::BAD_REQUEST,
        "These private backups can't be read. Start again from Settings → Cloud backup.",
    )
}

fn pack_missing() -> ApiError {
    json_error(StatusCode::NOT_FOUND, "Luna can't find that backup file.")
}

fn finish(joined: Result<Result<Value, ApiError>, tokio::task::JoinError>) -> ApiResult {
    match joined {
        Ok(Ok(value)) => Ok(Json(value)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not finish that. Try again.",
        )),
    }
}

fn valid_private_kind(kind: &str) -> Result<(), ApiError> {
    if kind == PSCOPES_KIND || kind == PSNAPSHOTS_KIND {
        Ok(())
    } else {
        Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can't share that kind of backup record.",
        ))
    }
}

/// A key the database holds, as the fixed-size array the crypto code wants.
fn fixed<const N: usize>(bytes: &[u8]) -> Result<[u8; N], ApiError> {
    <[u8; N]>::try_from(bytes).map_err(|_| read_failed("a stored key has the wrong length"))
}

/// The browser's base64 32-byte key.
fn decode_key(s: &str) -> Result<[u8; 32], ApiError> {
    match STANDARD.decode(s) {
        Ok(bytes) => fixed::<32>(&bytes).map_err(|_| unreadable()),
        Err(_) => Err(unreadable()),
    }
}

/// A scope id is 16 bytes written as 32 lowercase hex characters.
fn valid_scope(scope: &str) -> bool {
    scope.len() == 32
        && scope
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Decodes a pack id from the URL: 64 hex characters, in any case.
fn parse_pack_id(id: &str) -> Option<[u8; 32]> {
    if id.len() != 64 || !id.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The signed-in user's sealing key and this Luna's signing key. `None` when the user has no
/// recovery phrase on this Luna yet.
fn load_caller(db: &crate::Db, user_id: &str) -> Result<Option<CallerKeys>, ApiError> {
    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
    let Some(keys) = db::get_user_keys(&conn, user_id).map_err(read_failed)? else {
        return Ok(None);
    };
    let caller = fixed::<SEAL_PUBLIC_LEN>(&keys.seal_public)?;
    let identity = identity::load(&conn).map_err(read_failed)?.ok_or_else(|| {
        json_error(
            StatusCode::CONFLICT,
            "Luna has no cloud backup identity yet.",
        )
    })?;
    Ok(Some((caller, identity.public())))
}

async fn status(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> ApiResult {
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let store = connect_store(&connect, &db);
        status_with(&db, &user_id, store.as_ref().map(|s| s as &dyn CloudStore))
    })
    .await;
    finish(answer)
}

/// Says whether Connect holds a private scope for this user that this Luna has not indexed yet.
/// Without Connect, a phrase, or a reachable Connect, nothing is needed.
fn status_with(
    db: &crate::Db,
    user_id: &str,
    store: Option<&dyn CloudStore>,
) -> Result<Value, ApiError> {
    let (caller, luna_public, luna_id, signing_public) = {
        let conn = db.lock().unwrap_or_else(|p| p.into_inner());
        let keys = db::get_user_keys(&conn, user_id).map_err(read_failed)?;
        let identity = identity::load(&conn).map_err(read_failed)?;
        let caller = keys.and_then(|k| SealPublic::try_from(k.seal_public.as_slice()).ok());
        match identity {
            Some(id) => (
                caller,
                Some(id.public()),
                serde_json::json!(id.luna_id()),
                serde_json::json!(STANDARD.encode(id.public())),
            ),
            None => (caller, None, Value::Null, Value::Null),
        }
    };
    let mut out = json!({
        "needed": false,
        "luna_id": luna_id,
        "signing_public": signing_public,
        "scopes": 0,
    });
    let (Some(caller), Some(luna_public), Some(store)) = (caller, luna_public, store) else {
        return Ok(out);
    };
    let scopes = match caller_scopes(store, &luna_public, &caller) {
        Ok(scopes) => scopes,
        Err(err) => {
            tracing::warn!(error = %err, "could not list private scopes for a restore check");
            return Ok(out);
        }
    };
    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
    let mut needed = false;
    for scope in &scopes {
        if db::get_private_scope(&conn, &scope.scope)
            .map_err(read_failed)?
            .is_none()
        {
            needed = true;
        }
    }
    out["needed"] = json!(needed);
    out["scopes"] = json!(scopes.len());
    Ok(out)
}

async fn records(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(kind): Path<String>,
) -> ApiResult {
    valid_private_kind(&kind)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        records_with_store(&store, &luna_public, &caller, &kind)
    })
    .await;
    finish(answer)
}

/// Lists the private records of one kind that belong to the caller's scopes, sorted by name.
fn records_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    kind: &str,
) -> Result<Value, ApiError> {
    valid_private_kind(kind)?;
    let scopes = caller_scopes(store, luna_public, caller).map_err(unreachable_connect)?;
    let mut names: Vec<String> = store
        .list_records(kind)
        .map_err(unreachable_connect)?
        .into_iter()
        .filter(|name| is_mine(name, kind, &scopes))
        .collect();
    names.sort();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        if let Some(bytes) = store.get_record(kind, &name).map_err(unreachable_connect)? {
            out.push(json!({ "name": name, "data": STANDARD.encode(bytes) }));
        }
    }
    Ok(json!({ "records": out }))
}

/// A scope record is named by its scope. A snapshot record is `<scope>.<snapshot id>`.
fn is_mine(name: &str, kind: &str, scopes: &[ScopeRecord]) -> bool {
    scopes.iter().any(|s| {
        if kind == PSCOPES_KIND {
            name == s.scope
        } else {
            name.starts_with(&format!("{}.", s.scope))
        }
    })
}

async fn pack(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        pack_with_store(&store, &luna_public, &caller, &id)
    })
    .await;
    match answer {
        Ok(Ok(bytes)) => {
            Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
        }
        Ok(Err(err)) => Err(err),
        Err(_) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna could not finish that. Try again.",
        )),
    }
}

/// Serves one tree pack, and only when a verified snapshot in the caller's scopes names it.
fn pack_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    id: &str,
) -> Result<Vec<u8>, ApiError> {
    let id_bytes = parse_pack_id(id).ok_or_else(pack_missing)?;
    let scopes = caller_scopes(store, luna_public, caller).map_err(unreachable_connect)?;
    let packs = caller_tree_packs(store, luna_public, &scopes).map_err(unreachable_connect)?;
    if !packs.contains(&hex_lower(&id_bytes)) {
        return Err(pack_missing());
    }
    store.get_pack(&id_bytes).map_err(unreachable_connect)
}

async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<RestoreBody>,
) -> ApiResult {
    let parsed = parse_body(body)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        let restored = restore_with_store(
            &db,
            &store,
            &luna_public,
            &user_id,
            &caller,
            parsed,
            db::now_unix(),
        )?;
        Ok(json!({ "restored": restored }))
    })
    .await;
    finish(answer)
}

/// Checks the shape of the body and decodes the dedup key and snapshot records.
fn parse_body(body: RestoreBody) -> Result<Parsed, ApiError> {
    let RestoreBody {
        scope,
        dedup_key,
        snapshots,
    } = body;
    if !valid_scope(&scope) || snapshots.is_empty() || snapshots.len() > MAX_SNAPSHOTS {
        return Err(unreadable());
    }
    let dedup = decode_key(&dedup_key)?;
    let snapshots = snapshots
        .into_iter()
        .map(|s| {
            let record = STANDARD.decode(&s.record).map_err(|_| unreadable())?;
            Ok(PrivateSnapshotIn {
                snapshot_id: s.snapshot_id,
                protection_id: s.protection_id,
                record,
                meta: PlainMeta {
                    name: s.meta.name,
                    source_drive: s.meta.source_drive,
                    source_path: s.meta.source_path,
                },
                tree: s.tree,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Parsed {
        scope,
        dedup,
        snapshots,
    })
}

/// Loads the scope record from Connect, checks it under this Luna's key, and writes the index.
/// Every store read happens with the database lock free. The lock is taken only for the write.
fn restore_with_store(
    db: &crate::Db,
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    user_id: &str,
    caller: &SealPublic,
    parsed: Parsed,
    now: i64,
) -> Result<usize, ApiError> {
    let Parsed {
        scope,
        dedup,
        snapshots,
    } = parsed;
    let bytes = store
        .get_record(PSCOPES_KIND, &scope)
        .map_err(unreachable_connect)?
        .ok_or_else(|| {
            json_error(
                StatusCode::NOT_FOUND,
                "Luna can't find that private backup on Luna Connect.",
            )
        })?;
    let record = SignedScope::from_bytes(&bytes)
        .and_then(|signed| signed.verify(luna_public))
        .map_err(|_| {
            json_error(
                StatusCode::BAD_REQUEST,
                "This private backup's record can't be checked. It may be damaged.",
            )
        })?;
    let mut conn = db.lock().unwrap_or_else(|p| p.into_inner());
    write_private_index(
        &mut conn,
        luna_public,
        user_id,
        caller,
        &record,
        &dedup,
        snapshots,
        now,
    )
    .map_err(|err| json_error(StatusCode::BAD_REQUEST, err.to_string()))
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::{SealPublic, SigPublic};

    use super::{pack_with_store, records_with_store, status_with};
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::format::SnapshotRecord;
    use crate::backup::cloud::identity::{self, Identity};
    use crate::backup::cloud::private::{
        self, PRIVATE_SNAPSHOT_DOMAIN, PSCOPES_KIND, PSNAPSHOTS_KIND,
    };
    use crate::backup::cloud::store::{CloudStore, MemoryStore};
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;
    use crate::{AppState, db};

    #[test]
    fn the_not_set_up_error_points_to_about_advanced() {
        let (status, body) = super::not_set_up();
        assert_eq!(status, StatusCode::CONFLICT);
        let text = body.0["error"].as_str().unwrap().to_string();
        assert!(text.contains("Settings → About → Advanced"), "{text}");
        assert!(!text.contains("Settings → Luna Connect"), "{text}");
    }

    const NOW: i64 = 1_800_000_000;
    const DEDUP_A: [u8; 32] = [3; 32];
    const DEDUP_B: [u8; 32] = [4; 32];

    struct Fixture {
        _dir: tempfile::TempDir,
        state: AppState,
        router: Router,
        admin_id: String,
        member_id: String,
        member_token: String,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        let auth = state.auth.clone();
        let admin = auth
            .register("Max", "Max", "hunter22hunter1", "admin")
            .unwrap();
        let member = auth
            .register("Jamie", "Jamie", "hunter22hunter1", "user")
            .unwrap();
        let router = Router::new()
            .merge(super::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::guard,
            ))
            .with_state(state.clone());
        Fixture {
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
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn load_identity(f: &Fixture) -> Identity {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        identity::load_or_create(&conn, NOW).unwrap()
    }

    /// A real signing public key (Ed25519 and ML-DSA) for the auth key of a recovery phrase made of `n` bytes.
    fn auth_public(n: u8) -> SigPublic {
        crypto::derive(&[n; 16], "luna-test").auth_public
    }

    /// Give a user a recovery phrase on this Luna: their sealing public key is stored.
    fn set_keys(f: &Fixture, user: &str, x25519: &SealPublic) {
        let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
        db::set_user_keys(
            &conn,
            &db::UserKeys {
                user_id: user.into(),
                seal_public: x25519.to_vec(),
                auth_public: auth_public(4).to_vec(),
                self_sealed: vec![1; 8],
                phrase_set_at: NOW,
                last_checked_at: NOW,
                phrase_words: 0,
            },
        )
        .unwrap();
    }

    fn scope_for(owner: &str, x25519: &SealPublic, dedup: [u8; 32]) -> db::PrivateScope {
        let scope = private::scope_of(&dedup).1;
        let (secret, scope_public) = crypto::new_scope_keys();
        let sealed_scope_secret =
            private::seal_scope_secret(x25519, "luna-test", &scope, &secret).unwrap();
        db::PrivateScope {
            scope,
            owner: owner.into(),
            seal_public: x25519.to_vec(),
            scope_public: scope_public.to_vec(),
            sealed_scope_secret,
            dedup_key: dedup.to_vec(),
            state: "active".into(),
            retire_after: 0,
            created_at: NOW,
        }
    }

    /// Write a signed private snapshot record the way a private backup run does.
    fn put_private_snapshot(
        store: &MemoryStore,
        id: &Identity,
        scope: &str,
        snapshot_id: &str,
        tree_pack_id: [u8; 32],
    ) {
        let record = SnapshotRecord {
            luna_id: id.luna_id().into(),
            protection_id: "p1".into(),
            snapshot_id: snapshot_id.into(),
            created_at: NOW,
            key_version: 1,
            tree_pack_id,
            tree_hash: [0; 32],
            meta: vec![1, 2, 3],
        };
        let signed = record
            .sign_with(id.signer(), PRIVATE_SNAPSHOT_DOMAIN)
            .to_bytes();
        store
            .put_record(
                PSNAPSHOTS_KIND,
                &private::psnapshot_name(scope, snapshot_id),
                &signed,
            )
            .unwrap();
    }

    fn names(out: &Value) -> Vec<String> {
        out["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn hex(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn status_needed_only_when_a_scope_is_missing_locally() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        set_keys(&f, &f.member_id, &me.seal_public);
        let store = MemoryStore::new();
        let scope = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4)).unwrap();

        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], true);
        assert_eq!(out["scopes"], 1);

        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_private_scope(&conn, &scope).unwrap();
        }
        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], false);
        assert_eq!(out["scopes"], 1);

        // Without Connect, nothing is needed.
        let out = status_with(&f.state.db, &f.member_id, None).unwrap();
        assert_eq!(out["needed"], false);

        // A user with no recovery phrase on this Luna never needs a restore.
        let out = status_with(&f.state.db, &f.admin_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], false);
    }

    #[test]
    fn records_only_show_the_callers_scopes() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        let other = crypto::derive(&[8; 16], id.luna_id());
        let store = MemoryStore::new();
        let mine = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        let theirs = scope_for(&f.admin_id, &other.seal_public, DEDUP_B);
        private::publish_scope(&store, id.signer(), id.luna_id(), &mine, &auth_public(4)).unwrap();
        private::publish_scope(&store, id.signer(), id.luna_id(), &theirs, &auth_public(5))
            .unwrap();
        put_private_snapshot(&store, &id, &mine.scope, "snap-1", [5; 32]);
        put_private_snapshot(&store, &id, &theirs.scope, "snap-2", [6; 32]);
        let luna_public = id.public();

        let out = records_with_store(&store, &luna_public, &me.seal_public, PSCOPES_KIND).unwrap();
        assert_eq!(names(&out), vec![mine.scope.clone()]);

        let out =
            records_with_store(&store, &luna_public, &me.seal_public, PSNAPSHOTS_KIND).unwrap();
        assert_eq!(names(&out), vec![format!("{}.snap-1", mine.scope)]);

        let refused =
            records_with_store(&store, &luna_public, &me.seal_public, "self").unwrap_err();
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn pack_route_serves_only_tree_packs() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        let other = crypto::derive(&[8; 16], id.luna_id());
        let store = MemoryStore::new();
        let mine = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        let theirs = scope_for(&f.admin_id, &other.seal_public, DEDUP_B);
        private::publish_scope(&store, id.signer(), id.luna_id(), &mine, &auth_public(4)).unwrap();
        private::publish_scope(&store, id.signer(), id.luna_id(), &theirs, &auth_public(5))
            .unwrap();
        // Pack ids are the hash of their bytes, so the test names each pack by its own hash.
        let (mine_pack, theirs_pack, stray_pack) = (
            crypto::pack_id(b"mine"),
            crypto::pack_id(b"theirs"),
            crypto::pack_id(b"stray"),
        );
        put_private_snapshot(&store, &id, &mine.scope, "snap-1", mine_pack);
        put_private_snapshot(&store, &id, &theirs.scope, "snap-2", theirs_pack);
        // A pack that no snapshot names at all.
        store
            .put_pack(&mine_pack, Some(&mine.scope), b"mine")
            .unwrap();
        store
            .put_pack(&theirs_pack, Some(&theirs.scope), b"theirs")
            .unwrap();
        store
            .put_pack(&stray_pack, Some(&mine.scope), b"stray")
            .unwrap();
        let luna_public = id.public();
        let caller = me.seal_public;

        let bytes = pack_with_store(&store, &luna_public, &caller, &hex(&mine_pack)).unwrap();
        assert_eq!(bytes, b"mine");
        // Upper-case ids name the same pack.
        let bytes = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &hex(&mine_pack).to_uppercase(),
        )
        .unwrap();
        assert_eq!(bytes, b"mine");

        let refused =
            pack_with_store(&store, &luna_public, &caller, &hex(&theirs_pack)).unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
        let refused =
            pack_with_store(&store, &luna_public, &caller, &hex(&stray_pack)).unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
        let refused = pack_with_store(&store, &luna_public, &caller, "not-hex").unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn routes_refuse_without_a_phrase_and_status_is_quiet_without_connect() {
        let f = fixture();
        let (status, out) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/restore-private",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(out["needed"], false);

        let (status, _) = send(
            &f.router,
            "GET",
            "/api/v1/cloud/restore-private/records/pscopes",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let bogus = "/api/v1/cloud/restore-private/records/self";
        let (status, _) = send(&f.router, "GET", bogus, &f.member_token, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let pack_uri = format!("/api/v1/cloud/restore-private/packs/{}", hex(&[5; 32]));
        let (status, _) = send(&f.router, "GET", &pack_uri, &f.member_token, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let body = json!({
            "scope": "00000000000000000000000000000000",
            "dedup_key": STANDARD.encode([3u8; 32]),
            "snapshots": [{
                "snapshot_id": "snap-1",
                "protection_id": "p1",
                "record": STANDARD.encode(b"record"),
                "meta": { "name": "Photos", "source_drive": "drive-a", "source_path": "/Photos" },
                "tree": { "entries": [] },
            }],
        });
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/restore-private",
            &f.member_token,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_malformed_restore_body_is_refused_before_anything_else() {
        let f = fixture();
        // The dedup key decodes to three bytes, not 32.
        let body = json!({
            "scope": "00000000000000000000000000000000",
            "dedup_key": "AAAA",
            "snapshots": [{
                "snapshot_id": "snap-1",
                "protection_id": "p1",
                "record": STANDARD.encode(b"record"),
                "meta": { "name": "Photos", "source_drive": "drive-a", "source_path": "/Photos" },
                "tree": { "entries": [] },
            }],
        });
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/restore-private",
            &f.member_token,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // A scope id that is not 32 hex characters is refused too.
        let body = json!({
            "scope": "../../etc",
            "dedup_key": STANDARD.encode([3u8; 32]),
            "snapshots": [],
        });
        let (status, _) = send(
            &f.router,
            "POST",
            "/api/v1/cloud/restore-private",
            &f.member_token,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
