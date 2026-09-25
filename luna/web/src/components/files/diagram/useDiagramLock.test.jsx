import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { diagramLockWsUrl, useDiagramLock } from "./useDiagramLock.js";

// HACK coverage: the advisory .drawio edit lock. The hold is a WebSocket —
// these tests drive a fake socket instead of fetch stubs.

const PROPS = { driveId: "drive1", path: "docs/plan.drawio" };

class MockWebSocket {
  /** @type {MockWebSocket[]} */
  static instances = [];
  static OPEN = 1;

  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.readyState = MockWebSocket.OPEN;
    /** @type {string[]} */
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  /** @param {string} data */
  send(data) {
    this.sent.push(data);
  }

  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  /** Simulate a JSON message from lunad. */
  serverSays(msg) {
    this.emit("message", { data: JSON.stringify(msg) });
  }

  /** Simulate the peer/transport closing the socket. */
  drop() {
    this.emit("close", {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
}

function lastSocket() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

afterEach(() => {
  MockWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useDiagramLock", () => {
  it("acquires over a socket addressed with drive, path, and session", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let outcome;
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    const ws = lastSocket();
    expect(ws.url).toContain("/api/v1/diagrams/lock/ws");
    const params = new URL(ws.url).searchParams;
    expect(params.get("drive_id")).toBe("drive1");
    expect(params.get("path")).toBe("docs/plan.drawio");
    expect(params.get("session")?.length).toBeGreaterThan(8);

    await act(async () => {
      ws.serverSays({ type: "held" });
      outcome = await pending;
    });
    expect(outcome).toBe("held");
    expect(result.current.status).toBe("held");
  });

  it("reports blocked with the holder's name when someone else holds it", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let outcome;
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam" });
      outcome = await pending;
    });
    expect(outcome).toBe("blocked");
    expect(result.current.status).toBe("blocked");
    expect(result.current.holder).toBe("Sam");
  });

