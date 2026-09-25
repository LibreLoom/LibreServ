//! HACK — advisory edit locks for `.drawio` diagrams.
//!
//! This is a deliberate stopgap standing in for real-time collaboration: the
//! first person to open a diagram in the editor holds a lock on
//! (drive_id, path), and a second opener is told who's editing and offered
//! read-only / download / close instead of a silent clobber. It is
//! deliberately NOT generalized to other file kinds — office files have real
//! EuroOffice collab, and text and forms sync over the collab hub.
//!
//! The lock is held by a WebSocket (`GET /api/v1/diagrams/lock/ws`): the
//! socket staying open IS the heartbeat, so a live holder never loses
//! precedence to a later opener — including when the editor's tab is
//! backgrounded and JS timers get throttled (which is exactly why the old
//! HTTP-heartbeat version was buggy). Socket close releases instantly; a
//! pong timeout releases dead connections. Locks also live in RAM only, so
//! a lunad restart clears every lock — no lock can ever get stuck behind a
//! dead editor. The lock is advisory and also enforced on the write paths
//! (`check_save_allowed`, called from `api::files::upload` and
//! `api::uploads::complete`) so a stale editor can't overwrite a diagram
//! someone else is holding.
//!
//! Every acquire gets a generation number. Renew and release must present
//! the generation they hold, so a stale same-session socket (a dead
//! connection whose task hasn't timed out yet) can neither renew nor free
//! the lock its reconnect replaced — the bug that used to let a zombie
//! socket evict the live holder.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;

/// Backstop TTL: while a lock socket is open the server renews this on its
/// own ping ticks, so expiry only matters if the holding task dies without
/// running its release (panic, abrupt shutdown).
pub const LOCK_TTL: Duration = Duration::from_secs(45);
/// Server→client ping cadence — same value as the docstorage socket. The
/// browser answers pings automatically, even from a backgrounded tab.
const WS_PING_INTERVAL: Duration = Duration::from_secs(25);
/// No inbound traffic for this long while a ping is outstanding means the
/// peer is gone without a close frame (laptop sleep, network drop) — drop
/// the socket and free the lock.
const WS_PONG_TIMEOUT: Duration = Duration::from_secs(45);
/// Advisory locks are keyed per file — a hard cap keeps a runaway client
/// from growing the map without bound. 512 simultaneously-edited diagrams
/// is far past any real Luna box.
const MAX_LOCKS: usize = 512;

/// True when `path` names a diagram file (the same compound extensions the
/// web UI classifies: `.drawio`, `.drawio.svg`, `.drawio.png`).
pub fn is_diagram_name(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    base.ends_with(".drawio") || base.ends_with(".drawio.svg") || base.ends_with(".drawio.png")
}

/// Canonicalize a client-supplied rel path the way `Path::components()`
/// resolves it for the real filesystem write: empty and `.` segments drop
/// out, `..` pops a segment (an underflow means the write would escape or be
/// rejected downstream — `None`). Without this, an upload to `a/./x.drawio`
/// or `a//x.drawio` would resolve to the locked `a/x.drawio` on disk while
/// looking up a key that doesn't exist — a write-path bypass.
fn canon_rel(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Lock map key. Paths are lowercased because Luna drives can be
/// case-insensitive (FAT/exFAT): a lock on `A.drawio` must also block an
/// upload to `a.drawio`, which is the same file there. On a case-sensitive
/// drive the worst case is a same-named file being locked too — benign for
/// an advisory stopgap.
fn lock_key(drive_id: &str, path: &str) -> (String, String) {
    (drive_id.to_string(), path.to_lowercase())
}

#[derive(Clone)]
struct DiagramLock {
    user_id: String,
    /// Per-editor-instance id minted by the web app. Session is the holder:
    /// only the exact same session may re-acquire or renew — a second
    /// opener is blocked even when it's the same user's other tab.
    session: String,
    holder_name: String,
    /// Monotonic id bumped on every acquire. A stale same-session socket
    /// holds an older generation — it can neither renew nor release the
    /// lock its replacement owns.
    generation: u64,
    /// The holder's client reported no input for a while — connected but
    /// not working. Idle locks stay held (saves still land, coming back is
    /// seamless) but the next opener may take them — "grabbable".
    idle: bool,
    /// Live socket's notice channel: an idle lock being grabbed fires the
    /// new holder's name down it so the displaced session learns
    /// immediately instead of at its next renew tick.
    taken: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    expires: Instant,
}

struct LockTable {
    /// Keys are `(drive_id, canonical path)` — canonicalized like the
    /// filesystem resolves the write path, lowercased for case-insensitive
    /// drives.
    map: HashMap<(String, String), DiagramLock>,
    next_generation: u64,
}

/// In-memory lock table — a lunad restart clears every lock.
pub struct DiagramLocks {
    inner: Mutex<LockTable>,
}

impl Default for DiagramLocks {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LockTable {
                map: HashMap::new(),
                next_generation: 0,
            }),
        }
    }
}

