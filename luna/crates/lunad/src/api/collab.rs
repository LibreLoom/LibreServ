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
        .join(room_key.clone(), user_id.clone(), username, can_write)
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
    // `can_write` is a snapshot from the upgrade — a member whose grant is
    // revoked or narrowed mid-session must stop injecting ops into the
    // room. It is re-derived from the live DB on every heartbeat tick.
    let mut can_write = can_write;

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
                // Live re-check — the same pattern the docstorage socket
                // uses. `None` means even read access is gone (member row
                // removed, user deleted): the session is over, not merely
                // demoted.
                match member_caps_now(&state, &user_id, &drive_id, &path) {
                    None => {
                        let _ = send_json(
                            &mut sink,
                            &ServerEvent::Error {
                                message: "Your access to this file was removed. Close it and open it again if it is shared with you."
                                    .into(),
                            },
                        )
                        .await;
                        break;
                    }
                    Some(now) => {
                        if can_write && !now {
                            // Downgrade in place: later ops fail the hub's
                            // write gate. A *regained* grant still needs a
                            // reconnect so the client mounts editing UI.
                            can_write = false;
                            let _ = send_json(
                                &mut sink,
                                &ServerEvent::Error {
                                    message: "You no longer have permission to edit this file. You can keep viewing it."
                                        .into(),
                                },
                            )
                            .await;
                        }
                    }
                }
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
    // The link's password lockout keys on this address — hand it the
    // resolved client, not the tunnel peer, so Connect users don't share
    // one lockout bucket.
    let resolved = SocketAddr::new(crate::api::auth::client_ip(&addr, &headers), addr.port());
    let (link, proof) =
        match crate::api::access::resolve_public_link(&state, &resolved, &token, &headers) {
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

/// Re-derive a joined session's grant from the live DB, like
/// `office::current_office_access` does for office tokens. `None` means
/// the user or their view access is gone — drop the socket. `Some(w)` is
/// the current write bit: `true` only while the member still holds
/// `CAP_EDIT` on the file.
fn member_caps_now(state: &AppState, user_id: &str, drive_id: &str, path: &str) -> Option<bool> {
    let conn = state.db.lock().ok()?;
    // Guest sessions authenticate through the link, not a user row —
    // re-check the link the same way member grants are re-checked. A
    // deleted or expired link ends the session; a narrowed one drops the
    // write bit. (The first heartbeat tick fires immediately, so this
    // must be right for guests or they die on connect.)
    if let Some(link_id) = user_id.strip_prefix("guest:") {
        let link = crate::db::get_access_link(&conn, link_id).ok()??;
        if link.expires_at.is_some_and(|t| t <= crate::db::now_unix()) {
            return None;
        }
        return Some(link.caps & crate::access::CAP_EDIT != 0);
    }
    let row = crate::db::get_user(&conn, user_id).ok()??;
    let user = CurrentUser {
        id: row.id,
        username: row.username,
        role: row.role,
    };
    if !crate::auth::has_cap(&user, &conn, drive_id, path, crate::access::CAP_VIEW) {
        return None;
    }
    Some(crate::auth::has_cap(
        &user,
        &conn,
        drive_id,
        path,
        crate::access::CAP_EDIT,
    ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::DriveManager;
    use crate::drives::mount::shared_mock;

    /// A real `AppState` on a scratch dir — `member_caps_now` reads the
    /// live `users`/`access_members` tables, so the tests exercise the
    /// whole path the socket's heartbeat takes.
    fn test_state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&dir.path().join("luna.db")).unwrap();
        let drive_manager = std::sync::Arc::new(DriveManager::new(shared_mock(), dir.path()));
        let state = AppState::new(conn, drive_manager, dir.path());
        (dir, state)
    }

    fn member_row(id: &str, user: &str, caps: i64) -> crate::db::AccessMemberRow {
        crate::db::AccessMemberRow {
            id: id.into(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "d".into(),
            path: String::new(), // whole-drive grant
            album_id: String::new(),
            user_id: user.into(),
            caps,
            created_by: "a".into(),
        }
    }

    #[test]
    fn member_caps_now_tracks_live_grants() {
        let (_dir, state) = test_state();
        {
            let conn = state.db.lock().unwrap();
            crate::db::insert_user(&conn, "u1", "ada", "Ada", "hash", "user").unwrap();
            crate::db::insert_access_member(&conn, &member_row("m1", "u1", crate::access::CAP_ALL))
                .unwrap();
        }
        // Full grant → writable.
        assert_eq!(member_caps_now(&state, "u1", "d", "a.docx"), Some(true));

        // Grant narrowed to view → session would downgrade in place.
        {
            let conn = state.db.lock().unwrap();
            crate::db::update_access_member_caps(&conn, "m1", crate::access::CAP_VIEW).unwrap();
        }
        assert_eq!(member_caps_now(&state, "u1", "d", "a.docx"), Some(false));

        // Grant removed → `None`, the socket drops entirely.
        {
            let conn = state.db.lock().unwrap();
            crate::db::delete_access_member(&conn, "m1").unwrap();
        }
        assert_eq!(member_caps_now(&state, "u1", "d", "a.docx"), None);

        // A deleted user is gone too — `get_user` misses.
        assert_eq!(member_caps_now(&state, "ghost", "d", "a.docx"), None);
    }

    #[test]
    fn member_caps_now_admin_always_writable() {
        let (_dir, state) = test_state();
        {
            let conn = state.db.lock().unwrap();
            crate::db::insert_user(&conn, "root", "root", "Root", "hash", "admin").unwrap();
        }
        // Admins hold every capability without member rows.
        assert_eq!(member_caps_now(&state, "root", "d", "a.docx"), Some(true));
    }

    fn link_row(id: &str, caps: i64, expires_at: Option<i64>) -> crate::db::AccessLinkRow {
        crate::db::AccessLinkRow {
            id: id.into(),
            token_hash: format!("hash-{id}"),
            token: String::new(),
            subject_kind: crate::access::KIND_PATH.into(),
            drive_id: "d".into(),
            path: "a.drawio".into(),
            album_id: String::new(),
            caps,
            password_hash: String::new(),
            expires_at,
            created_by: "u1".into(),
            created_at: crate::db::now_unix(),
        }
    }

    /// Guests join as `guest:{link_id}` — the heartbeat must re-check the
    /// link instead of looking for a user row, or the first tick kills the
    /// socket outright (tokio's first interval tick fires immediately).
    #[test]
    fn member_caps_now_guest_follows_the_link() {
        let (_dir, state) = test_state();
        {
            let conn = state.db.lock().unwrap();
            crate::db::insert_access_link(
                &conn,
                &link_row(
                    "l1",
                    crate::access::CAP_VIEW | crate::access::CAP_EDIT,
                    None,
                ),
            )
            .unwrap();
        }
        // Live link → session survives with its write bit.
        assert_eq!(
            member_caps_now(&state, "guest:l1", "d", "a.drawio"),
            Some(true)
        );

        // Link narrowed to view-only → write bit drops, session stays.
        {
            let conn = state.db.lock().unwrap();
            let row = link_row("l1", crate::access::CAP_VIEW, None);
            crate::db::update_access_link(&conn, &row).unwrap();
        }
        assert_eq!(
            member_caps_now(&state, "guest:l1", "d", "a.drawio"),
            Some(false)
        );

        // Link expired → `None`, the socket closes.
        {
            let conn = state.db.lock().unwrap();
            let mut row = link_row("l1", crate::access::CAP_VIEW, None);
            row.expires_at = Some(crate::db::now_unix() - 1);
            crate::db::update_access_link(&conn, &row).unwrap();
        }
        assert_eq!(member_caps_now(&state, "guest:l1", "d", "a.drawio"), None);

        // Link deleted (revoked) → `None`.
        {
            let conn = state.db.lock().unwrap();
            let mut row = link_row("l1", crate::access::CAP_VIEW, None);
            row.expires_at = None;
            crate::db::update_access_link(&conn, &row).unwrap();
            crate::db::delete_access_link(&conn, "l1").unwrap();
        }
        assert_eq!(member_caps_now(&state, "guest:l1", "d", "a.drawio"), None);
    }
}
