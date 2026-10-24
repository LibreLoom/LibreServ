import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api.js";
import { QUEUE_RETRY_MS, JOB_POLL_MS, JOBS_STORAGE_KEY, JOB_PARALLEL } from "./jobRunner.js";
import { createFileOpsStore } from "./store.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/** @param {{ api?: any, storage?: any, source?: any }} [options] */
function harness({ api, storage = null, source } = {}) {
  let t = 1000;
  let id = 0;
  const timers = new Map();
  const addToast = vi.fn();
  const queryClient = { invalidateQueries: vi.fn() };
  const store = createFileOpsStore({
    queryClient,
    addToast,
    haptic: vi.fn(),
    now: () => t,
    setTimer: (fn, ms) => {
      id += 1;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (timerId) => timers.delete(timerId),
    api,
    storage,
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
  return { store, addToast, queryClient, advance, source };
}

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @returns {any} */
const driveSourceStub = (extra = {}) => ({ kind: "drive", remove: vi.fn(async () => ({})), ...extra });

/** An api whose POST hands out j1, j2... and whose list answers from `jobs`. */
/** @param {{ jobs?: any[], post?: (url: string, body: any) => Promise<any> }} [options] @returns {any} */
function fakeApi({ jobs = [], post } = {}) {
  let n = 0;
  const self = {
    state: { jobs },
    postJson: vi.fn(post || (async () => ({ id: `j${++n}`, state: "running", progress: 0, total: 10 }))),
    getJson: vi.fn(async (url) => {
      if (url.startsWith("/api/v1/jobs?")) return self.state.jobs;
      throw new ApiError(404, "Luna doesn't know this job.");
    }),
    deleteJson: vi.fn(async () => ({})),
  };
  return self;
}
/** @type {any} */
let api;

function items(n) {
  return Array.from({ length: n }, (_, i) => ({ path: `Docs/f${i + 1}.txt`, name: `f${i + 1}.txt` }));
}

describe("job runner: the client queue", () => {
  it("keeps at most 4 accepted jobs and sends the next when one ends", async () => {
    api = fakeApi();
    const { store, advance } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(10), toDrive: "b", toPath: "Dest", toLabel: "Dest", source: driveSourceStub() });
    await tick();
    expect(api.postJson).toHaveBeenCalledTimes(JOB_PARALLEL);
    api.state.jobs = [
      { id: "j1", state: "done", progress: 10, total: 10, error: "" },
      { id: "j2", state: "running", progress: 3, total: 10, error: "" },
      { id: "j3", state: "running", progress: 3, total: 10, error: "" },
      { id: "j4", state: "running", progress: 3, total: 10, error: "" },
    ];
    advance(JOB_POLL_MS);
    await tick();
    expect(api.postJson).toHaveBeenCalledTimes(5);
    const body = api.postJson.mock.calls[0][1];
    expect(body).toEqual({ kind: "copy", from_drive: "a", from_path: "Docs/f1.txt", to_drive: "b", to_path: "Dest" });
  });

  it("waits on queue_full and sends again after 5 s", async () => {
    let first = true;
    api = fakeApi({
      post: async () => {
        if (first) {
          first = false;
          throw new ApiError(503, "Luna is already working on a lot of copies.", "queue_full");
        }
        return { id: "j1", state: "running", progress: 0, total: 5 };
      },
    });
    const { store, advance } = harness({ api });
    store.startJobs({ kind: "move", fromDrive: "a", items: items(1), toDrive: "a", toPath: "Dest", source: driveSourceStub() });
    await tick();
    let item = store.getState().ops[0].items[0];
    expect(item.state).toBe("submitting");
    expect(item.waitingForQueue).toBe(true);
    expect(api.postJson).toHaveBeenCalledTimes(1);
    advance(QUEUE_RETRY_MS);
    await tick();
    item = store.getState().ops[0].items[0];
    expect(api.postJson).toHaveBeenCalledTimes(2);
    expect(item.state).toBe("running");
    expect(item.waitingForQueue).toBe(false);
  });

  it("treats any other 503 as a failure", async () => {
    api = fakeApi({
      post: async () => {
        throw new ApiError(503, "Luna's job queue isn't responding.");
      },
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    expect(store.getState().ops[0].items[0].state).toBe("failed");
  });
});

describe("job runner: how jobs end", () => {
  it("turns an error job into a failed item with lunad's own words, and keeps it", async () => {
    api = fakeApi();
    const { store, advance, addToast } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "Dest", toLabel: "Backup", source: driveSourceStub() });
    await tick();
    api.state.jobs = [{ id: "j1", state: "error", progress: 4, total: 10, error: "Backup is full. Free up some space on it and try again. Luna removed the partial copy." }];
    advance(JOB_POLL_MS);
    await tick();
    advance(60_000);
    const op = store.getState().ops[0];
    expect(op).toBeDefined();
    expect(op.state).toBe("failed");
    expect(op.items[0].state).toBe("failed");
    expect(op.items[0].error).toBe("Backup is full. Free up some space on it and try again. Luna removed the partial copy.");
    expect(op.items[0].retryable).toBe(true);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("an interrupted job is a failed item too", async () => {
    api = fakeApi();
    const { store, advance } = harness({ api });
    store.startJobs({ kind: "move", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    api.state.jobs = [{ id: "j1", state: "interrupted", progress: 1, total: 10, error: "" }];
    advance(JOB_POLL_MS);
    await tick();
    const item = store.getState().ops[0].items[0];
    expect(item.state).toBe("failed");
    expect(item.error).toBe("Luna couldn't move this. Try again.");
  });

  it("done refreshes the file lists and toasts once", async () => {
    api = fakeApi();
    const { store, advance, addToast, queryClient } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(2), toDrive: "b", toPath: "Dest", toLabel: "Dest", source: driveSourceStub() });
    await tick();
    api.state.jobs = [
      { id: "j1", state: "done", progress: 10, total: 10, error: "" },
      { id: "j2", state: "done", progress: 10, total: 10, error: "" },
    ];
    advance(JOB_POLL_MS);
    await tick();
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({ type: "success", message: "Copied 2 items to Dest." });
    for (const key of [["files", "a"], ["files", "b"], ["trash", "a"], ["trash", "b"], ["jobs"]]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: key });
    }
  });

  it("asks GET /jobs/{id} when a job is missing from the list, and fails a 404", async () => {
    api = fakeApi();
    const { store, advance } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    api.state.jobs = [];
    advance(JOB_POLL_MS);
    await tick();
    expect(api.getJson).toHaveBeenCalledWith("/api/v1/jobs/j1");
    expect(store.getState().ops[0].items[0].state).toBe("failed");
  });

  it("cancel sends DELETE for running jobs and the poll reports cancelled", async () => {
    api = fakeApi();
    const { store, advance } = harness({ api });
    const id = store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    store.cancel(id);
    expect(api.deleteJson).toHaveBeenCalledWith("/api/v1/jobs/j1");
    api.state.jobs = [{ id: "j1", state: "cancelled", progress: 2, total: 10, error: "Luna removed the partial copy." }];
    advance(JOB_POLL_MS);
    await tick();
    expect(store.getState().ops[0].state).toBe("cancelled");
  });
});

describe("job runner: clashes and warnings", () => {
  const clash = (kind = "file") => new ApiError(409, "A file or folder with this name is already there.", "exists", { existing_kind: kind });

  it("Keep both sends the job again with on_conflict", async () => {
    let calls = 0;
    api = fakeApi({
      post: async (_url, body) => {
        calls += 1;
        if (!body.on_conflict) throw clash();
        return { id: "j1", state: "running", progress: 0, total: 1 };
      },
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "Dest", source: driveSourceStub() });
    await tick();
    let op = store.getState().ops[0];
    expect(op.items[0].state).toBe("needs-decision");
    expect(op.items[0].decision.options).toEqual(["replace", "keep_both", "skip"]);
    store.decide(op.id, op.items[0].id, "keep_both");
    await tick();
    op = store.getState().ops[0];
    expect(calls).toBe(2);
    expect(api.postJson.mock.calls[1][1].on_conflict).toBe("keep_both");
    expect(op.items[0].state).toBe("running");
  });

  it("Replace moves the old file to Trash, then sends the job again with no on_conflict", async () => {
    let first = true;
    api = fakeApi({
      post: async () => {
        if (first) {
          first = false;
          throw clash();
        }
        return { id: "j1", state: "running", progress: 0, total: 1 };
      },
    });
    const source = driveSourceStub();
    const { store } = harness({ api });
    store.startJobs({ kind: "move", fromDrive: "a", items: items(1), toDrive: "b", toPath: "Dest", source });
    await tick();
    const op = store.getState().ops[0];
    store.decide(op.id, op.items[0].id, "replace");
    await tick();
    expect(source.remove).toHaveBeenCalledWith("b", "Dest/f1.txt");
    expect(api.postJson.mock.calls[1][1]).not.toHaveProperty("on_conflict");
    expect(store.getState().ops[0].items[0].state).toBe("running");
  });

  it("a failed Trash step fails the item with that error and sends nothing", async () => {
    api = fakeApi({
      post: async () => {
        throw clash();
      },
    });
    const source = driveSourceStub({
      remove: vi.fn(async () => {
        throw new ApiError(403, "You don't have permission to delete this.");
      }),
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "Dest", source });
    await tick();
    const op = store.getState().ops[0];
    store.decide(op.id, op.items[0].id, "replace");
    await tick();
    const item = store.getState().ops[0].items[0];
    expect(item.state).toBe("failed");
    expect(item.error).toBe("You don't have permission to delete this.");
    expect(api.postJson).toHaveBeenCalledTimes(1);
  });

  it("a folder in the way or a copy into its own folder offers no Replace", async () => {
    api = fakeApi({
      post: async () => {
        throw clash("dir");
      },
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "Dest", source: driveSourceStub() });
    await tick();
    expect(store.getState().ops[0].items[0].decision.options).toEqual(["keep_both", "skip"]);

    api = fakeApi({
      post: async () => {
        throw clash("file");
      },
    });
    const second = harness({ api });
    second.store.startJobs({ kind: "copy", fromDrive: "a", items: [{ path: "Docs/x.txt", name: "x.txt" }], toDrive: "a", toPath: "Docs", source: driveSourceStub() });
    await tick();
    expect(second.store.getState().ops[0].items[0].decision.options).toEqual(["keep_both", "skip"]);
  });

  it("broadens_access becomes a decision; confirm resends with confirm_broaden", async () => {
    api = fakeApi({
      post: async (_url, body) => {
        if (!body.confirm_broaden) throw new ApiError(409, "This is in a private folder.", "broadens_access");
        return { id: "j1", state: "running", progress: 0, total: 1 };
      },
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "move", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    const op = store.getState().ops[0];
    expect(op.items[0].decision).toEqual({ type: "broadens", message: "This is in a private folder.", options: ["confirm", "skip"] });
    store.decide(op.id, op.items[0].id, "confirm");
    await tick();
    expect(api.postJson.mock.calls[1][1].confirm_broaden).toBe(true);
  });
});

describe("job runner: browser work", () => {
  it("is true until Luna accepts the jobs, false once only accepted jobs remain", async () => {
    /** @type {any} */
    let release;
    api = fakeApi({
      post: () => new Promise((resolve) => (release = () => resolve({ id: "j1", state: "running", progress: 0, total: 1 }))),
    });
    const { store } = harness({ api });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    expect(store.hasBrowserWork()).toBe(true);
    release();
    await tick();
    expect(store.getState().ops[0].items[0].state).toBe("running");
    expect(store.hasBrowserWork()).toBe(false);
  });
});

describe("job runner: surviving a reload", () => {
  it("keeps accepted job ids in sessionStorage and picks them back up in a new store", async () => {
    const storage = memoryStorage();
    api = fakeApi();
    const first = harness({ api, storage });
    first.store.startJobs({ kind: "copy", fromDrive: "a", items: items(2), toDrive: "b", toPath: "Dest", toLabel: "Dest", source: driveSourceStub() });
    await tick();
    const stored = JSON.parse(storage.getItem(JOBS_STORAGE_KEY));
    expect(stored.jobs.map((j) => j.jobId)).toEqual(["j1", "j2"]);

    // The tab reloads: a new store reads the same storage.
    const api2 = fakeApi({ jobs: [{ id: "j1", state: "running", progress: 1, total: 10, error: "" }, { id: "j2", state: "error", progress: 5, total: 10, error: "Dest is full. Free up some space on it and try again." }] });
    const second = harness({ api: api2, storage });
    const [op] = second.store.getState().ops;
    expect(op.kind).toBe("copy");
    expect(op.shown).toBe(true);
    expect(op.items.map((i) => i.state)).toEqual(["running", "running"]);
    expect(second.store.hasBrowserWork()).toBe(false);
    second.advance(JOB_POLL_MS);
    await tick();
    const after = second.store.getState().ops[0];
    expect(after.items[1].state).toBe("failed");
    expect(after.items[1].error).toBe("Dest is full. Free up some space on it and try again.");
    // The ended job is gone from storage; the running one stays.
    expect(JSON.parse(storage.getItem(JOBS_STORAGE_KEY)).jobs.map((j) => j.jobId)).toEqual(["j1"]);
  });

  it("shows a restored job that Luna no longer knows as failed", async () => {
    const storage = memoryStorage();
    storage.setItem(
      JOBS_STORAGE_KEY,
      JSON.stringify({ v: 1, jobs: [{ opId: "old", itemId: "i", jobId: "gone", kind: "move", name: "a.txt", path: "a.txt", title: "a.txt", fromDrive: "a", toDrive: "b", toPath: "", toLabel: "B", createdAt: 1 }] }),
    );
    api = fakeApi({ jobs: [] });
    const { store, advance } = harness({ api, storage });
    advance(JOB_POLL_MS);
    await tick();
    const item = store.getState().ops[0].items[0];
    expect(item.state).toBe("failed");
    expect(item.error).toMatch(/no record of this move/);
  });

  it("works when storage throws", async () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    api = fakeApi();
    const { store } = harness({ api, storage });
    store.startJobs({ kind: "copy", fromDrive: "a", items: items(1), toDrive: "b", toPath: "", source: driveSourceStub() });
    await tick();
    expect(store.getState().ops[0].items[0].state).toBe("running");
  });
});
