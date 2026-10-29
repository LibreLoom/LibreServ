import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api.js";
import { AUTO_CLEAR_MS, createFileOpsStore, SHOW_AFTER_MS } from "./store.js";

/** A store with a clock and timers the test moves by hand. */
function harness(extra = {}) {
  let t = 1000;
  let id = 0;
  const timers = new Map();
  const queryClient = { invalidateQueries: vi.fn() };
  const addToast = vi.fn();
  const haptic = vi.fn();
  const store = createFileOpsStore({
    queryClient,
    addToast,
    haptic,
    now: () => t,
    setTimer: (fn, ms) => {
      id += 1;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (timerId) => timers.delete(timerId),
    storage: null,
    ...extra,
  });
  const advance = (ms) => {
    t += ms;
    for (const [timerId, timer] of [...timers]) {
      if (timer.at <= t && timers.has(timerId)) {
        timers.delete(timerId);
        timer.fn();
      }
    }
  };
  return { store, queryClient, addToast, haptic, advance };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    completeUpload: vi.fn(async () => ({})),
    cancelUpload: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    ...extra,
  };
}

const file = (name) => new File(["abc"], name);

describe("file ops store: operations and toasts", () => {
  it("shows one success toast per finished operation, counting only what succeeded", async () => {
    const { store, addToast } = harness();
    store.startUpload({ source: fakeSource(), driveId: "d", destLabel: "Inbox", files: [file("a.txt"), file("b.txt")] });
    await tick();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({ type: "success", message: "2 files uploaded." });
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("makes no toast when nothing succeeded", async () => {
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw new ApiError(507, "Inbox is full.");
      }),
    });
    const { store, addToast } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    const op = store.getState().ops[0];
    expect(op.state).toBe("failed");
    expect(op.items[0].error).toBe("Inbox is full.");
    expect(addToast).not.toHaveBeenCalled();
  });

  it("never toasts an error", async () => {
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw new ApiError(500, "Broken.");
      }),
    });
    const { store, addToast } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt"), file("b.txt")] });
    await tick();
    expect(addToast.mock.calls.filter(([toast]) => toast.type === "error")).toHaveLength(0);
  });

  it("uses the gallery wording and runs afterFinish once", async () => {
    const afterFinish = vi.fn();
    const { store, addToast, queryClient } = harness();
    store.startUpload({
      source: fakeSource(),
      driveId: "d",
      destFolder: "Photos",
      kind: "gallery",
      files: [file("a.jpg")],
      invalidateKeys: [["gallery"], ["gallery-status"]],
      afterFinish,
    });
    await tick();
    expect(addToast).toHaveBeenCalledWith({ type: "success", message: "1 photo uploaded." });
    expect(afterFinish).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["gallery"] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["files", "d", "Photos"] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["recents"] });
  });
});

describe("file ops store: visibility and clearing", () => {
  it("hides a quick request, shows a slow one after 600 ms", async () => {
    const hold = deferred();
    const { store, advance } = harness();
    store.startRequest({ kind: "empty-trash", title: "Backup", destLabel: "Backup", run: () => hold.promise, successToast: "Trash emptied." });
    expect(store.getState().ops[0].shown).toBe(false);
    advance(SHOW_AFTER_MS);
    expect(store.getState().ops[0].shown).toBe(true);
    hold.resolve();
    await tick();
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("a quick request never shows, but still toasts and clears", async () => {
    const { store, addToast, advance } = harness();
    store.startRequest({ kind: "purge", title: "a.txt", run: async () => {}, successToast: "Deleted permanently." });
    await tick();
    expect(store.getState().ops[0].shown).toBe(false);
    expect(addToast).toHaveBeenCalledWith({ type: "success", message: "Deleted permanently." });
    advance(AUTO_CLEAR_MS);
    expect(store.getState().ops).toHaveLength(0);
  });

  it("clears a clean upload 4 s after it finishes, but keeps one with a problem", async () => {
    const { store, advance } = harness();
    store.startUpload({ source: fakeSource(), driveId: "d", files: [file("a.txt")] });
    store.startUpload({
      source: fakeSource({
        uploadFile: vi.fn(async () => {
          throw new ApiError(500, "Nope.");
        }),
      }),
      driveId: "d",
      files: [file("b.txt")],
    });
    await tick();
    advance(AUTO_CLEAR_MS);
    const ops = store.getState().ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].state).toBe("failed");
    expect(ops[0].shown).toBe(true);
  });

  it("dismiss removes an operation", async () => {
    const { store } = harness();
    const id = store.startUpload({
      source: fakeSource({
        uploadFile: vi.fn(async () => {
          throw new ApiError(500, "Nope.");
        }),
      }),
      driveId: "d",
      files: [file("b.txt")],
    });
    await tick();
    store.dismiss(id);
    expect(store.getState().ops).toHaveLength(0);
  });

  it("takes initialOps as already shown", () => {
    const { store } = harness({
      initialOps: [{ id: "op1", kind: "upload", state: "running", items: [{ id: "i1", name: "a.txt", state: "uploading", size: 10, received: 5 }] }],
    });
    const [op] = store.getState().ops;
    expect(op.shown).toBe(true);
    expect(op.itemsTotal).toBe(1);
    expect(op.bytesDone).toBe(5);
  });
});

