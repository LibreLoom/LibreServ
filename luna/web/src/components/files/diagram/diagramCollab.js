/**
 * Real-time diagram editing over Luna's collab hub.
 *
 * The room is the same one EuroOffice uses for presence: lunad authenticates
 * peers, numbers a person's extra sessions, and fans out opaque ops. It
 * never reads the payload. Draw.io's embed diff patches are that payload.
 * A save election (`save_lock` / `save_end`) matches EuroOffice's rule that
 * only one open editor uploads the file at a time; live edits keep flowing
 * while that upload runs.
 */

import { CollabSocket } from "../office/collabSocket.js";

/** Remember this many applied seqs — the hub backlog is smaller. */
const APPLIED_CAP = 512;
/** A save election that never answers must not wedge autosave. */
const SAVE_LOCK_TIMEOUT_MS = 4_000;

/** @param {unknown} patch */
export function patchFingerprint(patch) {
  try {
    return JSON.stringify(patch);
  } catch {
    return "";
  }
}

/**
 * Remote patch ops to apply, in the order given.
 * Skips our own echo, seqs already applied, and patches this client sent.
 * A reconnect's catchup includes those, and draw.io cell inserts are not
 * safe to apply twice.
 *
 * @param {object[]} events
 * @param {{ selfPeerId?: number | null, appliedSeqs?: Set<number> | number[], sentFingerprints?: Set<string> | string[] }} scope
 */
export function patchesToApply(events, { selfPeerId = null, appliedSeqs, sentFingerprints } = {}) {
  const seen = appliedSeqs instanceof Set ? appliedSeqs : new Set(appliedSeqs || []);
  const sent = sentFingerprints instanceof Set ? sentFingerprints : new Set(sentFingerprints || []);
  /** @type {{ seq: number | undefined, patch: unknown, checksum: unknown }}[] */
  const out = [];
  for (const ev of events || []) {
    if (!ev || ev.type !== "op" || ev.payload?.kind !== "patch" || ev.payload.patch == null) {
      continue;
    }
    if (selfPeerId != null && ev.peer_id === selfPeerId) continue;
    if (typeof ev.seq === "number" && seen.has(ev.seq)) continue;
    const fp = patchFingerprint(ev.payload.patch);
    if (fp && sent.has(fp)) continue;
    out.push({
      seq: typeof ev.seq === "number" ? ev.seq : undefined,
      patch: ev.payload.patch,
      checksum: ev.payload.checksum ?? null,
    });
  }
  return out;
}

/**
 * A peer finished uploading. Their save covered the shared edits. Local
 * edits that have not been saved yet stay dirty so this client writes the
 * tail — the same rule as EuroOffice's changesIndex check.
 *
 * @param {{ localDirty?: boolean }} state
 */
export function dirtyAfterPeerSave({ localDirty = false } = {}) {
  return { localDirty: !!localDirty, remoteDirty: false };
}

/**
 * @param {{
 *   driveId?: string,
 *   path?: string,
 *   url?: string,
 *   socket?: object,
 *   canWrite?: boolean,
 *   onUpdate?: (snap: { peers: object[], selfPeerId: number | null, canWrite: boolean }) => void,
 *   onRemotePatch?: (patch: { seq: number | undefined, patch: unknown, checksum: unknown }) => void,
 *   onPeerSaved?: (msg: object) => void,
 * }} opts
 */
export class DiagramCollab {
  constructor({
    driveId,
    path,
    url,
    socket,
    canWrite = true,
    onUpdate,
    onRemotePatch,
    onPeerSaved,
  }) {
    this.canWrite = canWrite;
    this.onUpdate = onUpdate;
    this.onRemotePatch = onRemotePatch;
    this.onPeerSaved = onPeerSaved;
    /** @type {object[]} */
    this.peers = [];
    /** @type {number | null} */
    this.selfPeerId = null;
    /** Server's view of this socket. `null` until welcome. */
    this.serverCanWrite = /** @type {boolean | null} */ (null);
    this.appliedSeqs = new Set();
    /** @type {number[]} */
    this.appliedOrder = [];
    this.sentFingerprints = new Set();
    /** @type {((granted: boolean) => void) | null} */
    this._lockResolve = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._lockTimer = null;
    this.socket = socket || new CollabSocket(driveId || "", path || "", url);
    this.socket.onMessage = (msg) => this._onMessage(msg);
    this.socket.onStatus = (status) => {
      if (status === "closed" || status === "error") {
        // The election died with the socket. Let the save proceed or retry
        // rather than waiting out the timeout.
        this._settleLock(true);
      }
    };
  }

