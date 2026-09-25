/**
 * Yjs document sync over Luna's collab hub (`/api/v1/collab/ws`).
 *
 * The hub is an authenticated opaque relay — it knows rooms, peers, and
 * presence, but never looks inside payloads. We ride three frame kinds:
 *
 *   op        {k:"u",  d:b64}   Yjs document update (write peers only;
 *                               lands in the room's catchup backlog)
 *   presence  {k:"s1", d:b64}   sync request — our state vector
 *   presence  {k:"s2", d:b64}   sync reply — updates the peer is missing
 *   presence  {k:"a",  d:b64}   awareness update (remote cursors/names)
 *
 * Read-only peers cannot send `op` frames, which is why the whole sync
 * handshake lives on `presence` — a viewer can still fetch the document.
 *
 * Seeding: the file on the drive is the source of truth. The first peer in
 * a room (welcome.peers lists only itself) seeds the shared doc from the
 * fetched content via {@link CollabDocSync#adoptContent}. Later joiners see
 * peers in their welcome, send `s1`, and receive the live document — which
 * may already hold unsaved edits — instead of touching the file bytes.
 */

import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { CollabSocket } from "./office/collabSocket.js";

/** How long a joiner with peers waits for a sync reply before seeding the
 * file content anyway (covers peers that joined but never synced). */
const SEED_FALLBACK_MS = 4000;
/** Re-send the sync request once if no reply has arrived yet. */
const SYNC_RETRY_MS = 1500;

/** @param {Uint8Array} bytes */
function toB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** @param {string} b64 */
function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The slice of CollabSocket this provider needs — structurally satisfied by
 * CollabSocket and by test fakes.
 * @typedef {object} CollabSocketLike
 * @property {((msg: object) => void) | null} onMessage
 * @property {((status: string) => void) | null} onStatus
 * @property {boolean} _closed
 * @property {() => void} connect
 * @property {() => void} close
 * @property {(payload: object) => void} sendOp
 * @property {(cursor: object) => void} sendPresence
 * @property {(size: number) => void} sendSaved
 */

