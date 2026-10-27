//! Private items: restoring private backups from the cloud after the local database is lost.
//!
//! The browser does the work that needs the recovery phrase. It reads the sealed private records
//! through these routes, opens them, and POSTs the plain dedup key and snapshot trees back. Luna
//! checks each record against its own signing key before it writes anything. Luna only serves
//! sealed records and tree packs that belong to the signed-in user's own private scopes.

use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use crate::AppState;
use crate::api::cloud_backups::connect_store;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::backup::cloud::crypto::{SEAL_PUBLIC_LEN, SealPublic, SigPublic};
use crate::backup::cloud::format::Tree;
use crate::backup::cloud::identity;
use crate::backup::cloud::private::{PSCOPES_KIND, PSNAPSHOTS_KIND, ScopeRecord, SignedScope};
use crate::backup::cloud::private_recover::{
    CallerSnapshotStatusError, PlainMeta, PrivateSnapshotIn, RestorePageRequest,
    caller_has_missing_snapshot, caller_has_tree_pack, caller_scopes_page, write_private_index,
};
use crate::backup::cloud::store::{
    CloudStore, MAX_PACK_BYTES, MAX_RECORD_BYTES, RESTORE_RECORD_PAGE_SIZE, RecordPage,
};
use crate::db;

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;
/// The signed-in user's sealing public key and this Luna's signing public key.
type CallerKeys = (SealPublic, SigPublic);

/// Each private restore request carries one tree so the daemon never buffers a scope's full index.
const MAX_SNAPSHOTS: usize = 1;
const PRIVATE_RESTORE_PAGE_SIZE: usize = RESTORE_RECORD_PAGE_SIZE;
/// One decrypted tree can be almost as large as its 64 MiB cloud pack. Leave room for the encoded
/// signed record, decrypted metadata, and JSON envelope while still bounding each request.
const MAX_PRIVATE_RESTORE_BODY_BYTES: usize = MAX_PACK_BYTES + 4 * MAX_RECORD_BYTES;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/cloud/restore-private",
            get(status)
                .post(restore)
                .layer(DefaultBodyLimit::max(MAX_PRIVATE_RESTORE_BODY_BYTES)),
        )
        .route("/api/v1/cloud/restore-private/records/{kind}", get(records))
        .route(
            "/api/v1/cloud/restore-private/records/{kind}/names",
            get(record_names),
        )
        .route(
            "/api/v1/cloud/restore-private/records/{kind}/{name}",
            get(record),
        )
        .route(
            "/api/v1/cloud/restore-private/packs/{scope}/{snapshot_id}/{id}",
            get(pack),
        )
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

impl Zeroize for SnapshotIn {
    fn zeroize(&mut self) {
        self.snapshot_id.zeroize();
        self.protection_id.zeroize();
        self.record.zeroize();
        self.meta.zeroize();
        self.tree.zeroize();
    }
}

#[derive(Deserialize)]
struct MetaIn {
    name: String,
    source_drive: String,
    source_path: String,
}

