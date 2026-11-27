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
  it("keeps connect_error and revoked state so the dashboard can build its Needs you row", async () => {
    startFake((w) => {
      w.connect = {
        state: "revoked",
        connect_active: false,
        enabled: false,
        paired: false,
        unclaimed: false,
        tunnel_active: false,
        connect_error: "Luna Connect no longer accepts this Luna's connection.",
      };
    });

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect(body.connect_error).toBe("Luna Connect no longer accepts this Luna's connection.");
    expect(body).toMatchObject({ state: "revoked", enabled: false, paired: false, tunnel_active: false });
  });

  it("leaves connect_error out for an unused identity", async () => {
    startFake();

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect("connect_error" in body).toBe(false);
    expect(body).toMatchObject({ state: "unbound", enabled: false, paired: false, unclaimed: true, tunnel_active: false });
  });

  it("reports pairing without treating stale local activity as a binding", async () => {
    startFake((w) => {
      w.connectActive = true;
      w.connect = { state: "pairing", paired: false, device_token: "7K4M2Q9XR8N36T5W1PZH" };
    });

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect(body).toMatchObject({ state: "pairing", connect_active: false, paired: false, unclaimed: true });
    expect(body).not.toHaveProperty("device_code");
    expect(body).not.toHaveProperty("device_token_error");
  });

  it("reports a bound Luna without exposing the rolling credential", async () => {
    startFake((w) => {
      w.connectActive = true;
      w.connect = {
        state: "bound",
        paired: true,
        enabled: true,
        hostname: "kitchen.luna.servers.libreloom.org",
        device_token: "7K4M2Q9XR8N36T5W1PZH",
      };
    });

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect(body).toMatchObject({ state: "bound", connect_active: true, paired: true, unclaimed: false });
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("device_token_error");
  });

  it("keeps a pending disconnect in the bound state with pairing stopped", async () => {
    startFake((w) => {
      w.connectActive = true;
      w.connect = { state: "bound", paired: false, unbind_pending: true };
    });

    const body = await (await window.fetch("/api/v1/connect/status")).json();

    expect(body).toMatchObject({ state: "bound", unbind_pending: true, connect_active: false, paired: false });
    expect(body.connect_error).toMatch(/still disconnecting/);
  });

  it("does not report Connect active just because a device token exists", async () => {
    startFake((w) => {
      w.connectActive = true;
      w.connect = { paired: false, device_token: "7K4M2Q9XR8N36T5W1PZH" };
    });

    const status = await (await window.fetch("/api/v1/auth/status")).json();
    expect(status.connect_active).toBe(false);
  });
});

describe("fake POST /api/v1/auth/register off-LAN setup", () => {
  const body = { username: "max", display_name: "Max", password: "hunter22hunter1" };
  const TOKEN = "7K4M2Q9XR8N36T5W1PZH";
  const offLan = (world) => {
    world.users = [];
    world.sessionUserId = null;
    world.hasAdmin = false;
    world.setupOffLan = true;
    world.connect = { ...world.connect, device_token: TOKEN };
  };

  it("tells the setup page when the request is off the home network", async () => {
    startFake(offLan);
    const status = await (await window.fetch("/api/v1/auth/status")).json();
    expect(status.setup_off_lan).toBe(true);
    expect(status.device_token_set).toBe(true);
  });

  it("reports that no device token is saved", async () => {
    startFake((w) => { offLan(w); w.connect = { ...w.connect, device_token: null }; });
    const status = await (await window.fetch("/api/v1/auth/status")).json();
    expect(status.device_token_set).toBe(false);
  });

  it("refuses a missing or wrong token and creates no account", async () => {
    const world = startFake(offLan);

    const missing = await postJson("/api/v1/auth/register", body);
    expect(missing.status).toBe(403);
    const wrong = await postJson("/api/v1/auth/register", { ...body, device_token: "8K4M2Q9XR8N36T5W1PZH" });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toMatch(/device token/i);
    expect(world.users).toHaveLength(0);
  });

  it("accepts the right token, ignoring grouping and case", async () => {
    const world = startFake(offLan);

    const ok = await postJson("/api/v1/auth/register", { ...body, device_token: "7k4m-2q9x-r8n3-6t5w-1pzh" });

    expect(ok.status).toBe(200);
    expect(world.users).toHaveLength(1);
  });

  it("needs no token on the home network", async () => {
    const world = startFake((w) => { offLan(w); w.setupOffLan = false; });

    const ok = await postJson("/api/v1/auth/register", body);

    expect(ok.status).toBe(200);
    expect(world.users).toHaveLength(1);
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
