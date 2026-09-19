//! EuroOffice docstorage sessions — the "thin relay" half of client-side
//! office editing.
//!
//! Lunad never parses document content. Each document key gets a session that
//! tracks participants, an ordered op log (for late-joiner catch-up), the
//! strict-mode block-lock table, and the single-saver election. Message shapes
//! mirror ONLYOFFICE Document Server's `DocsCoServer`/`canvasservice` so the
//! stock EuroOffice pack works unmodified.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{Mutex, broadcast};

/// Soft caps — a misbehaving client must not grow lunad without bound.
pub const MAX_DOC_SESSIONS: usize = 32;
pub const MAX_PARTICIPANTS_PER_DOC: usize = 32;
/// DS default `maxChangesSize` is 150 MiB — far too generous for a Luna box.
/// Past this we ask clients to save+reopen instead of growing the log.
pub const MAX_OP_LOG_BYTES: usize = 8 * 1024 * 1024;
pub const IDLE_EMPTY_SECS: u64 = 300;
/// DS `services.CoAuthoring.expire.saveLock` default.
const SAVE_LOCK_TTL: Duration = Duration::from_secs(60);
/// Backstop for the Luna save election — longer than the frontend's save
/// timeout so a legitimately slow serialize can't lose the election mid-save.
/// Normal release is `lunaSaveEnd`/`bundle_refreshed`/disconnect; this only
/// covers a saver that vanished without any of those.
const SAVE_ELECTION_TTL: Duration = Duration::from_secs(300);

static SOCK_SEQ: AtomicU64 = AtomicU64::new(1);

/// A change record as relayed to clients: `{docid, change, time, user,
/// useridoriginal}`. `change` is the raw op payload (JSON string when
/// `binaryChanges` is off, which is what we advertise).
#[derive(Clone, Debug)]
pub struct OpRecord {
    pub idx: i64,
    pub change: String,
    pub time: i64,
    pub user: String,
    pub useridoriginal: String,
}

#[derive(Clone, Debug)]
pub struct Participant {
    /// `idOriginal + indexUser` — matches DS `curUserId`.
    pub id: String,
    pub id_original: String,
    pub username: String,
    pub index_user: i64,
    pub view: bool,
    /// Office token's write bit — view-only sessions can't push ops or locks.
    pub write: bool,
    /// Last changeIndex we broadcast to this participant — used to mark which
    /// ops are already inside a refreshed `Editor.bin`.
    pub delivered_index: i64,
}

#[derive(Clone, Debug)]
pub struct BlockLock {
    pub time: i64,
    pub user: String,
    pub block: Value,
}

/// Binding between a DocsAPI document key and the file it opened from.
/// Registered by the session endpoint so a doc key cannot be claimed for a
/// path the caller cannot read.
#[derive(Clone, Debug)]
pub struct DocBinding {
    pub drive_id: String,
    pub path: String,
    pub registered_at: Instant,
}

pub struct DocSession {
    pub binding: DocBinding,
    pub participants: HashMap<u64, Participant>,
    pub ops: Vec<OpRecord>,
    /// Ops with idx <= base_index are already inside the current bundle's
    /// `Editor.bin`; joiners replay only ops above it.
    pub base_index: i64,
    pub change_index: i64,
    pub op_bytes: usize,
    pub locks: HashMap<String, BlockLock>,
    /// (sock, since) — DS's `lockSave` mutex, held only across a saveChanges
    /// transaction (or the sdk's own isSaveLock election). Expires
    /// (`cfgExpSaveLock` ≈ 60s) so a client that dies mid-save cannot starve
    /// the room forever.
    pub save_holder: Option<(u64, Instant)>,
    /// (sock, since) — Luna's own save election, held across the whole
    /// client-side serialize → x2t → upload. Deliberately separate from
    /// `save_holder`: driving `isSaveLock`/`unSaveLock` moves the client's
    /// connection state machine (its `askLock` calls buffer until the reply
    /// lands), so holding the protocol mutex for a multi-second save freezes
    /// the saver's own editor. The election only excludes concurrent
    /// serialize+uploads — op flushes keep flowing while someone saves.
    pub save_election: Option<(u64, Instant)>,
    pub next_index_user: i64,
    pub last_event: Instant,
    /// True when the session record was recreated from a CONNECT-time token
    /// (daemon restart or idle eviction dropped the in-memory room). The op
    /// log, participants, and lock table of the dead session are gone, so a
    /// client echoing a pre-loss sessionId cannot prove continuity — its
    /// restore is refused (Stale) and it reloads the saved bundle instead of
    /// silently diverging. Fresh joins (no sessionId) are unaffected.
    pub resurrected: bool,
}

impl DocSession {
    fn new(binding: DocBinding) -> Self {
        Self {
            binding,
            participants: HashMap::new(),
            ops: Vec::new(),
            base_index: 0,
            change_index: 0,
            op_bytes: 0,
            locks: HashMap::new(),
            save_holder: None,
            save_election: None,
            next_index_user: 1,
            last_event: Instant::now(),
            resurrected: false,
        }
    }

    /// Ops a joining/reconnecting client still needs: everything above the
    /// bundle base, or everything above `known_index` when the client tells us
    /// what it already applied (reconnect with a live document).
    pub fn replay_from(&self, known_index: Option<i64>) -> Vec<OpRecord> {
        let floor = known_index.unwrap_or(self.base_index).max(self.base_index);
        self.ops
            .iter()
            .filter(|op| op.idx > floor)
            .cloned()
            .collect()
    }
}

struct HubInner {
    sessions: HashMap<String, DocSession>,
}

