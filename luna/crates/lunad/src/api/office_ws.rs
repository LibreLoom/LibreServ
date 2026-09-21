//! EuroOffice docstorage socket — Engine.IO v4 + Socket.IO v5 over a plain
//! axum WebSocket.
//!
//! The stock pack's socket client connects to `/eurooffice/{ver}/doc/{key}/c`
//! (or unversioned) with `?EIO=4&transport=websocket`, sends a Socket.IO
//! CONNECT whose payload carries `data.token` + `data.docid`, then speaks
//! single-event `message` frames — the same surface ONLYOFFICE Document
//! Server exposes. We speak just enough of both protocols to keep the editor
//! happy: open, connect-ack, one `message` event, ping/pong. Polling is never
//! requested by the pack client (websocket is tried first).

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{FromRequestParts, Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use futures_util::{SinkExt, StreamExt};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::AppState;
use crate::office::office_docs::{HubError, OfficeDocHub, Participant};

const PING_INTERVAL: Duration = Duration::from_secs(25);
const PONG_TIMEOUT: Duration = Duration::from_secs(20);
/// Fresh token minted into each auth reply so reconnects stay verifiable;
/// matches the session endpoint's all-day window.
const OFFICE_TOKEN_TTL_SECS: i64 = 24 * 60 * 60;
/// Matches the spike's maxHttpBufferSize; a single pasted image is the biggest
/// legitimate frame we expect.
const MAX_PAYLOAD: usize = 64 * 1024 * 1024;

/// Everything under `/eurooffice/` flows through one wildcard route: the
/// pack's versioned URLs (`/eurooffice/{semver}-{hash}/…`) can't be normalized
/// by route-level middleware (the router matches the ServeDir wildcard before
/// the layer runs), so the version strip happens here instead.
pub async fn dispatch(
    State(state): State<AppState>,
    Path(tail): Path<String>,
    mut req: axum::extract::Request,
) -> Response {
    // `9.3.4-26e016e8…/doc/…` → `doc/…`; a plain first segment passes through.
    let tail = match tail.split_once('/') {
        Some((seg, rest)) if is_version_segment(seg) => rest,
        _ => tail.as_str(),
    };

    // Docstorage socket: `doc/{key}/c` (socket.io appends a trailing slash to
    // the engine path). Key is a single path segment.
    if let Some(rest) = tail.strip_prefix("doc/") {
        let key = rest.strip_suffix("/c").or_else(|| rest.strip_suffix("/c/"));
        if let Some(key) = key.filter(|k| !k.is_empty() && !k.contains('/')) {
            // `Option<WebSocketUpgrade>` isn't an extractor — pull the upgrade
            // out of the request parts ourselves.
            let (mut parts, _body) = req.into_parts();
            return match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
                Ok(ws) => {
                    let key = key.to_string();
                    ws.max_message_size(MAX_PAYLOAD)
                        .on_upgrade(move |socket| session(state, socket, key))
                        .into_response()
                }
                Err(_) => (
                    StatusCode::BAD_REQUEST,
                    "docstorage endpoint expects a websocket upgrade",
                )
                    .into_response(),
            };
        }
    }

    // Static pack files. The service worker is registered at the versioned
    // root but lives under sdkjs/common/serviceworker/ — same nginx-layout
    // shim DS uses.
    let tail = match tail {
        "document_editor_service_worker.js" => {
            "sdkjs/common/serviceworker/document_editor_service_worker.js"
        }
        t => t,
    };
    let dir = state.data_dir.join("eurooffice");
    if let Ok(uri) = format!("/{tail}").parse::<axum::http::Uri>() {
        *req.uri_mut() = uri;
    }
    match ServeDir::new(dir).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The editor iframe resolves `../../sdkjs/…` against the site root, matching
/// Document Server's nginx layout — serve those from the pack's sdkjs tree.
pub async fn sdkjs_dispatch(
    State(state): State<AppState>,
    Path(tail): Path<String>,
    mut req: axum::extract::Request,
) -> Response {
    let dir = state.data_dir.join("eurooffice").join("sdkjs");
    if let Ok(uri) = format!("/{tail}").parse::<axum::http::Uri>() {
        *req.uri_mut() = uri;
    }
    match ServeDir::new(dir).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The sdkjs font loader resolves `../../../../fonts/` against the site root
/// (Document Server's nginx layout) — serve the pack's generated fonts.
/// The route shadows the web app's own /fonts/* brand fonts, so a miss falls
/// through to the embedded dist handler — but only for real dist assets: its
/// SPA fallback would hand index.html back with a 200, which sdkjs consumes
/// as corrupt font data (or a poisoned service-worker cache entry), so an
/// HTML answer must surface as a real 404.
pub async fn fonts_dispatch(
    State(state): State<AppState>,
    Path(tail): Path<String>,
    mut req: axum::extract::Request,
) -> Response {
    let dir = state.data_dir.join("eurooffice").join("fonts");
    let orig_path = req.uri().path().to_string();
    if let Ok(uri) = format!("/{tail}").parse::<axum::http::Uri>() {
        *req.uri_mut() = uri;
    }
    match ServeDir::new(dir).oneshot(req).await {
        Ok(res) if res.status() != StatusCode::NOT_FOUND => res.into_response(),
        Ok(_) => {
            let res = crate::system::staticweb::handle(&orig_path);
            let is_spa_index = res
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| ct.starts_with("text/html"));
            if is_spa_index {
                StatusCode::NOT_FOUND.into_response()
            } else {
                res.into_response()
            }
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `9.3.4-<hash>` — the build id the pack bakes into api.js.
fn is_version_segment(seg: &str) -> bool {
    let Some((ver, _hash)) = seg.split_once('-') else {
        return false;
    };
    let mut parts = ver.split('.');
    matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && parts.next().is_none()
}

async fn session(state: AppState, socket: WebSocket, key: String) {
    let sock_id = OfficeDocHub::next_sock_id();
    let (mut sink, mut stream) = socket.split();
    let mut rx = state.office_docs.subscribe(&key).await;

    // Engine.IO OPEN — the client waits for this before sending CONNECT.
    let eio_sid = format!("{:x}{:x}", now_nanos(), sock_id);
    if send_raw(
        &mut sink,
        &format!(
            "0{{\"sid\":\"{eio_sid}\",\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":20000,\"maxPayload\":{MAX_PAYLOAD}}}"
        ),
    )
    .await
    .is_err()
    {
        return;
    }

    let mut client = ClientState::default();
    // Any inbound traffic proves liveness — a chatty client that answers
    // pings late must not be dropped mid-edit.
    let mut last_rx = Instant::now();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First ping only after the interval; the handshake itself is activity.
    ping.reset();
    let mut ping_outstanding = false;
    // Every break path assigns the reason before exiting the loop.
    let close_reason: &str;

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_rx = Instant::now();
                        let text: &str = text.as_ref();
                        // Binary attachment for a pending 5x- event — can't be
                        // inside a text frame; treat stray data as noise.
                        if client.pending_binary.is_some() && text.starts_with('4') {
                            // protocol violation; drop the partial event.
                            client.pending_binary = None;
                        }
                        match handle_packet(&state, &key, sock_id, text, &mut client).await {
                            PacketOutcome::Frames(frames) => {
                                let mut failed = false;
                                for f in frames {
                                    if send_raw(&mut sink, &f).await.is_err() { failed = true; break; }
                                }
                                if failed { close_reason = "ws send failed"; break; }
                            }
                            PacketOutcome::Pong => { ping_outstanding = false; }
                            PacketOutcome::Close => { close_reason = "protocol close"; break; }
                            PacketOutcome::Ignore => {}
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        last_rx = Instant::now();
                        // Binary attachment of a 5x- event — the op log and
                        // relay carry JSON/base64 (binaryChanges=false), so
                        // just count the attachments off and drop the event.
                        if let Some((hdr, remaining)) = client.pending_binary.take()
                            && remaining > 1
                        {
                            client.pending_binary = Some((hdr, remaining - 1));
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        last_rx = Instant::now();
                        if sink.send(Message::Pong(p)).await.is_err() { close_reason = "ws pong failed"; break; }
                    }
                    Some(Ok(Message::Close(_))) => { close_reason = "ws close frame"; break; }
                    None => { close_reason = "ws stream ended"; break; }
                    Some(Ok(_)) => { last_rx = Instant::now(); }
                    Some(Err(e)) => { close_reason = "ws transport error"; tracing::info!(key = %key, sock = sock_id, error = %e, "docstorage socket error"); break; }
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(mut ev) => {
                        // Frames fanned out to "everyone else" carry __except.
                        let except = ev.get("__except").and_then(Value::as_u64);
                        if let Some(map) = ev.as_object_mut() { map.remove("__except"); }
                        if except == Some(sock_id) { continue; }
                        let payload = format!("42[\"message\",{}]", ev);
                        if send_raw(&mut sink, &payload).await.is_err() { close_reason = "ws send failed"; break; }
                    }
                    // A lagged client missed relayed ops — it must resync:
                    // drop the socket and let the client's reconnect replay
                    // the op log from its syncChangesIndex.
                    Err(broadcast::error::RecvError::Lagged(n)) => { close_reason = "bus lagged"; tracing::info!(key = %key, sock = sock_id, skipped = n, "docstorage client lagged, forcing resync"); break; }
                    Err(broadcast::error::RecvError::Closed) => { close_reason = "bus closed"; break; }
                }
            }
            _ = ping.tick() => {
                if ping_outstanding && last_rx.elapsed() > PONG_TIMEOUT {
                    close_reason = "pong timeout";
                    break;
                }
                if send_raw(&mut sink, "2").await.is_err() { close_reason = "ws ping failed"; break; }
                ping_outstanding = true;
            }
        }
    }

    tracing::info!(key = %key, sock = sock_id, reason = close_reason, "docstorage session ended");
    break_session(&state, &key, sock_id).await;
}

async fn break_session(state: &AppState, key: &str, sock_id: u64) {
    // releaseLock for the departed user's blocks, then connectState.
    for frame in state.office_docs.disconnect(key, sock_id).await {
        state.office_docs.publish_state(key, frame).await;
    }
}

enum PacketOutcome {
    Frames(Vec<String>),
    Pong,
    Close,
    Ignore,
}

/// Per-socket mutable state carried through the packet loop.
#[derive(Default)]
struct ClientState {
    authed: bool,
    can_write: bool,
    /// The authed participant record — cursor/message relays need id,
    /// id_original, and username for DS-shaped `messages` payloads.
    participant: Option<Participant>,
    /// Socket.IO binary-event reassembly: (header_json, remaining count).
    pending_binary: Option<(Vec<u8>, usize)>,
}

/// One Engine.IO text packet from the client. Returns frames to send back.
async fn handle_packet(
    state: &AppState,
    key: &str,
    sock_id: u64,
    text: &str,
    client: &mut ClientState,
) -> PacketOutcome {
    let Some(eio_type) = text.chars().next().and_then(|c| c.to_digit(10)) else {
        return PacketOutcome::Ignore;
    };
    match eio_type {
        // EIO ping from client (v3-style) — answer with pong anyway.
        2 => return PacketOutcome::Frames(vec!["3".into()]),
        3 => return PacketOutcome::Pong,
        1 => return PacketOutcome::Close,
        4 => {}
        _ => return PacketOutcome::Ignore,
    }
    let sio = &text[1..];
    let Some(sio_type) = sio.chars().next().and_then(|c| c.to_digit(10)) else {
        return PacketOutcome::Ignore;
    };
    match sio_type {
        // CONNECT — the handshake auth object carries jwtOpen at the TOP
        // level (`payload.token`); `payload.data` is the client's openCmd
        // whose `token` field is a hardcoded sdkjs placeholder, never the JWT.
        0 => {
            let payload: Value = serde_json::from_str(&sio[1..]).unwrap_or(Value::Null);
            let data = payload.get("data").cloned().unwrap_or(payload.clone());
            // The real credential rides as jwtSession (rotated session token)
            // or jwtOpen (the boot JWT) inside `data` — `data.token` is a
            // hardcoded sdkjs placeholder ("fghhfgsjdgfjs"), never the JWT.
            // A top-level `token` only exists while jwtOpen was still set at
            // _initSocksJs time; after the first auth the client clears it,
            // so reconnects authenticate via data.jwt*/data.jwtSession.
            fn cred<'v>(v: &'v Value, k: &str) -> Option<&'v str> {
                v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
            }
            let token = cred(&payload, "token")
                .or_else(|| cred(&data, "jwtSession"))
                .or_else(|| cred(&data, "jwtOpen"))
                .or_else(|| cred(&data, "token"))
                .unwrap_or("");
            let docid = data
                .get("docid")
                .and_then(Value::as_str)
                .or_else(|| payload.get("docid").and_then(Value::as_str))
                .unwrap_or(key);
            match verify_token(state, docid, token).await {
                Some(write) if docid == key => client.can_write = write,
                _ => {
                    // No payload logging — the CONNECT frame carries the
                    // office JWT, which must not land in the daemon log.
                    tracing::info!(key = %key, sock = sock_id, docid = %docid, "docstorage: CONNECT unauthorized");
                    return PacketOutcome::Frames(vec!["44{\"message\":\"unauthorized\"}".into()]);
                }
            }
            let mut frames = vec![format!("40{{\"sid\":\"{sock_id}\"}}")];
            frames.push(msg_frame(&json!({
                "type": "license",
                "license": {
                    // mode is AscCommon.c_oLicenseMode — 0=None, 1=Trial,
                    // 2=Developer, 4=Limited. Anything with Trial|Developer
                    // bits paints the editor's side "DEVELOPER MODE" strip,
                    // so this must stay 0.
                    "type": 3, "light": false, "mode": 0, "rights": 1,
                    "buildVersion": "9.3.4", "buildNumber": 1,
                    "protectionSupport": false, "isAnonymousSupport": true,
                    "liveViewerSupport": false, "branding": false,
                    "customization": false, "advancedApi": true,
                },
            })));
            PacketOutcome::Frames(frames)
        }
        // EVENT — ["message", {...}] is the only event the docstorage uses.
        2 => {
            let arr: Value = serde_json::from_str(&sio[1..]).unwrap_or(Value::Null);
            let msg = arr.get(1).cloned().unwrap_or(Value::Null);
            handle_message(state, key, sock_id, msg, client).await
        }
        // BINARY_EVENT — header "5<n>-[...]"; attachments follow as binary
        // frames. We never emit binary, so just buffer for the count.
        5 => {
            let (count, rest) = split_binary_header(sio);
            client.pending_binary = Some((rest.as_bytes().to_vec(), count));
            PacketOutcome::Ignore
        }
        // DISCONNECT / CONNECT_ERROR / ACK / BINARY_ACK — nothing to do.
        _ => PacketOutcome::Ignore,
    }
}