impl Zeroize for MetaIn {
    fn zeroize(&mut self) {
        self.name.zeroize();
        self.source_drive.zeroize();
        self.source_path.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordNamesQuery {
    scope: String,
    limit: usize,
    after: Option<String>,
    version: Option<u64>,
    total: Option<u64>,
}

#[derive(Deserialize)]
struct ScopeRecordsQuery {
    limit: usize,
    after: Option<String>,
    version: Option<u64>,
    total: Option<u64>,
    #[serde(default)]
    processed: u64,
}

/// A restore body that has been checked and decoded.
struct Parsed {
    scope: String,
    dedup: Zeroizing<[u8; 32]>,
    snapshots: Zeroizing<Vec<PrivateSnapshotIn>>,
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
fn decode_key(s: &str) -> Result<Zeroizing<[u8; 32]>, ApiError> {
    let bytes = Zeroizing::new(STANDARD.decode(s).map_err(|_| unreadable())?);
    let key = <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| unreadable())?;
    Ok(Zeroizing::new(key))
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
    let mut needed = false;
    let mut scope_count = 0usize;
    let mut scope_after = None;
    let mut scope_version = None;
    let mut scope_total = None;
    let mut processed = 0u64;
    loop {
        let page = caller_scopes_page(
            store,
            &luna_public,
            &caller,
            RestorePageRequest {
                after: scope_after.as_deref(),
                limit: PRIVATE_RESTORE_PAGE_SIZE,
                version: scope_version,
                expected_total: scope_total,
                processed,
            },
        )
        .map_err(unreachable_connect)?;
        scope_version = Some(page.page.version);
        scope_total = Some(page.page.total);
        processed = processed.saturating_add(page.page.names.len() as u64);
        for scope in &page.scopes {
            scope_count += 1;
            if needed {
                continue;
            }
            match caller_has_missing_snapshot(
                store,
                &luna_public,
                std::slice::from_ref(scope),
                |scope, id| {
                    let conn = db.lock().unwrap_or_else(|p| p.into_inner());
                    db::has_private_snapshot(&conn, scope, id)
                },
            ) {
                Ok(missing) => needed |= missing,
                Err(CallerSnapshotStatusError::Connect(err)) => {
                    return Err(unreachable_connect(err));
                }
                Err(CallerSnapshotStatusError::Local(err)) => return Err(read_failed(err)),
            }
        }
        match page.page.next_after {
            Some(next) => scope_after = Some(next),
            None => break,
        }
    }
    out["needed"] = json!(needed);
    out["scopes"] = json!(scope_count);
    Ok(out)
}

async fn records(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(kind): Path<String>,
    Query(query): Query<ScopeRecordsQuery>,
) -> ApiResult {
    valid_private_kind(&kind)?;
    if kind != PSCOPES_KIND {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Private snapshot records are fetched one at a time.",
        ));
    }
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        scope_records_page_with_store(
            &store,
            &luna_public,
            &caller,
            &kind,
            RestorePageRequest {
                after: query.after.as_deref(),
                limit: query.limit,
                version: query.version,
                expected_total: query.total,
                processed: query.processed,
            },
        )
    })
    .await;
    finish(answer)
}

fn scope_records_page_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    kind: &str,
    request: RestorePageRequest<'_>,
) -> Result<Value, ApiError> {
    valid_private_kind(kind)?;
    if kind != PSCOPES_KIND
        || request.limit == 0
        || request.limit > PRIVATE_RESTORE_PAGE_SIZE
        || request.version.is_some() != request.expected_total.is_some()
        || (request.after.is_some() && request.version.is_none())
        || (request.after.is_none() && request.processed != 0)
        || (request.after.is_some() && request.processed == 0)
        || request
            .expected_total
            .is_some_and(|expected| request.processed > expected)
        || request.after.is_some_and(|cursor| {
            cursor.len() > 128
                || !cursor.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_')
                })
        })
    {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That private backup listing page is not valid. Try again.",
        ));
    }
    let page =
        caller_scopes_page(store, luna_public, caller, request).map_err(unreachable_connect)?;
    let records: Vec<Value> = page
        .records
        .into_iter()
        .map(|(name, bytes)| json!({ "name": name, "data": STANDARD.encode(bytes) }))
        .collect();
    Ok(json!({
        "records": records,
        "scanned": page.page.names.len(),
        "total": page.page.total,
        "next_after": page.page.next_after,
        "version": page.page.version,
    }))
}

