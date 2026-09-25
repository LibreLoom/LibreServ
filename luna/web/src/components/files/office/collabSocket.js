/**
 * Thin WebSocket client for Luna collab rooms.
 * Protocol mirrors lunad `collab` ServerEvent / ClientMsg (snake_case JSON).
 *
 * Op payloads are opaque JSON for EuroOffice (or future bridges).
 * Luna does not interpret them.
 */

/**
 * @param {string} [driveId]
 * @param {string} [path]
 */
export function browserCollabWsUrl(driveId, path) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return (
    `${proto}://${window.location.host}/api/v1/collab/ws` +
    `?drive_id=${encodeURIComponent(driveId || "")}` +
    `&path=${encodeURIComponent(path || "")}`
  );
}

/**
 * Pure helper for tests / non-browser callers.
 * @param {string} host
 * @param {boolean} secure
 * @param {string} driveId
 * @param {string} path
 */
export function collabWsUrl(host, secure, driveId, path) {
  const proto = secure ? "wss" : "ws";
  return `${proto}://${host}/api/v1/collab/ws?drive_id=${encodeURIComponent(driveId)}&path=${encodeURIComponent(path)}`;
}

export class CollabSocket {
  /**
   * @param {string} driveId
   * @param {string} path
   */
  /**
   * @param {string} driveId
   * @param {string} path
   * @param {string} [url] override — guest diagram rooms use the share URL
   */
  constructor(driveId, path, url) {
    this.driveId = driveId;
    this.path = path;
    this._url = url || "";
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {((msg: object) => void) | null} */
    this.onMessage = null;
    /** @type {((status: string) => void) | null} */
    this.onStatus = null;
    this._closed = false;
    /** @type {number | null} */
    this.peerId = null;
    this._attempts = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._retryTimer = null;
  }

  connect() {
    if (this._closed) return;
    const url = this._url || browserCollabWsUrl(this.driveId, this.path);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.onStatus?.(this._attempts === 0 ? "connecting" : "reconnecting");

    ws.addEventListener("open", () => {
      this._attempts = 0;
      this.onStatus?.("open");
      ws.send(
        JSON.stringify({
          type: "hello",
          client_id: globalThis.crypto?.randomUUID?.() || `luna-${Date.now()}`,
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.type === "welcome") this.peerId = msg.peer_id ?? null;
      this.onMessage?.(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      this.onStatus?.("closed");
      this._scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      this.onStatus?.("error");
    });
  }

  /**
   * Retry a dropped socket with backoff so a lunad restart or a transient
   * proxy hiccup does not leave the editor silently disconnected.
   * Gives up after MAX_RECONNECT_ATTEMPTS — the user reopens the file.
   */
  _scheduleReconnect() {
    if (this._closed || this._retryTimer != null) return;
    if (this._attempts >= CollabSocket.MAX_RECONNECT_ATTEMPTS) return;
    const delay = Math.min(1000 * 2 ** this._attempts, 15000);
    this._attempts += 1;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * @param {object} payload opaque JSON (not stringified twice)
   */
  sendOp(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "op", payload }));
  }

  /** @param {object|null} [cursor] */
  sendPresence(cursor) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "presence", cursor: cursor ?? null }));
  }

  /** @param {number|null} [size] */
  sendSaved(size) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "saved", size: size ?? null }));
  }

  /**
   * Ask to be the one client uploading the file. Resolves nothing — the
   * `save_lock` reply arrives on `onMessage`. Returns false when the
   * socket is not up, so the caller can save solo.
   */
  sendSaveLock() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "save_lock" }));
    return true;
  }

  /** Drop the upload election after the save finishes or fails. */
  sendSaveEnd() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "save_end" }));
    return true;
  }

  close() {
    this._closed = true;
    if (this._retryTimer != null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

/** Cap retries so a permanently rejected upgrade does not spam the server. */
CollabSocket.MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Functional wrapper kept for callers that prefer a closure API.
 * @param {{
 *   driveId: string,
 *   path: string,
 *   onEvent: (msg: object) => void,
 *   onClose?: () => void,
 * }} opts
 */
export function connectCollab({ driveId, path, onEvent, onClose }) {
  const sock = new CollabSocket(driveId, path);
  sock.onMessage = onEvent;
  sock.onStatus = (status) => {
    if (status === "closed") onClose?.();
  };
  sock.connect();
  return {
    get peerId() {
      return sock.peerId;
    },
    sendOp(payload) {
      sock.sendOp(payload);
    },
    sendPresence(cursor) {
      sock.sendPresence(cursor);
    },
    sendSaved(size) {
      sock.sendSaved(size);
    },
    close() {
      sock.close();
    },
  };
}
