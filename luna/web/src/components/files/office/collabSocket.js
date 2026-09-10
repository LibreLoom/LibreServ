/**
 * Thin WebSocket client for Luna collab rooms.
 * Protocol mirrors lunad `collab` ServerEvent / ClientMsg (snake_case JSON).
 *
 * Op payloads are opaque JSON. The fallback editor uses:
 *   { engine: "luna-fallback/1", text: string }
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
  constructor(driveId, path) {
    this.driveId = driveId;
    this.path = path;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {((msg: object) => void) | null} */
    this.onMessage = null;
    /** @type {((status: string) => void) | null} */
    this.onStatus = null;
    this._closed = false;
    /** @type {number | null} */
    this.peerId = null;
  }

  connect() {
    if (this._closed) return;
    const url = browserCollabWsUrl(this.driveId, this.path);
    const ws = new WebSocket(url);
    this.ws = ws;
    this.onStatus?.("connecting");

    ws.addEventListener("open", () => {
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
      this.onStatus?.("closed");
    });

    ws.addEventListener("error", () => {
      this.onStatus?.("error");
    });
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

  close() {
    this._closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

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
