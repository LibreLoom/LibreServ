import { describe, expect, it } from "vitest";
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld } from "./fake/world.js";
import { scenarios } from "./scenarios/registry.js";

describe("state gallery harness", () => {
  it("mirrors token ownership and Connect Admin permissions", async () => {
    const world = createWorld((w) => {
      w.users.push({ id: "u2", username: "member", role: "user" });
      w.tokens = [{ id: "admin-token", name: "Phone" }];
    });
    installFake({ world, scenario: {}, now: 0 });
    world.sessionUserId = "u2";
    expect(await (await fetch("/api/v1/device-tokens")).json()).toEqual([]);
    expect((await fetch("/api/v1/device-tokens/admin-token", { method: "DELETE" })).status).toBe(404);
    expect((await fetch("/api/v1/device-tokens/admin-token/usage")).status).toBe(404);
    const created = await fetch("/api/v1/device-tokens", { method: "POST", body: JSON.stringify({ name: "Phone" }) });
    expect(created.status).toBe(200);
    expect((await created.json()).user_id).toBe("u2");
    expect((await fetch("/api/v1/connect/device-token", { method: "POST", body: JSON.stringify({ token: "demo" }) })).status).toBe(403);
    expect((await fetch("/api/v1/connect/device-token", { method: "DELETE" })).status).toBe(403);
    world.sessionUserId = "u1";
    expect((await (await fetch("/api/v1/device-tokens")).json()).map((t) => t.id)).toEqual(["admin-token"]);
  });

  it("allows first Connect token during setup but requires an Admin to replace it", async () => {
    const world = createWorld((w) => { w.users = []; w.sessionUserId = null; });
    installFake({ world, scenario: {}, now: 0 });
    const save = (token) => fetch("/api/v1/connect/device-token", { method: "POST", body: JSON.stringify({ token }) });
    expect((await save("first")).status).toBe(200);
    expect((await save("first")).status).toBe(200);
    expect((await save("other")).status).toBe(403);
  });

  it("builds a world from every scenario seed", () => {
    for (const s of scenarios) expect(() => createWorld(s.seed), s.id).not.toThrow();
  });

  it("answers real endpoints, applies faults, and flags unknown endpoints", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    const ok = await fetch("/api/v1/drives");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveLength(1);

    fake.addFault({ match: "GET /api/v1/drives", mode: "500" });
    expect((await fetch("/api/v1/drives")).status).toBe(500);
    fake.clearFaults();

    expect((await fetch("/api/v1/nope")).status).toBe(501);
    expect(fake.snapshot().unhandled[0][0]).toBe("GET /api/v1/nope");

    fake.expireSession();
    expect((await fetch("/api/v1/drives")).status).toBe(401);
  });
});
