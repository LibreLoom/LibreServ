import { describe, expect, it, vi } from "vitest";
import {
  DiagramCollab,
  patchFingerprint,
  patchesToApply,
  peerSaveCoversEditor,
} from "./diagramCollab.js";

function fakeSocket() {
  return {
    sent: /** @type {object[]} */ ([]),
    onMessage: /** @type {((msg: object) => void) | null} */ (null),
    onStatus: /** @type {((status: string) => void) | null} */ (null),
    connect() {},
    close() {},
    sendOp(payload) {
      this.sent.push({ type: "op", payload });
      return true;
    },
    sendSaved(size, seq) {
      this.sent.push({ type: "saved", size, seq });
    },
    sendSaveLock() {
      this.sent.push({ type: "save_lock" });
      return true;
    },
    sendSaveEnd() {
      this.sent.push({ type: "save_end" });
      return true;
    },
  };
}

describe("patchesToApply", () => {
  const patch = { u: { p1: { cells: { i: [{ id: "a" }] } } } };

  it("keeps foreign patches and skips our echo, repeats, and patches we sent", () => {
    const fp = patchFingerprint(patch);
    const events = [
      { type: "op", seq: 1, peer_id: 7, payload: { kind: "patch", patch } },
      { type: "op", seq: 1, peer_id: 7, payload: { kind: "patch", patch } },
      { type: "op", seq: 2, peer_id: 3, payload: { kind: "patch", patch: { u: {} } } },
      { type: "op", seq: 3, peer_id: 9, payload: { kind: "patch", patch } },
      { type: "saved", peer_id: 7 },
    ];
    const applied = patchesToApply(events, {
      selfPeerId: 3,
      appliedSeqs: new Set([1]),
      sentFingerprints: new Set([fp]),
    });
    expect(applied).toEqual([]);
  });

  it("replays catchup in order for a late joiner", () => {
    const applied = patchesToApply(
      [
        { type: "op", seq: 4, peer_id: 2, payload: { kind: "patch", patch: { n: 1 }, checksum: "a" } },
        { type: "op", seq: 5, peer_id: 2, payload: { kind: "patch", patch: { n: 2 } } },
      ],
      { selfPeerId: 8 },
    );
    expect(applied.map((p) => p.seq)).toEqual([4, 5]);
    expect(applied[0].checksum).toBe("a");
  });
});

describe("peerSaveCoversEditor", () => {
  it("covers an editor at or behind the saved sequence", () => {
    expect(peerSaveCoversEditor({ includedSeq: 2, savedSeq: 4 })).toBe(true);
    expect(peerSaveCoversEditor({ includedSeq: 4, savedSeq: 4 })).toBe(true);
  });

  it("keeps an editor that has moved past the save, or is still waiting on a sequence", () => {
    expect(peerSaveCoversEditor({ includedSeq: 5, savedSeq: 4 })).toBe(false);
    expect(peerSaveCoversEditor({ pending: 1, includedSeq: 2, savedSeq: 4 })).toBe(false);
    expect(peerSaveCoversEditor({ includedSeq: 2, savedSeq: null })).toBe(false);
  });
});

