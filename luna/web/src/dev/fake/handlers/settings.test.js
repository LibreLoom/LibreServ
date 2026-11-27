import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld } from "../world.js";

const originalFetch = window.fetch;
const originalXhr = window.XMLHttpRequest;
const originalWebSocket = window.WebSocket;
const fakeWindow = /** @type {Window & { __lunaFake?: unknown }} */ (window);
const originalFake = fakeWindow.__lunaFake;

const TOKEN = "7K4M2Q9XR8N36T5W1PZH";
const PASSWORD = "hunter22";

/** @param {(world: any) => void} [seed] */
function startFake(seed) {
  const world = createWorld(seed);
  installFake({ world, scenario: {}, now: 0 });
  return world;
}

const postJson = (path, body = {}) => window.fetch(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const putJson = (path, body = {}) => window.fetch(path, {
  method: "PUT",
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

describe("fake device token writes", () => {
  it("normalizes and saves the device token locally", async () => {
    const world = startFake();

    const response = await putJson("/api/v1/connect/device-token", { device_token: "7k4m-2q9x-r8n3-6t5w-1pzh" });

    expect(response.status).toBe(200);
    expect(world.connect).toMatchObject({ state: "unbound", device_token: TOKEN });
    const status = await (await window.fetch("/api/v1/connect/status")).json();
    expect(status.device_token_set).toBe(true);
  });

  it("refuses a token that is not 20 characters", async () => {
    const world = startFake();

    const response = await putJson("/api/v1/connect/device-token", { device_token: "7K4M-2Q9X" });

    expect(response.status).toBe(400);
    expect(world.connect.device_token).toBeNull();
  });

  it("replaces a saved token without touching the Connect binding", async () => {
    const world = startFake((w) => {
      w.connect = { state: "bound", paired: true, connect_active: true, device_token: TOKEN };
    });

    const response = await putJson("/api/v1/connect/device-token", { device_token: "8K4M2Q9XR8N36T5W1PZH" });

    expect(response.status).toBe(200);
    expect(world.connect).toMatchObject({ state: "bound", paired: true, device_token: "8K4M2Q9XR8N36T5W1PZH" });
  });
});

describe("fake DELETE /api/v1/connect/device-token", () => {
  it("removes the saved token while unpaired", async () => {
    const world = startFake((w) => {
      w.connect = { state: "unbound", device_token: TOKEN };
    });

    const response = await window.fetch("/api/v1/connect/device-token", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(world.connect.device_token).toBeNull();
    const status = await (await window.fetch("/api/v1/connect/status")).json();
    expect(status.device_token_set).toBe(false);
  });

  it("refuses with a plain message while paired", async () => {
    const world = startFake((w) => {
      w.connect = { state: "bound", paired: true, connect_active: true, device_token: TOKEN };
    });

    const response = await window.fetch("/api/v1/connect/device-token", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/device token/i);
    expect(world.connect.device_token).toBe(TOKEN);
  });
});

describe("fake POST /api/v1/connect/unbind", () => {
  it("cancels pairing after password step-up", async () => {
    const world = startFake((w) => {
      w.connect = {
        state: "pairing",
        account_id: "acct_1",
        pairing_id: "pair_1",
        device_token: TOKEN,
      };
    });

    const refused = await postJson("/api/v1/connect/unbind", { password: "wrong" });
    expect(refused.status).toBe(401);
    expect(world.connect.state).toBe("pairing");

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });
    expect(response.status).toBe(200);
    expect(world.connect).toMatchObject({
      state: "unbound",
      account_id: null,
      pairing_id: null,
      device_token: TOKEN,
      unbind_pending: false,
    });
  });

  it("clears revoked ownership after password step-up", async () => {
    const world = startFake((w) => {
      w.connect = { state: "revoked", account_id: "acct_1", device_token: TOKEN };
    });

    const refused = await postJson("/api/v1/connect/unbind", { password: "wrong" });
    expect(refused.status).toBe(401);
    expect(world.connect.account_id).toBe("acct_1");

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });
    expect(response.status).toBe(200);
    expect(world.connect).toMatchObject({ state: "unbound", account_id: null, unbind_pending: false });
  });

  it("keeps a failed revocation pending", async () => {
    const world = startFake((w) => {
      w.connect = { state: "bound", paired: true, account_id: "acct_1", device_token: TOKEN };
      w.unbindFails = true;
    });

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });

    expect(response.status).toBe(504);
    expect(world.connect).toMatchObject({ state: "bound", paired: false, account_id: "acct_1", unbind_pending: true });
    expect(world.connectActive).toBe(false);
  });

  it("does not turn a failed revoked disconnect into an ordinary pending retry", async () => {
    const world = startFake((w) => {
      w.connect = { state: "revoked", account_id: "acct_1", device_token: TOKEN };
      w.unbindFails = true;
    });

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });

    expect(response.status).toBe(504);
    expect(world.connect).toMatchObject({ state: "revoked", account_id: "acct_1", unbind_pending: false });
  });
});