/// Who currently holds a live lock — for "locked" replies.
#[derive(Debug)]
pub struct LockedBy {
    pub holder: String,
    /// True when the blocked opener is the same user as the holder (a
    /// second tab/session) — lets the UI say "you're editing it elsewhere".
    pub same_user: bool,
}

impl DiagramLocks {
    fn table(&self) -> std::sync::MutexGuard<'_, LockTable> {
        // Poisoning means a handler panicked mid-mutation; the map is still
        // structurally sound, so recover rather than wedge every diagram.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Drop expired locks. Called on every op so the table self-cleans
    /// without a background task.
    fn sweep(table: &mut LockTable) {
        let now = Instant::now();
        table.map.retain(|_, l| l.expires > now);
    }

    /// Grant the lock when it's free/expired, already belongs to this
    /// exact session (socket reconnect re-acquires idempotently — with a
    /// fresh generation so the dying socket's renew/release can't touch
    /// it), or is held but idle — a grabbable lock passes to the new
    /// opener and its displaced socket gets a `taken` notice. Any other
    /// live holder, same user or not, → `LockedBy`.
    fn acquire(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
        holder_name: &str,
        taken: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    ) -> Result<u64, LockedBy> {
        let mut table = self.table();
        Self::sweep(&mut table);
        let key = lock_key(drive_id, path);
        if let Some(lock) = table.map.get(&key)
            && lock.session != session
            && !lock.idle
        {
            return Err(LockedBy {
                holder: lock.holder_name.clone(),
                same_user: lock.user_id == user_id,
            });
        }
        if !table.map.contains_key(&key) && table.map.len() >= MAX_LOCKS {
            // Full table and no free slot — refuse rather than evict a live
            // lock out from under someone.
            return Err(LockedBy {
                holder: "Someone else".to_string(),
                same_user: false,
            });
        }
        // Grabbing an idle lock: tell the old socket who took it — its task
        // turns that into the "lost" message the displaced editor shows.
        if let Some(prev) = table.map.get(&key)
            && prev.session != session
            && let Some(tx) = &prev.taken
        {
            let _ = tx.send(holder_name.to_string());
        }
        table.next_generation += 1;
        let generation = table.next_generation;
        table.map.insert(
            key,
            DiagramLock {
                user_id: user_id.to_string(),
                session: session.to_string(),
                holder_name: holder_name.to_string(),
                generation,
                idle: false,
                taken,
                expires: Instant::now() + LOCK_TTL,
            },
        );
        Ok(generation)
    }

    /// Mark the holder's lock idle/active — the client reports this over
    /// the lock socket from its own activity watcher. Same identity rules
    /// as `renew`: only the exact `(user, session, generation)` holder may
    /// flip the flag. Returns `Err` like `renew` when the lock isn't ours.
    fn set_idle(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
        generation: u64,
        idle: bool,
    ) -> Result<(), Option<String>> {
        let mut table = self.table();
        Self::sweep(&mut table);
        let key = lock_key(drive_id, path);
        match table.map.get_mut(&key) {
            Some(lock)
                if lock.user_id == user_id
                    && lock.session == session
                    && lock.generation == generation =>
            {
                lock.idle = idle;
                Ok(())
            }
            Some(lock) => Err(Some(lock.holder_name.clone())),
            None => Err(None),
        }
    }

