// Tests for the harness itself: the fake lunad has to behave like lunad, or a "bug" found
// in the gallery may be the fake's. (Written, not run: the orchestrator runs ./ci.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createRouter, get } from "./fake/router.js";
import { parseRule, ruleMatches } from "./fake/faults.js";
import { createWorld, nextId, user } from "./fake/world.js";
import { addFile, fsOf, fsOpts } from "./fake/handlers/files.js";
import { loadState, saveState } from "./fake/persist.js";
import { bootMock, keepWorld } from "./boot.js";

const RealDate = window.Date;
const call = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A second drive for copies and moves. */
const withBackupDrive = (w) => {
  w.drives.push({ id: "d2", label: "Backup drive", state: "as_is", device: "sdb1", fs_type: "ext4" });
  w.summaries.d2 = { id: "d2", mounted: true, total_bytes: 100e9, free_bytes: 90e9, used_bytes: 10e9, shortcuts: [] };
  w.fs = { ...(w.fs || {}), d2: { nodes: {}, trash: [] } };
};
const asMember = (w, rows = []) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
  w.sessionUserId = "u2";
  w.access = rows.map((r) => ({ user_id: "u2", kind: "path", ...r }));
};

afterEach(() => { window.Date = RealDate; });

describe("fault rules", () => {
  const rule = (match) => ({ match });
  it("match the exact path, not a piece of it", () => {
    expect(ruleMatches(rule("GET /api/v1/drives"), "GET", "/api/v1/drives")).toBe(true);
    expect(ruleMatches(rule("GET /api/v1/drives"), "GET", "/api/v1/drives/")).toBe(true);
    expect(ruleMatches(rule("GET /api/v1/drives"), "GET", "/api/v1/drives/d1/files")).toBe(false);
    expect(ruleMatches(rule("GET /api/v1/drives"), "GET", "/api/v1/drives/d1/summary")).toBe(false);
    expect(ruleMatches(rule("GET /api/v1/drives"), "POST", "/api/v1/drives")).toBe(false);
  });
  it("take any method when none is given", () => {
    expect(ruleMatches(rule("/api/v1/users"), "POST", "/api/v1/users")).toBe(true);
    expect(ruleMatches(rule("/api/v1/users"), "GET", "/api/v1/users")).toBe(true);
  });
  it("use * as an explicit wildcard", () => {
    expect(ruleMatches(rule("GET /api/v1/drives/*/files"), "GET", "/api/v1/drives/d1/files")).toBe(true);
    expect(ruleMatches(rule("GET /api/v1/drives/*/files"), "GET", "/api/v1/drives/d1/files/stat")).toBe(false);
    expect(ruleMatches(rule("DELETE /api/v1/users/*"), "DELETE", "/api/v1/users/u2")).toBe(true);
    expect(ruleMatches(rule("DELETE /api/v1/users/*"), "DELETE", "/api/v1/users")).toBe(false);
  });
  it("can ask for query pairs", () => {
    const r = rule("GET /api/v1/gallery?favorites=true");
    expect(ruleMatches(r, "GET", "/api/v1/gallery", "?favorites=true&limit=80")).toBe(true);
    expect(ruleMatches(r, "GET", "/api/v1/gallery", "?limit=80")).toBe(false);
    expect(ruleMatches(r, "GET", "/api/v1/gallery", "")).toBe(false);
  });
  it("ignore an empty rule", () => {
    expect(parseRule("  ")).toBeNull();
    expect(ruleMatches(rule(""), "GET", "/x")).toBe(false);
  });
});

