import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api.js";
import { text } from "./copy.js";
import { createFileOpsStore } from "./store.js";
import { UPLOAD_PARALLEL } from "./uploadRunner.js";

function harness() {
  let t = 1000;
  const store = createFileOpsStore({
    queryClient: { invalidateQueries: vi.fn() },
    addToast: vi.fn(),
    haptic: vi.fn(),
    now: () => t,
    setTimer: () => 0,
    clearTimer: () => {},
    storage: null,
  });
  return { store, bump: () => (t += 500) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const file = (name) => new File(["abc"], name);

/** @returns {{ promise: Promise<any>, resolve: (v?: any) => void, reject: (e?: any) => void }} */
function deferred() {
  /** @type {any} */
  let resolve;
  /** @type {any} */
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** @returns {any} */
function fakeSource(extra = {}) {
  return {
    kind: "drive",
    isFile: false,
    listDir: vi.fn(async () => []),
    mkdir: vi.fn(async () => ({})),
    uploadFile: vi.fn(async (_drive, _file, _path, name) => ({ name })),
    completeUpload: vi.fn(async () => ({ name: "done" })),
    cancelUpload: vi.fn(async () => ({})),
    ...extra,
  };
}

const exists = (kind = "file") => new ApiError(409, "A file with this name is already here.", "exists", { existing_kind: kind });

const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
const brokenEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (_ok, fail) => fail(new Error("no")) });
const dirEntry = (name, children) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    const queue = [children, []];
    return { readEntries: (ok) => ok(queue.shift()) };
  },
});