describe("DiagramCollab", () => {
  it("announces peers and applies welcome catchup, then live patches", () => {
    const socket = fakeSocket();
    const remote = [];
    const updates = [];
    const collab = new DiagramCollab({
      socket,
      canWrite: true,
      onUpdate: (snap) => updates.push(snap.peers.map((p) => p.username)),
      onRemotePatch: (patch) => remote.push(patch.seq),
    });
    collab.connect();
    socket.onMessage?.({
      type: "welcome",
      peer_id: 1,
      can_write: true,
      peers: [
        { peer_id: 1, username: "Ada" },
        { peer_id: 2, username: "Sam" },
      ],
      catchup: [
        { type: "op", seq: 3, peer_id: 2, payload: { kind: "patch", patch: { n: 1 } } },
      ],
    });
    socket.onMessage?.({
      type: "op",
      seq: 4,
      peer_id: 2,
      payload: { kind: "patch", patch: { n: 2 } },
    });
    socket.onMessage?.({
      type: "peer_join",
      peer: { peer_id: 5, username: "Bea" },
    });
    expect(remote).toEqual([3, 4]);
    expect(updates.at(-1)).toEqual(["Ada", "Sam", "Bea"]);

    collab.sendPatch({ n: 9 }, "sum");
    expect(socket.sent.at(-1)).toEqual({
      type: "op",
      payload: { kind: "patch", patch: { n: 9 }, checksum: "sum" },
    });
    // Our own patch coming back in a later catchup is not applied again.
    socket.onMessage?.({
      type: "welcome",
      peer_id: 6,
      peers: [{ peer_id: 6, username: "Ada" }],
      catchup: [
        { type: "op", seq: 5, peer_id: 1, payload: { kind: "patch", patch: { n: 9 } } },
      ],
    });
    expect(remote).toEqual([3, 4]);
  });

  it("does not send patches when the server says this session is view-only", () => {
    const socket = fakeSocket();
    const collab = new DiagramCollab({ socket, canWrite: true });
    socket.onMessage?.({
      type: "welcome",
      peer_id: 1,
      can_write: false,
      peers: [{ peer_id: 1, username: "Ada" }],
      catchup: [],
    });
    collab.sendPatch({ n: 1 });
    expect(socket.sent).toEqual([]);
  });

  it("grants a solo save when the socket cannot take the election", async () => {
    const socket = fakeSocket();
    socket.sendSaveLock = () => false;
    const collab = new DiagramCollab({ socket });
    await expect(collab.requestSaveLock()).resolves.toBe(true);
  });

  it("waits for the save election and releases it", async () => {
    const socket = fakeSocket();
    const collab = new DiagramCollab({ socket });
    const pending = collab.requestSaveLock();
    expect(socket.sent.at(-1)).toEqual({ type: "save_lock" });
    socket.onMessage?.({ type: "save_lock", granted: false });
    await expect(pending).resolves.toBe(false);
    collab.releaseSaveLock();
    expect(socket.sent.at(-1)).toEqual({ type: "save_end" });
  });

  it("tells the editor when a peer saved", () => {
    const socket = fakeSocket();
    const saved = vi.fn();
    const collab = new DiagramCollab({ socket, onPeerSaved: saved });
    expect(collab.snapshotSeq()).toBe(0);
    socket.onMessage?.({ type: "saved", peer_id: 4, size: 12, seq: 3 });
    expect(saved).toHaveBeenCalledWith({ type: "saved", peer_id: 4, size: 12, seq: 3 });
  });

  it("names the save only after its own patches have a sequence", () => {
    const socket = fakeSocket();
    const collab = new DiagramCollab({ socket, canWrite: true });
    socket.onMessage?.({
      type: "welcome",
      peer_id: 1,
      can_write: true,
      peers: [{ peer_id: 1, username: "Ada" }],
      catchup: [
        { type: "op", seq: 2, peer_id: 9, payload: { kind: "patch", patch: { n: 1 } } },
      ],
    });
    expect(collab.snapshotSeq()).toBe(0);
    collab.confirmApplied(2);
    expect(collab.snapshotSeq()).toBe(2);
    collab.sendPatch({ n: 9 }, "sum");
    expect(collab.snapshotSeq()).toBeNull();
    expect(collab.editsCoveredBy(2)).toBe(false);
    socket.onMessage?.({ type: "ack", seq: 3 });
    expect(collab.snapshotSeq()).toBe(3);
    expect(collab.editsCoveredBy(3)).toBe(true);
    expect(collab.editsCoveredBy(2)).toBe(false);
    collab.sendSaved(20, collab.snapshotSeq());
    expect(socket.sent.at(-1)).toEqual({ type: "saved", size: 20, seq: 3 });
  });

  it("does not count a remote patch until draw.io confirms it", () => {
    const socket = fakeSocket();
    const remote = [];
    const collab = new DiagramCollab({
      socket,
      onRemotePatch: (patch) => remote.push(patch.seq),
    });
    socket.onMessage?.({
      type: "op",
      seq: 4,
      peer_id: 2,
      payload: { kind: "patch", patch: { n: 1 } },
    });
    expect(remote).toEqual([4]);
    expect(collab.snapshotSeq()).toBe(0);
    expect(collab.appliedSeqs.has(4)).toBe(false);
    collab.confirmApplied(4);
    expect(collab.snapshotSeq()).toBe(4);
    expect(collab.appliedSeqs.has(4)).toBe(true);
    socket.onMessage?.({
      type: "op",
      seq: 4,
      peer_id: 2,
      payload: { kind: "patch", patch: { n: 1 } },
    });
    expect(remote).toEqual([4]);
  });

  it("holds the save at a hole when a later patch is confirmed first", () => {
    const socket = fakeSocket();
    const collab = new DiagramCollab({ socket });
    socket.onMessage?.({
      type: "welcome",
      peer_id: 1,
      can_write: true,
      peers: [],
      catchup: [
        { type: "op", seq: 3, peer_id: 2, payload: { kind: "patch", patch: { n: 1 } } },
        { type: "op", seq: 4, peer_id: 2, payload: { kind: "patch", patch: { n: 2 } } },
      ],
    });
    collab.confirmApplied(4);
    expect(collab.snapshotSeq()).toBe(2);
    expect(collab.appliedSeqs.has(3)).toBe(false);
    expect(collab.appliedSeqs.has(4)).toBe(true);
    expect(collab.editsCoveredBy(4)).toBe(true);
    collab.confirmApplied(3);
    expect(collab.snapshotSeq()).toBe(4);
  });
});