fn split_binary_header(sio: &str) -> (usize, &str) {
    // "5<attachments>-<json>"
    let after5 = &sio[1..];
    let Some(dash) = after5.find('-') else {
        return (0, "null");
    };
    let count = after5[..dash].parse::<usize>().unwrap_or(0);
    (count, &after5[dash + 1..])
}

async fn handle_message(
    state: &AppState,
    key: &str,
    sock_id: u64,
    msg: Value,
    client: &mut ClientState,
) -> PacketOutcome {
    let Some(mtype) = msg.get("type").and_then(Value::as_str) else {
        return PacketOutcome::Ignore;
    };
    let hub = &state.office_docs;
    match mtype {
        "auth" => {
            // The auth message must name the same doc key the socket was
            // opened for — a mismatched docid would join the wrong room.
            if msg
                .get("docid")
                .and_then(Value::as_str)
                .map(|d| d != key)
                .unwrap_or(false)
            {
                return PacketOutcome::Close;
            }
            // The message's own `token` field is the sdkjs placeholder, never
            // the JWT — the real credential rides as jwtOpen/jwtSession (and
            // was already verified on CONNECT).
            if !client.authed {
                let jwt = msg
                    .get("jwtSession")
                    .and_then(Value::as_str)
                    .or_else(|| msg.get("jwtOpen").and_then(Value::as_str))
                    .unwrap_or("");
                if !jwt.is_empty() && verify_token(state, key, jwt).await.is_none() {
                    return PacketOutcome::Close;
                }
            }
            match hub.auth(key, sock_id, &msg, client.can_write).await {
                Ok((participant, mut frames, peer_frame)) => {
                    client.authed = true;
                    client.participant = Some(participant.clone());
                    // The client wipes its open-token on every auth reply and
                    // keeps only the `jwt` we hand back (_onRefreshToken) —
                    // without one the next reconnect's CONNECT carries no
                    // credential and our socket layer refuses it. Mint a
                    // fresh office token bound to the same user+file.
                    if let Some((drive_id, path)) = state.office_docs.binding(key).await
                        && let Ok(jwt) = state.auth.issue_office_token(
                            &participant.id_original,
                            &drive_id,
                            &path,
                            client.can_write,
                            OFFICE_TOKEN_TTL_SECS,
                        )
                    {
                        for f in &mut frames {
                            if f.get("type").and_then(Value::as_str) == Some("auth")
                                && f.get("result").and_then(Value::as_i64) == Some(1)
                            {
                                f["jwt"] = json!(jwt);
                            }
                        }
                    }
                    // openCmd → documentOpen with this key's bundle urls.
                    if msg.get("openCmd").is_some() {
                        let urls = bundle_urls(state, key).await;
                        if let Some(open) = hub.open_urls(key, &urls).await {
                            frames.push(open);
                        } else {
                            frames.push(json!({
                                "type": "documentOpen",
                                "data": { "type": "open", "status": "err", "data": "-80" },
                            }));
                        }
                    }
                    // Tell peers a participant appeared.
                    if let Some(state_frame) = connect_state(state, key).await {
                        hub.relay(key, sock_id, state_frame).await;
                    }
                    if let Some(b) = peer_frame {
                        hub.relay(key, sock_id, b).await;
                    }
                    PacketOutcome::Frames(frames.into_iter().map(|v| msg_frame(&v)).collect())
                }
                // DS sendFileErrorAuth: a stale restore gets an explicit error
                // so the client reloads instead of silently diverging.
                Err(HubError::Stale) => PacketOutcome::Frames(vec![msg_frame(&json!({
                    "type": "error",
                    "description": "Restore error. Document modified.",
                    "code": 4010,
                }))]),
                Err(_) => PacketOutcome::Frames(vec![msg_frame(&json!({
                    "type": "auth", "result": 0,
                }))]),
            }
        }
        "changes" | "saveChanges" => match hub.save_changes(key, sock_id, &msg).await {
            Ok((replies, broadcast)) => {
                if let Some(b) = broadcast {
                    hub.relay(key, sock_id, b).await;
                }
                PacketOutcome::Frames(replies.iter().map(msg_frame).collect())
            }
            Err(_) => PacketOutcome::Ignore,
        },
        "getLock" => match hub.get_lock(key, sock_id, &msg).await {
            Ok((reply, broadcast)) => {
                hub.relay(key, sock_id, broadcast).await;
                PacketOutcome::Frames(vec![msg_frame(&reply)])
            }
            Err(_) => PacketOutcome::Ignore,
        },
        "unLock" | "releaseLocks" | "unLockDocument" => {
            match hub.unlock(key, sock_id, &msg).await {
                Ok((replies, broadcast)) => {
                    if let Some(b) = broadcast {
                        hub.relay(key, sock_id, b).await;
                    }
                    PacketOutcome::Frames(replies.iter().map(msg_frame).collect())
                }
                Err(_) => PacketOutcome::Ignore,
            }
        }
        "isSaveLock" => match hub.is_save_lock(key, sock_id).await {
            Ok(reply) => PacketOutcome::Frames(vec![msg_frame(&reply)]),
            Err(_) => PacketOutcome::Ignore,
        },
        // DS sends unSaveLock to the asker only — a peer seeing it would end
        // its own in-flight save state machine early.
        "unSaveLock" => match hub.un_save_lock(key, sock_id).await {
            Ok(Some(reply)) => PacketOutcome::Frames(vec![msg_frame(&reply)]),
            _ => PacketOutcome::Ignore,
        },
        "cursor" => {
            // DS shape: {type:cursor, messages:[{cursor,time,user,
            // useridoriginal}]} — the sdk reads data.messages and ignores a
            // bare `cursor` field.
            let mut m = json!({
                "cursor": msg.get("cursor").cloned().unwrap_or(Value::Null),
                "time": crate::office::office_docs::now_ms(),
            });
            if let Some(p) = &client.participant {
                m["user"] = json!(p.id);
                m["useridoriginal"] = json!(p.id_original);
            }
            hub.relay(key, sock_id, json!({ "type": "cursor", "messages": [m] }))
                .await;
            PacketOutcome::Ignore
        }
        "message" => {
            // DS shape: {type:message, messages:[{docid,message,time,user,
            // useridoriginal,username}]} — sent to peers AND echoed back to
            // the sender (the chat UI renders its own message from the echo).
            let mut m = json!({
                "docid": key,
                "message": msg.get("message").cloned().unwrap_or(Value::Null),
                "time": crate::office::office_docs::now_ms(),
            });
            if let Some(p) = &client.participant {
                m["user"] = json!(p.id);
                m["useridoriginal"] = json!(p.id_original);
                m["username"] = json!(p.username);
            }
            let frame = json!({ "type": "message", "messages": [m] });
            hub.relay(key, sock_id, frame.clone()).await;
            PacketOutcome::Frames(vec![msg_frame(&frame)])
        }
        // Luna-only save election — deliberately NOT the sdk's isSaveLock:
        // those frames move the client's connection state (its askLock calls
        // buffer until unSaveLock lands), so holding them across a whole
        // serialize+upload freezes the saver's editor. This election only
        // excludes concurrent serialize+uploads; op flushes flow through.
        "lunaSaveLock" => match hub.luna_save_lock(key, sock_id).await {
            Ok(reply) => PacketOutcome::Frames(vec![msg_frame(&reply)]),
            Err(_) => PacketOutcome::Ignore,
        },
        "lunaSaveEnd" => {
            hub.luna_save_end(key, sock_id).await;
            PacketOutcome::Ignore
        }
        // Luna-only notice: the save-elected client finished serializing and
        // uploading the live document — peers clear their dirty flags and
        // stand down their autosaves. Unknown to the sdk (falls through its
        // dispatch), observed by the host's own socket listener.
        "lunaSaved" => {
            // Pass `changesIndex` through — peers compare it to their own op
            // index to decide whether the snapshot covered their tail edits.
            let mut out = json!({
                "type": "lunaSaved",
                "changesIndex": msg.get("changesIndex").cloned().unwrap_or(Value::Null),
            });
            if let Some(p) = &client.participant {
                out["userIdOriginal"] = json!(p.id_original);
                out["userIndexOriginal"] = json!(p.index_user);
            }
            hub.relay(key, sock_id, out).await;
            PacketOutcome::Ignore
        }
        "getMessages" => PacketOutcome::Frames(vec![msg_frame(&json!({
            "type": "message", "messages": Vec::<Value>::new(),
        }))]),
        "getUsers" => {
            let users = participants_json(state, key).await;
            PacketOutcome::Frames(vec![msg_frame(
                &json!({ "type": "getUsers", "users": users }),
            )])
        }
        "getLocks" => {
            let locks = lock_list_json(state, key).await;
            PacketOutcome::Frames(vec![msg_frame(
                &json!({ "type": "getLock", "locks": locks }),
            )])
        }
        "close" => PacketOutcome::Close,
        // One-way client → server notices and requests we don't serve:
        // authChangesAck paces DS's chunked replay (we send one chunk),
        // clientLog is a debug channel, extendSession answers DS's idle
        // close (we never send it), spellCheck needs the (empty) spell
        // service, forceSaveStart/rpc/version calls have no lunad side.
        // None of these fan out to peers under DS either.
        "authChangesAck" | "extendSession" | "clientLog" | "versionHistory" | "forceSaveStart"
        | "updateVersion" | "rpc" | "setpassword" | "getIndexUser" | "openDocument"
        | "spellCheck" => PacketOutcome::Ignore,
        _ => {
            // Unknown types get dropped, not relayed — DS never fans them
            // out and a stray type reaching peers only confuses the room.
            tracing::debug!(key = %key, sock = sock_id, mtype, "docstorage: unhandled message type");
            PacketOutcome::Ignore
        }
    }
}