describe("route table", () => {
  it("throws on a duplicate method and pattern, whatever the parameter is called", () => {
    const r = createRouter();
    r.route("GET", "/a/:id/b", () => 1);
    expect(() => r.route("GET", "/a/:id/b", () => 2)).toThrow(/Duplicate fake route/);
    expect(() => r.route("GET", "/a/:name/b", () => 2)).toThrow(/Duplicate fake route/);
    expect(() => r.route("POST", "/a/:id/b", () => 3)).not.toThrow();
  });
  it("prefers a fixed segment over a parameter, in either registration order", () => {
    for (const order of [["/a/:x", "/a/special"], ["/a/special", "/a/:x"]]) {
      const r = createRouter();
      for (const p of order) r.route("GET", p, () => p);
      expect(r.find("GET", "/a/special")?.route.pattern).toBe("/a/special");
      expect(r.find("GET", "/a/other")?.route.pattern).toBe("/a/:x");
    }
  });
  it("lets the real handler files load together (no duplicates among them)", () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    const patterns = fake.handlerPatterns();
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe("the engine", () => {
  it("answers 500 'fake crashed' when a handler throws something that is not an answer", async () => {
    get("/api/v1/__boom", () => { throw new Error("kaboom"); });
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    const res = await call("GET", "/api/v1/__boom");
    expect(res.status).toBe(500);
    expect(res.data.error).toBe("fake crashed: kaboom");
    expect(fake.snapshot().crashed[0]).toMatchObject({ message: "kaboom", count: 1 });
  });
  it("counts what each fault rule caught, and hands out the same snapshot until something changes", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    fake.addFault({ match: "GET /api/v1/drives", mode: "500" });
    await call("GET", "/api/v1/drives");
    await call("GET", "/api/v1/drives/d1/summary"); // not caught
    await call("GET", "/api/v1/drives");
    const snap = fake.snapshot();
    expect(snap.faults[0].hits).toBe(2);
    expect(fake.snapshot()).toBe(snap);
    await call("GET", "/api/v1/auth/me");
    expect(fake.snapshot()).not.toBe(snap);
  });
  it("keeps the log in real time and the response body for the gallery", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: Date.UTC(2020, 0, 1) });
    await call("GET", "/api/v1/drives");
    const entry = fake.snapshot().log[0];
    expect(Math.abs(entry.t - RealDate.now())).toBeLessThan(5000);
    expect(entry.body).toContain("Family photos");
  });
  it("hands out ids per prefix without reusing a seeded id", () => {
    createWorld((w) => { w.users.push(user({ id: "u2" }), user({ id: "u3" })); });
    expect(nextId("u")).toBe("u4"); // u1 is the Admin, u2 and u3 are seeded
    expect(nextId("d")).toBe("d2"); // d1 is the base drive
    expect(nextId("u")).toBe("u5");
  });
});

describe("FakeXHR", () => {
  const upload = (url = "/api/v1/drives/d1/files/upload?path=Documents", size = 4000) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(size)], "big.bin"));
    return { form, url };
  };

  it("streams upload progress across a slow request, and fires properties and listeners alike", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    fake.addFault({ match: "POST /api/v1/drives/d1/files/upload", mode: "slow:600" });
    const { form, url } = upload();
    const xhr = new XMLHttpRequest();
    const seen = { prop: [], listener: [], states: [], events: [] };
    xhr.onreadystatechange = () => seen.states.push(xhr.readyState);
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => seen.prop.push(e.loaded);
    xhr.upload.addEventListener("progress", (e) => seen.listener.push(e.loaded));
    for (const t of ["loadstart", "load", "loadend"]) xhr.addEventListener(t, () => seen.events.push(t));
    const done = new Promise((r) => { xhr.onloadend = r; });
    xhr.send(form);
    await done;
    expect(xhr.status).toBe(200);
    expect(JSON.parse(xhr.responseText).name).toBe("big.bin");
    expect(xhr.response).toBe(xhr.responseText);
    expect(xhr.getResponseHeader("content-type")).toContain("json");
    expect(seen.states).toEqual([1, 2, 3, 4]);
    expect(seen.events).toEqual(["loadstart", "load", "loadend"]);
    // The bar moved before the answer came, instead of jumping to 100% at the end.
    const partial = seen.prop.filter((n) => n > 0 && n < 4000);
    expect(partial.length).toBeGreaterThan(1);
    expect(seen.prop.at(-1)).toBe(4000);
    expect(seen.listener).toEqual(seen.prop);
  });

  it("an abort mid-request fires abort and never writes the file", async () => {
    const world = createWorld();
    const fake = installFake({ world, scenario: {}, now: 0 });
    fake.setLatency(300);
    const { form, url } = upload();
    const xhr = new XMLHttpRequest();
    const events = [];
    xhr.open("POST", url);
    xhr.onabort = () => events.push("abort");
    xhr.onload = () => events.push("load");
    xhr.addEventListener("loadend", () => events.push("loadend"));
    xhr.send(form);
    await sleep(60);
    xhr.abort();
    await sleep(500);
    expect(events).toEqual(["abort", "loadend"]);
    expect(fsOf(world, "d1").nodes["Documents/big.bin"]).toBeUndefined();
  });

  it("reports a network failure as error, and honours timeout", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    fake.setOffline(true);
    const a = new XMLHttpRequest();
    const events = [];
    a.open("GET", "/api/v1/drives");
    a.onerror = () => events.push("error");
    a.addEventListener("loadend", () => events.push("loadend"));
    a.send();
    await sleep(50);
    expect(events).toEqual(["error", "loadend"]);
    fake.setOffline(false);
    fake.addFault({ match: "GET /api/v1/drives", mode: "hang" });
    const b = new XMLHttpRequest();
    const got = [];
    b.open("GET", "/api/v1/drives");
    b.timeout = 80;
    b.ontimeout = () => got.push("timeout");
    b.send();
    await sleep(200);
    expect(got).toEqual(["timeout"]);
  });
});

