import { describe, expect, it, vi } from "vitest";

import { dockSummary, moreProblems, opStatus, plain } from "./copy.js";
import { classifyError } from "./errors.js";
import { dockInfo, inlineProblem, opProgress, problemItems, visibleOps } from "./selectors.js";
import { createFileOpsStore } from "./store.js";

function stateOf(initialOps) {
  return createFileOpsStore({
    queryClient: { invalidateQueries: vi.fn() },
    addToast: vi.fn(),
    initialOps,
    storage: null,
  }).getState();
}

const clash = (id, name) => ({
  id,
  name,
  state: "needs-decision",
  decision: { type: "exists", existingKind: "file", options: ["replace", "keep_both", "skip"] },
});

describe("selectors", () => {
  it("shows only the operations marked shown (the 600 ms rule lives in the store)", () => {
    const state = stateOf([
      { id: "a", kind: "upload", state: "running", items: [] },
      { id: "b", kind: "purge", state: "running", shown: false, items: [] },
    ]);
    expect(visibleOps(state).map((o) => o.id)).toEqual(["a"]);
    expect(visibleOps(state)).toBe(visibleOps(state));
  });

  it("gives the first problem and counts the rest", () => {
    const items = Array.from({ length: 15 }, (_, i) => clash(`i${i}`, `f${i}.txt`));
    const state = stateOf([{ id: "a", kind: "upload", state: "waiting", destLabel: "Inbox", items }]);
    const op = state.ops[0];
    expect(problemItems(op)).toHaveLength(15);
    const { item, moreCount } = inlineProblem(op);
    expect(item.name).toBe("f0.txt");
    expect(moreCount).toBe(14);
    expect(moreProblems(moreCount)).toBe("14 more problems →");
    expect(moreProblems(1)).toBe("1 more problem →");
  });

  it("builds the dock header and collapsed summary", () => {
    const running = stateOf([
      { id: "a", kind: "upload", state: "running", destLabel: "Inbox", items: [{ id: "i", name: "a", size: 100, received: 50, state: "uploading" }, { id: "j", name: "b", size: 100, received: 50, state: "uploading" }] },
    ]);
    let info = dockInfo(running);
    expect(info.visible).toBe(true);
    expect(info.title).toBe("Working on your files");
    expect(info.summary).toBe("Uploading 2 files · 50%");

    const mixed = stateOf([
      { id: "a", kind: "upload", state: "running", items: [{ id: "i", name: "a", size: 100, received: 50, state: "uploading" }] },
      { id: "b", kind: "copy", state: "running", items: [{ id: "k", name: "x", size: 100, received: 50, state: "running" }] },
      { id: "c", kind: "upload", state: "waiting", items: [clash("c1", "z")] },
    ]);
    info = dockInfo(mixed);
    expect(info.summary).toBe("2 running · 50% · 1 need you");

    const needs = stateOf([{ id: "c", kind: "upload", state: "waiting", items: [clash("c1", "z")] }]);
    info = dockInfo(needs);
    expect(info.title).toBe("Some files need you");
    expect(info.summary).toBe("1 need you");

    expect(dockInfo(stateOf([])).visible).toBe(false);
  });

  it("reports progress, null for indeterminate", () => {
    const state = stateOf([
      { id: "a", kind: "upload", state: "running", items: [{ id: "i", name: "a", size: 200, received: 50, state: "uploading" }] },
      { id: "b", kind: "empty-trash", state: "running", indeterminate: true, items: [{ id: "k", name: "t", state: "running" }] },
    ]);
    expect(opProgress(state.ops[0])).toBe(25);
    expect(opProgress(state.ops[1])).toBeNull();
  });
});

describe("copy and errors", () => {
  it("writes the status line from the spec", () => {
    const op = { kind: "upload", state: "running", title: "", itemsTotal: 3, itemsDone: 1, destLabel: "Inbox", items: [] };
    expect(plain(opStatus(op))).toBe("Uploading 3 files to Inbox");
    expect(plain(opStatus({ ...op, state: "partial" }))).toBe("Uploaded 1 of 3 files to Inbox");
    expect(plain(opStatus({ ...op, title: "Docs", rootFolder: true, state: "partial" }))).toBe("Uploaded 1 of 3 files in Docs");
    expect(plain(opStatus({ kind: "copy", state: "done", title: "a.txt", itemsTotal: 1, destLabel: "Backup" }))).toBe("Copied a.txt to Backup");
    expect(plain(opStatus({ kind: "empty-trash", state: "running", destLabel: "Backup" }))).toBe("Emptying Trash on Backup");
    expect(plain(opStatus({ kind: "move", state: "cancelled" }))).toBe("Cancelled");
    expect(opStatus({ kind: "copy", state: "running", title: "a.txt", itemsTotal: 1, destLabel: "Backup" })[1]).toEqual({ pill: "a.txt" });
  });

  it("collapses the summary when nothing runs", () => {
    expect(dockSummary({ running: 0, problems: 0, pct: null })).toBe("");
  });

  it("classifies errors", () => {
    expect(classifyError({ status: 0, message: "x" }, "upload")).toMatchObject({ retryable: true, offline: true });
    expect(classifyError({ status: 401, message: "Sign in again." }, "upload")).toMatchObject({ retryable: true, message: "Sign in again." });
    expect(classifyError({ status: 503, code: "queue_full", message: "Busy." }, "copy")).toMatchObject({ queueFull: true });
    expect(classifyError({ status: 409, code: "keep_both_unsupported", message: "No." }, "copy")).toMatchObject({ retryable: false, message: "No." });
    expect(classifyError({ status: 409, code: "exists", data: { existing_kind: "dir" }, message: "x" }, "upload").decision).toMatchObject({ existingKind: "dir", options: ["keep_both", "skip"] });
    expect(classifyError({ status: 409, code: "exists", message: "x" }, "copy", { sameFolder: true }).decision.options).toEqual(["keep_both", "skip"]);
    expect(classifyError({ status: 409, message: "x" }, "upload").decision).toBeUndefined();
    expect(classifyError({ status: 409, message: "x" }, "upload", { uncodedConflictIsExists: true }).decision.type).toBe("exists");
    expect(classifyError({ name: "AbortError" }, "upload").aborted).toBe(true);
    expect(classifyError({ status: 500 }, "purge").message).toBe("Luna couldn't delete this permanently. Try again.");
  });
});