describe("upload runner: the pool", () => {
  it("never runs more than 3 uploads at once across two operations", async () => {
    let running = 0;
    let peak = 0;
    const gates = [];
    const source = fakeSource({
      uploadFile: vi.fn(async (_d, _f, _p, name) => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        running -= 1;
        return { name };
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: ["a", "b", "c", "d"].map(file) });
    store.startUpload({ source, driveId: "d", files: ["e", "f"].map(file) });
    await tick();
    expect(running).toBe(UPLOAD_PARALLEL);
    for (let i = 0; i < 6; i += 1) {
      while (!gates[i]) await tick();
      gates[i].resolve();
      await tick();
    }
    expect(peak).toBe(3);
    expect(source.uploadFile).toHaveBeenCalledTimes(6);
    expect(store.getState().ops.every((op) => op.state === "done")).toBe(true);
  });
});

describe("upload runner: name clashes", () => {
  it("parks one clashing item while the others finish", async () => {
    const source = fakeSource({ listDir: vi.fn(async () => [{ name: "a.txt", kind: "file" }]) });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", destFolder: "Inbox", files: [file("a.txt"), file("b.txt"), file("c.txt")] });
    await tick();
    const op = store.getState().ops[0];
    expect(op.state).toBe("waiting");
    expect(source.uploadFile).toHaveBeenCalledTimes(2);
    const parked = op.items.find((i) => i.name === "a.txt");
    expect(parked.state).toBe("needs-decision");
    expect(parked.decision.options).toEqual(["replace", "keep_both", "skip"]);
    expect(op.items.filter((i) => i.state === "done")).toHaveLength(2);
    expect(source.listDir).toHaveBeenCalledTimes(1);
  });

  it("offers no Replace when a folder is in the way", async () => {
    const source = fakeSource({ listDir: vi.fn(async () => [{ name: "a.txt", kind: "dir" }]) });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    expect(store.getState().ops[0].items[0].decision).toMatchObject({ existingKind: "dir", options: ["keep_both", "skip"] });
  });

  it("answers Replace and Keep both by sending the choice with the upload", async () => {
    const source = fakeSource({ listDir: vi.fn(async () => [{ name: "a.txt", kind: "file" }, { name: "b.txt", kind: "file" }]) });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt"), file("b.txt")] });
    await tick();
    const op = store.getState().ops[0];
    store.decide(op.id, op.items[0].id, "replace");
    store.decide(op.id, op.items[1].id, "keep_both");
    await tick();
    const choices = source.uploadFile.mock.calls.map((c) => [c[3], c[4].onConflict]).sort();
    expect(choices).toEqual([["a.txt", "replace"], ["b.txt", "keep_both"]]);
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("Skip ends the item as skipped and the operation as done", async () => {
    const source = fakeSource({ listDir: vi.fn(async () => [{ name: "a.txt", kind: "file" }]) });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    const op = store.getState().ops[0];
    store.decide(op.id, op.items[0].id, "skip");
    expect(store.getState().ops[0].items[0].state).toBe("skipped");
    expect(store.getState().ops[0].state).toBe("done");
    expect(source.uploadFile).not.toHaveBeenCalled();
  });

  it("decideAll sets the policy for clashes found later", async () => {
    const late = deferred();
    const source = fakeSource({
      uploadFile: vi.fn(async (_d, _f, _p, name, opts) => {
        if (opts.onConflict) return { name };
        if (name === "a.txt") throw exists();
        return late.promise.then(() => {
          throw exists();
        });
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt"), file("b.txt")] });
    await tick();
    let op = store.getState().ops[0];
    expect(op.items[0].state).toBe("needs-decision");
    store.decideAll(op.id, "keep_both");
    expect(store.getState().ops[0].policy).toBe("keep_both");
    late.resolve();
    await tick();
    op = store.getState().ops[0];
    expect(op.items.every((i) => i.state === "done")).toBe(true);
    const bCalls = source.uploadFile.mock.calls.filter((c) => c[3] === "b.txt");
    expect(bCalls).toHaveLength(2);
    expect(bCalls[1][4].onConflict).toBe("keep_both");
  });

  it("a chunked clash at /complete calls /complete again, never the uploads", async () => {
    const clash = Object.assign(exists(), { uploadId: "u1", completeOnly: true });
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw clash;
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("big.bin")] });
    await tick();
    const op = store.getState().ops[0];
    expect(op.items[0].state).toBe("needs-decision");
    expect(op.items[0].completeOnly).toBe(true);
    expect(source.cancelUpload).not.toHaveBeenCalled();
    store.decide(op.id, op.items[0].id, "replace");
    await tick();
    expect(source.completeUpload).toHaveBeenCalledWith("d", "u1", "replace");
    expect(source.uploadFile).toHaveBeenCalledTimes(1);
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("skipping a chunked clash drops the session on Luna", async () => {
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw Object.assign(exists(), { uploadId: "u9", completeOnly: true });
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("big.bin")] });
    await tick();
    const op = store.getState().ops[0];
    store.decide(op.id, op.items[0].id, "skip");
    expect(source.cancelUpload).toHaveBeenCalledWith("d", "u9");
  });

  it("treats a bare 409 from a multipart upload as a name clash", async () => {
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw new ApiError(409, "A file with this name is already here. Rename it or choose another.");
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    expect(store.getState().ops[0].items[0].state).toBe("needs-decision");
  });

  it("never asks on a single-file share link", async () => {
    const source = fakeSource({ isFile: true });
    const { store } = harness();
    store.startUpload({ source, driveId: "token", files: [file("a.txt")] });
    await tick();
    expect(source.listDir).not.toHaveBeenCalled();
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("refuses two files on a single-file link with the op-level message", () => {
    const { store } = harness();
    store.startUpload({ source: fakeSource({ isFile: true }), driveId: "token", files: [file("a"), file("b")] });
    const op = store.getState().ops[0];
    expect(op.state).toBe("failed");
    expect(op.error).toBe(text.singleFileLink);
  });
});

describe("upload runner: folders", () => {
  it("one unreadable entry doesn't stop the others", async () => {
    const source = fakeSource();
    const { store } = harness();
    const root = dirEntry("Docs", [fileEntry("a.txt"), brokenEntry("bad.txt"), fileEntry("c.txt")]);
    store.startUpload({ source, driveId: "d", destFolder: "Inbox", dropped: { entries: [root], files: [] } });
    await tick();
    await tick();
    const op = store.getState().ops[0];
    expect(op.walking).toBe(false);
    expect(op.title).toBe("Docs");
    expect(op.rootFolder).toBe(true);
    const bad = op.items.find((i) => i.name === "bad.txt");
    expect(bad.state).toBe("failed");
    expect(bad.error).toBe(text.unreadable);
    expect(bad.retryable).toBe(false);
    expect(op.items.filter((i) => i.state === "done").map((i) => i.name).sort()).toEqual(["a.txt", "c.txt"]);
    expect(source.uploadFile.mock.calls.map((c) => c[2])).toEqual(["Inbox/Docs", "Inbox/Docs"]);
    expect(op.state).toBe("partial");
  });

  it("makes empty folders on Luna, every level, and treats 'already there' as done", async () => {
    const mkdir = vi.fn(async (_d, path) => {
      if (path === "Inbox/Docs") throw new ApiError(409, "A folder with this name is already here.");
      return {};
    });
    const source = fakeSource({ mkdir });
    const { store } = harness();
    store.startUpload({
      source,
      driveId: "d",
      destFolder: "Inbox",
      dropped: { entries: [dirEntry("Docs", [dirEntry("Empty", [])])], files: [] },
    });
    await tick();
    await tick();
    expect(mkdir.mock.calls.map((c) => c[1])).toEqual(["Inbox/Docs", "Inbox/Docs/Empty"]);
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("only lists a nested folder when its parent has a folder of that name", async () => {
    const listDir = vi.fn(async (_d, path) => (path === "Inbox" ? [{ name: "Docs", kind: "dir" }] : []));
    const source = fakeSource({ listDir });
    const { store } = harness();
    store.startUpload({
      source,
      driveId: "d",
      destFolder: "Inbox",
      dropped: { entries: [dirEntry("Docs", [fileEntry("a.txt")]), dirEntry("New", [fileEntry("b.txt")])], files: [] },
    });
    await tick();
    await tick();
    expect(listDir.mock.calls.map((c) => c[1]).sort()).toEqual(["Inbox", "Inbox/Docs"]);
  });
});

describe("upload runner: network loss", () => {
  it("fails offline items as retryable and retries them when the connection returns", async () => {
    let online = false;
    const source = fakeSource({
      uploadFile: vi.fn(async (_d, _f, _p, name) => {
        if (!online) throw new ApiError(0, "Failed to fetch");
        return { name };
      }),
    });
    const { store } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    let item = store.getState().ops[0].items[0];
    expect(item.state).toBe("failed");
    expect(item.retryable).toBe(true);
    expect(item.error).toBe(text.offline);
    online = true;
    store.retryOffline();
    await tick();
    item = store.getState().ops[0].items[0];
    expect(item.state).toBe("done");
  });

  it("shows the retry line while a chunk is being sent again", async () => {
    const hold = deferred();
    /** @type {any} */
    let onRetry;
    const source = fakeSource({
      uploadFile: vi.fn(async (_d, _f, _p, name, opts) => {
        onRetry = opts.onRetry;
        await hold.promise;
        return { name };
      }),
    });
    const { store, bump } = harness();
    store.startUpload({ source, driveId: "d", files: [file("big.bin")] });
    await tick();
    bump();
    onRetry(1);
    expect(store.getState().ops[0].items[0].retrying).toBe(true);
    hold.resolve();
    await tick();
    expect(store.getState().ops[0].items[0].retrying).toBe(false);
  });
});

describe("upload runner: cancel", () => {
  it("cancelling aborts what is running and drops what is queued", async () => {
    const signals = [];
    const source = fakeSource({
      uploadFile: vi.fn(
        (_d, _f, _p, _name, opts) =>
          new Promise((_resolve, reject) => {
            signals.push(opts.signal);
            opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    });
    const { store } = harness();
    const id = store.startUpload({ source, driveId: "d", files: ["a", "b", "c", "d", "e"].map(file) });
    await tick();
    store.cancel(id);
    await tick();
    expect(signals.every((s) => s.aborted)).toBe(true);
    const op = store.getState().ops[0];
    expect(op.state).toBe("cancelled");
    expect(op.items.every((i) => i.state === "cancelled")).toBe(true);
    expect(source.uploadFile).toHaveBeenCalledTimes(3);
  });
});
