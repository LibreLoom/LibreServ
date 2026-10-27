import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld } from "../world.js";

const originalFetch = window.fetch;
const originalXhr = window.XMLHttpRequest;
const originalWebSocket = window.WebSocket;
const fakeWindow = /** @type {Window & { __lunaFake?: unknown }} */ (window);
const originalFake = fakeWindow.__lunaFake;

function startFake({ failureAfter, relinkPending = false } = {}) {
  const world = createWorld();
  world.restore = {
    needed: true,
    relink_pending: relinkPending,
    luna_id: "luna-fixture-1",
    signing_public: "fixture",
    cloud_snapshots: 3,
    indexed_snapshots: 0,
  };
  if (failureAfter !== undefined) world.restoreFailureAfter = failureAfter;
  installFake({ world, scenario: {}, now: 0 });
  return world;
}

async function eventFrames(response) {
  const body = await response.text();
  return body.trim().split("\n\n").map((frame) => JSON.parse(frame.slice("data: ".length)));
}

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

describe("fake shared restore event stream", () => {
  it("reports progress, keeps a partial write after a provider error, and completes a retry", async () => {
    const world = startFake({ failureAfter: 1 });
    const first = await window.fetch("/api/v1/cloud/restore", { method: "POST" });
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    const failed = await eventFrames(first);
    expect(failed).toEqual([
      { type: "progress", processed: 1, total: 3, snapshots: 1, already_indexed: 0, skipped: 0 },
      { type: "error", message: "Luna couldn't finish restoring your backup list. Some versions may already be back; try again to continue." },
    ]);
    expect(world.restore).toMatchObject({ needed: true, indexed_snapshots: 1 });

    const retry = await window.fetch("/api/v1/cloud/restore", { method: "POST" });
    const completed = await eventFrames(retry);
    expect(completed).toEqual([
      { type: "progress", processed: 2, total: 3, snapshots: 1, already_indexed: 1, skipped: 0 },
      { type: "progress", processed: 3, total: 3, snapshots: 2, already_indexed: 1, skipped: 0 },
      { type: "done", snapshots: 2, already_indexed: 1, skipped: 0, warning: null },
    ]);
    expect(world.restore).toMatchObject({ needed: false, indexed_snapshots: 3 });
  });

  it("aborts the event stream after progress and leaves already indexed versions retryable", async () => {
    const world = startFake();
    const controller = new AbortController();
    const response = await window.fetch("/api/v1/cloud/restore", {
      method: "POST",
      signal: controller.signal,
    });
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"progress"');
    expect(world.restore.indexed_snapshots).toBe(1);

    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(world.restore).toMatchObject({ needed: true, indexed_snapshots: 1 });

    const retry = await window.fetch("/api/v1/cloud/restore", { method: "POST" });
    const completed = await eventFrames(retry);
    expect(completed.at(-1)).toEqual({ type: "done", snapshots: 2, already_indexed: 1, skipped: 0, warning: null });
    expect(world.restore).toMatchObject({ needed: false, indexed_snapshots: 3 });
  });

  it("keeps the restore warning in the terminal event while leaving status retryable", async () => {
    const world = startFake({ relinkPending: true });
    const response = await window.fetch("/api/v1/cloud/restore", { method: "POST" });
    const frames = await eventFrames(response);
    expect(frames.at(-1)).toMatchObject({
      type: "done",
      warning: "Some backups are still linked to an old account. Try again to finish reconnecting them.",
    });
    expect(world.restore).toMatchObject({ needed: true, relink_pending: true, indexed_snapshots: 3 });
  });
});