  it("degrades to failed (not blocked) when the socket can't connect", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let outcome;
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().emit("error", {});
      lastSocket().emit("close", {});
      outcome = await pending;
    });
    expect(outcome).toBe("failed");
    expect(result.current.status).toBe("off");
  });

  it("silently re-holds after a dropped socket — a lunad restart is not a loss", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });
    expect(result.current.status).toBe("held");

    // Socket dies (daemon restart clears RAM locks) — the client must
    // re-acquire instead of crying wolf.
    await act(async () => {
      lastSocket().drop();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
    });
    expect(result.current.status).toBe("held");
    vi.useRealTimers();
  });

  it("goes lost only when a reconnect finds a real holder", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });

    await act(async () => {
      lastSocket().drop();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam" });
    });
    expect(result.current.status).toBe("lost");
    expect(result.current.holder).toBe("Sam");
    vi.useRealTimers();
  });

  it("goes lost when the server says the hold ended (same-user takeover)", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });
    await act(async () => {
      lastSocket().serverSays({ type: "lost", holder: "Sam" });
    });
    expect(result.current.status).toBe("lost");
    expect(result.current.holder).toBe("Sam");
  });

  it("gives up and marks lost when reconnects keep failing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });

    // Drop the socket, then fail every reconnect (daemon down).
    await act(async () => {
      lastSocket().drop();
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
        lastSocket().drop();
      });
    }
    expect(result.current.status).toBe("lost");
    vi.useRealTimers();
  });

  it("releases with a keepalive fetch on unmount — not sendBeacon", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const fetchMock = vi.fn(
      async (/** @type {any} */ _url, /** @type {any} */ _init) =>
        new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const beacon = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });

    const { result, unmount } = renderHook(() => useDiagramLock(PROPS));
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });
    const ws = lastSocket();

    unmount();

    expect(ws.closed).toBe(true);
    const releases = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/diagrams/lock/release"),
    );
    expect(releases).toHaveLength(1);
    expect(releases[0][1]?.keepalive).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
  });

  it("does not release a lock it never held", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const fetchMock = vi.fn(
      async (/** @type {any} */ _url, /** @type {any} */ _init) =>
        new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useDiagramLock(PROPS));
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam" });
      await pending;
    });
    unmount();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/release"),
      ),
    ).toHaveLength(0);
  });

  it("acquire while already held is a no-op — no second socket", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 3 });
      await pending;
    });

    let again;
    await act(async () => {
      again = await result.current.acquire();
    });
    expect(again).toBe("held");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("overlapping acquire calls share one socket attempt", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let first;
    let second;
    await act(async () => {
      first = result.current.acquire();
      second = result.current.acquire();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 1 });
    });
    await act(async () => {
      expect(await first).toBe("held");
      expect(await second).toBe("held");
    });
  });

  it("ignores a stale socket once a newer one holds the lock", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    const stale = lastSocket();
    await act(async () => {
      stale.serverSays({ type: "held", gen: 1 });
      await pending;
    });

    // Socket drops, reconnect lands a replacement.
    await act(async () => {
      stale.drop();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const live = lastSocket();
    await act(async () => {
      live.serverSays({ type: "held", gen: 2 });
    });
    expect(result.current.status).toBe("held");

    // The stale socket's events must not touch state: a late "lost" can
    // not evict the live hold, and its close must not spawn reconnects.
    await act(async () => {
      stale.serverSays({ type: "lost", holder: "Sam" });
      stale.drop();
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.status).toBe("held");
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });

  it("a holder-less lost means the lock is gone — silently re-acquire", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 1 });
      await pending;
    });
    await act(async () => {
      lastSocket().serverSays({ type: "lost", holder: null });
      lastSocket().drop();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // Re-acquired on a fresh socket — the editor never shows a false loss.
    expect(MockWebSocket.instances).toHaveLength(2);
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 2 });
    });
    expect(result.current.status).toBe("held");
    vi.useRealTimers();
  });

  it("flags a same-user block so the card can say it's your own other tab", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam", self: true });
      await pending;
    });
    expect(result.current.status).toBe("blocked");
    expect(result.current.selfHold).toBe(true);
  });

  it("echoes the held generation in the release keepalive", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const fetchMock = vi.fn(
      async (/** @type {any} */ _url, /** @type {any} */ _init) =>
        new Response("{}"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 7 });
      await pending;
    });
    unmount();

    const releases = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/diagrams/lock/release"),
    );
    expect(releases).toHaveLength(1);
    const body = JSON.parse(String(releases[0][1]?.body));
    expect(body.gen).toBe(7);
  });

  it("reports idle after a quiet stretch, then active on input", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    const ws = lastSocket();
    await act(async () => {
      ws.serverSays({ type: "held", gen: 1 });
      await pending;
    });

    // Five quiet minutes → the hold reports itself grabbable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(ws.sent.map((m) => JSON.parse(m).idle)).toEqual([true]);

    // Input → back to active so nobody can grab the lock.
    await act(async () => {
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(ws.sent.map((m) => JSON.parse(m).idle)).toEqual([true, false]);
    vi.useRealTimers();
  });

  it("restores the idle flag across a reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));

    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held", gen: 1 });
      await pending;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(JSON.parse(lastSocket().sent[lastSocket().sent.length - 1]).idle).toBe(true);

    // Socket drops while idle → reconnect re-holds AND re-marks idle, so
    // the lock stays grabbable rather than falsely looking active.
    await act(async () => {
      lastSocket().drop();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const fresh = lastSocket();
    await act(async () => {
      fresh.serverSays({ type: "held", gen: 2 });
    });
    expect(JSON.parse(fresh.sent[fresh.sent.length - 1]).idle).toBe(true);
    vi.useRealTimers();
  });

  it("markLost flips a held lock to the save-a-copy state", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const { result } = renderHook(() => useDiagramLock(PROPS));
    let pending;
    await act(async () => {
      pending = result.current.acquire();
    });
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
      await pending;
    });
    act(() => result.current.markLost("Sam"));
    expect(result.current.status).toBe("lost");
    expect(result.current.holder).toBe("Sam");
  });
});

describe("diagramLockWsUrl", () => {
  it("builds a same-origin ws url", () => {
    const url = diagramLockWsUrl("d1", "a/b.drawio", "sess");
    expect(url).toContain("/api/v1/diagrams/lock/ws");
    expect(url).toContain("drive_id=d1");
    expect(url).toContain("path=a%2Fb.drawio");
    expect(url).toContain("session=sess");
  });
});
