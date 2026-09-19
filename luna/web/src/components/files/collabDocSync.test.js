import { describe, expect, it, vi, afterEach } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { CollabDocSync } from "./collabDocSync.js";
import { CollabSocket } from "./office/collabSocket.js";

function toB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/** In-memory stand-in for CollabSocket — records frames, never connects. */
class FakeSocket {
  constructor() {
    this._closed = false;
    this._attempts = 0;
    this.ops = [];
    this.presence = [];
    this.saved = [];
    this.onMessage = null;
    this.onStatus = null;
  }
  connect() {
    this.onStatus?.("open");
  }
  sendOp(payload) {
    this.ops.push(payload);
  }
  sendPresence(payload) {
    this.presence.push(payload);
  }
  sendSaved(size) {
    this.saved.push(size);
  }
  close() {
    this._closed = true;
  }
  emit(msg) {
    this.onMessage?.(msg);
  }
  welcome({ peerId = 1, others = [], catchup = [] } = {}) {
    const self = {
      peer_id: peerId,
      user_id: "u1",
      username: "Ada",
      color: "#111111", // color-scan: ignore-line — fake peer fixture, not UI
      can_write: true,
    };
    this.emit({
      type: "welcome",
      peer_id: peerId,
      peers: [self, ...others],
      can_write: true,
      catchup,
    });
  }
}

const PEER_B = {
  peer_id: 2,
  user_id: "u2",
  username: "Bea",
  color: "#222222", // color-scan: ignore-line — fake peer fixture, not UI
  can_write: true,
};

function makeSession(socket) {
  return new CollabDocSync({ driveId: "d1", path: "docs/a.md", socket });
}