async fn record_names(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(kind): Path<String>,
    Query(query): Query<RecordNamesQuery>,
) -> ApiResult {
    valid_private_kind(&kind)?;
    if kind != PSNAPSHOTS_KIND
        || query.scope.is_empty()
        || query.scope.len() > 64
        || !query
            .scope
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || query.limit == 0
        || query.limit > PRIVATE_RESTORE_PAGE_SIZE
        || query.version.is_some() != query.total.is_some()
        || (query.after.is_some() && query.version.is_none())
        || query.after.as_ref().is_some_and(|after| {
            after.len() > 128
                || !after.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_')
                })
                || !after.starts_with(&format!("{}.", query.scope))
        })
    {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That private backup listing page is not valid. Try again.",
        ));
    }
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        record_names_with_store(
            &store,
            &luna_public,
            &caller,
            &kind,
            &query.scope,
            RestorePageRequest {
                after: query.after.as_deref(),
                limit: query.limit,
                version: query.version,
                expected_total: query.total,
                processed: 0,
            },
        )
    })
    .await;
    finish(answer)
}

async fn record(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((kind, name)): Path<(String, String)>,
) -> ApiResult {
    valid_private_kind(&kind)?;
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Value, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        record_with_store(&store, &luna_public, &caller, &kind, &name)
    })
    .await;
    finish(answer)
}

/// Lists only the names of records the caller may restore. Snapshot bytes are fetched separately.
fn record_names_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    kind: &str,
    scope: &str,
    request: RestorePageRequest<'_>,
) -> Result<Value, ApiError> {
    valid_private_kind(kind)?;
    if kind != PSNAPSHOTS_KIND
        || request.limit == 0
        || request.limit > PRIVATE_RESTORE_PAGE_SIZE
        || request.version.is_some() != request.expected_total.is_some()
        || (request.after.is_some() && request.version.is_none())
        || request
            .after
            .is_some_and(|cursor| !cursor.starts_with(&format!("{scope}.")))
    {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "That private backup listing page is not valid. Try again.",
        ));
    }
    if verified_scope_for_caller(store, luna_public, caller, scope)?.is_none() {
        return Err(record_missing());
    }
    let prefix = format!("{scope}.");
    let page = store
        .list_record_page_prefix_versioned(
            kind,
            &prefix,
            request.after,
            request.limit,
            request.version,
            request.expected_total,
        )
        .map_err(unreachable_connect)?;
    validate_private_names_page(&page, &prefix, request.after, request.limit)?;
    Ok(
        json!({ "names": page.names, "total": page.total, "next_after": page.next_after, "version": page.version }),
    )
}

fn validate_private_names_page(
    page: &RecordPage,
    prefix: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<(), ApiError> {
    let mut previous = after.unwrap_or(prefix);
    for name in &page.names {
        if !name.starts_with(prefix) || name.as_str() <= previous {
            return Err(unreachable_connect(
                "Connect returned an invalid private backup page",
            ));
        }
        previous = name;
    }
    if page.names.len() > limit
        || page.total < page.names.len() as u64
        || (page.names.is_empty() && page.next_after.is_some())
        || (page.next_after.is_some() && page.names.len() != limit)
        || page.next_after.as_deref().is_some_and(|cursor| {
            !cursor.starts_with(prefix) || page.names.last().map(String::as_str) != Some(cursor)
        })
    {
        return Err(unreachable_connect(
            "Connect returned an incomplete private backup page",
        ));
    }
    Ok(())
}

/// Returns one record only when its name belongs to one of the caller's verified scopes.
fn record_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    kind: &str,
    name: &str,
) -> Result<Value, ApiError> {
    valid_private_kind(kind)?;
    let scope_name = if kind == PSCOPES_KIND {
        name
    } else {
        let Some((scope, _)) = name.split_once('.') else {
            return Err(record_missing());
        };
        scope
    };
    let Some((_, scope_bytes)) = verified_scope_for_caller(store, luna_public, caller, scope_name)?
    else {
        return Err(record_missing());
    };
    if kind == PSCOPES_KIND {
        return Ok(json!({ "name": name, "data": STANDARD.encode(scope_bytes) }));
    }
    let bytes = store
        .get_record(kind, name)
        .map_err(unreachable_connect)?
        .ok_or_else(record_missing)?;
    Ok(json!({ "name": name, "data": STANDARD.encode(bytes) }))
}

