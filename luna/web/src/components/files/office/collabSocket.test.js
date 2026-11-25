import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabSocket, collabWsUrl } from "./collabSocket.js";

describe("collabSocket", () => {
  it("builds a same-origin collab websocket URL", () => {
    expect(collabWsUrl("luna.local", false, "drive-1", "Docs/a.docx")).toBe(
      "ws://luna.local/api/v1/collab/ws?drive_id=drive-1&path=Docs%2Fa.docx",
    );
    expect(collabWsUrl("luna.local", true, "drive-1", "a.docx")).toBe(
      "wss://luna.local/api/v1/collab/ws?drive_id=drive-1&path=a.docx",
    );
  });
});

/** Stand-in for the browser socket: nothing happens until a test says so. */
class SilentSocket {
  static OPEN = 1;
  static instances = /** @type {SilentSocket[]} */ ([]);
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.silentClose = false;
    this.sent = /** @type {string[]} */ ([]);
    /** @type {Record<string, ((ev: any) => void)[]>} */
    this.listeners = {};
    SilentSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(data) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
    if (!this.silentClose) this.fire("close");
  }
}

describe("collabSocket connect timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    SilentSocket.instances = [];
  });

  it("gives up on a hub that never answers instead of waiting forever", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", SilentSocket);
    const statuses = /** @type {string[]} */ ([]);
    const sock = new CollabSocket("d1", "a.txt", "ws://luna.test/api/v1/collab/ws");
    sock.onStatus = (s) => statuses.push(s);

    sock.connect();
    expect(statuses).toEqual(["connecting"]);

    vi.advanceTimersByTime(CollabSocket.CONNECT_TIMEOUT_MS + 10);
    // Offline is reported as a dropped socket, which is what lets the editor
    // seed the document from the file and keep saving.
    expect(statuses).toContain("closed");
    sock.close();
  });

  it("ignores a delayed close from a socket that already timed out", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", SilentSocket);
    const statuses = /** @type {string[]} */ ([]);
    const sock = new CollabSocket("d1", "a.txt", "ws://luna.test/api/v1/collab/ws");
    sock.onStatus = (s) => statuses.push(s);

    sock.connect();
    const first = SilentSocket.instances[0];
    first.silentClose = true;
    vi.advanceTimersByTime(CollabSocket.CONNECT_TIMEOUT_MS + 10);
    vi.advanceTimersByTime(1000);
    const second = SilentSocket.instances[1];

    first.fire("close");
    expect(sock.ws).toBe(second);
    expect(sock._connectTimer).not.toBeNull();
    expect(statuses).toEqual(["connecting", "closed", "reconnecting"]);

    vi.advanceTimersByTime(CollabSocket.CONNECT_TIMEOUT_MS + 10);
    expect(statuses.at(-1)).toBe("closed");
    sock.close();
  });

  it("stays quiet once the socket opens", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", SilentSocket);
    const statuses = /** @type {string[]} */ ([]);
    const sock = new CollabSocket("d1", "a.txt", "ws://luna.test/api/v1/collab/ws");
    sock.onStatus = (s) => statuses.push(s);

    sock.connect();
    const ws = SilentSocket.instances[0];
    ws.readyState = SilentSocket.OPEN;
    ws.fire("open");

    vi.advanceTimersByTime(CollabSocket.CONNECT_TIMEOUT_MS + 10);
    expect(statuses).toEqual(["connecting", "open"]);
    sock.close();
  });
});