async fn connect_state(state: &AppState, key: &str) -> Option<Value> {
    let users = participants_json(state, key).await;
    Some(json!({
        "type": "connectState",
        "participantsTimestamp": crate::office::office_docs::now_ms(),
        "participants": users,
        "waitAuth": false,
    }))
}

async fn participants_json(state: &AppState, key: &str) -> Value {
    state.office_docs.participants_json(key).await
}

async fn lock_list_json(state: &AppState, key: &str) -> Value {
    state.office_docs.lock_list_json(key).await
}

/// Bundle file list the open command resolves to — `Editor.bin`, `media/*`,
/// `origin.<ext>`, all served by the REST bundle endpoints.
async fn bundle_urls(state: &AppState, key: &str) -> Value {
    let dir = state.data_dir.join("office_bundles").join(key);
    let mut urls = serde_json::Map::new();
    let read = tokio::fs::read_dir(&dir).await;
    let mut entries = match read {
        Ok(e) => e,
        Err(_) => return Value::Object(urls),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "media" && entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            if let Ok(mut m) = tokio::fs::read_dir(entry.path()).await {
                while let Ok(Some(f)) = m.next_entry().await {
                    let fname = f.file_name().to_string_lossy().to_string();
                    urls.insert(
                        format!("media/{fname}"),
                        json!(format!("/api/v1/office/bundle/{key}/media/{fname}")),
                    );
                }
            }
        } else {
            urls.insert(
                name.clone(),
                json!(format!("/api/v1/office/bundle/{key}/{name}")),
            );
        }
    }
    Value::Object(urls)
}

/// Verify the office JWT and that the claimed doc key is bound to the same
/// drive+path the token was minted for. Returns the token's write bit.
///
/// Sessions (and their bindings) live in memory — a daemon restart or the
/// idle-session sweep drops them while open editors still hold valid tokens.
/// Rather than refusing those reconnects forever (`CONNECT unauthorized`
/// loop → dead editor), recreate the room from the verified claims and mark
/// it `resurrected` so dead-era sessionId restores are refused at `auth`.
async fn verify_token(state: &AppState, key: &str, token: &str) -> Option<bool> {
    let claims = state.auth.verify_office_token(token).ok()?;
    match state.office_docs.binding(key).await {
        Some((drive_id, path)) if drive_id == claims.drive_id && path == claims.path => {
            Some(claims.write)
        }
        Some(_) => None,
        None => {
            state
                .office_docs
                .resurrect_key(key, &claims.drive_id, &claims.path)
                .await;
            Some(claims.write)
        }
    }
}

fn msg_frame(v: &Value) -> String {
    format!("42[\"message\",{v}]")
}

async fn send_raw<S>(sink: &mut S, text: &str) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    sink.send(Message::Text(text.to_string().into()))
        .await
        .map_err(|_| ())
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}