describe("jobs", () => {
  const demoWorld = (setup) => createWorld((w) => { withBackupDrive(w); fsOpts(w).jobMs = 40; setup?.(w); });
  const finish = async (id) => { await sleep(120); return (await call("GET", `/api/v1/jobs/${id}`)).data; };

  it("a move to another drive copies first and then trashes the original", async () => {
    const world = demoWorld();
    installFake({ world, scenario: {}, now: 0 });
    const made = await call("POST", "/api/v1/jobs", { kind: "move", from_drive: "d1", from_path: "Photos", to_drive: "d2", to_path: "" });
    expect(made.data.state).toBe("running");
    const job = await finish(made.data.id);
    expect(job.state).toBe("done");
    expect(job.progress).toBe(job.total);
    expect(fsOf(world, "d2").nodes["Photos/2024/Spain/beach.jpg"]).toBeTruthy();
    expect(fsOf(world, "d1").nodes.Photos).toBeUndefined();
    expect(fsOf(world, "d1").trash.some((t) => t.original_path === "Photos")).toBe(true);
  });

  it("a failed move leaves the original alone, removes the partial copy and keeps its real progress", async () => {
    const world = demoWorld((w) => { fsOpts(w).jobFailAt = 0.5; });
    installFake({ world, scenario: {}, now: 0 });
    const made = await call("POST", "/api/v1/jobs", { kind: "move", from_drive: "d1", from_path: "Photos", to_drive: "d2", to_path: "" });
    const job = await finish(made.data.id);
    expect(job.state).toBe("error");
    expect(job.error).toContain("Nothing was moved.");
    expect(job.progress).toBeLessThan(job.total);
    expect(fsOf(world, "d1").nodes["Photos/2024/Spain/beach.jpg"]).toBeTruthy();
    expect(Object.keys(fsOf(world, "d2").nodes)).toEqual([]);
    expect(fsOf(world, "d1").trash).toHaveLength(0);
  });

  it("a move inside one drive is a single rename, and a taken name is refused up front", async () => {
    const world = demoWorld();
    installFake({ world, scenario: {}, now: 0 });
    const made = await call("POST", "/api/v1/jobs", { kind: "move", from_drive: "d1", from_path: "Music", to_drive: "d1", to_path: "Documents" });
    expect((await finish(made.data.id)).state).toBe("done");
    expect(fsOf(world, "d1").nodes["Documents/Music/song.mp3"]).toBeTruthy();
    expect(fsOf(world, "d1").nodes.Music).toBeUndefined();
    const clash = await call("POST", "/api/v1/jobs", { kind: "copy", from_drive: "d1", from_path: "Documents/notes.txt", to_drive: "d1", to_path: "Documents" });
    expect(clash.status).toBe(409);
    expect(clash.data.code).toBe("exists");
    const both = await call("POST", "/api/v1/jobs", { kind: "copy", from_drive: "d1", from_path: "Documents/notes.txt", to_drive: "d1", to_path: "Documents", on_conflict: "keep_both" });
    expect(both.status).toBe(200);
    await finish(both.data.id);
    expect(fsOf(world, "d1").nodes["Documents/notes (1).txt"]).toBeTruthy();
  });

  it("cancelling a copy removes what it had made", async () => {
    const world = demoWorld((w) => { fsOpts(w).jobMs = 400; });
    installFake({ world, scenario: {}, now: 0 });
    const made = await call("POST", "/api/v1/jobs", { kind: "copy", from_drive: "d1", from_path: "Photos", to_drive: "d2", to_path: "" });
    await sleep(200);
    await call("GET", "/api/v1/jobs");
    await call("DELETE", `/api/v1/jobs/${made.data.id}`);
    const job = (await call("GET", `/api/v1/jobs/${made.data.id}`)).data;
    expect(job.state).toBe("cancelled");
    expect(Object.keys(fsOf(world, "d2").nodes)).toEqual([]);
  });
});