  connect() {
    this.socket.connect?.();
  }

  close() {
    this._settleLock(true);
    this.socket.close?.();
  }

  get writable() {
    return this.canWrite && this.serverCanWrite !== false;
  }

  /**
   * @param {unknown} patch
   * @param {unknown} [checksum]
   */
  sendPatch(patch, checksum) {
    if (!this.writable) return;
    const fp = patchFingerprint(patch);
    if (fp) this.sentFingerprints.add(fp);
    this.socket.sendOp?.({ kind: "patch", patch, checksum: checksum ?? null });
  }

  /** @param {number | null} [size] */
  sendSaved(size) {
    this.socket.sendSaved?.(size ?? null);
  }

  /**
   * Ask to be the client that uploads. Resolves true when this client may
   * write, or when there is no live socket to ask (a solo save).
   * @returns {Promise<boolean>}
   */
  requestSaveLock() {
    return new Promise((resolve) => {
      this._lockResolve = resolve;
      this._lockTimer = setTimeout(() => this._settleLock(true), SAVE_LOCK_TIMEOUT_MS);
      const sent = this.socket.sendSaveLock?.() === true;
      if (!sent) this._settleLock(true);
    });
  }

  releaseSaveLock() {
    this.socket.sendSaveEnd?.();
  }

  /** @param {number | undefined} seq */
  markApplied(seq) {
    if (typeof seq !== "number" || this.appliedSeqs.has(seq)) return;
    this.appliedSeqs.add(seq);
    this.appliedOrder.push(seq);
    while (this.appliedOrder.length > APPLIED_CAP) {
      const old = this.appliedOrder.shift();
      if (old != null) this.appliedSeqs.delete(old);
    }
  }

  /** @param {boolean | null} value `null` clears without resolving. */
  _settleLock(value) {
    if (this._lockTimer) {
      clearTimeout(this._lockTimer);
      this._lockTimer = null;
    }
    const resolve = this._lockResolve;
    this._lockResolve = null;
    if (value != null) resolve?.(value);
  }

  _emit() {
    this.onUpdate?.({
      peers: this.peers,
      selfPeerId: this.selfPeerId,
      canWrite: this.writable,
    });
  }

  /** @param {object} msg */
  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "welcome") {
      this.peers = Array.isArray(msg.peers) ? msg.peers : [];
      this.selfPeerId = typeof msg.peer_id === "number" ? msg.peer_id : null;
      if (typeof msg.can_write === "boolean") this.serverCanWrite = msg.can_write;
      this._emit();
      const patches = patchesToApply(msg.catchup, {
        selfPeerId: this.selfPeerId,
        appliedSeqs: this.appliedSeqs,
        sentFingerprints: this.sentFingerprints,
      });
      for (const patch of patches) this._deliver(patch);
      return;
    }
    if (msg.type === "peer_join" && msg.peer) {
      if (!this.peers.some((p) => p.peer_id === msg.peer.peer_id)) {
        this.peers = [...this.peers, msg.peer];
        this._emit();
      }
      return;
    }
    if (msg.type === "peer_leave") {
      this.peers = this.peers.filter((p) => p.peer_id !== msg.peer_id);
      this._emit();
      return;
    }
    if (msg.type === "op") {
      const [patch] = patchesToApply([msg], {
        selfPeerId: this.selfPeerId,
        appliedSeqs: this.appliedSeqs,
        sentFingerprints: this.sentFingerprints,
      });
      if (patch) this._deliver(patch);
      return;
    }
    if (msg.type === "saved") {
      this.onPeerSaved?.(msg);
      return;
    }
    if (msg.type === "save_lock") {
      this._settleLock(msg.granted !== false);
    }
  }

  /** @param {{ seq: number | undefined, patch: unknown, checksum: unknown }} patch */
  _deliver(patch) {
    this.markApplied(patch.seq);
    this.onRemotePatch?.(patch);
  }
}