/** A Yjs update carrying `text` on a doc with the same "file" Y.Text. */
function updateWith(text) {
  const doc = new Y.Doc();
  doc.getText("file").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe("CollabDocSync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a stale socket's late close so status doesn't stick offline", () => {
    const statuses = [];
    const sockets = [];
    const sync = new CollabDocSync({
      driveId: "d1",
      path: "a.md",
      onStatus: (s) => statuses.push(s),
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    sync.connect(); // socket A opens
    sync.disconnect(); // A closed — its "closed" event lands asynchronously
    sync.connect(); // socket B opens (StrictMode remount)
    sockets[0].onStatus?.("closed"); // A's late close event
    expect(statuses[statuses.length - 1]).toBe("open");
    sync.destroy();
  });

  it("reports a dropped socket with retries left as reconnecting, not offline", () => {
    const statuses = [];
    const socket = new FakeSocket();
    const sync = new CollabDocSync({
      driveId: "d1",
      path: "a.md",
      onStatus: (s) => statuses.push(s),
      socket,
    });
    sync.connect();
    socket._attempts = 1; // a retry is already scheduled
    socket.onStatus?.("closed");
    expect(statuses[statuses.length - 1]).toBe("reconnecting");
    socket._attempts = CollabSocket.MAX_RECONNECT_ATTEMPTS;
    socket.onStatus?.("closed");
    expect(statuses[statuses.length - 1]).toBe("closed"); // genuinely offline now
    sync.destroy();
  });

  it("seeds the document from file content when alone in the room", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome();
    sync.adoptContent("# hello");
    expect(sync.serialize()).toBe("# hello");
    expect(sync.hydrated).toBe(true);
  });

  it("asks peers for the document instead of seeding when the room is busy", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome({ others: [PEER_B] });
    const syncReq = socket.presence.find((p) => p.k === "s1");
    expect(syncReq).toBeTruthy();
    sync.adoptContent("disk copy");
    expect(sync.serialize()).toBe("");
    expect(sync.hydrated).toBe(false);
  });

  it("applies a sync reply so the joiner sees live content", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome({ others: [PEER_B] });
    socket.emit({
      type: "presence",
      peer_id: 2,
      cursor: { k: "s2", d: toB64(updateWith("live from Bea")) },
    });
    expect(sync.serialize()).toBe("live from Bea");
    // A late disk fetch must not clobber the synced document.
    sync.adoptContent("disk copy");
    expect(sync.serialize()).toBe("live from Bea");
  });

  it("broadcasts local edits as ops and applies remote ops", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome();
    sync.adoptContent("hi");
    socket.ops.length = 0;

    sync.ytext.insert(2, " there");
    const op = socket.ops.find((o) => o.k === "u");
    expect(op).toBeTruthy();

    // A real peer converges by applying our ops onto shared history — the
    // joiner path is state sync, so assert with the full doc state.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(sync.ydoc));
    expect(other.getText("file").toString()).toBe("hi there");

    // A remote op is incremental relative to shared history: the peer has
    // our state, types on top, and sends just the diff for our vector.
    other.getText("file").insert(9, ", remote");
    const diff = Y.encodeStateAsUpdate(other, Y.encodeStateVector(sync.ydoc));
    socket.emit({
      type: "op",
      seq: 1,
      peer_id: 2,
      payload: { k: "u", d: toB64(diff) },
    });
    expect(sync.serialize()).toBe("hi there, remote");
  });

  it("replays catchup ops from the welcome backlog", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome({
      catchup: [
        {
          type: "op",
          seq: 1,
          peer_id: 2,
          payload: { k: "u", d: toB64(updateWith("backlog")) },
        },
      ],
    });
    expect(sync.serialize()).toBe("backlog");
  });

  it("tracks peer awareness and drops it when the peer leaves", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome({ others: [PEER_B] });

    const remote = new Awareness(new Y.Doc());
    remote.setLocalState({ peerId: 2, user: { name: "Bea", color: "#222222" } }); // color-scan: ignore-line — fake peer fixture
    socket.emit({
      type: "presence",
      peer_id: 2,
      cursor: {
        k: "a",
        d: toB64(encodeAwarenessUpdate(remote, [remote.clientID])),
      },
    });
    const names = [...sync.awareness.getStates().values()].map(
      (s) => s?.user?.name,
    );
    expect(names).toContain("Bea");

    socket.emit({ type: "peer_leave", peer_id: 2 });
    const after = [...sync.awareness.getStates().values()].map(
      (s) => s?.user?.name,
    );
    expect(after).not.toContain("Bea");
  });

  it("falls back to the file content when peers never answer", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.welcome({ others: [PEER_B] });
    sync.adoptContent("from disk");
    vi.advanceTimersByTime(5000);
    expect(sync.serialize()).toBe("from disk");
  });

  it("seeds offline when the hub is unreachable", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.onStatus?.("closed");
    sync.adoptContent("offline draft");
    expect(sync.serialize()).toBe("offline draft");
  });

  it("reports peer saves and notifies the room on save", () => {
    const socket = new FakeSocket();
    let savedBy = null;
    const sync = new CollabDocSync({
      driveId: "d1",
      path: "a.md",
      socket,
      onPeerSaved: (peerId) => {
        savedBy = peerId;
      },
    });
    sync.connect();
    socket.welcome({ others: [PEER_B] });
    socket.emit({ type: "saved", peer_id: 2, size: 10 });
    expect(savedBy).toBe(2);
    sync.notifySaved(42);
    expect(socket.saved).toContain(42);
  });

  it("keeps the local seed when it is the lowest peer after an offline seed", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.onStatus?.("closed"); // offline seed
    sync.adoptContent("same file");
    expect(sync.serialize()).toBe("same file");
    // The hub comes back with us as peer 1 — the lowest — so our seed wins.
    socket.welcome({ peerId: 1, others: [PEER_B] });
    expect(sync.serialize()).toBe("same file");
  });

  it("drops the local seed for the higher peer to avoid duplication", () => {
    const socket = new FakeSocket();
    const sync = makeSession(socket);
    sync.connect();
    socket.onStatus?.("closed");
    sync.adoptContent("same file");
    // We're peer 2 — peer 1 keeps its seed, ours is dropped before sync.
    socket.welcome({
      peerId: 2,
      others: [{ ...PEER_B, peer_id: 1 }],
    });
    expect(sync.serialize()).toBe("");
  });
});
