import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { createWorld } from "../world.js";
import { scenarios } from "../../scenarios/registry.js";

const originalFetch = window.fetch;
const originalXhr = window.XMLHttpRequest;
const originalWebSocket = window.WebSocket;
const fakeWindow = /** @type {Window & { __lunaFake?: unknown }} */ (window);
const originalFake = fakeWindow.__lunaFake;

/** Starts the fake from a scenario's own seed, so the test breaks when the seed does. */
function startScenario(id) {
  const scenario = scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  const world = createWorld(scenario.seed);
  installFake({ world, scenario, now: 0 });
  return world;
}

const get = (path) => window.fetch(path).then(async (res) => ({ status: res.status, data: await res.json() }));
const post = (path, body) => window.fetch(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, data: await res.json() }));

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

// A tester saw one version where there should be several. An older copy has to be a real
// earlier file — its own bytes, its own size — and Download and Restore have to act on the
// copy that was picked, not on today's file (api/backup_folder.rs).
describe("fake backup versions, download and restore", () => {
  it("the backups-browse seed lists the current copy plus two older ones that really differ", async () => {
    startScenario("files/backups-browse");

    const { status, data } = await get("/api/v1/drives/d2/backups/b1/versions?path=notes.txt");

    expect(status).toBe(200);
    // lunad pushes the current copy first (at: null), then the kept copies newest first.
    expect(data).toHaveLength(3);
    expect(data[0].at).toBeNull();
    expect(data.slice(1).every((v) => typeof v.at === "number")).toBe(true);
    expect(data[1].at).toBeGreaterThan(data[2].at);
    // Every row is a different file, not today's size repeated: a tester judges by the list.
    const sizes = data.map((v) => v.size);
    expect(sizes.every((n) => n > 0)).toBe(true);
    expect(new Set(sizes).size).toBe(3);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
    // Each row carries the mtime lunad reads off the copy.
    expect(data.every((v) => typeof v.mtime === "number" && v.mtime > 0)).toBe(true);
  });

  it("downloads the copy that was picked, not today's file", async () => {
    startScenario("files/backups-browse");
    const { data: versions } = await get("/api/v1/drives/d2/backups/b1/versions?path=notes.txt");
    const older = versions[1];

    const res = await window.fetch(`/api/v1/drives/d2/backups/b1/download?path=notes.txt&at=${older.at}`);
    const bytes = await res.text();

    expect(res.status).toBe(200);
    expect(bytes.length).toBe(older.size);
    // The current copy is the longer shopping list; the older copy stops short of it.
    const current = await (await window.fetch("/api/v1/drives/d2/backups/b1/download?path=notes.txt")).text();
    expect(bytes).not.toBe(current);
    expect(current.startsWith(bytes)).toBe(true);
  });

  it("restores an older copy beside the current file and never replaces it", async () => {
    const world = startScenario("files/backups-browse");
    const before = world.fs.d1.nodes["Documents/notes.txt"].text;
    const { data: versions } = await get("/api/v1/drives/d2/backups/b1/versions?path=notes.txt");
    const older = versions[2];

    const { status, data } = await post("/api/v1/drives/d2/backups/b1/restore", { path: "notes.txt", at: older.at });

    expect(status).toBe(200);
    expect(data.name).toMatch(/^notes \(restored .+\)\.txt$/);
    // lunad's rule: a clashing name gets the "(restored <day>)" suffix, the original stays.
    expect(world.fs.d1.nodes["Documents/notes.txt"].text).toBe(before);
    expect(world.fs.d1.nodes[`Documents/${data.name}`].text.length).toBe(older.size);
  });

  it("restores a file at the top of the backup into the source folder", async () => {
    // The destination is the backup's own root, which `join(root, "")` used to leave
    // with a trailing slash — every top-level restore answered 409 "folder is missing".
    const world = startScenario("files/backups-browse");

    const { status, data } = await post("/api/v1/drives/d2/backups/b1/restore", { path: "notes.txt" });

    expect(status).toBe(200);
    expect(data.path).toBe(data.name);
    expect(world.fs.d1.nodes[`Documents/${data.name}`]).toBeTruthy();
  });

  it("a folder inside the backup still restores whole", async () => {
    const world = startScenario("files/backups-browse");

    const { status, data } = await post("/api/v1/drives/d2/backups/b1/restore", { path: "Taxes" });

    expect(status).toBe(200);
    expect(world.fs.d1.nodes[`Documents/${data.name}/2025 return.pdf`]).toBeTruthy();
    expect(world.fs.d1.nodes["Documents/Taxes/2025 return.pdf"]).toBeTruthy();
  });

  it("noVersions keeps only the current copy", async () => {
    startScenario("files/backups-no-versions");

    const { data } = await get("/api/v1/drives/d2/backups/b1/versions?path=notes.txt");

    expect(data).toEqual([expect.objectContaining({ at: null })]);
  });

  it("a backup on another drive is a 404, and an unplugged drive a 409", async () => {
    const world = startScenario("files/backups-browse");
    // b1 lives on d2; asking for it through d1 must not find it.
    expect(await get("/api/v1/drives/d1/backups/b1/versions?path=notes.txt")).toMatchObject({
      status: 404,
      data: { error: "Luna couldn't find that backup on this drive." },
    });

    world.summaries.d2.mounted = false;
    expect(await get("/api/v1/drives/d2/backups/b1/versions?path=notes.txt")).toMatchObject({
      status: 409,
      data: { error: "Connect that drive to see its backups." },
    });
  });

  it("refuses a version that is not digits, and one this backup never kept", async () => {
    startScenario("files/backups-browse");

    expect(await get("/api/v1/drives/d2/backups/b1/download?path=notes.txt&at=soon")).toMatchObject({
      status: 400,
      data: { error: "That version is not valid. Choose one from the list." },
    });
    expect(await get("/api/v1/drives/d2/backups/b1/download?path=notes.txt&at=123")).toMatchObject({
      status: 404,
      data: { error: "Luna couldn't find that version of this file." },
    });
    expect(await post("/api/v1/drives/d2/backups/b1/restore", { path: "notes.txt", at: 123 })).toMatchObject({
      status: 404,
      data: { error: "Luna couldn't find that in this backup." },
    });
  });

  it("lists a deleted file's kept copies without a current one", async () => {
    startScenario("files/backups-browse");

    const { status, data } = await get("/api/v1/drives/d2/backups/b1/versions?path=deleted-since.txt");

    expect(status).toBe(200);
    // Gone from the source, so there is no `at: null` row — only the copies kept.
    expect(data.length).toBeGreaterThan(1);
    expect(data.every((v) => typeof v.at === "number")).toBe(true);
    expect(new Set(data.map((v) => v.size)).size).toBe(data.length);
  });
});