    /// Renew the holder's lock (called by the socket loop, not by clients).
    /// The exact `(user, session, generation)` must match: an older generation is a
    /// stale socket whose reconnect already replaced it. Returns
    /// `Err(Some(holder))` when someone else holds it, `Err(None)` when the
    /// lock is simply gone — the caller reports either as a loss.
    fn renew(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
        generation: u64,
    ) -> Result<(), Option<String>> {
        let mut table = self.table();
        Self::sweep(&mut table);
        let key = lock_key(drive_id, path);
        match table.map.get_mut(&key) {
            Some(lock)
                if lock.user_id == user_id
                    && lock.session == session
                    && lock.generation == generation =>
            {
                lock.expires = Instant::now() + LOCK_TTL;
                Ok(())
            }
            Some(lock) => Err(Some(lock.holder_name.clone())),
            None => Err(None),
        }
    }

    /// Explicit release — socket close and the keepalive POST both land
    /// here. Only the exact (user, session, generation) holder can drop it,
    /// so a stale socket's teardown or a late keepalive from a dying page
    /// can't free the lock a newer connection holds.
    fn release(&self, drive_id: &str, path: &str, user_id: &str, session: &str, generation: u64) {
        let mut table = self.table();
        Self::sweep(&mut table);
        let key = lock_key(drive_id, path);
        if matches!(table.map.get(&key), Some(l) if l.user_id == user_id && l.session == session && l.generation == generation)
        {
            table.map.remove(&key);
        }
    }

    /// Write-path check used by the upload paths: a diagram save while a
    /// lock is live is refused unless it comes from the exact
    /// `(user, session)` holding it. Session-scoped like the lock itself —
    /// after an idle grab, the displaced session's autosave must stop
    /// landing even when it's the same user's other tab.
    fn save_holder_conflict(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
    ) -> Option<String> {
        let mut table = self.table();
        Self::sweep(&mut table);
        match table.map.get(&lock_key(drive_id, path)) {
            Some(lock) if !(lock.user_id == user_id && lock.session == session) => {
                Some(lock.holder_name.clone())
            }
            _ => None,
        }
    }

    /// Test helper: seed a held lock without standing up a socket.
    #[cfg(test)]
    pub(crate) fn acquire_for_test(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
        holder_name: &str,
    ) {
        let _ = self.acquire(drive_id, path, user_id, session, holder_name, None);
    }

    /// Test helper: flip the idle flag the way a socket's report would.
    #[cfg(test)]
    fn set_idle_for_test(
        &self,
        drive_id: &str,
        path: &str,
        user_id: &str,
        session: &str,
        generation: u64,
        idle: bool,
    ) -> Result<(), Option<String>> {
        self.set_idle(drive_id, path, user_id, session, generation, idle)
    }

    /// Test helper: force a lock entry to look expired without sleeping.
    #[cfg(test)]
    fn force_expire(&self, drive_id: &str, path: &str) {
        let mut table = self.table();
        if let Some(lock) = table.map.get_mut(&lock_key(drive_id, path)) {
            lock.expires = Instant::now() - Duration::from_secs(1);
        }
    }
}

/// The holder key a guest (public share-link) session uses:
/// `guest:{link}:{session}` — one identity per editor instance on a link.
/// The guest lock socket stores it as the lock's user id and the save path
/// re-derives it from the `X-Diagram-Session` header, so member and guest
/// holds contend on the same `(drive, path)` key in one table.
pub fn guest_lock_key(link_id: &str, session: &str) -> String {
    format!("guest:{link_id}:{session}")
}

/// The `X-Diagram-Session` header the editor's save path carries — the
/// holder-key suffix that lets a save prove it comes from the session
/// actually holding the lock. A missing header is just a different session.
pub fn session_header(headers: &HeaderMap) -> String {
    headers
        .get("x-diagram-session")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Upload enforcement hook. Called from `api::files::upload` and
/// `api::uploads::complete` once the destination name is known; non-diagram
/// targets pass through untouched. The rel path is canonicalized the same
/// way the filesystem resolves it so `./`/`//`/case variants can't slip a
/// write past the lock. `session` is the `X-Diagram-Session` value — a save
/// only passes while its session still holds the lock, so a displaced
/// (grabbed) session's autosave can't clobber the new holder's work.
pub fn check_save_allowed(
    state: &AppState,
    user_id: &str,
    session: &str,
    drive_id: &str,
    rel_path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(rel) = canon_rel(rel_path) else {
        // A path that resolves to nothing never reaches a diagram file.
        return Ok(());
    };
    if !is_diagram_name(&rel) {
        return Ok(());
    }
    match state
        .diagram_locks
        .save_holder_conflict(drive_id, &rel, user_id, session)
    {
        Some(holder) => Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!(
                    "{holder} is editing this diagram right now. Save a copy or try again after they close it."
                ),
                "code": "diagram_locked",
                "holder": holder,
            })),
        )),
        None => Ok(()),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/diagrams/lock/ws", get(lock_ws))
        .route("/api/v1/diagrams/lock/release", post(release_lock))
        .route("/s/{token}/diagrams/lock/ws", get(guest_lock_ws))
}

