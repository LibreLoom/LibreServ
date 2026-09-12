//! In-memory collaborative editing rooms for Luna Files.
//!
//! Lunad never interprets document ops — it authenticates peers, tracks
//! presence, assigns a monotonic sequence number, and fans frames out.
//! Document bytes stay on the drive and move over the normal HTTP files API.
//! Empty rooms are dropped after a short idle period.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast};

/// Soft caps so a misbehaving client cannot grow lunad without bound.
pub const MAX_ROOMS: usize = 64;
pub const MAX_PEERS_PER_ROOM: usize = 32;
pub const OP_BACKLOG: usize = 256;
pub const MAX_OP_BYTES: usize = 256 * 1024;
pub const IDLE_EMPTY_SECS: u64 = 60;

static PEER_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct CollabHub {
    inner: Arc<Mutex<HubInner>>,
}

struct HubInner {
    rooms: HashMap<String, Room>,
}

struct Room {
    tx: broadcast::Sender<ServerEvent>,
    peers: HashMap<u64, PeerInfo>,
    seq: u64,
    backlog: Vec<ServerEvent>,
    last_event: Instant,
}

#[derive(Clone, Debug, Serialize)]
pub struct PeerInfo {
    pub peer_id: u64,
    pub user_id: String,
    pub username: String,
    pub color: String,
    pub can_write: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        client_id: String,
        #[serde(default)]
        display_name: Option<String>,
    },
    Op {
        payload: serde_json::Value,
    },
    Presence {
        #[serde(default)]
        cursor: Option<serde_json::Value>,
    },
    Saved {
        #[serde(default)]
        size: Option<u64>,
    },
    Ping,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Welcome {
        peer_id: u64,
        seq: u64,
        peers: Vec<PeerInfo>,
        can_write: bool,
        catchup: Vec<ServerEvent>,
    },
    PeerJoin {
        peer: PeerInfo,
    },
    PeerLeave {
        peer_id: u64,
    },
    Presence {
        peer_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<serde_json::Value>,
    },
    Op {
        seq: u64,
        peer_id: u64,
        payload: serde_json::Value,
    },
    Saved {
        peer_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
    },
    Error {
        message: String,
    },
    Pong,
    Evict {
        reason: String,
    },
}

#[derive(Debug)]
pub enum JoinError {
    TooManyRooms,
    RoomFull,
}

impl CollabHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubInner {
                rooms: HashMap::new(),
            })),
        }
    }

    pub fn room_key(drive_id: &str, path: &str) -> String {
        format!("{drive_id}\n{path}")
    }

    pub async fn join(
        &self,
        room_key: String,
        user_id: String,
        username: String,
        can_write: bool,
    ) -> Result<(u64, broadcast::Receiver<ServerEvent>, ServerEvent), JoinError> {
        let mut hub = self.inner.lock().await;
        if !hub.rooms.contains_key(&room_key) && hub.rooms.len() >= MAX_ROOMS {
            return Err(JoinError::TooManyRooms);
        }
        let room = hub.rooms.entry(room_key).or_insert_with(|| {
            let (tx, _) = broadcast::channel(512);
            Room {
                tx,
                peers: HashMap::new(),
                seq: 0,
                backlog: Vec::new(),
                last_event: Instant::now(),
            }
        });
        if room.peers.len() >= MAX_PEERS_PER_ROOM {
            return Err(JoinError::RoomFull);
        }
        let peer_id = PEER_SEQ.fetch_add(1, Ordering::Relaxed);
        let peer = PeerInfo {
            peer_id,
            username: session_username(room, &user_id, &username),
            user_id,
            color: color_for_peer(peer_id),
            can_write,
        };
        room.peers.insert(peer_id, peer.clone());
        room.last_event = Instant::now();
        // Subscribe before PeerJoin so this peer does not miss concurrent ops
        // between catchup clone and subscribe (and so we can skip our own join).
        let rx = room.tx.subscribe();
        let peers: Vec<_> = room.peers.values().cloned().collect();
        let catchup = room.backlog.clone();
        let welcome = ServerEvent::Welcome {
            peer_id,
            seq: room.seq,
            peers,
            can_write,
            catchup,
        };
        let _ = room.tx.send(ServerEvent::PeerJoin { peer });
        Ok((peer_id, rx, welcome))
    }

    pub async fn leave(&self, room_key: &str, peer_id: u64) {
        let mut hub = self.inner.lock().await;
        let Some(room) = hub.rooms.get_mut(room_key) else {
            return;
        };
        room.peers.remove(&peer_id);
        room.last_event = Instant::now();
        let _ = room.tx.send(ServerEvent::PeerLeave { peer_id });
    }

    pub async fn handle(
        &self,
        room_key: &str,
        peer_id: u64,
        can_write: bool,
        msg: ClientMsg,
    ) -> Option<ServerEvent> {
        let mut hub = self.inner.lock().await;
        let Some(room) = hub.rooms.get_mut(room_key) else {
            return Some(ServerEvent::Error {
                message: "This editing session ended. Close and open the file again.".into(),
            });
        };
        room.last_event = Instant::now();
        match msg {
            ClientMsg::Hello { .. } => None,
            ClientMsg::Ping => Some(ServerEvent::Pong),
            ClientMsg::Presence { cursor } => {
                let _ = room.tx.send(ServerEvent::Presence { peer_id, cursor });
                None
            }
            ClientMsg::Op { payload } => {
                if !can_write {
                    return Some(ServerEvent::Error {
                        message:
                            "You can read this file, but you do not have permission to edit it."
                                .into(),
                    });
                }
                let payload_bytes = payload.to_string().len();
                if payload_bytes > MAX_OP_BYTES {
                    return Some(ServerEvent::Error {
                        message: "That edit is too large to share live. Save the file instead."
                            .into(),
                    });
                }
                room.seq += 1;
                let event = ServerEvent::Op {
                    seq: room.seq,
                    peer_id,
                    payload,
                };
                push_backlog(&mut room.backlog, event.clone());
                let _ = room.tx.send(event);
                None
            }
            ClientMsg::Saved { size } => {
                if !can_write {
                    return Some(ServerEvent::Error {
                        message:
                            "You can read this file, but you do not have permission to edit it."
                                .into(),
                    });
                }
                let _ = room.tx.send(ServerEvent::Saved { peer_id, size });
                None
            }
        }
    }

    /// Drop empty rooms that have been idle past [`IDLE_EMPTY_SECS`].
    pub async fn evict_idle(&self) {
        let mut hub = self.inner.lock().await;
        let cutoff = Duration::from_secs(IDLE_EMPTY_SECS);
        hub.rooms.retain(|_, room| {
            if room.peers.is_empty() && room.last_event.elapsed() > cutoff {
                let _ = room.tx.send(ServerEvent::Evict {
                    reason: "idle".into(),
                });
                false
            } else {
                true
            }
        });
    }

    #[cfg(test)]
    pub async fn room_count(&self) -> usize {
        self.inner.lock().await.rooms.len()
    }

    #[cfg(test)]
    pub async fn peer_count(&self, room_key: &str) -> usize {
        self.inner
            .lock()
            .await
            .rooms
            .get(room_key)
            .map(|r| r.peers.len())
            .unwrap_or(0)
    }
}

