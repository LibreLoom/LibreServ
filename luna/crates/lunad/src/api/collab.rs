//! WebSocket endpoint for collaborative file editing.
//!
//! `GET /api/v1/collab/ws?drive_id=&path=` upgrades after the normal auth guard.

use std::time::Duration;

use std::net::SocketAddr;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::AppState;
use crate::api::response::json_error;
use crate::auth::CurrentUser;
use crate::files::{self, FilesError};
use crate::office::collab::{ClientMsg, CollabHub, JoinError, ServerEvent};

#[derive(Debug, Deserialize)]
pub struct CollabQuery {
    pub drive_id: String,
    pub path: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/collab/ws", get(upgrade))
        .route("/s/{token}/collab/ws", get(guest_upgrade))
}

async fn upgrade(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<CollabQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let path = normalize_rel(&query.path);
    if path.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Choose a file to edit together.",
        ));
    }
    ensure_file(&state, &query.drive_id, &path)?;
    if !user_can(&state, &user, &query.drive_id, &path, false)? {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "You don't have permission to view this file.",
        ));
    }
    let can_write = user_can(&state, &user, &query.drive_id, &path, true).unwrap_or(false);

    let drive_id = query.drive_id;
    let user_id = user.id.clone();
    let username = user.username.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        session(state, socket, drive_id, path, user_id, username, can_write).await;
    }))
}

async fn session(
    state: AppState,
    socket: WebSocket,
    drive_id: String,
    path: String,
    user_id: String,
    username: String,
    can_write: bool,
) {
    let room_key = CollabHub::room_key(&drive_id, &path);
    let (mut sink, mut stream) = socket.split();

    let joined = state
        .collab
        .join(room_key.clone(), user_id, username, can_write)
        .await;
    let (peer_id, mut rx, welcome) = match joined {
        Ok(v) => v,
        Err(err) => {
            let message = match err {
                JoinError::TooManyRooms => {
                    "Too many people are editing files right now. Try again in a minute."
                }
                JoinError::RoomFull => "This file already has too many people editing it.",
            };
            let _ = send_json(
                &mut sink,
                &ServerEvent::Error {
                    message: message.into(),
                },
            )
            .await;
            return;
        }
    };

    if send_json(&mut sink, &welcome).await.is_err() {
        state.collab.leave(&room_key, peer_id).await;
        return;
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let msg = match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(m) => m,
                            Err(_) => {
                                let err = ServerEvent::Error {
                                    message: "Luna could not read that editing message.".into(),
                                };
                                if send_json(&mut sink, &err).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                        };
                        if let Some(reply) = state.collab.handle(&room_key, peer_id, can_write, msg).await
                            && send_json(&mut sink, &reply).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(ev) => {
                        if should_skip_echo(&ev, peer_id) {
                            continue;
                        }
                        if send_json(&mut sink, &ev).await.is_err() {
                            break;
                        }
                        if matches!(ev, ServerEvent::Evict { .. }) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let err = ServerEvent::Error {
                            message: "This editing session fell behind. Reload the file.".into(),
                        };
                        let _ = send_json(&mut sink, &err).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    state.collab.leave(&room_key, peer_id).await;
}

fn should_skip_echo(ev: &ServerEvent, peer_id: u64) -> bool {
    match ev {
        ServerEvent::PeerJoin { peer } if peer.peer_id == peer_id => true,
        ServerEvent::Op { peer_id: src, .. } if *src == peer_id => true,
        ServerEvent::Presence { peer_id: src, .. } if *src == peer_id => true,
        ServerEvent::Saved { peer_id: src, .. } if *src == peer_id => true,
        _ => false,
    }
}

async fn send_json<S>(sink: &mut S, event: &ServerEvent) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let Ok(text) = serde_json::to_string(event) else {
        return Err(());
    };
    sink.send(Message::Text(text.into())).await.map_err(|_| ())
}

#[derive(Debug, Deserialize)]
struct GuestCollabQuery {
    #[serde(default)]
    path: String,
}

/// Guest half of the same room members join. The link resolves the file —
/// the query path is relative to the share, never a drive id. View-only
/// links join with `can_write: false` so they follow live edits without
/// sending any. Only diagram files are accepted: a guest must not be able
/// to inject ops into a text or office room.
async fn guest_upgrade(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    Query(query): Query<GuestCollabQuery>,
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
        guest_collab_upgrade(&state, &link, &query, ws),
        &link_id,
        proof,
        &headers,
    )
}

fn guest_collab_upgrade(
    state: &AppState,
    link: &crate::db::AccessLinkRow,
    query: &GuestCollabQuery,
    ws: WebSocketUpgrade,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let rel = crate::api::access::link_file(state, link, &query.path)?;
    if !is_diagram_name(&rel) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Live editing on a shared link is for diagram files.",
        ));
    }
    let can_write = link.caps & crate::access::CAP_EDIT != 0;
    let drive_id = link.drive_id.clone();
    let user_id = format!("guest:{}", link.id);
    let state = state.clone();
    Ok(ws.on_upgrade(move |socket| {
        session(
            state,
            socket,
            drive_id,
            rel,
            user_id,
            "Guest".to_string(),
            can_write,
        )
    }))
}

/// `.drawio`, `.drawio.svg`, and `.drawio.png` — the same names the web UI
/// opens in the diagram editor.
pub(crate) fn is_diagram_name(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    base.ends_with(".drawio") || base.ends_with(".drawio.svg") || base.ends_with(".drawio.png")
}

/// A diagram file just hit disk (or the dirty cache a reader will see).
/// Named coverage trims the replay log; the writer's election is released
/// either way, matching EuroOffice's bundle PUT.
pub(crate) async fn note_diagram_saved(
    state: &AppState,
    drive_id: &str,
    rel: &str,
    user_id: &str,
    coverage: Option<&str>,
) {
    if !is_diagram_name(rel) {
        return;
    }
    let seq = coverage.and_then(|value| value.parse::<u64>().ok());
    state
        .collab
        .file_landed(&CollabHub::room_key(drive_id, rel), user_id, seq)
        .await;
}

fn normalize_rel(path: &str) -> String {
    path.trim().trim_start_matches('/').replace('\\', "/")
}

fn ensure_file(
    state: &AppState,
    drive_id: &str,
    path: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    let (_abs, meta) = files::file_path(&conn, drive_id, path).map_err(map_files_err)?;
    if !meta.is_file() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Luna can only open files for editing together — not folders.",
        ));
    }
    Ok(())
}

fn user_can(
    state: &AppState,
    user: &CurrentUser,
    drive_id: &str,
    path: &str,
    write: bool,
) -> Result<bool, (StatusCode, Json<Value>)> {
    let conn = state.db.lock().map_err(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna's index is busy. Try again.",
        )
    })?;
    Ok(crate::auth::has_cap(
        user,
        &conn,
        drive_id,
        path,
        if write {
            crate::access::CAP_EDIT
        } else {
            crate::access::CAP_VIEW
        },
    ))
}

fn map_files_err(err: FilesError) -> (StatusCode, Json<Value>) {
    match err {
        FilesError::UnknownDrive => json_error(
            StatusCode::NOT_FOUND,
            "Luna doesn't know this drive. Make sure it is plugged in.",
        ),
        FilesError::MissingDriveDb => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            files::MISSING_DRIVE_DB_MSG,
        ),
        FilesError::Path(_) => json_error(StatusCode::NOT_FOUND, "Luna can't find that file."),
        FilesError::Io(_) | FilesError::Db(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Luna couldn't open that file. Try again.",
        ),
    }
}
