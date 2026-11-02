import { describe, expect, it } from "vitest";
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld } from "./fake/world.js";
import { addFile, fsOf, fsOpts } from "./fake/handlers/files.js";
import { scenarioById, scenarios } from "./scenarios/registry.js";

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

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {{ overwrite?: boolean, keepBoth?: boolean }} [opts] */
const upload = (path, name, opts = {}) => {
  const { overwrite, keepBoth } = opts;
  const form = new FormData();
  form.append("file", new File(["hello"], name, { type: "text/plain" }));
  const q = new URLSearchParams({ path, ...(overwrite ? { overwrite: "1" } : {}), ...(keepBoth ? { keep_both: "1" } : {}) });
  return fetch(`/api/v1/drives/d1/files/upload?${q}`, { method: "POST", body: form }).then(async (res) => ({ status: res.status, data: await res.json() }));
};

describe("file operation card: the fake answers like lunad", () => {
  it("a taken name is a 409 with its kind, and keep both lands the next free name at complete", async () => {
    installFake({ world: createWorld(), scenario: {}, now: 0 });
    const taken = await call("POST", "/api/v1/uploads", { drive_id: "d1", path: "Documents", name: "notes.txt", size: 0 });
    expect(taken.status).toBe(409);
    expect(taken.data).toMatchObject({ code: "exists", existing_kind: "file" });
    const made = await call("POST", "/api/v1/uploads", { drive_id: "d1", path: "Documents", name: "notes.txt", size: 0, on_conflict: "keep_both" });
    expect(made.status).toBe(200);
    const done = await call("POST", `/api/v1/uploads/${made.data.upload_id}/complete?keep_both=1`);
    expect(done.data.name).toBe("notes (1).txt");
  });

  it("a folder clash is refused as a folder, and overwrite never replaces a folder", async () => {
    const world = createWorld((w) => { addFile(w, "d1", "Documents/Taxes/2025.pdf", { size: 10 }); });
    installFake({ world, scenario: {}, now: 0 });
    const clash = await upload("Documents", "Taxes");
    expect(clash.status).toBe(409);
    expect(clash.data).toMatchObject({ code: "exists", existing_kind: "dir" });
    expect((await upload("Documents", "Taxes", { overwrite: true })).status).toBe(409);
    const kept = await upload("Documents", "Taxes", { keepBoth: true });
    expect(kept.data.name).toBe("Taxes (1)");
    expect(fsOf(world, "d1").nodes["Documents/Taxes/2025.pdf"]).toBeTruthy();
  });

  it("a multipart file clash offers keep both and overwrite, with lunad's (1) numbering", async () => {
    const world = createWorld();
    installFake({ world, scenario: {}, now: 0 });
    const clash = await upload("Documents", "notes.txt");
    expect(clash.status).toBe(409);
    expect(clash.data.code).toBe("exists");
    expect((await upload("Documents", "notes.txt", { keepBoth: true })).data.name).toBe("notes (1).txt");
    expect((await upload("Documents", "notes.txt", { overwrite: true })).data.name).toBe("notes.txt");
    expect(fsOf(world, "d1").nodes["Documents/notes.txt"].size).toBe(5);
  });

  it("uploads create the folders they go into, and refuse a name Luna keeps for itself", async () => {
    const world = createWorld();
    installFake({ world, scenario: {}, now: 0 });
    expect((await upload("Trips/2026/Lisbon", "tram.jpg")).status).toBe(200);
    expect(fsOf(world, "d1").nodes["Trips/2026/Lisbon"]?.kind).toBe("dir");
    const refused = await upload("Documents", ".luna-3f9a2c1e.txt");
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe("That file name can't be used. Try renaming it.");
  });

  it("a fifth copy or move at once is a 503 queue_full, and the fourth is still accepted", async () => {
    installFake({ world: createWorld((w) => { fsOpts(w).jobMs = 60_000; }), scenario: {}, now: 0 });
    const copy = (from) => call("POST", "/api/v1/jobs", { kind: "copy", from_drive: "d1", from_path: from, to_drive: "d1", to_path: "Documents/Taxes" });
    for (const from of ["Music", "Photos/2025", "Photos/2024", "Documents/notes.txt"]) expect((await copy(from)).status).toBe(200);
    const fifth = await copy("Photos");
    expect(fifth.status).toBe(503);
    expect(fifth.data.code).toBe("queue_full");
    expect(fifth.data.error).toBe("Luna is already working on a lot of copies and moves. Try again when they finish.");
  });

  it("the move-fails-partway scenario fails with the drive-full words and leaves Spain where it was", async () => {
    const scenario = scenarioById("files/move-fails-partway");
    const world = createWorld(scenario.seed);
    fsOpts(world).jobMs = 40;
    installFake({ world, scenario, now: 0 });
    const made = await call("POST", "/api/v1/jobs", { kind: "move", from_drive: "d1", from_path: "Photos/2024/Spain", to_drive: "d2", to_path: "" });
    expect(made.status).toBe(200);
    await sleepFor(150);
    const job = (await call("GET", `/api/v1/jobs/${made.data.id}`)).data;
    expect(job.state).toBe("error");
    expect(job.error).toBe("Backup drive is full. Free up some space on it and try again. Nothing was moved. Your files are still where they were.");
    expect(job.progress).toBeLessThan(job.total);
    expect(fsOf(world, "d1").nodes["Photos/2024/Spain/beach.jpg"]).toBeTruthy();
    expect(Object.keys(fsOf(world, "d2").nodes)).toEqual([]);
  });

  it("the four new scenarios exist and their faults name real routes", () => {
    for (const id of ["files/upload-many-clashes", "files/upload-folder-mixed", "files/trash-empty-slow", "files/restore-backup-slow"]) {
      expect(scenarioById(id), id).toBeTruthy();
    }
    expect(scenarioById("files/trash-empty-slow").faults[0].match).toBe("POST /api/v1/drives/d1/files/purge");
    expect(scenarioById("files/restore-backup-slow").faults[0].match).toBe("POST /api/v1/drives/d2/backups/*/restore");
  });
});

