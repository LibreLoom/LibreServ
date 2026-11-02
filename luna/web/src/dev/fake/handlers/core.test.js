import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld, user as makeUser } from "../world.js";

const originalFetch = window.fetch;
const originalXhr = window.XMLHttpRequest;
const originalWebSocket = window.WebSocket;
const fakeWindow = /** @type {Window & { __lunaFake?: unknown }} */ (window);
const originalFake = fakeWindow.__lunaFake;

/** @param {(world: any) => void} [seed] */
function startFake(seed) {
  const world = createWorld(seed);
  installFake({ world, scenario: {}, now: 0 });
  return world;
}

/** A POST the way lib/drives.js sends it. */
const postJson = (path, body = {}) =>
  window.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

describe("fake GET /api/v1/connect/status", () => {
  it("keeps device_token_error so the dashboard can build its Needs you row", async () => {
    // What lunad's status_for leaves behind when the saved token is unusable.
    startFake((w) => {
      w.connect = {
        connect_active: true,
        enabled: true,
        paired: true,
        unclaimed: true,
        tunnel_active: true,
        device_token_error: "Luna Connect did not accept this device token.",
      };
    });

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect(body.device_token_error).toBe("Luna Connect did not accept this device token.");
    // A token error also turns the remote-access flags off (net/connect.rs status_for).
    expect(body).toMatchObject({ enabled: false, paired: false, unclaimed: false, tunnel_active: false });
  });

  it("leaves device_token_error out when the token is fine, as lunad's serde skip does", async () => {
    startFake();

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect("device_token_error" in body).toBe(false);
    expect(body).toMatchObject({ enabled: false, paired: false, unclaimed: false, tunnel_active: false });
  });
});

describe("fake POST /api/v1/drives/:name/release", () => {
  it("succeeds after adopt removed the drive from the detected list", async () => {
    const world = startFake((w) => {
      w.detected = [{ name: "sdb", fs_type: "fat32" }];
    });

    const adopted = await postJson("/api/v1/drives/sdb/adopt", { label: "USB stick" });
    expect(adopted.status).toBe(200);
    expect(world.detected).toHaveLength(0);

    // The InspectModal closes after adopting and still releases the drive it showed.
    const released = await postJson("/api/v1/drives/sdb/release");
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ ok: true });
  });

  it("succeeds for a drive Luna never inspected, like release_foreign", async () => {
    startFake();

    const released = await postJson("/api/v1/drives/sdz/release");

    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ ok: true });
  });

  it("still refuses a Member", async () => {
    startFake((w) => {
      w.users.push(makeUser({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
      w.sessionUserId = "u2";
    });

    const released = await postJson("/api/v1/drives/sdz/release");

    expect(released.status).toBe(403);
    expect((await released.json()).error).toBe("Only an Admin can manage drives.");
  });
});