describe("file ops store: emits and haptics", () => {
  it("throttles progress to one emit per 100 ms but emits state changes at once", async () => {
    const hold = deferred();
    /** @type {any} */
    let progress;
    const source = fakeSource({
      uploadFile: vi.fn(async (_d, _f, _p, name, opts) => {
        progress = opts.onProgress;
        await hold.promise;
        return { name };
      }),
    });
    const { store, advance } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    advance(200);
    progress(1, 3); // the first one after a pause goes straight out
    const listener = vi.fn();
    store.subscribe(listener);
    progress(2, 3);
    expect(listener).not.toHaveBeenCalled();
    advance(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().ops[0].items[0].received).toBe(2);
    hold.resolve();
    await tick();
    expect(listener.mock.calls.length).toBeGreaterThan(1);
    expect(store.getState().ops[0].state).toBe("done");
  });

  it("buzzes once per operation for a burst of failures", async () => {
    const source = fakeSource({
      uploadFile: vi.fn(async () => {
        throw new ApiError(503, "Luna is busy.");
      }),
    });
    const { store, haptic, advance } = harness();
    store.startUpload({ source, driveId: "d", files: [file("a"), file("b"), file("c")] });
    await tick();
    expect(haptic.mock.calls.filter(([p]) => p === "error")).toHaveLength(1);
    advance(2500);
    store.retry(store.getState().ops[0].id);
    await tick();
    expect(haptic.mock.calls.filter(([p]) => p === "error")).toHaveLength(2);
  });
});

describe("file ops store: requests", () => {
  it("continues past a failed item and shows one problem", async () => {
    const ran = [];
    const items = ["a", "b", "c"].map((name) => ({
      name,
      run: async () => {
        ran.push(name);
        if (name === "b") throw new ApiError(500, "b is locked.");
      },
    }));
    const { store, addToast } = harness();
    store.startRequest({ kind: "purge", items, successToast: (done) => `Deleted ${done} items permanently.` });
    await tick();
    expect(ran).toEqual(["a", "b", "c"]);
    const op = store.getState().ops[0];
    expect(op.state).toBe("partial");
    expect(op.items.filter((i) => i.state === "failed")).toHaveLength(1);
    expect(op.items[1].error).toBe("b is locked.");
    expect(addToast).toHaveBeenCalledWith({ type: "success", message: "Deleted 2 items permanently." });
  });

  it("is indeterminate when there is no item count", () => {
    const { store } = harness();
    store.startRequest({ kind: "empty-trash", title: "Backup", run: () => new Promise(() => {}) });
    const op = store.getState().ops[0];
    expect(op.indeterminate).toBe(true);
    expect(op.itemsTotal).toBeNull();
  });

  it("a broadens decision resends with confirmBroaden", async () => {
    const seen = [];
    const run = async (ctx) => {
      seen.push(!!ctx?.confirmBroaden);
      if (!ctx?.confirmBroaden) throw new ApiError(409, "This lets everyone open it.", "broadens_access");
    };
    const { store } = harness();
    store.startRequest({ kind: "restore-trash", items: [{ name: "a", run }, { name: "b", run: async () => {} }] });
    await tick();
    let op = store.getState().ops[0];
    expect(op.items[0].state).toBe("needs-decision");
    store.decide(op.id, op.items[0].id, "confirm");
    await tick();
    op = store.getState().ops[0];
    expect(seen).toEqual([false, true]);
    expect(op.items[0].state).toBe("done");
  });

  it("cancel stops queued items", async () => {
    const hold = deferred();
    const { store } = harness();
    const id = store.startRequest({
      kind: "trash",
      items: [{ name: "a", run: () => hold.promise }, { name: "b", run: async () => {} }],
    });
    store.cancel(id);
    hold.resolve();
    await tick();
    const op = store.getState().ops[0];
    expect(op.items[1].state).toBe("cancelled");
    expect(op.state).toBe("cancelled");
  });
});

describe("file ops store: hasBrowserWork", () => {
  it("is true while uploading and false afterwards", async () => {
    const hold = deferred();
    const source = fakeSource({ uploadFile: vi.fn(async (_d, _f, _p, name) => (await hold.promise, { name })) });
    const { store } = harness();
    expect(store.hasBrowserWork()).toBe(false);
    store.startUpload({ source, driveId: "d", files: [file("a.txt")] });
    await tick();
    expect(store.hasBrowserWork()).toBe(true);
    hold.resolve();
    await tick();
    expect(store.hasBrowserWork()).toBe(false);
  });

  it("is true for a batch with items not yet sent, false for a lone blocking request", async () => {
    const hold = deferred();
    const { store } = harness();
    store.startRequest({ kind: "empty-trash", title: "Backup", run: () => hold.promise });
    expect(store.hasBrowserWork()).toBe(false);
    store.startRequest({ kind: "purge", items: [{ name: "a", run: () => hold.promise }, { name: "b", run: async () => {} }] });
    expect(store.hasBrowserWork()).toBe(true);
    hold.resolve();
    await tick();
    expect(store.hasBrowserWork()).toBe(false);
  });
});