#[derive(Clone)]
pub struct OfficeDocHub {
    inner: Arc<Mutex<HubInner>>,
    /// Broadcast bus per doc key is implicit — each socket task owns a
    /// `broadcast::Receiver` subscribed to the session's channel.
    bus: Arc<Mutex<HashMap<String, broadcast::Sender<Value>>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HubError {
    TooManySessions,
    SessionFull,
    UnknownKey,
    Forbidden,
    /// Rejoining client missed foreign ops while its socket was down —
    /// it must reload instead of silently diverging (DS restore check).
    Stale,
}

impl OfficeDocHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubInner {
                sessions: HashMap::new(),
            })),
            bus: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Session endpoint registers the key → file binding before any socket
    /// may auth against it. Re-registering is idempotent.
    pub async fn register_key(&self, key: &str, drive_id: &str, path: &str) {
        let mut hub = self.inner.lock().await;
        let binding = DocBinding {
            drive_id: drive_id.to_string(),
            path: path.to_string(),
            registered_at: Instant::now(),
        };
        match hub.sessions.get_mut(key) {
            Some(session) => session.binding = binding,
            None => {
                hub.sessions
                    .insert(key.to_string(), DocSession::new(binding));
            }
        }
    }

    /// Recreate a lost session record from a verified office token at CONNECT
    /// time. The token's claims already authorize the drive+path, so the only
    /// thing missing after a restart/eviction is the in-memory room itself.
    /// Marks the session `resurrected` so dead-era restores are refused. A
    /// live session keeps its state — resurrecting one would be wrong.
    pub async fn resurrect_key(&self, key: &str, drive_id: &str, path: &str) {
        let mut hub = self.inner.lock().await;
        if !hub.sessions.contains_key(key) {
            let mut session = DocSession::new(DocBinding {
                drive_id: drive_id.to_string(),
                path: path.to_string(),
                registered_at: Instant::now(),
            });
            session.resurrected = true;
            hub.sessions.insert(key.to_string(), session);
        }
    }

    /// Look up the file a key was registered for.
    pub async fn binding(&self, key: &str) -> Option<(String, String)> {
        let hub = self.inner.lock().await;
        hub.sessions
            .get(key)
            .map(|s| (s.binding.drive_id.clone(), s.binding.path.clone()))
    }

    /// The key of the session already live on this file — bound to it and
    /// holding at least one participant — if any.
    ///
    /// A minted key fingerprints the file's size+mtime at first open, so
    /// every save that lands on disk changes what a fresh session request
    /// computes: a later opener would get a different key and land in an
    /// empty room with its own converted bundle while the live document
    /// keeps editing elsewhere. Session create must join the live room
    /// instead — its bundle plus op log IS the document's current state.
    ///
    /// Empty sessions are never reused: with nobody connected, their op log
    /// may reach past the file's current bytes (a save followed by an
    /// external change), so a fresh versioned key is the safe start there.
    pub async fn live_key_for(&self, drive_id: &str, path: &str) -> Option<String> {
        let hub = self.inner.lock().await;
        hub.sessions.iter().find_map(|(key, session)| {
            (session.binding.drive_id == drive_id
                && session.binding.path == path
                && !session.participants.is_empty())
            .then(|| key.clone())
        })
    }

    pub async fn subscribe(&self, key: &str) -> broadcast::Receiver<Value> {
        let mut bus = self.bus.lock().await;
        bus.entry(key.to_string())
            .or_insert_with(|| broadcast::channel(512).0)
            .subscribe()
    }

    async fn publish(&self, key: &str, msg: Value) {
        let bus = self.bus.lock().await;
        if let Some(tx) = bus.get(key) {
            let _ = tx.send(msg);
        }
    }

    /// Publish to every participant except `except_sock`. Each frame carries
    /// `__to`/participants already filtered client-side by content; DS-style
    /// sessions fan out whole frames, so we tag with the sender's sock id and
    /// let the socket loop drop its own echo for lock/change frames.
    async fn publish_others(&self, key: &str, except: u64, mut msg: Value) {
        if let Value::Object(ref mut map) = msg {
            map.insert("__except".into(), json!(except));
        }
        self.publish(key, msg).await;
    }

    /// Allocate a socket id — a fresh connection gets a new sessionId.
    pub fn next_sock_id() -> u64 {
        SOCK_SEQ.fetch_add(1, Ordering::Relaxed)
    }

    /// `auth` message → auth reply + optional authChanges. Returns the
    /// participant's sock record, the frames to send back to this socket in
    /// order, and an optional broadcast to the other participants (a getLock
    /// refresh when a restore re-granted blocks the room had released).
    pub async fn auth(
        &self,
        key: &str,
        sock: u64,
        msg: &Value,
        can_write: bool,
    ) -> Result<(Participant, Vec<Value>, Option<Value>), HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();

        let user = msg.get("user").cloned().unwrap_or(Value::Null);
        let id_original = user
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("anon")
            .to_string();
        let username = user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        // Rejoin: the client echoes its previous sessionId (our sock id) and
        // indexUser. Its old socket may still be a half-open zombie — evict
        // that entry now. Otherwise two participants share the same
        // `{id}{index}` id: the zombie's eventual disconnect() would release
        // the live participant's locks by that shared id and leave it unable
        // to edit (and every connectState would list the user twice).
        // DS `bIsRestore = null != data.sessionId`: any non-null sessionId
        // claims continuity with a previous session. `_id` is null on a fresh
        // connect, so a null/absent sessionId means a plain join.
        let is_restore = msg.get("sessionId").map(|v| !v.is_null()).unwrap_or(false);
        let rejoin = msg
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s != sock);
        let rejoin_known = rejoin
            .map(|old| session.participants.contains_key(&old))
            .unwrap_or(false);
        // A resurrected session lost its op log and lock table with the dead
        // daemon — a client echoing a sessionId from that era holds a
        // document we can no longer prove current. Refuse the restore so it
        // reloads the saved bundle (4010) rather than silently diverging;
        // participants who joined *after* the loss are known and restore
        // normally.
        if session.resurrected && is_restore && !rejoin_known {
            return Err(HubError::Stale);
        }
        if let Some(old) = rejoin
            && let Some(p) = session.participants.remove(&old)
        {
            session.locks.retain(|_, l| l.user != p.id);
            if session.save_holder.map(|(s, _)| s) == Some(old) {
                session.save_holder = None;
            }
            // A save in flight survives the socket flap — move the election to
            // the replacement socket so its `lunaSaveEnd`/bundle PUT releases
            // it instead of a peer stealing it while the saver reconnects.
            if session.save_election.map(|(s, _)| s) == Some(old) {
                session.save_election = Some((sock, Instant::now()));
            }
        }
        if session.participants.len() >= MAX_PARTICIPANTS_PER_DOC
            && !session.participants.contains_key(&sock)
        {
            return Err(HubError::SessionFull);
        }
        // Reconnecting clients echo their old sessionId + indexUser — reuse the
        // index so their id stays stable across the flap.
        let claimed_index = msg
            .get("sessionId")
            .and_then(|_| user.get("indexUser"))
            .and_then(Value::as_i64)
            .filter(|i| *i > 0);
        let index_user = claimed_index.unwrap_or_else(|| {
            let idx = session.next_index_user;
            session.next_index_user += 1;
            idx
        });
        // DS: view when the client asked for view mode or its permissions say
        // edit=false — both matter for authChanges replay and UI.
        let view = msg
            .get("mode")
            .and_then(Value::as_str)
            .map(|m| m == "view")
            .unwrap_or(false)
            || msg
                .get("permissions")
                .and_then(|p| p.get("edit"))
                .and_then(Value::as_bool)
                .map(|e| !e)
                .unwrap_or(false);
        let participant = Participant {
            id: format!("{id_original}{index_user}"),
            id_original,
            username,
            index_user,
            view,
            write: can_write,
            delivered_index: session.change_index,
        };
        let mut regranted = false;
        if is_restore && !participant.view {
            // DS restore check: the rejoining client must have seen the newest
            // foreign op. The sdk never applies authChanges on a re-auth
            // (`_isAuth` skips `_updateAuthChanges`), so replaying missed ops
            // is dead traffic — if it fell behind, refuse the restore and let
            // the client reload instead of silently diverging. Its own ops in
            // flight resend via the client's reSave path, so a self-authored
            // newest op means nothing foreign was missed.
            let ok = match session.ops.last() {
                None => true,
                Some(op) if op.user == participant.id => true,
                Some(op) => msg
                    .get("lastOtherSaveTime")
                    .and_then(Value::as_i64)
                    // Same-second comparison, like DS's `((a - b)/1000)>>0 === 0`
                    // (truncating division; absent field passes, as NaN>>0 === 0).
                    .map(|t| ((t - op.time) / 1000) == 0)
                    .unwrap_or(true),
            };
            if !ok {
                return Err(HubError::Stale);
            }
            // Re-grant the locks the client reported still owning
            // (auth `block` = ownedLockBlocks), DS getLock(bIsRestore=true) —
            // addLocksNX semantics: only blocks still free are re-taken.
            if let Some(blocks) = msg.get("block").and_then(Value::as_array) {
                let now = now_ms();
                for b in blocks {
                    if let std::collections::hash_map::Entry::Vacant(e) =
                        session.locks.entry(lock_key(b))
                    {
                        e.insert(BlockLock {
                            time: now,
                            user: participant.id.clone(),
                            block: b.clone(),
                        });
                        regranted = true;
                    }
                }
            }
        }
        session.participants.insert(sock, participant.clone());

        // If the restore re-granted owned blocks, peers that saw this user's
        // disconnect `releaseLock` need the refreshed lock map back.
        let peer_frame = if regranted {
            Some(json!({ "type": "getLock", "locks": locks_json(session) }))
        } else {
            None
        };

        let mut out = Vec::new();
        // Late joiner catch-up: ops above the bundle base. DS replays the
        // whole log to a fresh join (`!bIsRestore && needSendChanges`) — the
        // client hasn't loaded a document yet, so any index it reports is
        // meaningless. On a restore the client holds a live document and the
        // sdk ignores authChanges entirely.
        if !is_restore && !participant.view {
            let replay = session.replay_from(None);
            if !replay.is_empty() {
                out.push(json!({
                    "type": "authChanges",
                    "changes": replay.iter().map(op_json).collect::<Vec<_>>(),
                }));
            }
        }
        let lock_map = locks_json(session);
        out.push(json!({
            "type": "auth",
            "result": 1,
            "sessionId": sock.to_string(),
            "sessionTimeConnect": now_ms(),
            "participants": session.participants.values().map(participant_json).collect::<Vec<_>>(),
            "locks": lock_map,
            "indexUser": index_user,
            "licenseType": 3,
            // The app compares this to its own About version and shows a
            // "server version changed" warning + disables editing on a
            // mismatch — keep it in sync with the shipped pack.
            "buildVersion": "9.3.4",
            "buildNumber": 1,
            "g_cAscSpellCheckUrl": "",
            "settings": {
                "spellcheckerUrl": "",
                "reconnection": { "attempts": 50, "delay": 2000 },
                "binaryChanges": false,
                "websocketMaxPayloadSize": 1_572_864,
                "maxChangesSize": 157_286_400,
                "limits_image_size": 26_214_400,
                "limits_image_types_upload": "jpg;jpeg;jpe;png;gif;bmp;svg;tiff;tif;webp;heic;heif;avif",
            },
            "openedAt": now_ms(),
        }));
        Ok((participant, out, peer_frame))
    }

    /// The bundle file list a client's `open` command resolves to.
    pub async fn open_urls(&self, key: &str, urls: &Value) -> Option<Value> {
        let mut hub = self.inner.lock().await;
        let session = hub.sessions.get_mut(key)?;
        session.last_event = Instant::now();
        Some(json!({
            "type": "documentOpen",
            "data": { "type": "open", "status": "ok", "data": urls, "openedAt": now_ms() },
        }))
    }

    /// `saveChanges`/`changes`: append to the op log, relay to other
    /// participants, ack the sender. Returns (reply frames, broadcast frame).
    pub async fn save_changes(
        &self,
        key: &str,
        sock: u64,
        msg: &Value,
    ) -> Result<(Vec<Value>, Option<Value>), HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        let Some(participant) = session.participants.get(&sock).cloned() else {
            return Err(HubError::UnknownKey);
        };
        if !participant.write {
            return Err(HubError::Forbidden);
        }
        // DS runs `lockSave` at the top of saveChanges — the save mutex is
        // taken (or refreshed) by whoever is flushing. A flush arriving while
        // another participant's save lock is live is dropped, exactly like DS
        // (`lockSave` failure → return, no ack, no relay).
        match session.save_holder {
            Some((holder, since)) if holder != sock && since.elapsed() <= SAVE_LOCK_TTL => {
                return Err(HubError::Forbidden);
            }
            _ => session.save_holder = Some((sock, Instant::now())),
        }

        // Undo-past-save: the client reports `deleteIndex` (a global op index)
        // on the first chunk when its history rewound — drop the ops it undid
        // before appending, exactly like DS's `deleteChangesPromise`.
        let delete_index = msg.get("deleteIndex").and_then(Value::as_i64).unwrap_or(-1);
        let start_save = msg
            .get("startSaveChanges")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if start_save && delete_index != -1 {
            truncate_ops(session, delete_index);
        }

        let parsed = match msg.get("changes") {
            Some(Value::String(s)) => serde_json::from_str::<Vec<Value>>(s).unwrap_or_default(),
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        let start_index = session.change_index;
        let now = now_ms();
        let mut records = Vec::with_capacity(parsed.len());
        for ch in parsed {
            // `change` is always the JSON.stringify of the element — for a
            // base64 op string that's the *quoted* string; clients do
            // JSON.parse(change) to recover it.
            let change = ch.to_string();
            session.op_bytes += change.len();
            session.change_index += 1;
            records.push(OpRecord {
                idx: session.change_index,
                change,
                time: now,
                user: participant.id.clone(),
                useridoriginal: participant.id_original.clone(),
            });
        }
        session.ops.extend(records.iter().cloned());

        // DS semantics: changesIndex is the index the sender's flush started
        // from when it isn't a deleteIndex-carrying save.
        let changes_index = if delete_index == -1 && start_save {
            start_index
        } else {
            -1
        };
        let end_save = msg
            .get("endSaveChanges")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // DS releases the saver's block locks when the client asks
        // (`releaseLocks` is set while co-editing) and hands the released list
        // to peers inside the saveChanges broadcast — without it peers keep
        // the saver's paragraphs locked forever.
        let released_locks = if end_save
            && msg
                .get("releaseLocks")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            release_participant_locks(session, &participant.id)
        } else {
            Vec::new()
        };
        let broadcast = json!({
            "type": "saveChanges",
            "changes": records.iter().map(op_json).collect::<Vec<_>>(),
            "startIndex": start_index,
            "changesIndex": session.change_index,
            "syncChangesIndex": session.change_index,
            "endSaveChanges": end_save,
            "locks": released_locks,
            "excelAdditionalInfo": if end_save {
                msg.get("excelAdditionalInfo").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        });
        // Track each participant's coverage — the newest change_index their
        // live doc holds. For the author the just-appended ops are in it by
        // definition; for everyone else the broadcast carries them.
        for p in session.participants.values_mut() {
            p.delivered_index = session.change_index;
        }
        let mut replies = Vec::new();
        if end_save {
            session.save_holder = None;
            replies.push(json!({
                "type": "unSaveLock",
                "index": changes_index,
                "time": now,
                "syncChangesIndex": session.change_index,
            }));
        } else {
            replies.push(json!({
                "type": "savePartChanges",
                "changesIndex": changes_index,
                "syncChangesIndex": session.change_index,
            }));
        }
        let over_cap = session.op_bytes > MAX_OP_LOG_BYTES;
        if over_cap {
            replies.push(json!({
                "type": "warning",
                "code": "session.ops.overflow",
                "message": "This editing session has many unsaved changes. Save the file, then close and reopen it.",
            }));
        }
        Ok((replies, Some(broadcast)))
    }

    /// `getLock {block:[..]}` — grant free blocks, reply+broadcast the full
    /// document lock map (DS shape: `{blockId: {time,user,block}}`).
    pub async fn get_lock(
        &self,
        key: &str,
        sock: u64,
        msg: &Value,
    ) -> Result<(Value, Value), HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        let Some(participant) = session.participants.get(&sock) else {
            return Err(HubError::UnknownKey);
        };
        if !participant.write {
            return Err(HubError::Forbidden);
        }
        let want = msg
            .get("block")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for block in want {
            let k = lock_key(&block);
            let held_by_other = session
                .locks
                .get(&k)
                .map(|l| l.user != participant.id)
                .unwrap_or(false);
            if !held_by_other {
                session.locks.insert(
                    k,
                    BlockLock {
                        time: now_ms(),
                        user: participant.id.clone(),
                        block,
                    },
                );
            }
        }
        let map = locks_json(session);
        Ok((
            json!({ "type": "getLock", "locks": map }),
            json!({ "type": "getLock", "locks": map }),
        ))
    }

    /// `unLock`/`releaseLocks`/`unLockDocument` — release this participant's
    /// blocks and broadcast the released list (DS sends an array of
    /// `{block,user,time,changes}`). Mirrors `checkEndAuthLock`: honors
    /// `deleteIndex` (undo-past-save truncation) and `isSave` (the sender's
    /// save is done — drop the save hold and ack with `unSaveLock`).
    /// Returns (frames for the sender, broadcast for everyone else). The
    /// sender gets its own `releaseLock` echo — DS `sendReleaseLock` includes
    /// the conn so its local `_locks` reset to released.
    pub async fn unlock(
        &self,
        key: &str,
        sock: u64,
        msg: &Value,
    ) -> Result<(Vec<Value>, Option<Value>), HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        let Some(participant) = session.participants.get(&sock) else {
            return Err(HubError::UnknownKey);
        };
        let participant = participant.clone();

        if let Some(delete_index) = msg
            .get("deleteIndex")
            .and_then(Value::as_i64)
            .filter(|i| *i != -1)
        {
            truncate_ops(session, delete_index);
        }

        let listed: Option<Vec<Value>> = match msg.get("block") {
            Some(Value::Array(a)) => Some(a.clone()),
            Some(v) => Some(vec![v.clone()]),
            None => None,
        };
        // No explicit block list: release all of the participant's locks only
        // when asked — DS `checkEndAuthLock` requires `releaseLocks` truthy on
        // unLockDocument; a bare `unLock`/`releaseLocks` frame is itself the
        // request.
        let release_all = listed.is_none()
            && (msg
                .get("releaseLocks")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || matches!(
                    msg.get("type").and_then(Value::as_str),
                    Some("unLock") | Some("releaseLocks")
                ));
        let mut released = Vec::new();
        match listed {
            Some(blocks) => {
                let now = now_ms();
                for block in blocks {
                    let k = lock_key(&block);
                    if session.locks.get(&k).map(|l| l.user.as_str())
                        == Some(participant.id.as_str())
                    {
                        session.locks.remove(&k);
                        released.push(json!({
                            "block": block,
                            "user": participant.id,
                            "time": now,
                            "changes": Value::Null,
                        }));
                    }
                }
            }
            None if release_all => {
                released = release_participant_locks(session, &participant.id);
            }
            _ => {}
        }

        let mut replies = Vec::new();
        let broadcast = if released.is_empty() {
            None
        } else {
            let frame = json!({ "type": "releaseLock", "locks": released });
            replies.push(frame.clone());
            Some(frame)
        };
        // `isSave` on unLockDocument = the sender's save finished; drop the
        // save hold and ack so its client can settle the save UI. DS
        // `unSaveLock` replies unless a *live* foreign hold exists (expired
        // counts as Empty → still answered) — an unanswered `unSaveLock`
        // leaves the client's _state wedged and its askLock queue buffered.
        if msg.get("isSave").and_then(Value::as_bool).unwrap_or(false) {
            match session.save_holder {
                Some((holder, since)) if holder != sock && since.elapsed() <= SAVE_LOCK_TTL => {}
                _ => {
                    session.save_holder = None;
                    replies.push(json!({
                        "type": "unSaveLock", "index": -1, "time": -1, "syncChangesIndex": -1,
                    }));
                }
            }
        }
        Ok((replies, broadcast))
    }

    /// `isSaveLock` — DS returns `saveLock: !granted`: false = caller may save.
    pub async fn is_save_lock(&self, key: &str, sock: u64) -> Result<Value, HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        if !session
            .participants
            .get(&sock)
            .map(|p| p.write)
            .unwrap_or(false)
        {
            return Ok(json!({ "type": "saveLock", "saveLock": true }));
        }
        let granted = match session.save_holder {
            Some((holder, since)) => holder == sock || since.elapsed() > SAVE_LOCK_TTL,
            None => true,
        };
        if granted {
            session.save_holder = Some((sock, Instant::now()));
        }
        Ok(json!({ "type": "saveLock", "saveLock": !granted }))
    }

    /// `unSaveLock` — the client withdrew its save election without saving.
    /// DS answers the asker alone with `-1` sentinels (`unSaveLock(conn, -1,
    /// -1, -1)` — "emergency withdrawal without saving"). This frame must
    /// never reach peers: `_onUnSaveLock` ends their own in-flight save state
    /// machine. Returns the sender's reply, if any — DS `unlockSave` is
    /// silent only while a *live* foreign hold exists; a free or expired hold
    /// (`Unlocked`/`Empty`) still gets the reply, otherwise the asker retries
    /// the frame forever.
    pub async fn un_save_lock(&self, key: &str, sock: u64) -> Result<Option<Value>, HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        match session.save_holder {
            Some((holder, since)) if holder != sock && since.elapsed() <= SAVE_LOCK_TTL => Ok(None),
            _ => {
                session.save_holder = None;
                Ok(Some(json!({
                    "type": "unSaveLock", "index": -1, "time": -1, "syncChangesIndex": -1,
                })))
            }
        }
    }

    /// `lunaSaveLock` — Luna's own save election. The winner gets to
    /// serialize + upload the live document; losers retry via autosave.
    /// `saveLock:false` = granted (same polarity as `saveLock` replies).
    /// Kept apart from `save_holder` on purpose: see `DocSession::save_election`.
    pub async fn luna_save_lock(&self, key: &str, sock: u64) -> Result<Value, HubError> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Err(HubError::UnknownKey);
        };
        session.last_event = Instant::now();
        if !session
            .participants
            .get(&sock)
            .map(|p| p.write)
            .unwrap_or(false)
        {
            return Ok(json!({ "type": "lunaSaveLock", "saveLock": true }));
        }
        let granted = match session.save_election {
            // A holder whose socket vanished without a clean disconnect
            // can't still be mid-serialize — treat the election as free
            // rather than wedging saves for the TTL.
            Some((holder, since)) => {
                holder == sock
                    || since.elapsed() > SAVE_ELECTION_TTL
                    || !session.participants.contains_key(&holder)
            }
            None => true,
        };
        if granted {
            session.save_election = Some((sock, Instant::now()));
        }
        Ok(json!({ "type": "lunaSaveLock", "saveLock": !granted }))
    }

    /// `lunaSaveEnd` — the elected saver is done (or aborted). Releases the
    /// election; the bundle PUT releases it too, so a lost end-frame cannot
    /// wedge the room.
    pub async fn luna_save_end(&self, key: &str, sock: u64) {
        let mut hub = self.inner.lock().await;
        if let Some(session) = hub.sessions.get_mut(key)
            && session.save_election.map(|(s, _)| s) == Some(sock)
        {
            session.save_election = None;
        }
    }

    /// A refreshed `Editor.bin` landed on disk: every op the saver had been
    /// sent is baked into the new base — drop them from the replay log so
    /// joiners don't double-apply.
    pub async fn bundle_refreshed(&self, key: &str, saver_user_id: &str, coverage: Option<i64>) {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return;
        };
        // `coverage` is the saver's self-reported op index — the exact bound
        // of what its serialized Editor.bin contains. `delivered_index` is
        // only a fallback: it's bumped optimistically for every participant
        // on each broadcast, so a saver whose socket was dead mid-broadcast
        // would claim ops its doc never had — compacting past them would
        // drop live ops that were never saved.
        let saver_index = coverage
            .unwrap_or_else(|| {
                session
                    .participants
                    .values()
                    .filter(|p| p.id_original == saver_user_id)
                    .map(|p| p.delivered_index)
                    .max()
                    .unwrap_or(session.change_index)
            })
            .clamp(session.base_index, session.change_index);
        let keep_from = saver_index;
        session.ops.retain(|op| op.idx > keep_from);
        session.op_bytes = session.ops.iter().map(|o| o.change.len()).sum();
        session.base_index = keep_from;
        // The uploaded Editor.bin IS the elected save — release the election
        // here so a lost `lunaSaveEnd` frame can't wedge the room.
        if let Some((holder, _)) = session.save_election
            && session
                .participants
                .get(&holder)
                .map(|p| p.id_original.as_str() == saver_user_id)
                .unwrap_or(false)
        {
            session.save_election = None;
        }
        session.last_event = Instant::now();
    }

    /// Socket dropped — release every lock it held, drop the save election,
    /// and tell the survivors the participant list changed. Returns the frames
    /// to broadcast to survivors: `releaseLock` first so peers free the
    /// departed user's blocks (DS `closeDocument` publishes it — without it
    /// the leaver's paragraphs stay locked in everyone's `_locks` table), then
    /// `connectState`.
    pub async fn disconnect(&self, key: &str, sock: u64) -> Vec<Value> {
        let mut hub = self.inner.lock().await;
        let Some(session) = hub.sessions.get_mut(key) else {
            return Vec::new();
        };
        let mut frames = Vec::new();
        if let Some(p) = session.participants.remove(&sock) {
            let released = release_participant_locks(session, &p.id);
            if !released.is_empty() {
                frames.push(json!({ "type": "releaseLock", "locks": released }));
            }
        }
        if session.save_holder.map(|(s, _)| s) == Some(sock) {
            session.save_holder = None;
        }
        if session.save_election.map(|(s, _)| s) == Some(sock) {
            session.save_election = None;
        }
        session.last_event = Instant::now();
        // Keep the binding so a bundle GET still resolves; ops stay too —
        // a solo reconnect within the idle window still catches up. With no
        // subscribers left the connectState below fans out to nobody.
        frames.push(json!({
            "type": "connectState",
            "participantsTimestamp": now_ms(),
            "participants": session.participants.values().map(participant_json).collect::<Vec<_>>(),
            "waitAuth": false,
        }));
        frames
    }

    /// Fan a peer frame (cursor, message/chat, connectState) to everyone else.
    pub async fn relay(&self, key: &str, except: u64, msg: Value) {
        self.publish_others(key, except, msg).await;
    }

    /// Broadcast a frame to every participant including the originator —
    /// used for connectState after a disconnect.
    pub async fn publish_state(&self, key: &str, msg: Value) {
        self.publish(key, msg).await;
    }

    pub async fn participants_json(&self, key: &str) -> Value {
        let hub = self.inner.lock().await;
        hub.sessions
            .get(key)
            .map(|s| Value::Array(s.participants.values().map(participant_json).collect()))
            .unwrap_or(Value::Array(Vec::new()))
    }

    /// `getLocks` pull response — the sdk iterates `data.locks` as the
    /// `{blockId: {time,user,block}}` map, same shape as getLock/auth. An
    /// array would index its entries as lock ids "0", "1", …
    pub async fn lock_list_json(&self, key: &str) -> Value {
        let hub = self.inner.lock().await;
        hub.sessions.get(key).map(locks_json).unwrap_or(json!({}))
    }

    /// Drop sessions with no participants past the idle window, and their bus.
    pub async fn evict_idle(&self) {
        let cutoff = Duration::from_secs(IDLE_EMPTY_SECS);
        let mut hub = self.inner.lock().await;
        hub.sessions
            .retain(|_, s| !(s.participants.is_empty() && s.last_event.elapsed() > cutoff));
        let live: Vec<String> = hub.sessions.keys().cloned().collect();
        drop(hub);
        let mut bus = self.bus.lock().await;
        bus.retain(|k, _| live.iter().any(|s| s == k));
    }

    #[cfg(test)]
    pub async fn session_count(&self) -> usize {
        self.inner.lock().await.sessions.len()
    }

    #[cfg(test)]
    pub async fn op_count(&self, key: &str) -> usize {
        self.inner
            .lock()
            .await
            .sessions
            .get(key)
            .map(|s| s.ops.len())
            .unwrap_or(0)
    }
}

