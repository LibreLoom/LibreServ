import { describe, expect, it, vi } from "vitest";

import { dockHeaderTitle, dockSummary, moreProblems, opMeta, opStatus, plain } from "./copy.js";
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
    expect(moreProblems(moreCount)).toBe("14 more problems");
    expect(moreProblems(1)).toBe("1 more problem");
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
    expect(info.summary).toBe("1 needs you");

    // Finished, with nothing to answer: the card says so rather than
    // announcing that files need you.
    const done = stateOf([
      {
        id: "d",
        kind: "upload",
        state: "done",
        endedAt: 1,
        itemsTotal: 3,
        itemsDone: 3,
        items: [
          { id: "x", name: "a", state: "done" },
          { id: "y", name: "b", state: "done" },
          { id: "z", name: "c", state: "done" },
        ],
      },
    ]);
    info = dockInfo(done);
    expect(info.title).toBe("Finished");
    expect(info.summary).toBe("3 files uploaded");

    expect(dockInfo(stateOf([])).visible).toBe(false);
  });

  // A single-file share link refuses a two-file drop before any item exists,
  // so the reason lives on the op and its item list stays empty. Counting only
  // items called that "Finished / 0 files uploaded" and kept the reason folded.
  it("treats an op that failed as a whole as a problem, not finished work", () => {
    const state = stateOf([
      {
        id: "f",
        kind: "upload",
        state: "failed",
        endedAt: 1,
        title: "report.pdf",
        destLabel: "report.pdf",
        error: "Choose one file to replace this file.",
        items: [],
      },
    ]);
    const info = dockInfo(state);
    expect(info.problemCount).toBe(1);
    expect(info.finishedCount).toBe(0);
    expect(info.title).toBe("Some files need you");
    expect(info.hasProblems).toBe(true);
  });

  it("names the file, not a count of zero, when nothing was counted", () => {
    const state = stateOf([
      {
        id: "f",
        kind: "upload",
        state: "failed",
        endedAt: 1,
        title: "report.pdf",
        destLabel: "report.pdf",
        error: "Choose one file to replace this file.",
        items: [],
      },
    ]);
    const [op] = state.ops;
    expect(plain(opStatus(op))).toBe("Couldn't replace report.pdf");
  });

  it("reports progress, null for indeterminate", () => {
    const state = stateOf([
      { id: "a", kind: "upload", state: "running", items: [{ id: "i", name: "a", size: 200, received: 50, state: "uploading" }] },
      { id: "b", kind: "empty-trash", state: "running", indeterminate: true, items: [{ id: "k", name: "t", state: "running" }] },
    ]);
    expect(opProgress(state.ops[0])).toBe(25);
    expect(opProgress(state.ops[1])).toBeNull();
  });

  it("gives a moving bar for a drop of empty folders, which has no bytes to measure", () => {
    const state = stateOf([
      // The store derives `foldersDone` from what each folder item made, so
      // the count lives on the item, not on the op.
      { id: "a", kind: "upload", state: "running", items: [{ id: "i", name: "Photos", isDir: true, state: "done", foldersMade: 2 }] },
    ]);
    expect(state.ops[0].foldersDone).toBe(2);
    expect(opProgress(state.ops[0])).toBeNull();
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

  it("collapses the summary when nothing runs and nothing finished", () => {
    expect(dockSummary({ running: 0, problems: 0, finished: 0, pct: null })).toBe("");
  });

  it("says what finished instead of claiming files need you", () => {
    // The old header had only two states, so a finished upload announced
    // "Some files need you". These are the three real states.
    expect(dockHeaderTitle({ running: 1, problems: 0, finished: 0 })).toBe("Working on your files");
    expect(dockHeaderTitle({ running: 0, problems: 2, finished: 0 })).toBe("Some files need you");
    expect(dockHeaderTitle({ running: 0, problems: 0, finished: 1 })).toBe("Finished");
    // A problem outranks a finish: something still needs an answer.
    expect(dockHeaderTitle({ running: 0, problems: 1, finished: 1 })).toBe("Some files need you");
    // A cancelled operation is not finished work; say it stopped instead.
    expect(dockHeaderTitle({ running: 0, problems: 0, finished: 1, cancelled: 1 })).toBe("Stopped");
    expect(dockHeaderTitle({ running: 0, problems: 0, finished: 2, cancelled: 1 })).toBe("Finished");
  });

  it("names what finished in the collapsed summary", () => {
    expect(dockSummary({ running: 0, problems: 0, finished: 1, finishedLabel: "3 files uploaded", pct: null }))
      .toBe("3 files uploaded");
    expect(dockSummary({ running: 0, problems: 0, finished: 2, pct: null })).toBe("2 finished");
    expect(dockSummary({ running: 0, problems: 1, finished: 0, pct: null })).toBe("1 needs you");
    expect(dockSummary({ running: 0, problems: 2, finished: 0, pct: null })).toBe("2 need you");
  });

  it("names the items a batch is moving, not just how many", () => {
    const items = (names) => names.map((name, i) => ({ id: `i${i}`, name, state: "running" }));
    // "Moving 3 items to Trash" tells you nothing about what is going.
    expect(plain(opStatus({ kind: "trash", state: "running", items: items(["a.jpg"]) })))
      .toBe("Moving a.jpg to Trash");
    expect(plain(opStatus({ kind: "trash", state: "running", items: items(["a.jpg", "b.jpg"]) })))
      .toBe("Moving a.jpg and b.jpg to Trash");
    expect(plain(opStatus({ kind: "trash", state: "running", items: items(["a.jpg", "b.jpg", "c.jpg"]) })))
      .toBe("Moving a.jpg, b.jpg and c.jpg to Trash");
    // Past three, a list is worse than a count.
    expect(plain(opStatus({ kind: "trash", state: "running", items: items(["a", "b", "c", "d"]) })))
      .toBe("Moving 4 items to Trash");
    expect(plain(opStatus({ kind: "purge", state: "running", items: items(["a.jpg", "b.jpg"]) })))
      .toBe("Deleting a.jpg and b.jpg permanently");
    expect(plain(opStatus({ kind: "restore-trash", state: "running", items: items(["a.jpg", "b.jpg"]) })))
      .toBe("Putting back a.jpg and b.jpg");
    // A batch has no bytes, so the meta line says how far along it is instead.
    expect(opMeta({ kind: "trash", state: "running", itemsTotal: 5, itemsDone: 2, items: [] }))
      .toBe("2 of 5 done");
  });

  it("classifies errors", () => {
    expect(classifyError({ status: 0, message: "x" }, "upload")).toMatchObject({ retryable: true, offline: true });
    expect(classifyError({ status: 401, message: "Sign in again." }, "upload")).toMatchObject({ retryable: true, message: "Sign in again." });
    expect(classifyError({ status: 503, code: "queue_full", message: "Busy." }, "copy")).toMatchObject({ queueFull: true });
    expect(classifyError({ status: 409, code: "keep_both_unsupported", message: "No." }, "copy")).toMatchObject({ retryable: false, message: "No." });
    expect(classifyError({ status: 409, code: "exists", data: { existing_kind: "dir" }, message: "x" }, "upload").decision).toMatchObject({ existingKind: "dir", options: ["keep_both", "skip"] });
    expect(classifyError({ status: 409, code: "exists", message: "x" }, "copy", { sameFolder: true }).decision.options).toEqual(["keep_both", "skip"]);
    expect(classifyError({ status: 409, message: "x" }, "upload").decision).toBeUndefined();
    expect(classifyError({ name: "AbortError" }, "upload").aborted).toBe(true);
    expect(classifyError({ status: 500 }, "purge").message).toBe("Luna couldn't delete this permanently. Try again.");
  });
});
