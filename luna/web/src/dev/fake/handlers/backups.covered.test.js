import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { installFake } from "../engine.js";
import { addDir } from "../fsmodel.js";
import { backup, createWorld } from "../world.js";

// db::covering_protection: a private folder is always its own backup, so a
// bigger backup never holds it. A shared folder keeps today's behaviour.
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

afterEach(() => {
  window.fetch = originalFetch;
  window.XMLHttpRequest = originalXhr;
  window.WebSocket = originalWebSocket;
  if (originalFake === undefined) delete fakeWindow.__lunaFake;
  else fakeWindow.__lunaFake = originalFake;
});

describe("fake GET /api/v1/backups (db::covering_protection)", () => {
  it("never reports a private folder as covered by the private item's backup", async () => {
    startFake((w) => {
      // Diary is Max's private item; Diary/2025 is a folder inside it.
      addDir(w, "d1", "Diary/2025");
      w.fs.d1.nodes.Diary.private = true;
      w.fs.d1.nodes.Diary.owner = "u1";
      w.backups.push(backup({ id: "b-diary", source_path: "Diary", source_name: "Diary", private_owner: "u1" }));
      w.backups.push(backup({ id: "b-2025", source_path: "Diary/2025", source_name: "2025", private_owner: "u1" }));
    });

    const rows = await (await window.fetch("/api/v1/backups?drive=d1&path=Diary/2025")).json();

    const row = rows.find((b) => b.id === "b-2025");
    expect(row).toBeDefined();
    // A private folder is its own backup, so the item's finished backup never holds it.
    expect(row.covered_by).toBeNull();
  });

  it("still reports a shared folder as covered by its shared parent's backup", async () => {
    startFake((w) => {
      addDir(w, "d1", "Docs/Sub");
      w.backups.push(backup({ id: "b-docs", source_path: "Docs", source_name: "Docs" }));
      w.backups.push(backup({ id: "b-sub", source_path: "Docs/Sub", source_name: "Sub" }));
    });

    const rows = await (await window.fetch("/api/v1/backups?drive=d1&path=Docs/Sub")).json();

    const row = rows.find((b) => b.id === "b-sub");
    expect(row).toBeDefined();
    expect(row.covered_by).toEqual({ path: "Docs", name: "Docs" });
  });
});
