import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld } from "../world.js";

const originalFetch = window.fetch;
const originalXhr = window.XMLHttpRequest;
const originalWebSocket = window.WebSocket;
const fakeWindow = /** @type {Window & { __lunaFake?: unknown }} */ (window);
const originalFake = fakeWindow.__lunaFake;

const UID = "7K4M2Q9XR8N36T5W1PZH";
const OTHER_UID = "8K4M2Q9XR8N36T5W1PZH";
const CODE = "A3F91C";
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
const pairingBody = { device_uid: UID, verification_code: CODE };

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

describe("fake pairing-material writes", () => {
  it("normalizes and saves the original Device ID and Verification code", async () => {
    const world = startFake();
    const response = await postJson("/api/v1/connect/device-token", {
      device_uid: "7k4m-2q9x-r8n3-6t5w-1pzh",
      verification_code: " a3f91c ",
    });

    expect(response.status).toBe(200);
    expect(world.connect).toMatchObject({ state: "unbound", device_uid: UID, verification_code: CODE });
  });

  it("keeps the Device ID immutable", async () => {
    const world = startFake((w) => {
      w.connect = { state: "unbound", device_uid: UID, verification_code: CODE };
    });

    const response = await postJson("/api/v1/connect/device-token", {
      device_uid: OTHER_UID,
      verification_code: CODE,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/different Device ID/i);
    expect(world.connect).toMatchObject({ device_uid: UID, verification_code: CODE });
  });

  it("does not replace a saved Verification code", async () => {
    const world = startFake((w) => {
      w.connect = { state: "bound", paired: true, device_uid: UID, verification_code: CODE };
    });

    const response = await postJson("/api/v1/connect/device-token", {
      device_uid: UID,
      verification_code: "B4E82D",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not match/i);
    expect(world.connect.verification_code).toBe(CODE);
  });

  it("restores the same pair after only the local Verification code was removed", async () => {
    const world = startFake((w) => {
      w.connect = { state: "bound", paired: true, connect_active: true, device_uid: UID, verification_code: null };
    });

    const removed = await window.fetch("/api/v1/connect/device-token", { method: "DELETE" });
    expect(removed.status).toBe(200);
    const restored = await postJson("/api/v1/connect/device-token", pairingBody);

    expect(restored.status).toBe(200);
    expect(world.connect).toMatchObject({ state: "bound", paired: true, device_uid: UID, verification_code: CODE });
  });

  it("refuses pairing-material writes while a disconnect is pending", async () => {
    startFake((w) => {
      w.connect = { state: "bound", unbind_pending: true, device_uid: UID, verification_code: null };
    });

    const response = await postJson("/api/v1/connect/device-token", pairingBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/still disconnecting/i);
  });

  it.each(["pairing", "bound", "revoked"])("requires the original Device ID in the %s state", async (state) => {
    startFake((w) => {
      w.connect = { state, device_uid: null, verification_code: null };
    });

    const response = await postJson("/api/v1/connect/device-token", pairingBody);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Device ID is missing/i);
  });
});

describe("fake POST /api/v1/connect/unbind", () => {
  it("cancels pairing after password step-up", async () => {
    const world = startFake((w) => {
      w.connect = {
        state: "pairing",
        account_id: "acct_1",
        pairing_id: "pair_1",
        device_uid: UID,
        verification_code: CODE,
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
      device_uid: UID,
      verification_code: CODE,
      unbind_pending: false,
    });
  });

  it("clears revoked ownership after password step-up", async () => {
    const world = startFake((w) => {
      w.connect = { state: "revoked", account_id: "acct_1", device_uid: UID, verification_code: CODE };
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
      w.connect = { state: "bound", paired: true, account_id: "acct_1", device_uid: UID };
      w.unbindFails = true;
    });

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });

    expect(response.status).toBe(504);
    expect(world.connect).toMatchObject({ state: "bound", paired: false, account_id: "acct_1", unbind_pending: true });
    expect(world.connectActive).toBe(false);
  });

  it("does not turn a failed revoked disconnect into an ordinary pending retry", async () => {
    const world = startFake((w) => {
      w.connect = { state: "revoked", account_id: "acct_1", device_uid: UID };
      w.unbindFails = true;
    });

    const response = await postJson("/api/v1/connect/unbind", { password: PASSWORD });

    expect(response.status).toBe(504);
    expect(world.connect).toMatchObject({ state: "revoked", account_id: "acct_1", unbind_pending: false });
  });
});
