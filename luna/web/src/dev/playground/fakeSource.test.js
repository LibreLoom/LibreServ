// The playground is only useful if its fake lunad puts the card in the state
// the knob promises. These drive the real store against the fake and read the
// resulting state, so a knob that stops working fails here instead of quietly
// showing the wrong thing during a review.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOpsStore } from "../../lib/fileOps/store.js";
import { createFakeWorld, dirEntry, fakeFile, badEntry } from "./fakeSource.js";

const DEST = { driveId: "d1", destFolder: "Documents", destLabel: "Documents" };

/** @param {ReturnType<typeof createFakeWorld>} world */
function makeStore(world) {
  return createFileOpsStore({
    queryClient: { invalidateQueries: vi.fn() },
    addToast: vi.fn(),
    api: world.api,
    storage: null,
    restoreJobs: false,
  });
}

const ops = (store) => store.getState().ops;
const only = (store) => ops(store)[0];
const items = (store) => only(store).items;

/** Wait until `check` passes, or fail with what the store actually holds. */
async function until(store, check, label, timeoutMs = 4000) {
  const started = Date.now();
  for (;;) {
    if (check(store)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `${label} never happened. Store: ${JSON.stringify(
          ops(store).map((o) => ({ kind: o.kind, state: o.state, items: o.items.map((i) => i.state) })),
        )}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("playground fake lunad", () => {
  it("uploads a file and finishes", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ uploadMs: 40 });
    const store = makeStore(world);

    store.startUpload({ source: world.source, ...DEST, files: [fakeFile("notes.txt", 240_000)] });
    await until(store, (s) => only(s).state === "done", "upload to finish");

    expect(only(store).kind).toBe("upload");
    expect(items(store)[0].state).toBe("done");
    store.destroy();
    world.dispose();
  });

  it("makes the drive-full error lunad makes", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ upload: "full", uploadMs: 40 });
    const store = makeStore(world);

    store.startUpload({ source: world.source, ...DEST, files: [fakeFile("big.mp4", 900_000)] });
    await until(store, (s) => only(s).state === "failed", "upload to fail");

    expect(items(store)[0].error).toBe("This drive is full. Free up some space and try again.");
    expect(items(store)[0].retryable).toBe(false);
    store.destroy();
    world.dispose();
  });

  it("makes an offline upload say what to check", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ upload: "offline", uploadMs: 40 });
    const store = makeStore(world);

    store.startUpload({ source: world.source, ...DEST, files: [fakeFile("notes.txt", 1000)] });
    await until(store, (s) => only(s).state === "failed", "upload to fail");

    expect(items(store)[0].error).toBe(
      "Couldn't reach Luna. Check this device's connection and try again.",
    );
    expect(items(store)[0].offline).toBe(true);
    store.destroy();
    world.dispose();
  });

  it("parks a name clash until it is answered, then finishes", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ uploadMs: 40 });
    world.seed("Documents", "notes.txt", "file");
    const store = makeStore(world);

    store.startUpload({ source: world.source, ...DEST, files: [fakeFile("notes.txt", 1000)] });
    await until(store, (s) => items(s)[0].state === "needs-decision", "the clash to be asked");

    expect(items(store)[0].decision).toEqual({
      type: "exists",
      existingKind: "file",
      options: ["replace", "keep_both", "skip"],
    });

    store.decide(only(store).id, items(store)[0].id, "keep_both");
    await until(store, (s) => only(s).state === "done", "the upload to finish");
    expect(items(store)[0].conflict).toBe("keep_both");
    store.destroy();
    world.dispose();
  });

  it("offers no Replace when a folder is in the way", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ uploadMs: 40 });
    world.seed("Documents", "Holiday", "dir");
    const store = makeStore(world);

    // A file named like an existing folder: the folder can't be replaced by it.
    store.startUpload({ source: world.source, ...DEST, files: [fakeFile("Holiday", 90_000)] });
    await until(store, (s) => items(s).some((i) => i.state === "needs-decision"), "the clash to be asked");

    const waiting = items(store).find((i) => i.state === "needs-decision");
    expect(waiting.decision.existingKind).toBe("dir");
    expect(waiting.decision.options).toEqual(["keep_both", "skip"]);
    store.destroy();
    world.dispose();
  });

  it("counts folders when a drop holds no files", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ uploadMs: 40 });
    const store = makeStore(world);

    store.startUpload({
      source: world.source,
      ...DEST,
      dropped: { entries: [dirEntry("Empty folder", [])], files: [] },
    });
    await until(store, (s) => only(s).state === "done", "the folders to be made");

    expect(only(store).foldersDone).toBe(1);
    expect(only(store).itemsTotal).toBe(0);
    store.destroy();
    world.dispose();
  });

  it("reports a file the browser can't read", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ uploadMs: 40 });
    const store = makeStore(world);

    store.startUpload({
      source: world.source,
      ...DEST,
      dropped: { entries: [badEntry("locked.pdf")], files: [] },
    });
    await until(store, (s) => only(s).state === "failed", "the unreadable file to fail");

    expect(items(store)[0].error).toBe("Your browser couldn't read this file from your device.");
    expect(items(store)[0].retryable).toBe(false);
    store.destroy();
    world.dispose();
  });

  it("runs a copy job to the end", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ jobMs: 120 });
    const store = makeStore(world);

    store.startJobs({
      kind: "copy",
      fromDrive: "d1",
      items: [{ path: "Documents/notes.txt", name: "notes.txt" }],
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });
    await until(store, (s) => only(s).state === "done", "the copy to finish", 6000);

    expect(only(store).kind).toBe("copy");
    expect(items(store)[0].state).toBe("done");
    store.destroy();
    world.dispose();
  });

  it("fails a move with lunad's 'nothing was moved' ending", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ jobs: "full", jobMs: 120 });
    const store = makeStore(world);

    store.startJobs({
      kind: "move",
      fromDrive: "d1",
      items: [{ path: "Documents/notes.txt", name: "notes.txt" }],
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });
    await until(store, (s) => only(s).state === "failed", "the move to fail", 6000);

    expect(items(store)[0].error).toContain("Nothing was moved. Your files are still where they were.");
    store.destroy();
    world.dispose();
  });

  it("asks about a name taken at the destination, then copies", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ jobs: "exists", jobMs: 120 });
    const store = makeStore(world);

    store.startJobs({
      kind: "copy",
      fromDrive: "d1",
      items: [{ path: "Documents/notes.txt", name: "notes.txt" }],
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });
    await until(store, (s) => items(s)[0].state === "needs-decision", "the clash to be asked");

    expect(items(store)[0].decision.type).toBe("exists");
    store.decide(only(store).id, items(store)[0].id, "keep_both");
    await until(store, (s) => only(s).state === "done", "the copy to finish", 6000);
    store.destroy();
    world.dispose();
  });

  it("asks before widening who can open a private file", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ jobs: "broadens", jobMs: 120 });
    const store = makeStore(world);

    store.startJobs({
      kind: "move",
      fromDrive: "d1",
      items: [{ path: "Private/notes.txt", name: "notes.txt" }],
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });
    await until(store, (s) => items(s)[0].state === "needs-decision", "the warning to be asked");

    expect(items(store)[0].decision.type).toBe("broadens");
    expect(items(store)[0].decision.options).toEqual(["confirm", "skip"]);
    store.destroy();
    world.dispose();
  });

  it("waits out a full job queue and then sends", async () => {
    const world = createFakeWorld();
    world.setBehaviour({ jobs: "queue_full", jobMs: 120 });
    const store = makeStore(world);

    store.startJobs({
      kind: "copy",
      fromDrive: "d1",
      items: [{ path: "Documents/notes.txt", name: "notes.txt" }],
      toDrive: "d2",
      toPath: "",
      toLabel: "Backup drive",
      source: world.source,
    });
    await until(store, (s) => items(s)[0].waitingForQueue === true, "the queue wait");

    // The runner retries after five seconds; the second send is accepted.
    await until(store, (s) => only(s).state === "done", "the copy to finish", 9000);
    store.destroy();
    world.dispose();
  });

  it("names the action when a task fails with no words of its own", async () => {
    const world = createFakeWorld();
    const store = makeStore(world);

    store.startRequest({
      kind: "trash",
      title: "a.jpg",
      destLabel: "Documents",
      source: world.source,
      driveId: "d1",
      items: [{ name: "a.jpg", run: async () => { throw new Error(""); } }],
    });
    await until(store, (s) => only(s).state === "failed", "the trash to fail");

    expect(items(store)[0].error).toBe("Luna couldn't move this to Trash. Try again.");
    store.destroy();
    world.dispose();
  });

  it("finishes a batch of one-shot tasks", async () => {
    const world = createFakeWorld();
    const store = makeStore(world);

    store.startRequest({
      kind: "trash",
      destLabel: "Documents",
      source: world.source,
      driveId: "d1",
      items: ["a.jpg", "b.jpg", "c.jpg"].map((name) => ({
        name,
        run: () => new Promise((r) => setTimeout(r, 10)),
      })),
    });
    await until(store, (s) => only(s).state === "done", "the batch to finish");

    expect(items(store).map((i) => i.state)).toEqual(["done", "done", "done"]);
    store.destroy();
    world.dispose();
  });
});