impl Default for OfficeDocHub {
    fn default() -> Self {
        Self::new()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn op_json(op: &OpRecord) -> Value {
    json!({
        "change": op.change,
        "time": op.time,
        "user": op.user,
        "useridoriginal": op.useridoriginal,
    })
}

/// Lock-table key for a `block` element. DS keys word-doc locks by the raw
/// block string and object blocks (excel/present) by `block.guid`
/// (`map[block.guid || block]`). `Value::to_string()` on a String bakes JSON
/// quotes into the key — the client's `_locks`/`_lockCallbacks` tables are
/// keyed by the raw id and would never match.
fn lock_key(block: &Value) -> String {
    if let Some(guid) = block.get("guid").and_then(Value::as_str) {
        return guid.to_string();
    }
    if let Some(s) = block.as_str() {
        return s.to_string();
    }
    block.to_string()
}

/// Drop every lock `user` holds, DS `removeUserLocks`-style. Returns the
/// released records (`{block,user,time,changes:null}`) for `releaseLock`/
/// `saveChanges` broadcasts.
fn release_participant_locks(session: &mut DocSession, user: &str) -> Vec<Value> {
    let now = now_ms();
    let keys: Vec<String> = session
        .locks
        .iter()
        .filter(|(_, l)| l.user == user)
        .map(|(k, _)| k.clone())
        .collect();
    let mut released = Vec::with_capacity(keys.len());
    for k in keys {
        if let Some(l) = session.locks.remove(&k) {
            released.push(json!({
                "block": l.block,
                "user": l.user,
                "time": now,
                "changes": Value::Null,
            }));
        }
    }
    released
}

/// `deleteIndex` handling shared by saveChanges and unLockDocument: the
/// client rewound its history past the last save point, so the ops it undid
/// must leave the replay log (DS `deleteChangesPromise` + index rewind).
/// `delete_index` is a count-based index like DS's puckerIndex; our op idx
/// is 1-based, so keeping `idx <= delete_index` retains exactly that many.
fn truncate_ops(session: &mut DocSession, delete_index: i64) {
    let delete_count = session.change_index - delete_index;
    if delete_count > 0 {
        session.ops.retain(|op| op.idx <= delete_index);
        session.op_bytes = session.ops.iter().map(|o| o.change.len()).sum();
        // Never rewind below base_index — ops already baked into the bundle
        // left the log; new ops must stay above the baked range or joiners
        // (who replay idx > base_index) would never see them.
        session.change_index = delete_index.max(session.base_index);
    } else if delete_count < 0 {
        tracing::warn!(
            delete_index,
            change_index = session.change_index,
            "docstorage: deleteIndex ahead of op log"
        );
    }
}

fn participant_json(p: &Participant) -> Value {
    json!({
        "id": p.id,
        "idOriginal": p.id_original,
        "username": p.username,
        "indexUser": p.index_user,
        "view": p.view,
        "connectionId": p.id,
        "isCloseCoAuthoring": false,
        "isLiveViewer": false,
        "encrypted": false,
    })
}

fn locks_json(session: &DocSession) -> Value {
    let map: serde_json::Map<String, Value> = session
        .locks
        .iter()
        .map(|(k, l)| {
            (
                k.clone(),
                json!({ "time": l.time, "user": l.user, "block": l.block }),
            )
        })
        .collect();
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn make_session(hub: &OfficeDocHub, key: &str) {
        hub.register_key(key, "drive-a", "docs/a.docx").await;
    }

    fn auth_msg(user: &str, session_id: Option<&str>) -> Value {
        let mut m = json!({
            "type": "auth",
            "docid": "k",
            "user": { "id": user, "username": user },
            "mode": "edit",
            "openCmd": { "c": "open", "id": "k" },
        });
        if let Some(sid) = session_id {
            m["sessionId"] = json!(sid);
            m["user"]["indexUser"] = json!(3);
        }
        m
    }

    #[tokio::test]
    async fn auth_assigns_index_and_replays_to_late_joiner() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        let (a, _, _) = hub
            .auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        assert_eq!(a.index_user, 1);

        // A pushes an op, then B joins — B must see the op via authChanges.
        let msg = json!({"type":"saveChanges","changes":"[{\"x\":1}]","startSaveChanges":true,"endSaveChanges":true});
        let _ = hub.save_changes("k", 1, &msg).await.unwrap();

        let (b, frames, _) = hub
            .auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        assert_eq!(b.index_user, 2);
        let changes = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("authChanges"))
            .expect("late joiner must get authChanges");
        let arr = changes["changes"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["change"], "{\"x\":1}");
        assert_eq!(arr[0]["user"], "alice1");
    }

