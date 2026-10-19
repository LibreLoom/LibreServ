import { describe, expect, it } from "vitest";
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld } from "./fake/world.js";
import { scenarios } from "./scenarios/registry.js";

describe("state gallery harness", () => {
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