export class CollabDocSync {
  /**
   * @param {{
   *   driveId: string,
   *   path: string,
   *   onPeers?: (peers: object[]) => void,
   *   onStatus?: (status: string) => void,
   *   onPeerSaved?: (peerId: number) => void,
   *   socket?: CollabSocketLike | (() => CollabSocketLike),
   *   solo?: boolean,
   * }} opts `socket` is injectable for tests — an instance or a factory.
   * `solo` skips the hub entirely (link guests have no session): the doc
   * seeds straight from the file and never syncs peers.
   */
  constructor({ driveId, path, onPeers, onStatus, onPeerSaved, socket, solo = false }) {
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("file");
    this.awareness = new Awareness(this.ydoc);
    /** @type {Map<number, object>} peer_id → PeerInfo */
    this.peers = new Map();
    this.peerId = null;
    this._onPeers = onPeers;
    this._onStatus = onStatus;
    this._onPeerSaved = onPeerSaved;
    this._synced = false;
    this._pendingContent = null;
    this._destroyed = false;
    this._welcomed = false;
    // Solo sessions seed immediately — adoptContent alone unlocks the doc.
    this._offline = solo;
    this._seeded = false;
    this._seedContent = null;
    this._seedTimer = null;
    this._retryTimer = null;
    this._driveId = driveId;
    this._path = path;
    this._socketFactory = socket
      ? typeof socket === "function"
        ? socket
        : () => socket
      : () => new CollabSocket(driveId, path);
    /** @type {CollabSocketLike | null} */
    this.socket = null;
    /** Resolves once the welcome handshake has been handled. */
    this.ready = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    this.ydoc.on("update", (update, origin) => {
      if (origin === "remote" || this._destroyed) return;
      this.socket?.sendOp({ k: "u", d: toB64(update) });
    });

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === "remote" || this._destroyed) return;
      const ids = [...added, ...updated, ...removed];
      if (!ids.length) return;
      this._sendPresence({ k: "a", d: toB64(encodeAwarenessUpdate(this.awareness, ids)) });
    });
  }

  /** Open (or re-open after close) the room socket and wire handlers. */
  connect() {
    if (this._destroyed) return;
    if (this._offline && !this.socket) {
      // Solo: no hub. Report open so the editor doesn't show "Connecting…".
      this._onStatus?.("open");
      return;
    }
    if (this.socket && !this.socket._closed) return;
    const sock = this._socketFactory();
    this.socket = sock;
    sock.onMessage = (msg) => {
      if (sock === this.socket) this._onMessage(msg);
    };
    sock.onStatus = (status) => {
      // Ignore events from a stale socket — disconnect() closes the old one
      // and its `close` event lands asynchronously, which would otherwise
      // override the live socket's "open" and falsely report Offline.
      if (sock !== this.socket) return;
      if ((status === "closed" || status === "error") && !this._welcomed) {
        // The hub is unreachable — let the editor work offline and seed
        // from the file instead of sitting on an empty document.
        this._offline = true;
        this._maybeSeed();
      }
      // A drop while retries remain is a reconnect in progress, not
      // offline — the socket re-opens on its own backoff timer.
      const attempts = /** @type {any} */ (sock)._attempts ?? 0;
      const willRetry =
        !sock._closed &&
        attempts < CollabSocket.MAX_RECONNECT_ATTEMPTS;
      const display =
        (status === "closed" || status === "error") && willRetry
          ? "reconnecting"
          : status;
      this._onStatus?.(display);
    };
    sock.connect();
  }

  /** Drop the socket but keep the document — reconnect picks up via s1. */
  disconnect() {
    this.socket?.close();
    this.socket = null;
    this._welcomed = false;
  }

  /**
   * Hand the freshly fetched file bytes to the session. Seeds the shared
   * document when we are (or became) the room's authority; ignored when
   * peers already supplied a synced document.
   * @param {string} content
   */
  adoptContent(content) {
    this._pendingContent = content;
    this._maybeSeed();
  }

  /**
   * Peers besides ourselves, for the "editing with …" strip.
   * @returns {object[]}
   */
  otherPeers() {
    return [...this.peers.values()].filter((p) => p.peer_id !== this.peerId);
  }

  /** Serialize the shared document — what save writes back to the drive. */
  serialize() {
    return this.ytext.toString();
  }

  /**
   * True once the shared doc reflects reality — seeded from the file,
   * synced from a peer, or the user has typed into it. Before this the doc
   * is empty by timing, not by fact, so dirty checks must wait for it.
   */
  get hydrated() {
    return this._seeded || this._synced || this.ytext.length > 0;
  }

  /** Tell the room we persisted the file (peers show a "saved" beat). */
  notifySaved(size) {
    this.socket?.sendSaved(size);
  }

  destroy() {
    this._destroyed = true;
    if (this._seedTimer) clearTimeout(this._seedTimer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this.socket?.close();
    this.awareness.destroy();
    this.ydoc.destroy();
  }

  // ── wire protocol ────────────────────────────────────────────────────

  _sendPresence(payload) {
    this.socket?.sendPresence(payload);
  }

  _sendSyncRequest() {
    this._sendPresence({ k: "s1", d: toB64(Y.encodeStateVector(this.ydoc)) });
  }

  _onMessage(msg) {
    if (this._destroyed || !msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "welcome":
        this._onWelcome(msg);
        break;
      case "peer_join":
        if (msg.peer) {
          this.peers.set(msg.peer.peer_id, msg.peer);
          this._emitPeers();
        }
        break;
      case "peer_leave":
        this._onPeerLeave(msg.peer_id);
        break;
      case "presence":
        this._onPresence(msg.cursor);
        break;
      case "op":
        this._onOp(msg.payload);
        break;
      case "saved":
        this._onPeerSaved?.(msg.peer_id);
        break;
      default:
        break;
    }
  }

  _onWelcome(msg) {
    this._welcomed = true;
    this.peerId = msg.peer_id ?? null;
    this.peers.clear();
    for (const peer of msg.peers || []) this.peers.set(peer.peer_id, peer);
    this._emitPeers();

    const self = this.peerId != null ? this.peers.get(this.peerId) : null;
    this.awareness.setLocalState({
      peerId: this.peerId,
      user: {
        name: self?.username || "Someone",
        color: self?.color || "var(--accent)",
      },
    });

    // The backlog may carry doc updates from before we joined — apply them
    // before live traffic; Yjs updates are idempotent, so overlaps are safe.
    for (const ev of msg.catchup || []) this._onMessage(ev);

    if (this.otherPeers().length > 0) {
      // If we seeded while the hub was unreachable and haven't typed past
      // the seed, resolve the double-seed deterministically: the lowest
      // peer_id keeps its copy, everyone else drops theirs and syncs.
      if (this._seeded && this.ytext.toString() === this._seedContent) {
        const lowest = Math.min(...this.peers.keys());
        if (this.peerId !== lowest) {
          this.ydoc.transact(() => {
            this.ytext.delete(0, this.ytext.length);
          }, "remote");
          this._seeded = false;
        }
      }
      this._sendSyncRequest();
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (!this._synced) this._sendSyncRequest();
      }, SYNC_RETRY_MS);
      // If nobody answers (dead peers, foreign clients), fall back to the
      // file content rather than sitting on an empty document.
      this._seedTimer = setTimeout(() => {
        this._seedTimer = null;
        this._maybeSeed(true);
      }, SEED_FALLBACK_MS);
    } else {
      this._maybeSeed();
    }
    this._readyResolve?.(this);
  }

  _onPeerLeave(peerId) {
    if (peerId == null) return;
    this.peers.delete(peerId);
    this._emitPeers();
    // Drop that peer's awareness states (matched by the peerId we store in
    // each local state) so its cursors vanish instead of going stale.
    const stale = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (state?.peerId === peerId) stale.push(clientId);
    }
    if (stale.length) {
      removeAwarenessStates(this.awareness, stale, "remote");
    }
  }

  _onPresence(cursor) {
    if (!cursor || typeof cursor !== "object" || typeof cursor.d !== "string") {
      return;
    }
    try {
      if (cursor.k === "s1") {
        // A peer wants our state: send the diff they are missing, then ask
        // for theirs in return (standard two-step sync).
        const reply = Y.encodeStateAsUpdate(this.ydoc, fromB64(cursor.d));
        this._sendPresence({ k: "s2", d: toB64(reply) });
        this._sendSyncRequest();
      } else if (cursor.k === "s2") {
        this._synced = true;
        Y.applyUpdate(this.ydoc, fromB64(cursor.d), "remote");
      } else if (cursor.k === "a") {
        applyAwarenessUpdate(this.awareness, fromB64(cursor.d), "remote");
      }
    } catch {
      // A malformed frame from a peer must not take the session down.
    }
  }

  _onOp(payload) {
    if (!payload || payload.k !== "u" || typeof payload.d !== "string") return;
    try {
      this._synced = true;
      Y.applyUpdate(this.ydoc, fromB64(payload.d), "remote");
    } catch {
      // ignore malformed update
    }
  }

  _maybeSeed(force = false) {
    if (this._destroyed || this.ytext.length > 0) return;
    const alone = this.otherPeers().length === 0;
    const allowed = this._welcomed || this._offline;
    if (!allowed || (!alone && !force)) return;
    const content = this._pendingContent;
    if (content == null) return;
    this._pendingContent = null;
    this._seeded = true;
    this._seedContent = content;
    // Empty files insert nothing — mark seeded first so `hydrated` still
    // flips (and the update event may legitimately never fire).
    this.ydoc.transact(() => {
      if (this.ytext.length === 0 && content.length > 0) {
        this.ytext.insert(0, content);
      }
    }, "seed");
  }

  _emitPeers() {
    this._onPeers?.(this.otherPeers());
  }
}