    #[tokio::test]
    async fn restore_skips_replay_and_checks_last_foreign_op() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        // alice pushes an op — newest op is hers, so her own restore is safe
        // without lastOtherSaveTime (in-flight self ops resend via reSave).
        let msg = json!({"type":"saveChanges","changes":"[{\"n\":0}]"});
        let _ = hub.save_changes("k", 1, &msg).await.unwrap();
        let (_p, frames, _) = hub
            .auth("k", 9, &auth_msg("alice", Some("1")), true)
            .await
            .unwrap();
        // The sdk ignores authChanges on re-auth — none are sent.
        assert!(
            !frames
                .iter()
                .any(|f| f.get("type").and_then(Value::as_str) == Some("authChanges"))
        );

        // bea pushes a foreign op; alice's restore now needs a matching
        // lastOtherSaveTime — stale/absent-ish values are rejected.
        let msg = json!({"type":"saveChanges","changes":"[{\"n\":1}]"});
        let _ = hub.save_changes("k", 2, &msg).await.unwrap();
        let foreign_time = {
            let hub_guard = hub.inner.lock().await;
            hub_guard.sessions["k"].ops.last().unwrap().time
        };
        let mut rejoin = auth_msg("alice", Some("9"));
        rejoin["lastOtherSaveTime"] = json!(foreign_time - 5000);
        assert!(matches!(
            hub.auth("k", 10, &rejoin, true).await,
            Err(HubError::Stale)
        ));
        let mut rejoin = auth_msg("alice", Some("9"));
        rejoin["lastOtherSaveTime"] = json!(foreign_time); // same second
        assert!(hub.auth("k", 10, &rejoin, true).await.is_ok());
    }

    #[tokio::test]
    async fn restore_regrants_owned_locks_and_notifies_peers() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let lock = json!({"type":"getLock","block":["para-1"]});
        let _ = hub.get_lock("k", 1, &lock).await.unwrap();

        // alice's socket drops: her lock is released to the room.
        let frames = hub.disconnect("k", 1).await;
        let released = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("releaseLock"))
            .expect("disconnect must broadcast releaseLock for held locks");
        assert_eq!(released["locks"][0]["block"], "para-1");

        // She reconnects (restore) still owning para-1 — it is re-granted and
        // peers get a getLock refresh so their tables match the server's.
        let mut rejoin = auth_msg("alice", Some("1"));
        rejoin["user"]["indexUser"] = json!(1);
        rejoin["block"] = json!(["para-1"]);
        let (_p, _frames, peer) = hub.auth("k", 9, &rejoin, true).await.unwrap();
        let peer = peer.expect("re-granted locks must be broadcast to peers");
        assert_eq!(peer["type"], "getLock");
        assert_eq!(peer["locks"]["para-1"]["user"], "alice1");
    }

    #[tokio::test]
    async fn save_election_is_exclusive_and_inverted_flag() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        // First isSaveLock grants (saveLock:false), second denies.
        assert_eq!(hub.is_save_lock("k", 1).await.unwrap()["saveLock"], false);
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], true);
        // Holder re-asking is still granted.
        assert_eq!(hub.is_save_lock("k", 1).await.unwrap()["saveLock"], false);
        // unSaveLock frees the election for B — and answers with the DS
        // sentinel triple (-1/-1/-1), addressed to the asker only.
        let reply = hub.un_save_lock("k", 1).await.unwrap().unwrap();
        assert_eq!(reply["type"], "unSaveLock");
        assert_eq!(reply["index"], -1);
        assert_eq!(reply["time"], -1);
        assert_eq!(reply["syncChangesIndex"], -1);
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], false);
    }

    #[tokio::test]
    async fn block_locks_exclude_other_writers_and_release() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let lock = json!({"type":"getLock","block":[{"guid":"b1"}]});
        let (reply_a, _) = hub.get_lock("k", 1, &lock).await.unwrap();
        assert!(reply_a["locks"]["b1"].is_object());
        // B locking b1 gets the map back but doesn't own it.
        let (reply_b, _) = hub.get_lock("k", 2, &lock).await.unwrap();
        assert_eq!(reply_b["locks"]["b1"]["user"], "alice1");
        // A releases; B can then take it.
        let _ = hub.unlock("k", 1, &lock).await.unwrap();
        let (reply_b2, _) = hub.get_lock("k", 2, &lock).await.unwrap();
        assert_eq!(reply_b2["locks"]["b1"]["user"], "bea2");
    }

    #[tokio::test]
    async fn disconnect_reaps_locks_and_save_hold() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let lock = json!({"type":"getLock","block":[{"guid":"b1"}]});
        let _ = hub.get_lock("k", 1, &lock).await.unwrap();
        let _ = hub.is_save_lock("k", 1).await.unwrap();
        let frames = hub.disconnect("k", 1).await;
        // Survivors get releaseLock for A's blocks before the connectState.
        let released = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("releaseLock"))
            .expect("disconnect must broadcast releaseLock");
        assert_eq!(released["locks"][0]["block"]["guid"], "b1");
        assert_eq!(released["locks"][0]["user"], "alice1");
        // A's lock is gone and B can win the save election.
        let (reply_b, _) = hub.get_lock("k", 2, &lock).await.unwrap();
        assert_eq!(reply_b["locks"]["b1"]["user"], "bea2");
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], false);
    }

    #[tokio::test]
    async fn reconnect_reclaims_zombie_participant() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let lock = json!({"type":"getLock","block":[{"guid":"b1"}]});
        let _ = hub.get_lock("k", 1, &lock).await.unwrap();
        let _ = hub.is_save_lock("k", 1).await.unwrap();

        // alice's socket is a half-open zombie; her client reconnects on
        // sock 9 echoing sessionId "1" + indexUser 1 — the stale entry must
        // be evicted up front, releasing its locks and save hold.
        let mut rejoin = auth_msg("alice", Some("1"));
        rejoin["user"]["indexUser"] = json!(1);
        let (p, _, _) = hub.auth("k", 9, &rejoin, true).await.unwrap();
        assert_eq!(p.id, "alice1");

        let (reply_b, _) = hub.get_lock("k", 2, &lock).await.unwrap();
        assert_eq!(reply_b["locks"]["b1"]["user"], "bea2");
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], false);

        // The zombie's eventual disconnect must not reap the rejoined
        // participant's identity or bea's fresh lock.
        hub.disconnect("k", 1).await;
        let (reply_b2, _) = hub.get_lock("k", 2, &lock).await.unwrap();
        assert_eq!(reply_b2["locks"]["b1"]["user"], "bea2");
        let parts = hub.participants_json("k").await;
        assert_eq!(parts.as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn bundle_refresh_truncates_delivered_ops() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        for i in 0..4 {
            let msg = json!({"type":"saveChanges","changes":format!("[{{\"n\":{i}}}]")});
            let _ = hub.save_changes("k", 1, &msg).await.unwrap();
        }
        // The saver's doc holds all 4 ops whether they authored or received
        // them — either way the refreshed bundle covers the whole log.
        hub.bundle_refreshed("k", "bea", None).await;
        assert_eq!(hub.op_count("k").await, 0);
        // Same when the author herself saves.
        for i in 4..8 {
            let msg = json!({"type":"saveChanges","changes":format!("[{{\"n\":{i}}}]")});
            let _ = hub.save_changes("k", 1, &msg).await.unwrap();
        }
        hub.bundle_refreshed("k", "alice", None).await;
        assert_eq!(hub.op_count("k").await, 0);
    }

    #[tokio::test]
    async fn read_only_participant_cannot_push_ops() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("victor", None), false)
            .await
            .unwrap();
        let msg = json!({"type":"saveChanges","changes":"[{\"x\":1}]"});
        assert_eq!(
            hub.save_changes("k", 1, &msg).await,
            Err(HubError::Forbidden)
        );
        assert_eq!(hub.op_count("k").await, 0);
    }

    #[tokio::test]
    async fn string_block_locks_use_raw_id_keys() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        // Word docs send bare string block ids — the map key must be the raw
        // id, not the JSON-serialized "\"para-1\"".
        let lock = json!({"type":"getLock","block":["para-1"]});
        let (reply, _) = hub.get_lock("k", 1, &lock).await.unwrap();
        let locks = reply["locks"].as_object().unwrap();
        assert!(locks.contains_key("para-1"), "keys: {:?}", locks.keys());
        assert_eq!(reply["locks"]["para-1"]["block"], "para-1");
        // getLocks pull response is the same map shape.
        assert!(hub.lock_list_json("k").await["para-1"].is_object());
        // unLock by the same raw string frees it.
        let (replies, broadcast) = hub
            .unlock("k", 1, &json!({"type":"unLock","block":["para-1"]}))
            .await
            .unwrap();
        let b = broadcast.unwrap();
        assert_eq!(b["locks"][0]["block"], "para-1");
        assert_eq!(replies[0], b); // sender gets its own releaseLock echo
        assert!(hub.lock_list_json("k").await["para-1"].is_null());
    }

    #[tokio::test]
    async fn delete_index_truncates_op_log() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        for i in 0..3 {
            let msg = json!({"type":"saveChanges","changes":format!("[{{\"n\":{i}}}]")});
            let _ = hub.save_changes("k", 1, &msg).await.unwrap();
        }
        assert_eq!(hub.op_count("k").await, 3);
        // Undo past the save point: keep idx<=1, then the resaved ops continue
        // the global index from there (DS puckerIndex rewind).
        let msg = json!({
            "type": "saveChanges",
            "changes": "[{\"n\":9}]",
            "startSaveChanges": true,
            "endSaveChanges": true,
            "deleteIndex": 1,
        });
        let (replies, broadcast) = hub.save_changes("k", 1, &msg).await.unwrap();
        assert_eq!(hub.op_count("k").await, 2);
        // The replacement op lands at idx 2 — a joiner sees 0 and 9, never 1/2.
        let (_p, frames, _) = hub
            .auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let changes = frames
            .iter()
            .find(|f| f.get("type").and_then(Value::as_str) == Some("authChanges"))
            .unwrap();
        let arr = changes["changes"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["change"], "{\"n\":0}");
        assert_eq!(arr[1]["change"], "{\"n\":9}");
        // A deleteIndex save reports index -1 to the saver (DS: indices
        // shifted, no meaningful start index); the broadcast carries the new
        // high-water mark.
        assert_eq!(replies[0]["type"], "unSaveLock");
        assert_eq!(replies[0]["index"], -1);
        assert_eq!(broadcast.unwrap()["changesIndex"], 2);
    }

    #[tokio::test]
    async fn save_changes_releases_locks_and_drops_non_holder_flush() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let lock = json!({"type":"getLock","block":["para-1"]});
        let _ = hub.get_lock("k", 1, &lock).await.unwrap();

        // alice's endSaveChanges with releaseLocks frees her blocks and the
        // released list rides inside the saveChanges broadcast for peers.
        let msg = json!({
            "type": "saveChanges",
            "changes": "[{\"x\":1}]",
            "startSaveChanges": true,
            "endSaveChanges": true,
            "releaseLocks": true,
        });
        let (replies, broadcast) = hub.save_changes("k", 1, &msg).await.unwrap();
        let b = broadcast.unwrap();
        assert_eq!(b["locks"][0]["block"], "para-1");
        assert_eq!(b["locks"][0]["user"], "alice1");
        assert_eq!(replies[0]["type"], "unSaveLock");
        assert!(hub.lock_list_json("k").await["para-1"].is_null());
        // Save election is free again — alice can take it right back.
        assert_eq!(hub.is_save_lock("k", 1).await.unwrap()["saveLock"], false);

        // While alice's save is in flight, a foreign flush is dropped like
        // DS's lockSave failure — no ops appended, no ack.
        let mid = json!({"type":"saveChanges","changes":"[{\"x\":2}]"});
        assert_eq!(
            hub.save_changes("k", 2, &mid).await,
            Err(HubError::Forbidden)
        );
        assert_eq!(hub.op_count("k").await, 1);
        // Her own flush still passes.
        assert!(hub.save_changes("k", 1, &mid).await.is_ok());
    }

    #[tokio::test]
    async fn unlock_document_is_save_replies_un_save_lock() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let _ = hub.is_save_lock("k", 1).await.unwrap();
        let lock = json!({"type":"getLock","block":["para-1"]});
        let _ = hub.get_lock("k", 1, &lock).await.unwrap();

        let (replies, broadcast) = hub
            .unlock(
                "k",
                1,
                &json!({"type":"unLockDocument","isSave":true,"releaseLocks":true}),
            )
            .await
            .unwrap();
        // The released blocks are broadcast and echoed; the save hold clears
        // with a DS-shaped unSaveLock to the sender only.
        assert!(broadcast.is_some());
        assert!(replies.iter().any(|f| f.get("type").and_then(Value::as_str)
            == Some("unSaveLock")
            && f["index"] == -1));
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], false);
        assert!(hub.lock_list_json("k").await["para-1"].is_null());
    }

    #[tokio::test]
    async fn save_lock_expires_for_dead_holder() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();
        let _ = hub.is_save_lock("k", 1).await.unwrap();
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], true);
        // Age the hold past the TTL — a dead saver must not starve the room.
        {
            let mut g = hub.inner.lock().await;
            let s = g.sessions.get_mut("k").unwrap();
            s.save_holder = Some((1, Instant::now() - SAVE_LOCK_TTL - Duration::from_secs(1)));
        }
        assert_eq!(hub.is_save_lock("k", 2).await.unwrap()["saveLock"], false);
    }

    #[tokio::test]
    async fn luna_save_election_excludes_saves_but_not_flushes() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();

        // alice wins the election; bea loses it.
        assert_eq!(hub.luna_save_lock("k", 1).await.unwrap()["saveLock"], false);
        assert_eq!(hub.luna_save_lock("k", 2).await.unwrap()["saveLock"], true);
        // ...but the election never gates op flushes — holding it across a
        // serialize must not drop peers' edits or their own.
        let flush = json!({"type":"saveChanges","changes":"[{\"x\":1}]",
            "startSaveChanges":true,"endSaveChanges":true});
        assert!(hub.save_changes("k", 2, &flush).await.is_ok());
        assert!(hub.save_changes("k", 1, &flush).await.is_ok());
        // Holder re-asking refreshes instead of deadlocking.
        assert_eq!(hub.luna_save_lock("k", 1).await.unwrap()["saveLock"], false);

        // lunaSaveEnd releases; the next client can win.
        hub.luna_save_end("k", 1).await;
        assert_eq!(hub.luna_save_lock("k", 2).await.unwrap()["saveLock"], false);
    }

    #[tokio::test]
    async fn luna_save_election_releases_on_bundle_refresh_and_disconnect() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();

        // The uploaded Editor.bin IS the save — bundle_refreshed frees the
        // election even if the client's lunaSaveEnd frame never arrives.
        let _ = hub.luna_save_lock("k", 1).await.unwrap();
        hub.bundle_refreshed("k", "alice", None).await;
        assert_eq!(hub.luna_save_lock("k", 2).await.unwrap()["saveLock"], false);

        // A saver whose socket dies mid-save must not starve the room.
        let _ = hub.luna_save_lock("k", 2).await.unwrap();
        let _ = hub.disconnect("k", 2).await;
        assert_eq!(hub.luna_save_lock("k", 1).await.unwrap()["saveLock"], false);
    }

    #[tokio::test]
    async fn un_save_lock_answers_unless_live_foreign_hold() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        hub.auth("k", 2, &auth_msg("bea", None), true)
            .await
            .unwrap();

        // Live foreign hold → silence (DS c_oAscUnlockRes.Locked).
        let _ = hub.is_save_lock("k", 1).await.unwrap();
        assert!(hub.un_save_lock("k", 2).await.unwrap().is_none());
        // An isSave unLockDocument under the same live hold is silent too.
        let (replies, _) = hub
            .unlock("k", 2, &json!({"type":"unLockDocument","isSave":true}))
            .await
            .unwrap();
        assert!(!replies.iter().any(|f| f["type"] == "unSaveLock"));

        // Expired foreign hold → Empty: clear and reply, or the asker retries
        // the frame forever (and its askLock queue stays buffered).
        {
            let mut g = hub.inner.lock().await;
            let s = g.sessions.get_mut("k").unwrap();
            s.save_holder = Some((1, Instant::now() - SAVE_LOCK_TTL - Duration::from_secs(1)));
        }
        let reply = hub.un_save_lock("k", 2).await.unwrap().unwrap();
        assert_eq!(reply["type"], "unSaveLock");
        assert_eq!(reply["index"], -1);
        // Free hold → still answered.
        let reply = hub.un_save_lock("k", 2).await.unwrap().unwrap();
        assert_eq!(reply["type"], "unSaveLock");
    }

    #[tokio::test]
    async fn live_key_for_matches_only_rooms_with_participants() {
        let hub = OfficeDocHub::new();
        make_session(&hub, "k").await;
        // Registered but nobody connected → not live.
        assert_eq!(hub.live_key_for("drive-a", "docs/a.docx").await, None);
        // A bound session on a different file must not match.
        assert_eq!(hub.live_key_for("drive-a", "docs/b.docx").await, None);
        assert_eq!(hub.live_key_for("drive-b", "docs/a.docx").await, None);

        hub.auth("k", 1, &auth_msg("alice", None), true)
            .await
            .unwrap();
        assert_eq!(
            hub.live_key_for("drive-a", "docs/a.docx").await,
            Some("k".to_string())
        );

        // The room going empty ends reuse — a stale op log must not be
        // replayed onto a file that may have changed since.
        hub.disconnect("k", 1).await;
        assert_eq!(hub.live_key_for("drive-a", "docs/a.docx").await, None);
    }

    #[tokio::test]
    async fn resurrected_session_refuses_dead_era_restores() {
        let hub = OfficeDocHub::new();
        // Sessions are in-memory — a restart/eviction drops them while open
        // editors still hold valid tokens. verify_token rebinds the key from
        // the token claims; the recreated session must refuse sessionId
        // restores (its op log is gone) while letting fresh joins through.
        hub.resurrect_key("k", "drive-a", "docs/a.docx").await;
        assert_eq!(
            hub.binding("k").await,
            Some(("drive-a".to_string(), "docs/a.docx".to_string()))
        );

        // A pre-loss sessionId cannot prove continuity → Stale (client
        // reloads the saved bundle instead of silently diverging).
        assert!(matches!(
            hub.auth("k", 1, &auth_msg("alice", Some("77")), true).await,
            Err(HubError::Stale)
        ));

        // A fresh join (no sessionId) is unaffected.
        let (p, _, _) = hub
            .auth("k", 2, &auth_msg("alice", None), true)
            .await
            .unwrap();
        assert_eq!(p.id_original, "alice");

        // That participant's own later flap is a *known* restore — its
        // sessionId belongs to the live session, so it rejoins normally.
        assert!(
            hub.auth("k", 3, &auth_msg("alice", Some("2")), true)
                .await
                .is_ok()
        );
    }
}