fn verified_scope_for_caller(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    scope_name: &str,
) -> Result<Option<(ScopeRecord, Vec<u8>)>, ApiError> {
    let Some(bytes) = store
        .get_record(PSCOPES_KIND, scope_name)
        .map_err(unreachable_connect)?
    else {
        return Ok(None);
    };
    let Ok(record) = SignedScope::from_bytes(&bytes).and_then(|signed| signed.verify(luna_public))
    else {
        return Ok(None);
    };
    if record.scope != scope_name || &record.seal_public != caller {
        return Ok(None);
    }
    Ok(Some((record, bytes)))
}

fn record_missing() -> ApiError {
    json_error(
        StatusCode::NOT_FOUND,
        "That private backup could not be found.",
    )
}

/// Lists the caller's sealed scope records. Snapshot records are fetched one at a time.
async fn pack(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((scope, snapshot_id, id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let db = state.db.clone();
    let connect = state.connect.clone();
    let user_id = user.id.clone();
    let answer = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, ApiError> {
        let (caller, luna_public) = load_caller(&db, &user_id)?.ok_or_else(no_phrase)?;
        let store = connect_store(&connect, &db).ok_or_else(not_set_up)?;
        pack_with_store(&store, &luna_public, &caller, &scope, &snapshot_id, &id)
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

/// Serves one tree pack after directly verifying its signed scope and snapshot records.
fn pack_with_store(
    store: &dyn CloudStore,
    luna_public: &SigPublic,
    caller: &SealPublic,
    scope: &str,
    snapshot_id: &str,
    id: &str,
) -> Result<Vec<u8>, ApiError> {
    let id_bytes = parse_pack_id(id).ok_or_else(pack_missing)?;
    if !caller_has_tree_pack(store, luna_public, caller, scope, snapshot_id, &id_bytes)
        .map_err(unreachable_connect)?
    {
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
    let dedup_key = Zeroizing::new(dedup_key);
    let mut snapshots = Zeroizing::new(snapshots);
    if !valid_scope(&scope) || snapshots.is_empty() || snapshots.len() > MAX_SNAPSHOTS {
        return Err(unreadable());
    }
    let dedup = decode_key(&dedup_key)?;
    let mut parsed_snapshots = Zeroizing::new(Vec::with_capacity(snapshots.len()));
    for snapshot in snapshots.iter_mut() {
        let record = STANDARD
            .decode(&snapshot.record)
            .map_err(|_| unreadable())?;
        parsed_snapshots.push(PrivateSnapshotIn {
            snapshot_id: std::mem::take(&mut snapshot.snapshot_id),
            protection_id: std::mem::take(&mut snapshot.protection_id),
            record,
            meta: PlainMeta {
                name: std::mem::take(&mut snapshot.meta.name),
                source_drive: std::mem::take(&mut snapshot.meta.source_drive),
                source_path: std::mem::take(&mut snapshot.meta.source_path),
            },
            tree: std::mem::replace(&mut snapshot.tree, Tree { entries: vec![] }),
        });
    }
    Ok(Parsed {
        scope,
        dedup,
        snapshots: parsed_snapshots,
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
        &snapshots,
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    use super::{SealPublic, SigPublic};

    use super::{
        RestorePageRequest, pack_with_store, record_names_with_store, record_with_store,
        scope_records_page_with_store, status_with,
    };
    use crate::backup::cloud::crypto;
    use crate::backup::cloud::format::SnapshotRecord;
    use crate::backup::cloud::identity::{self, Identity};
    use crate::backup::cloud::private::{
        self, PRIVATE_SNAPSHOT_DOMAIN, PSCOPES_KIND, PSNAPSHOTS_KIND,
    };
    use crate::backup::cloud::store::{CloudStore, MemoryStore, RecordPage, StoreError, Usage};
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

    struct FailingListStore<'a> {
        inner: &'a MemoryStore,
        failing_kind: &'a str,
    }

    struct CountPrefixPages<'a> {
        inner: &'a MemoryStore,
        calls: AtomicUsize,
        get_calls: AtomicUsize,
        count_kind: &'static str,
    }

    impl CloudStore for CountPrefixPages<'_> {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }

        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }

        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }

        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            self.inner.put_record(kind, name, bytes)
        }

        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.get_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.get_record(kind, name)
        }

        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }

        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list_records(kind)
        }

        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<RecordPage, StoreError> {
            if kind == self.count_kind {
                self.calls.fetch_add(1, Ordering::SeqCst);
            }
            self.inner.list_record_page(kind, after, limit)
        }

        fn list_record_page_prefix_versioned(
            &self,
            kind: &str,
            prefix: &str,
            after: Option<&str>,
            limit: usize,
            version: Option<u64>,
            expected_total: Option<u64>,
        ) -> Result<RecordPage, StoreError> {
            if kind == self.count_kind {
                self.calls.fetch_add(1, Ordering::SeqCst);
            }
            self.inner.list_record_page_prefix_versioned(
                kind,
                prefix,
                after,
                limit,
                version,
                expected_total,
            )
        }

        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
    }

    impl CloudStore for FailingListStore<'_> {
        fn put_pack(
            &self,
            id: &[u8; 32],
            scope: Option<&str>,
            bytes: &[u8],
        ) -> Result<(), StoreError> {
            self.inner.put_pack(id, scope, bytes)
        }

        fn get_pack(&self, id: &[u8; 32]) -> Result<Vec<u8>, StoreError> {
            self.inner.get_pack(id)
        }

        fn delete_pack(&self, id: &[u8; 32]) -> Result<(), StoreError> {
            self.inner.delete_pack(id)
        }

        fn put_record(&self, kind: &str, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
            self.inner.put_record(kind, name, bytes)
        }

        fn get_record(&self, kind: &str, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.inner.get_record(kind, name)
        }

        fn delete_record(&self, kind: &str, name: &str) -> Result<(), StoreError> {
            self.inner.delete_record(kind, name)
        }

        fn list_records(&self, kind: &str) -> Result<Vec<String>, StoreError> {
            if kind == self.failing_kind {
                Err(StoreError::Unavailable("fixture outage".into()))
            } else {
                self.inner.list_records(kind)
            }
        }

        fn list_record_page(
            &self,
            kind: &str,
            after: Option<&str>,
            limit: usize,
        ) -> Result<RecordPage, StoreError> {
            if kind == self.failing_kind {
                Err(StoreError::Unavailable("fixture outage".into()))
            } else {
                self.inner.list_record_page(kind, after, limit)
            }
        }

        fn usage(&self) -> Result<Usage, StoreError> {
            self.inner.usage()
        }
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
    fn status_needs_restore_only_for_missing_snapshots() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        set_keys(&f, &f.member_id, &me.seal_public);
        let store = MemoryStore::new();
        let scope = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4)).unwrap();

        // An empty scope has no snapshot metadata to restore and the UI must not offer a
        // restore that cannot write anything.
        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], false);
        assert_eq!(out["scopes"], 1);

        put_private_snapshot(&store, &id, &scope.scope, "snap-1", [5; 32]);
        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], true);

        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_private_scope(&conn, &scope).unwrap();
        }
        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], true);
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute(
                "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
                rusqlite::params!["snap-1", scope.scope, b"{}"],
            )
            .unwrap();
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
    fn status_stays_needed_until_every_signed_snapshot_is_indexed() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        set_keys(&f, &f.member_id, &me.seal_public);
        let store = MemoryStore::new();
        let scope = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4)).unwrap();
        put_private_snapshot(&store, &id, &scope.scope, "snap-1", [5; 32]);
        put_private_snapshot(&store, &id, &scope.scope, "snap-2", [6; 32]);
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_private_scope(&conn, &scope).unwrap();
            conn.execute(
                "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
                rusqlite::params!["snap-1", scope.scope, b"{}"],
            )
            .unwrap();
        }

        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], true);

        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            conn.execute(
                "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
                rusqlite::params!["snap-2", scope.scope, b"{}"],
            )
            .unwrap();
        }
        let out = status_with(&f.state.db, &f.member_id, Some(&store)).unwrap();
        assert_eq!(out["needed"], false);
    }

    #[test]
    fn status_checks_large_private_snapshot_inventory_in_bounded_pages() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        set_keys(&f, &f.member_id, &me.seal_public);
        let store = MemoryStore::new();
        let scope = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4)).unwrap();
        for index in 0..130 {
            put_private_snapshot(
                &store,
                &id,
                &scope.scope,
                &format!("snap-{index:03}"),
                [index as u8; 32],
            );
        }
        {
            let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
            db::insert_private_scope(&conn, &scope).unwrap();
            for index in 0..130 {
                conn.execute(
                    "INSERT INTO cloud_private_trees (snapshot_id, scope, tree) VALUES (?1, ?2, ?3)",
                    rusqlite::params![format!("snap-{index:03}"), scope.scope, b"{}"],
                )
                .unwrap();
            }
        }

        let counted = CountPrefixPages {
            inner: &store,
            calls: AtomicUsize::new(0),
            get_calls: AtomicUsize::new(0),
            count_kind: PSNAPSHOTS_KIND,
        };
        let out = status_with(&f.state.db, &f.member_id, Some(&counted)).unwrap();
        assert_eq!(out["needed"], false);
        // 130 records at a 64-name page size require two full pages and one final page.
        assert_eq!(counted.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn status_scans_private_scope_inventory_in_bounded_pages() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        set_keys(&f, &f.member_id, &me.seal_public);
        let store = MemoryStore::new();
        for index in 0..130 {
            let scope = scope_for(&f.member_id, &me.seal_public, [index as u8; 32]);
            private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4))
                .unwrap();
        }

        let counted = CountPrefixPages {
            inner: &store,
            calls: AtomicUsize::new(0),
            get_calls: AtomicUsize::new(0),
            count_kind: PSCOPES_KIND,
        };
        let out = status_with(&f.state.db, &f.member_id, Some(&counted)).unwrap();
        assert_eq!(out["needed"], true);
        assert_eq!(out["scopes"], 130);
        // 130 scopes at a 64-name page size require two full pages and one final page.
        assert_eq!(counted.calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn status_reports_connect_record_list_failures_instead_of_saying_nothing_is_needed() {
        for failing_kind in [PSCOPES_KIND, PSNAPSHOTS_KIND] {
            let f = fixture();
            let id = load_identity(&f);
            let me = crypto::derive(&[7; 16], id.luna_id());
            set_keys(&f, &f.member_id, &me.seal_public);
            let store = MemoryStore::new();
            let scope = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
            private::publish_scope(&store, id.signer(), id.luna_id(), &scope, &auth_public(4))
                .unwrap();
            if failing_kind == PSNAPSHOTS_KIND {
                let conn = f.state.db.lock().unwrap_or_else(|p| p.into_inner());
                db::insert_private_scope(&conn, &scope).unwrap();
            }

            let failing = FailingListStore {
                inner: &store,
                failing_kind,
            };
            let error = status_with(&f.state.db, &f.member_id, Some(&failing)).unwrap_err();

            assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        }
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
        put_private_snapshot(&store, &id, &mine.scope, "snap-3", [7; 32]);
        put_private_snapshot(&store, &id, &theirs.scope, "snap-2", [6; 32]);
        let luna_public = id.public();

        let out = scope_records_page_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSCOPES_KIND,
            RestorePageRequest {
                after: None,
                limit: 64,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec![mine.scope.clone()]);
        assert_eq!(out["scanned"], 2);
        assert_eq!(out["total"], 2);
        assert!(out["next_after"].is_null());

        let refused = scope_records_page_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            RestorePageRequest {
                after: None,
                limit: 64,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);

        let first = record_names_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &mine.scope,
            RestorePageRequest {
                after: None,
                limit: 1,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap();
        assert_eq!(first["names"], json!([format!("{}.snap-1", mine.scope)]));
        assert_eq!(first["total"], 2);
        let cursor = first["next_after"].as_str().unwrap();
        let last = record_names_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &mine.scope,
            RestorePageRequest {
                after: Some(cursor),
                limit: 1,
                version: first["version"].as_u64(),
                expected_total: first["total"].as_u64(),
                processed: 0,
            },
        )
        .unwrap();
        assert_eq!(last["names"], json!([format!("{}.snap-3", mine.scope)]));
        assert!(last["next_after"].is_null());
        store
            .delete_record(PSNAPSHOTS_KIND, &format!("{}.snap-3", mine.scope))
            .unwrap();
        put_private_snapshot(&store, &id, &mine.scope, "snap-4", [8; 32]);
        let stale = record_names_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &mine.scope,
            RestorePageRequest {
                after: Some(cursor),
                limit: 1,
                version: first["version"].as_u64(),
                expected_total: first["total"].as_u64(),
                processed: 0,
            },
        )
        .unwrap_err();
        assert_eq!(stale.0, StatusCode::BAD_GATEWAY);
        let foreign = record_names_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &theirs.scope,
            RestorePageRequest {
                after: None,
                limit: 1,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap_err();
        assert_eq!(foreign.0, StatusCode::NOT_FOUND);
        let invalid_cursor = record_names_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &mine.scope,
            RestorePageRequest {
                after: Some(&format!("{}.snap-x", theirs.scope)),
                limit: 1,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap_err();
        assert_eq!(invalid_cursor.0, StatusCode::BAD_REQUEST);

        let one = record_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &format!("{}.snap-1", mine.scope),
        )
        .unwrap();
        assert_eq!(one["name"], format!("{}.snap-1", mine.scope));
        assert!(one["data"].as_str().is_some());
        let refused = record_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            PSNAPSHOTS_KIND,
            &format!("{}.snap-2", theirs.scope),
        )
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);

        let refused = scope_records_page_with_store(
            &store,
            &luna_public,
            &me.seal_public,
            "self",
            RestorePageRequest {
                after: None,
                limit: 64,
                version: None,
                expected_total: None,
                processed: 0,
            },
        )
        .unwrap_err();
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
        let mine_snapshot = "00000000000000000000000000000001";
        let theirs_snapshot = "00000000000000000000000000000002";
        put_private_snapshot(&store, &id, &mine.scope, mine_snapshot, mine_pack);
        put_private_snapshot(&store, &id, &theirs.scope, theirs_snapshot, theirs_pack);
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

        let bytes = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &mine.scope,
            mine_snapshot,
            &hex(&mine_pack),
        )
        .unwrap();
        assert_eq!(bytes, b"mine");
        // Upper-case ids name the same pack.
        let bytes = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &mine.scope,
            mine_snapshot,
            &hex(&mine_pack).to_uppercase(),
        )
        .unwrap();
        assert_eq!(bytes, b"mine");

        let refused = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &theirs.scope,
            theirs_snapshot,
            &hex(&theirs_pack),
        )
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
        let refused = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &mine.scope,
            mine_snapshot,
            &hex(&stray_pack),
        )
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
        let refused = pack_with_store(
            &store,
            &luna_public,
            &caller,
            &mine.scope,
            mine_snapshot,
            "not-hex",
        )
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn pack_authorization_uses_two_exact_record_lookups_for_large_inventories() {
        let f = fixture();
        let id = load_identity(&f);
        let me = crypto::derive(&[7; 16], id.luna_id());
        let store = MemoryStore::new();
        let mine = scope_for(&f.member_id, &me.seal_public, DEDUP_A);
        private::publish_scope(&store, id.signer(), id.luna_id(), &mine, &auth_public(4)).unwrap();

        let mut target = None;
        let target_snapshot = "00000000000000000000000000000000";
        for index in 0..130 {
            let bytes = format!("pack-{index}");
            let pack_id = crypto::pack_id(bytes.as_bytes());
            put_private_snapshot(&store, &id, &mine.scope, &format!("{index:032x}"), pack_id);
            if index == 0 {
                store
                    .put_pack(&pack_id, Some(&mine.scope), bytes.as_bytes())
                    .unwrap();
                target = Some(pack_id);
            }
        }

        let counted = CountPrefixPages {
            inner: &store,
            calls: AtomicUsize::new(0),
            get_calls: AtomicUsize::new(0),
            count_kind: PSNAPSHOTS_KIND,
        };
        let bytes = pack_with_store(
            &counted,
            &id.public(),
            &me.seal_public,
            &mine.scope,
            target_snapshot,
            &hex(&target.unwrap()),
        )
        .unwrap();
        assert_eq!(bytes, b"pack-0");
        assert_eq!(counted.calls.load(Ordering::SeqCst), 0);
        assert_eq!(counted.get_calls.load(Ordering::SeqCst), 2);
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
            "/api/v1/cloud/restore-private/records/pscopes?limit=64&processed=0",
            &f.member_token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let bogus = "/api/v1/cloud/restore-private/records/self";
        let (status, _) = send(&f.router, "GET", bogus, &f.member_token, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let pack_uri = format!(
            "/api/v1/cloud/restore-private/packs/{}/{}/{}",
            "00000000000000000000000000000000",
            "00000000000000000000000000000001",
            hex(&[5; 32]),
        );
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

        let body = json!({
            "scope": "00000000000000000000000000000000",
            "dedup_key": STANDARD.encode([3u8; 32]),
            "snapshots": [
                {
                    "snapshot_id": "snap-1",
                    "protection_id": "p1",
                    "record": STANDARD.encode(b"record"),
                    "meta": { "name": "Photos", "source_drive": "drive-a", "source_path": "/Photos" },
                    "tree": { "entries": [] },
                },
                {
                    "snapshot_id": "snap-2",
                    "protection_id": "p2",
                    "record": STANDARD.encode(b"record"),
                    "meta": { "name": "Photos", "source_drive": "drive-a", "source_path": "/Photos" },
                    "tree": { "entries": [] },
                },
            ],
        });
        let body = serde_json::from_value(body).unwrap();
        assert!(super::parse_body(body).is_err());

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

    #[tokio::test]
    async fn private_restore_accepts_one_tree_near_the_cloud_pack_limit() {
        let f = fixture();
        let body = json!({
            "scope": "00000000000000000000000000000000",
            "dedup_key": STANDARD.encode([3u8; 32]),
            "snapshots": [{
                "snapshot_id": "snap-1",
                "protection_id": "p1",
                "record": STANDARD.encode(b"record"),
                "meta": { "name": "Photos", "source_drive": "drive-a", "source_path": "/Photos" },
                "tree": { "entries": [{
                    "path": "a".repeat(33 * 1024 * 1024),
                    "size": 1,
                    "mtime": 1,
                    "chunks": [],
                }] },
            }],
        });
        let serialized = body.to_string();
        assert!(serialized.len() > 32 * 1024 * 1024);
        assert!(serialized.len() < super::MAX_PRIVATE_RESTORE_BODY_BYTES);
        let response = f
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/cloud/restore-private")
                    .header("Authorization", format!("Bearer {}", f.member_token))
                    .header("content-type", "application/json")
                    .body(Body::from(serialized))
                    .unwrap(),
            )
            .await
            .unwrap();
        // This fixture user has no recovery phrase, so a request accepted by the
        // larger bounded extractor reaches the ordinary authorization error.
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