#[derive(Deserialize)]
struct LockBody {
    drive_id: String,
    path: String,
    session: String,
    /// Generation the client holds (echoed from the `held` message).
    #[serde(default, rename = "gen")]
    generation: u64,
}

#[derive(Deserialize)]
struct LockWsQuery {
    drive_id: String,
    path: String,
    session: String,
}

/// Trim and bound the client fields — a lock is cheap but junk input
/// shouldn't allocate unbounded keys in the map. The path comes back
/// canonicalized to what the filesystem resolves.
fn normalize_fields(
    drive_id: &str,
    path: &str,
    session: &str,
) -> Result<(String, String, String), (StatusCode, Json<Value>)> {
    let drive_id = drive_id.trim();
    let session = session.trim();
    if drive_id.is_empty() || session.is_empty() || drive_id.len() > 128 || session.len() > 128 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't read that lock request. Refresh and try again.",
        ));
    }
    let Some(path) = canon_rel(path.trim().trim_matches('/')) else {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't read that lock request. Refresh and try again.",
        ));
    };
    if path.len() > 2048 {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna couldn't read that lock request. Refresh and try again.",
        ));
    }
    if !is_diagram_name(&path) {
        // Only diagrams lock — other kinds were never meant to reach here.
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Only diagram files can be locked.",
        ));
    }
    Ok((drive_id.to_string(), path, session.to_string()))
}

/// Shared guard for the lock socket: upload permission on the file (read-
/// only viewers never lock) plus the display name other users see.
fn authorize(
    state: &AppState,
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    if !crate::auth::has_cap(&user, &conn, drive_id, path, crate::access::CAP_UPLOAD) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to change this file.",
        ));
    }
    // Show the person's display name (what other users see in Files), not
    // the login username.
    let holder_name = crate::db::get_user(&conn, &user.id)
        .ok()
        .flatten()
        .map(|u| u.display_name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| user.username.clone());
    Ok(holder_name)
}

/// The lock channel. The socket's lifetime IS the hold: browsers keep
/// WebSockets alive in backgrounded tabs (where `setInterval` heartbeats
/// get throttled to once a minute — the bug this replaced), so the first
/// editor keeps precedence for as long as they're actually connected. The
/// acquire result and any later takeover arrive as JSON messages:
/// `{"type":"held","gen":N}`, `{"type":"locked","holder":..,"self":bool}`,
/// `{"type":"lost","holder":..}`.
async fn lock_ws(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<LockWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let (drive_id, path, session) = normalize_fields(&query.drive_id, &query.path, &query.session)?;
    let holder_name = authorize(&state, &user, &drive_id, &path)?;
    let user_id = user.id.clone();
    Ok(ws.on_upgrade(move |socket| {
        lock_session(state, socket, drive_id, path, user_id, session, holder_name)
    }))
}

#[derive(Deserialize)]
struct GuestLockWsQuery {
    #[serde(default)]
    path: String,
    session: String,
}

/// The guest half of the lock channel — same socket lifecycle, scoped by a
/// share link instead of a member session. `resolve_public_link` owns
/// token lookup, expiry, and password + proof-cookie auth (the proof
/// cookie is Path=/s, so it rides this same-origin upgrade). The lock
/// identity is `guest:{link}:{session}` — the same key `check_save_allowed`
/// re-derives from `X-Diagram-Session` on the guest save path.
async fn guest_lock_ws(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<GuestLockWsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let (link, proof) =
        match crate::api::access::resolve_public_link(&state, &addr, &token, &headers) {
            Ok(pair) => pair,
            Err(e) => return crate::api::access::finish_public(Err(e), "", None, &headers),
        };
    let link_id = link.id.clone();
    crate::api::access::finish_public(
        guest_lock_upgrade(&state, &link, &query, ws),
        &link_id,
        proof,
        &headers,
    )
}

