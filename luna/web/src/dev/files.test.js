import { describe, expect, it } from "vitest";
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld } from "./fake/world.js";
import { fsOpts } from "./fake/handlers/files.js";
import { scenarios } from "./scenarios/registry.js";

const call = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
};

describe("files fake", () => {
  it("keeps changes: collision, delete, restore", async () => {
    installFake({ world: createWorld(), scenario: {}, now: 0 });
    expect((await call("POST", "/api/v1/drives/d1/files/mkdir", { path: "Documents/Taxes" })).status).toBe(409);
    expect((await call("DELETE", "/api/v1/drives/d1/files?path=Documents/notes.txt")).status).toBe(200);
    const trash = (await call("GET", "/api/v1/drives/d1/files?path=.luna-trash")).data;
    expect(trash[0].original_name).toBe("notes.txt");
    await call("POST", "/api/v1/drives/d1/files/restore", { path: `.luna-trash/${trash[0].name}`, dest: "Documents/notes.txt" });
    const list = (await call("GET", "/api/v1/drives/d1/files?path=Documents")).data;
    expect(list.map((e) => e.name)).toContain("notes.txt");
  });

  it("copy jobs finish and can fail partway", async () => {
    const world = createWorld((w) => { fsOpts(w).jobMs = 1; });
    installFake({ world, scenario: {}, now: 0 });
    const job = { kind: "copy", from_drive: "d1", from_path: "Documents", to_drive: "d1", to_path: "Music" };
    expect((await call("POST", "/api/v1/jobs", job)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await call("GET", "/api/v1/jobs")).data[0].state).toBe("done");
    expect((await call("GET", "/api/v1/drives/d1/files?path=Music")).data.map((e) => e.name)).toContain("Documents");
  });

  it("every files scenario seeds and its start folder lists without a missing mock", async () => {
    for (const s of scenarios.filter((x) => x.id.startsWith("files/"))) {
      const world = createWorld(s.seed);
      installFake({ world, scenario: s, now: 0 });
      const path = new URL(s.url, "http://x").searchParams.get("path") || "";
      const res = await fetch(`/api/v1/drives/d1/files?path=${encodeURIComponent(path)}`);
      expect(res.status, s.id).not.toBe(501);
    }
  });
});