impl Default for CollabHub {
    fn default() -> Self {
        Self::new()
    }
}

fn push_backlog(backlog: &mut Vec<ServerEvent>, event: ServerEvent) {
    backlog.push(event);
    if backlog.len() > OP_BACKLOG {
        let overflow = backlog.len() - OP_BACKLOG;
        backlog.drain(0..overflow);
    }
}

/// Display name for a joining peer. The first session of a user keeps the bare
/// name; concurrent extra sessions of the same `user_id` get `"{base} ({n})"`
/// with the lowest free `n >= 2`. Numbers are assigned at join time only —
/// peers are never renumbered when another session leaves.
fn session_username(room: &Room, user_id: &str, base: &str) -> String {
    if !room.peers.values().any(|p| p.user_id == user_id) {
        return base.to_string();
    }
    let mut n = 2u64;
    loop {
        let candidate = format!("{base} ({n})");
        if !room
            .peers
            .values()
            .any(|p| p.user_id == user_id && p.username == candidate)
        {
            return candidate;
        }
        n += 1;
    }
}

fn color_for_peer(peer_id: u64) -> String {
    const PALETTE: &[&str] = &[
        "#5B8A72", "#6B7C9B", "#8B6B5B", "#6B8B5B", "#8B5B7C", "#5B7C8B", "#8B8B5B", "#7C5B8B",
    ];
    PALETTE[(peer_id as usize) % PALETTE.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn join_leave_and_idle_evict() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("drive-a", "docs/a.docx");
        let (pid, _rx, welcome) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        match welcome {
            ServerEvent::Welcome {
                peer_id,
                can_write,
                peers,
                ..
            } => {
                assert_eq!(peer_id, pid);
                assert!(can_write);
                assert_eq!(peers.len(), 1);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(hub.peer_count(&key).await, 1);
        hub.leave(&key, pid).await;
        assert_eq!(hub.peer_count(&key).await, 0);
        {
            let mut inner = hub.inner.lock().await;
            if let Some(room) = inner.rooms.get_mut(&key) {
                room.last_event = Instant::now() - Duration::from_secs(IDLE_EMPTY_SECS + 1);
            }
        }
        hub.evict_idle().await;
        assert_eq!(hub.room_count().await, 0);
    }

    #[tokio::test]
    async fn fans_out_ops_with_seq() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("d", "f.docx");
        let (a, mut rx_a, _) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        let (_b, mut rx_b, _) = hub
            .join(key.clone(), "u2".into(), "Bea".into(), true)
            .await
            .unwrap();
        while rx_a.try_recv().is_ok() {}
        while rx_b.try_recv().is_ok() {}

        let reply = hub
            .handle(
                &key,
                a,
                true,
                ClientMsg::Op {
                    payload: serde_json::json!({"engine":"eurooffice","text":"hi"}),
                },
            )
            .await;
        assert!(reply.is_none());
        let event = rx_b.recv().await.unwrap();
        match event {
            ServerEvent::Op {
                seq,
                peer_id,
                payload,
            } => {
                assert_eq!(seq, 1);
                assert_eq!(peer_id, a);
                assert_eq!(payload["text"], "hi");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn multi_writer_live_ops() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("d", "f.docx");
        let (a, mut rx_a, welcome_a) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        match welcome_a {
            ServerEvent::Welcome { can_write, .. } => assert!(can_write),
            other => panic!("unexpected {other:?}"),
        }
        let (b, mut rx_b, welcome_b) = hub
            .join(key.clone(), "u2".into(), "Bea".into(), true)
            .await
            .unwrap();
        match welcome_b {
            ServerEvent::Welcome { can_write, .. } => assert!(can_write),
            other => panic!("unexpected {other:?}"),
        }
        while rx_a.try_recv().is_ok() {}
        while rx_b.try_recv().is_ok() {}
        assert!(
            hub.handle(
                &key,
                a,
                true,
                ClientMsg::Op {
                    payload: serde_json::json!({"text":"from-a"}),
                },
            )
            .await
            .is_none()
        );
        let from_a = rx_b.recv().await.unwrap();
        assert!(matches!(from_a, ServerEvent::Op { peer_id, .. } if peer_id == a));
        // Sender also sees its own fan-out; drain it so the next recv is B's op.
        let _ = rx_a.recv().await.unwrap();
        assert!(
            hub.handle(
                &key,
                b,
                true,
                ClientMsg::Op {
                    payload: serde_json::json!({"text":"from-b"}),
                },
            )
            .await
            .is_none()
        );
        let from_b = rx_a.recv().await.unwrap();
        assert!(matches!(from_b, ServerEvent::Op { peer_id, .. } if peer_id == b));
    }

    #[tokio::test]
    async fn rejects_write_when_read_only() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("d", "f.docx");
        let (pid, _, _) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), false)
            .await
            .unwrap();
        let reply = hub
            .handle(
                &key,
                pid,
                false,
                ClientMsg::Op {
                    payload: serde_json::json!({}),
                },
            )
            .await;
        assert!(matches!(reply, Some(ServerEvent::Error { .. })));
    }

    fn self_name(welcome: &ServerEvent, peer_id: u64) -> String {
        match welcome {
            ServerEvent::Welcome { peers, .. } => peers
                .iter()
                .find(|p| p.peer_id == peer_id)
                .map(|p| p.username.clone())
                .expect("welcome must list the joining peer"),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn peer_names(welcome: &ServerEvent) -> Vec<String> {
        match welcome {
            ServerEvent::Welcome { peers, .. } => {
                peers.iter().map(|p| p.username.clone()).collect()
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn numbers_concurrent_sessions_of_same_user() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("d", "f.docx");
        let (p1, mut rx1, w1) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w1, p1), "Ada");

        // Second session of the same user is numbered; the broadcast to the
        // first session carries the suffixed name too.
        let (p2, _rx2, w2) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w2, p2), "Ada (2)");
        let mut names = peer_names(&w2);
        names.sort();
        assert_eq!(names, vec!["Ada", "Ada (2)"]);

        let (p3, _rx3, w3) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w3, p3), "Ada (3)");

        let mut joined = Vec::new();
        while let Ok(ev) = rx1.try_recv() {
            if let ServerEvent::PeerJoin { peer } = ev {
                joined.push(peer.username);
            }
        }
        assert_eq!(joined, vec!["Ada", "Ada (2)", "Ada (3)"]);

        // A different user with the same display name is not numbered —
        // numbering keys on user_id, not on the name string.
        let (p4, _rx4, w4) = hub
            .join(key.clone(), "u2".into(), "Ada".into(), false)
            .await
            .unwrap();
        assert_eq!(self_name(&w4, p4), "Ada");
    }

    #[tokio::test]
    async fn reuses_lowest_free_session_index() {
        let hub = CollabHub::new();
        let key = CollabHub::room_key("d", "f.docx");
        let (p1, _r1, _) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        let (p2, _r2, _) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        let (_p3, _r3, _) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();

        // "Ada (2)" leaving frees index 2 for the next session.
        hub.leave(&key, p2).await;
        let (p4, _r4, w4) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w4, p4), "Ada (2)");

        // The unnumbered first session leaving frees no numbered slot, so the
        // next join takes the lowest free index above the survivors.
        hub.leave(&key, p1).await;
        let (p5, _r5, w5) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w5, p5), "Ada (4)");

        // Once every session of the user has left, the next one is plain again.
        hub.leave(&key, p5).await;
        hub.leave(&key, p4).await;
        // p3's session "Ada (3)" still holds the room; drop it too.
        hub.leave(&key, _p3).await;
        let (p6, _r6, w6) = hub
            .join(key.clone(), "u1".into(), "Ada".into(), true)
            .await
            .unwrap();
        assert_eq!(self_name(&w6, p6), "Ada");
    }
}