describe("who may do what", () => {
  it("filters the drive list for a Member and stamps writable and caps", async () => {
    const world = createWorld((w) => {
      withBackupDrive(w);
      asMember(w, [{ drive_id: "d1", path: "Documents", caps: "full" }]);
    });
    installFake({ world, scenario: {}, now: 0 });
    const drives = (await call("GET", "/api/v1/drives")).data;
    expect(drives.map((d) => d.id)).toEqual(["d1"]);
    expect(drives[0]).toMatchObject({ writable: true, caps: "none", device: "", mount_point: "" });
    world.sessionUserId = "u1";
    const admin = (await call("GET", "/api/v1/drives")).data;
    expect(admin.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(admin[0].caps).toBe("full+share");
    expect(admin[0].device).not.toBe("");
  });

  it("answers 403 to a Member on Admin-only routes, with that route's own words", async () => {
    installFake({ world: createWorld((w) => asMember(w)), scenario: {}, now: 0 });
    expect(await call("GET", "/api/v1/users")).toMatchObject({ status: 403, data: { error: "Only an Admin can manage users." } });
    expect(await call("GET", "/api/v1/drives/d1/health")).toMatchObject({ status: 403, data: { error: "Only an Admin can manage drives." } });
    expect(await call("GET", "/api/v1/system/updates")).toMatchObject({ status: 403, data: { error: "Only an Admin can manage updates." } });
    // Not Admin-only: a reduced answer.
    const net = await call("GET", "/api/v1/network/status");
    expect(net.status).toBe(200);
    expect(net.data.wifi_connected).toBe(false);
  });

  it("keeps the Admin out of someone else's private folder", async () => {
    const world = createWorld((w) => {
      w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
      addFile(w, "d1", "Sam/x.txt", { text: "x" });
      w.fs.d1.nodes.Sam.private = true;
      w.fs.d1.nodes.Sam.owner = "u2";
    });
    installFake({ world, scenario: {}, now: 0 });
    const root = (await call("GET", "/api/v1/drives/d1/files?path=")).data;
    expect(root.map((e) => e.name)).not.toContain("Sam");
    expect((await call("GET", "/api/v1/drives/d1/files?path=Sam")).status).toBe(403);
  });
});

describe("recents, renames and restores", () => {
  it("records a visit once per (user, drive, path) and re-paths it on rename", async () => {
    const world = createWorld();
    installFake({ world, scenario: {}, now: 0 });
    const visit = { kind: "file", driveId: "d1", path: "Documents/notes.txt" };
    await call("POST", "/api/v1/me/recents", visit);
    await call("POST", "/api/v1/me/recents", visit);
    expect((await call("GET", "/api/v1/me/recents")).data).toHaveLength(1);
    await call("POST", "/api/v1/drives/d1/files/rename", { path: "Documents/notes.txt", new_name: "list.txt" });
    const after = (await call("GET", "/api/v1/me/recents")).data;
    expect(after).toHaveLength(1);
    expect(after[0].path).toBe("Documents/list.txt");
  });

  it("follows a rename or move through files/resolve, folders included", async () => {
    installFake({ world: createWorld(), scenario: {}, now: 0 });
    await call("POST", "/api/v1/drives/d1/files/rename", { path: "Documents", new_name: "Papers" });
    const hit = await call("GET", "/api/v1/drives/d1/files/resolve?path=Documents/notes.txt");
    expect(hit.data).toEqual({ drive_id: "d1", path: "Papers/notes.txt", kind: "file" });
    expect((await call("GET", "/api/v1/drives/d1/files/resolve?path=Nowhere/x")).status).toBe(404);
  });

  it("trashing a folder after trashing an item inside it moves the folder to Trash too, and restore rebuilds missing parents", async () => {
    const world = createWorld();
    installFake({ world, scenario: {}, now: 0 });
    await call("DELETE", "/api/v1/drives/d1/files?path=Documents/notes.txt");
    const gone = await call("DELETE", "/api/v1/drives/d1/files?path=Documents");
    expect(gone.data.trash_path).toMatch(/^\.luna-trash\//);
    const trash = (await call("GET", "/api/v1/drives/d1/files?path=.luna-trash")).data;
    expect(trash.map((e) => e.original_name).sort()).toEqual(["Documents", "notes.txt"]);
    const item = trash.find((e) => e.original_name === "notes.txt");
    const restored = await call("POST", "/api/v1/drives/d1/files/restore", { path: `.luna-trash/${item.name}`, dest: "Vanished/Deep/notes.txt" });
    expect(restored.status).toBe(200);
    expect(fsOf(world, "d1").nodes["Vanished/Deep/notes.txt"]).toBeTruthy();
    expect(fsOf(world, "d1").nodes["Vanished/Deep"].kind).toBe("dir");
  });
});

describe("keeping the world across a page load", () => {
  beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

  it("saves and loads a world with its ids, faults and clock", () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: Date.UTC(2026, 9, 18) });
    fake.addFault({ match: "GET /api/v1/drives", mode: "500" });
    expect(saveState("s/one", fake.exportState())).toBe(true);
    expect(loadState("s/other")).toBeNull();
    const back = loadState("s/one");
    expect(back.world.users[0].id).toBe("u1");
    expect(back.faults[0].match).toBe("GET /api/v1/drives");
    expect(back.clock.base).toBe(Date.UTC(2026, 9, 18));
  });

  it("a reload without ?__mock= picks the world up where it was; ?__mock= starts fresh", async () => {
    window.history.replaceState(null, "", `/?__mock=${encodeURIComponent("dashboard/calm")}`);
    expect(bootMock()).toBe(true);
    await call("POST", "/api/v1/me/recents", { kind: "file", driveId: "d1", path: "Documents/notes.txt" });
    /** @type {any} */ (window).__lunaFake.saveNow();
    window.Date = RealDate;

    // The sign-out redirect: the address has lost its flag.
    window.history.replaceState(null, "", "/login");
    expect(bootMock()).toBe(true);
    expect((await call("GET", "/api/v1/me/recents")).data).toHaveLength(1);
    window.Date = RealDate;

    // The gallery's Reload: the flag is back, so the data is fresh.
    window.history.replaceState(null, "", `/?__mock=${encodeURIComponent("dashboard/calm")}`);
    expect(bootMock()).toBe(true);
    expect((await call("GET", "/api/v1/me/recents")).data).toHaveLength(0);
  });

  it("saves shortly after a change", async () => {
    const fake = installFake({ world: createWorld(), scenario: {}, now: 0 });
    keepWorld(fake, "s/two", { delay: 10 });
    await call("POST", "/api/v1/me/recents", { kind: "file", driveId: "d1", path: "Documents/notes.txt" });
    await sleep(120);
    expect(loadState("s/two").world.recents).toHaveLength(1);
  });
});
