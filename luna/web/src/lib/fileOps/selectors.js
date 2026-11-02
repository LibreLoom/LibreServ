// Pure readers of the store state, for `useFileOpsState(selector)`.
// Selectors that return a new array/object each call must not be passed
// straight to useFileOpsState (it compares by reference); use the `select*`
// helpers below that are memoized on the ops array.

import { dockHeaderTitle, dockSummary } from "./copy.js";

/** @typedef {import("./store.js").Op} Op */
/** @typedef {import("./store.js").Item} Item */
/** @typedef {import("./store.js").FileOpsState} FileOpsState */

const RUNNING = new Set(["preparing", "running"]);

/** @param {Op} op */
export function isRunning(op) {
  return RUNNING.has(op.state);
}

/** @param {Item} item */
export function isProblem(item) {
  return item.state === "needs-decision" || item.state === "failed";
}

/** The ops the dock shows (the 600 ms rule is applied by the store: `op.shown`). */
export function visibleOps(state) {
  return memo(visibleCache, state.ops, (ops) => ops.filter((o) => o.shown));
}

/** @param {Op} op */
export function problemItems(op) {
  return memo(problemCache, op, (o) => o.items.filter(isProblem));
}

/** Inline problem (the oldest) and how many more are behind it. */
export function inlineProblem(op) {
  const list = problemItems(op);
  return { item: list[0] || null, moreCount: Math.max(0, list.length - 1) };
}

/** Percent 0-100, or null when the size isn't known (indeterminate bar). */
export function opProgress(op) {
  if (op.indeterminate) return null;
  if (op.bytesTotal > 0) return Math.min(100, (op.bytesDone / op.bytesTotal) * 100);
  if (op.itemsTotal > 0) return Math.min(100, (op.itemsDone / op.itemsTotal) * 100);
  return 0;
}

/**
 * What the dock header and its collapsed summary need.
 * @param {FileOpsState} state
 */
export function dockInfo(state) {
  return memo(dockCache, state.ops, (ops) => {
    const shown = ops.filter((o) => o.shown);
    const running = shown.filter(isRunning);
    const problems = shown.reduce((sum, o) => sum + problemItems(o).length, 0);
    const known = running.filter((o) => !o.indeterminate);
    const pct = known.length
      ? known.reduce((sum, o) => sum + (opProgress(o) || 0), 0) / known.length
      : null;
    const only = shown.length === 1 && running.length === 1 ? running[0] : null;
    const singleUpload =
      only && (only.kind === "upload" || only.kind === "gallery")
        ? { files: only.itemsTotal || 0 }
        : null;
    const info = {
      visible: shown.length > 0,
      runningCount: running.length,
      problemCount: problems,
      pct,
      title: "",
      summary: "",
      /** True when a new problem appeared since the previous state (the dock opens itself). */
      hasProblems: problems > 0,
    };
    info.title = shown.length ? dockHeaderTitle({ running: running.length, problems }) : "";
    info.summary = dockSummary({ running: running.length, problems, pct, singleUpload });
    return info;
  });
}

/** Total number of problems across visible ops (for "open the dock on the first problem"). */
export function problemCount(state) {
  return dockInfo(state).problemCount;
}

/** One op by id, or undefined. */
export function opById(state, id) {
  return state.ops.find((o) => o.id === id);
}

// -- tiny single-slot memo (selectors return stable references) -------------

const visibleCache = new WeakMap();
const problemCache = new WeakMap();
const dockCache = new WeakMap();

function memo(cache, key, compute) {
  if (cache.has(key)) return cache.get(key);
  const value = compute(key);
  cache.set(key, value);
  return value;
}