fn guest_lock_upgrade(
    state: &AppState,
    link: &crate::db::AccessLinkRow,
    query: &GuestLockWsQuery,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<Value>)> {
    // View-only guests never hold an edit lock.
    crate::api::access::require_link_edit(link)?;
    // The drive/path the lock keys on is resolved server-side through the
    // link's scope — never trusted from the query string — and must be a
    // real diagram file the link can open.
    let rel = crate::api::access::link_file(state, link, &query.path)?;
    let (drive_id, path, session) = normalize_fields(&link.drive_id, &rel, &query.session)?;
    let user_id = guest_lock_key(&link.id, &session);
    let state = state.clone();
    Ok(ws
        .on_upgrade(move |socket| {
            lock_session(
                state,
                socket,
                drive_id,
                path,
                user_id,
                session,
                "A guest".to_string(),
            )
        })
        .into_response())
}

async fn lock_session(
    state: AppState,
    socket: WebSocket,
    drive_id: String,
    path: String,
    user_id: String,
    session: String,
    holder_name: String,
) {
    let (mut sink, mut stream) = socket.split();
    // The lock entry carries this channel's sender while this socket holds
    // it — an idle grab fires the new holder's name down it so the
    // displaced session learns immediately, not at its next renew tick.
    let (taken_tx, taken_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut taken_rx = Some(taken_rx);
    let generation = match state.diagram_locks.acquire(
        &drive_id,
        &path,
        &user_id,
        &session,
        &holder_name,
        Some(taken_tx),
    ) {
        Ok(generation) => {
            if send_lock_msg(&mut sink, &json!({ "type": "held", "gen": generation }))
                .await
                .is_err()
            {
                state
                    .diagram_locks
                    .release(&drive_id, &path, &user_id, &session, generation);
                return;
            }
            generation
        }
        Err(LockedBy { holder, same_user }) => {
            let _ = send_lock_msg(
                &mut sink,
                &json!({ "type": "locked", "holder": holder, "self": same_user }),
            )
            .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    let mut ping = tokio::time::interval(WS_PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First ping only after the interval; the handshake itself is activity.
    ping.reset();
    let mut last_rx = Instant::now();
    let mut ping_outstanding = false;

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        last_rx = Instant::now();
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        last_rx = Instant::now();
                        // The only client→server message: the holder's
                        // activity watcher reporting `{"type":"idle"}`.
                        // A flag write on a lock that isn't ours anymore
                        // means the session lost it — same report as renew.
                        if let Ok(msg) = serde_json::from_str::<Value>(&text)
                            && msg.get("type").and_then(|t| t.as_str()) == Some("idle")
                            && let Some(idle) = msg.get("idle").and_then(|i| i.as_bool())
                            && let Err(holder) = state.diagram_locks.set_idle(
                                &drive_id,
                                &path,
                                &user_id,
                                &session,
                                generation,
                                idle,
                            )
                        {
                            let _ = send_lock_msg(
                                &mut sink,
                                &json!({ "type": "lost", "holder": holder }),
                            )
                            .await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {
                        // Any inbound frame (pong, stray binary) is liveness.
                        last_rx = Instant::now();
                    }
                    Some(Err(_)) => break,
                }
            }
            taken = async {
                match taken_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                match taken {
                    Some(new_holder) => {
                        // Someone grabbed our idle lock — the modal they see
                        // is this "lost" notice.
                        let _ = send_lock_msg(
                            &mut sink,
                            &json!({ "type": "lost", "holder": new_holder }),
                        )
                        .await;
                        break;
                    }
                    // Our entry was replaced or dropped — the renew tick
                    // reports the real state soon enough.
                    None => taken_rx = None,
                }
            }
            _ = ping.tick() => {
                if ping_outstanding && last_rx.elapsed() > WS_PONG_TIMEOUT {
                    break;
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
                ping_outstanding = true;
                // Renew the TTL backstop while the socket lives. Renewal
                // failing means the lock changed hands or lapsed — tell
                // this session it lost, then stop. The generation check is
                // what keeps a stale reconnect's predecessor from evicting
                // or extending the live holder's lock.
                match state
                    .diagram_locks
                    .renew(&drive_id, &path, &user_id, &session, generation)
                {
                    Ok(()) => {}
                    Err(holder) => {
                        let _ = send_lock_msg(
                            &mut sink,
                            &json!({ "type": "lost", "holder": holder }),
                        )
                        .await;
                        break;
                    }
                }
            }
        }
    }

    state
        .diagram_locks
        .release(&drive_id, &path, &user_id, &session, generation);
}

async fn send_lock_msg<S>(sink: &mut S, msg: &Value) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let Ok(text) = serde_json::to_string(msg) else {
        return Err(());
    };
    sink.send(Message::Text(text.into())).await.map_err(|_| ())
}

/// Release a held lock on editor close. Always 200 — releasing a lock that
/// isn't yours (or that's already gone, or belongs to a newer generation)
/// is a no-op, and the close path (`fetch` with `keepalive` from `pagehide`)
/// can't surface errors anyway. Socket close is the primary release; this
/// covers the browser killing the page before the teardown lands.
async fn release_lock(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(body): Json<LockBody>,
) -> impl IntoResponse {
    // Malformed bodies on the close path are noise — release what we can.
    if let Ok((drive_id, path, session)) =
        normalize_fields(&body.drive_id, &body.path, &body.session)
    {
        state
            .diagram_locks
            .release(&drive_id, &path, &user.id, &session, body.generation);
    }
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locks() -> DiagramLocks {
        DiagramLocks::default()
    }

    #[test]
    fn first_holder_keeps_precedence_over_a_later_opener() {
        let l = locks();
        let gen1 = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // A different user opening later is refused — they never displace A.
        let Err(LockedBy { holder, same_user }) =
            l.acquire("d", "a.drawio", "u2", "s2", "Bo", None)
        else {
            panic!("later opener must not take the lock");
        };
        assert_eq!(holder, "Ada");
        assert!(!same_user);
        // A's socket renewal still succeeds — A keeps editing.
        l.renew("d", "a.drawio", "u1", "s1", gen1).unwrap();
        // And A's save path stays clean.
        assert_eq!(l.save_holder_conflict("d", "a.drawio", "u1", "s1"), None);
        assert_eq!(
            l.save_holder_conflict("d", "a.drawio", "u2", "s2")
                .as_deref(),
            Some("Ada")
        );
    }

    #[test]
    fn same_user_second_session_is_also_blocked() {
        let l = locks();
        l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // Same user, different tab — still a second opener, still blocked,
        // and the reply flags it as the user's own session.
        let Err(LockedBy { same_user, .. }) = l.acquire("d", "a.drawio", "u1", "s2", "Ada", None)
        else {
            panic!("a second tab must not displace the live first tab");
        };
        assert!(same_user);
    }

    #[test]
    fn exact_same_session_reacquires_idempotently() {
        let l = locks();
        let gen1 = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // Socket reconnect with the same session — not a takeover, but it
        // gets a fresh generation so the dying socket can't touch it.
        let gen2 = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        assert!(gen2 > gen1);
        l.renew("d", "a.drawio", "u1", "s1", gen2).unwrap();
    }

    #[test]
    fn stale_generation_can_neither_renew_nor_release() {
        let l = locks();
        let gen1 = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // Same-session reconnect (new socket) while the old one lingers.
        let gen2 = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // The stale socket's renew is refused — it can't extend the lock.
        assert_eq!(
            l.renew("d", "a.drawio", "u1", "s1", gen1),
            Err(Some("Ada".to_string()))
        );
        // The stale socket's teardown must not free the live lock.
        l.release("d", "a.drawio", "u1", "s1", gen1);
        assert_eq!(l.renew("d", "a.drawio", "u1", "s1", gen2), Ok(()));
    }

    #[test]
    fn expired_lock_is_free_for_the_next_opener() {
        let l = locks();
        l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        l.force_expire("d", "a.drawio");
        l.acquire("d", "a.drawio", "u2", "s2", "Bo", None).unwrap();
        assert_eq!(
            l.save_holder_conflict("d", "a.drawio", "u1", "s1")
                .as_deref(),
            Some("Bo")
        );
    }

    #[test]
    fn release_frees_the_lock_for_someone_else() {
        let l = locks();
        let generation = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        l.release("d", "a.drawio", "u1", "s1", generation);
        l.acquire("d", "a.drawio", "u2", "s2", "Bo", None).unwrap();
    }

    #[test]
    fn idle_lock_is_grabbable_and_the_old_socket_is_told() {
        let l = locks();
        let (taken_tx, mut taken_rx) = tokio::sync::mpsc::unbounded_channel();
        let generation = l
            .acquire("d", "a.drawio", "u1", "s1", "Ada", Some(taken_tx))
            .unwrap();
        // Still active — not grabbable.
        let Err(..) = l.acquire("d", "a.drawio", "u2", "s2", "Bo", None) else {
            panic!("an active lock must refuse a second opener");
        };
        // A's client reports idle — the lock becomes grabbable, not free.
        l.set_idle_for_test("d", "a.drawio", "u1", "s1", generation, true)
            .unwrap();
        // A's own save still lands while it holds the idle lock.
        assert_eq!(l.save_holder_conflict("d", "a.drawio", "u1", "s1"), None);
        // B grabs it — and A's socket hears who took it.
        l.acquire("d", "a.drawio", "u2", "s2", "Bo", None).unwrap();
        assert_eq!(taken_rx.try_recv().unwrap(), "Bo");
        // A's renew and saves now fail — the hold genuinely moved.
        assert_eq!(
            l.renew("d", "a.drawio", "u1", "s1", generation),
            Err(Some("Bo".to_string()))
        );
        assert_eq!(
            l.save_holder_conflict("d", "a.drawio", "u1", "s1")
                .as_deref(),
            Some("Bo")
        );
    }

    #[test]
    fn grabbed_sessions_save_is_refused_even_for_the_same_user() {
        let l = locks();
        let generation = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        l.set_idle_for_test("d", "a.drawio", "u1", "s1", generation, true)
            .unwrap();
        // Same user, second tab grabs the idle lock.
        l.acquire("d", "a.drawio", "u1", "s2", "Ada", None).unwrap();
        // The old session's autosave must not clobber the new holder's work.
        assert_eq!(
            l.save_holder_conflict("d", "a.drawio", "u1", "s1")
                .as_deref(),
            Some("Ada")
        );
        assert_eq!(l.save_holder_conflict("d", "a.drawio", "u1", "s2"), None);
    }

    #[test]
    fn set_idle_requires_the_live_holder() {
        let l = locks();
        let generation = l.acquire("d", "a.drawio", "u1", "s1", "Ada", None).unwrap();
        // Another session can't mark someone else's lock idle.
        assert_eq!(
            l.set_idle_for_test("d", "a.drawio", "u2", "s2", 9, true),
            Err(Some("Ada".to_string()))
        );
        // Nor can a stale generation of the holder's own session.
        assert_eq!(
            l.set_idle_for_test("d", "a.drawio", "u1", "s1", generation + 1, true),
            Err(Some("Ada".to_string()))
        );
    }

    #[test]
    fn renew_reports_no_holder_when_the_lock_is_gone() {
        let l = locks();
        assert_eq!(l.renew("d", "a.drawio", "u1", "s1", 1), Err(None));
    }

    #[test]
    fn lock_keys_match_after_lexical_and_case_normalization() {
        let l = locks();
        l.acquire("d", "dir/Plan.drawio", "u1", "s1", "Ada", None)
            .unwrap();
        // The same file reached via `.` segments, double slashes, or a
        // different case still collides with the live lock.
        for p in ["dir/./plan.drawio", "dir//plan.drawio", "dir/PLAN.drawio"] {
            let canon = canon_rel(p).unwrap();
            assert_eq!(
                l.save_holder_conflict("d", &canon, "u2", "s2").as_deref(),
                Some("Ada"),
                "{p} must hit the same lock"
            );
        }
    }

    #[test]
    fn canon_rel_resolves_like_the_filesystem() {
        assert_eq!(canon_rel("a/b.drawio").as_deref(), Some("a/b.drawio"));
        assert_eq!(canon_rel("./a//b.drawio").as_deref(), Some("a/b.drawio"));
        assert_eq!(canon_rel("a/../b.drawio").as_deref(), Some("b.drawio"));
        assert_eq!(canon_rel("../a.drawio"), None);
        assert_eq!(canon_rel(""), None);
        assert_eq!(canon_rel("/"), None);
    }

    #[test]
    fn non_diagram_names_never_lock() {
        assert!(is_diagram_name("x.drawio"));
        assert!(is_diagram_name("x.drawio.svg"));
        assert!(is_diagram_name("x.drawio.png"));
        assert!(!is_diagram_name("x.drawio.bak"));
        assert!(!is_diagram_name("x.md"));
        assert!(!is_diagram_name("x.lunaform"));
    }
}
