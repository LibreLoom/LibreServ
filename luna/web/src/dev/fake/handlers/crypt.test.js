import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld } from "../world.js";
import { PASSWORD, encryptDrive } from "./crypt.js";

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

const postJson = (path, body = {}) =>
  window.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

describe("fake encrypted drives", () => {
  it("a locked drive says so in the drive list and the files routes answer 423", async () => {
    startFake((w) => encryptDrive(w, "d1"));
    const [drive] = await (await window.fetch("/api/v1/drives")).json();
    expect(drive).toMatchObject({ encrypted: true, locked: true, mounted: false });
    const files = await window.fetch("/api/v1/drives/d1/files?path=");
    expect(files.status).toBe(423);
    expect((await files.json()).code).toBe("drive_locked");
    const state = await (await window.fetch("/api/v1/drives/d1/encryption")).json();
    expect(state).toMatchObject({ status: "locked", locked: true, unlocked: false });
  });

  it("the right password unlocks it and lock closes it again", async () => {
    startFake((w) => encryptDrive(w, "d1"));
    expect((await postJson("/api/v1/drives/d1/unlock", { password: PASSWORD })).status).toBe(200);
    expect((await window.fetch("/api/v1/drives/d1/files?path=")).status).toBe(200);
    expect((await postJson("/api/v1/drives/d1/lock")).status).toBe(200);
    expect((await window.fetch("/api/v1/drives/d1/files?path=")).status).toBe(423);
  });

  it("five wrong passwords lock the person out, even for the right one", async () => {
    startFake((w) => encryptDrive(w, "d1"));
    for (let i = 1; i <= 5; i += 1) {
      const res = await postJson("/api/v1/drives/d1/unlock", { password: "nope" });
      expect(res.status).toBe(401);
      expect((await res.json()).locked_out).toBe(i === 5);
    }
    const res = await postJson("/api/v1/drives/d1/unlock", { password: PASSWORD });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("too_many_tries");
  });

  it("a busy drive refuses to lock", async () => {
    startFake((w) => { encryptDrive(w, "d1", { locked: false }); w.drives[0].lockBusy = true; });
    const res = await postJson("/api/v1/drives/d1/lock");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("drive_busy");
  });

  it("changing the password needs the current one and checks the new one", async () => {
    startFake((w) => encryptDrive(w, "d1"));
    expect((await postJson("/api/v1/drives/d1/password", { current_password: "wrong", new_password: "brand-new-pass-2" })).status).toBe(401);
    expect((await postJson("/api/v1/drives/d1/password", { current_password: PASSWORD, new_password: "short" })).status).toBe(400);
    expect((await postJson("/api/v1/drives/d1/password", { current_password: PASSWORD, new_password: "brand-new-pass-2" })).status).toBe(200);
    expect((await postJson("/api/v1/drives/d1/unlock", { password: "brand-new-pass-2" })).status).toBe(200);
  });

  it("an encrypted drive that isn't registered yet is added with its password", async () => {
    const world = startFake((w) => { w.detected = [{ name: "sdq", encrypted: true, fs_type: "crypto_LUKS", volume_label: "Family" }]; });
    expect((await postJson("/api/v1/drives/sdq/unlock-and-add", { password: "nope" })).status).toBe(401);
    const res = await postJson("/api/v1/drives/sdq/unlock-and-add", { password: PASSWORD });
    expect(res.status).toBe(200);
    const added = world.drives.find((d) => d.label === "Family");
    expect(added).toMatchObject({ encrypted: true, locked: false });
    expect(world.detected).toHaveLength(0);
  });
});
