// The file operation store: one per browser tab, created by FileOpsProvider.
// Plain JS plus subscribe/getState (see docs/states-feedback/file-operations.md
// §2.1-2.7). Each operation carries its own context from the moment it starts
// (source, drive, folder, labels), so nothing depends on the component that
// started it still being mounted.

import { deleteJson, getJson, postJson } from "../api.js";
import { driveSource, fileListKey } from "../fileSource.jsx";
import { parentPath, pathBasename } from "../paths.js";
import { successToast } from "./copy.js";
import { createJobRunner } from "./jobRunner.js";
import { createRequestRunner } from "./requestRunner.js";
import { createUploadRunner } from "./uploadRunner.js";

export const UPLOAD_PARALLEL = 3;
export const JOB_PARALLEL = 4;
export const SHOW_AFTER_MS = 600;
export const AUTO_CLEAR_MS = 4000;
export const EMIT_MS = 100;
export const HAPTIC_GAP_MS = 2000;
export const INVALIDATE_GAP_MS = 1000;

/** @typedef {"upload"|"gallery"|"copy"|"move"|"trash"|"restore-trash"|"purge"|"empty-trash"|"restore-backup"|"zip"} OpKind */

/**
 * @typedef {{
 *   type: "exists", existingKind: "file"|"dir",
 *   options: Array<"replace"|"keep_both"|"skip">,
 * } | { type: "broadens", message: string, options: ["confirm","skip"] }} Decision
 */

/**
 * @typedef {{
 *   id: string, name: string, relPath: string, destPath: string,
 *   size: number, received: number,
 *   state: "queued"|"uploading"|"finishing"|"submitting"|"running"|"done"|"skipped"|"needs-decision"|"failed"|"cancelled",
 *   error: string|null, retryable: boolean, decision: Decision|null,
 *   isDir?: boolean,
 *   offline?: boolean,
 *   retrying?: boolean,
 *   waitingForQueue?: boolean,
 *   conflict?: "replace"|"keep_both"|null,
 *   finalName?: string,
 *   file?: File, uploadId?: string|null, jobId?: string|null,
 *   abort?: AbortController|null, completeOnly?: boolean,
 *   run?: (ctx: { signal?: AbortSignal, confirmBroaden?: boolean }) => Promise<unknown>,
 *   extra?: Record<string, unknown>,
 *   confirmBroaden?: boolean,
 * }} Item
 */

/**
 * @typedef {{
 *   id: string, kind: OpKind, createdAt: number, endedAt: number|null,
 *   source: import("../fileSource.jsx").FileSource,
 *   driveId: string, destDriveId: string, destFolder: string, destLabel: string, title: string,
 *   state: "preparing"|"running"|"waiting"|"done"|"partial"|"failed"|"cancelled",
 *   walking: boolean,
 *   bytesDone: number, bytesTotal: number,
 *   itemsDone: number, itemsTotal: number|null,
 *   policy: null|"replace"|"keep_both"|"skip",
 *   items: Item[],
 *   error: string|null,
 *   successToast: string|null,
 *   shown: boolean,
 *   indeterminate: boolean,
 *   rootFolder: boolean,
 *   cancelled: boolean,
 * }} Op
 */

/** @typedef {{ ops: Op[] }} FileOpsState */

const IMMEDIATE_KINDS = new Set(["upload", "gallery", "copy", "move", "zip"]);
const ACTIVE = new Set(["queued", "uploading", "finishing", "submitting", "running"]);

export const isActiveItem = (/** @type {Item} */ item) => ACTIVE.has(item.state);

/**
 * @param {{
 *   queryClient: { invalidateQueries: (opts: any) => unknown },
 *   addToast: (toast: any) => unknown,
 *   haptic?: (pattern: string) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 *   initialOps?: Partial<Op>[],
 *   api?: { getJson: Function, postJson: Function, deleteJson: Function },
 *   storage?: Pick<Storage, "getItem"|"setItem"|"removeItem"> | null,
 *   restoreJobs?: boolean,
 * }} options
 */
export function createFileOpsStore({
  queryClient,
  addToast,
  haptic = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  initialOps = [],
  api = { getJson, postJson, deleteJson },
  storage,
  restoreJobs = true,
}) {
  /** @type {Op[]} */
  const ops = [];
  /** @type {FileOpsState} */
  let state = { ops: [] };
  const listeners = new Set();
  const opSnaps = new WeakMap();
  const itemSnaps = new WeakMap();
  const dirtyOps = new Set();
  const runtime = new WeakMap();
  let seq = 0;
  let lastEmit = -Infinity;
  let trailing = null;
  let destroyed = false;

  // -- ids, runtime ----------------------------------------------------------

  // A short tag keeps ids from this page load apart from ids stored by an earlier load of the tab.
  const tag = Math.random().toString(36).slice(2, 6);
  const newId = (/** @type {string} */ prefix) => `${prefix}_${tag}${++seq}`;

  /** Per-operation private data (timers, caches, callbacks). Never in the state. */
  function rt(/** @type {Op} */ op) {
    let r = runtime.get(op);
    if (!r) {
      r = {
        toasted: false,
        toastFn: null,
        afterFinish: null,
        invalidateKeys: [],
        touched: new Set(),
        invTimer: null,
        clearTimer: null,
        showTimer: null,
        hapticAt: { warning: -Infinity, error: -Infinity },
        nameMaps: new Map(),
        walkAbort: null,
        reportedJobs: false,
      };
      runtime.set(op, r);
    }
    return r;
  }

  // -- snapshots and emits ---------------------------------------------------

  function touch(/** @type {Op} */ op, /** @type {Item|undefined} */ item = undefined) {
    if (item) itemSnaps.delete(item);
    opSnaps.delete(op);
    dirtyOps.add(op);
  }

  function snapItem(/** @type {Item} */ item) {
    let snap = itemSnaps.get(item);
    if (!snap) {
      snap = { ...item };
      itemSnaps.set(item, snap);
    }
    return snap;
  }

  function snapOp(/** @type {Op} */ op) {
    let snap = opSnaps.get(op);
    if (!snap) {
      snap = { ...op, items: op.items.map(snapItem) };
      opSnaps.set(op, snap);
    }
    return snap;
  }

  function recompute(/** @type {Op} */ op) {
    let bytesTotal = 0;
    let bytesDone = 0;
    let total = 0;
    let done = 0;
    for (const item of op.items) {
      if (item.isDir) continue;
      if (item.state === "skipped" || item.state === "cancelled") continue;
      total += 1;
      bytesTotal += item.size || 0;
      if (item.state === "done") {
        done += 1;
        bytesDone += item.size || 0;
      } else {
        bytesDone += Math.min(item.received || 0, item.size || 0);
      }
    }
    op.bytesTotal = bytesTotal;
    op.bytesDone = bytesDone;
    op.itemsDone = done;
    op.itemsTotal = op.indeterminate ? null : total;
  }

  function flush() {
    if (trailing != null) {
      clearTimer(trailing);
      trailing = null;
    }
    lastEmit = now();
    for (const op of dirtyOps) recompute(op);
    for (const op of dirtyOps) opSnaps.delete(op);
    dirtyOps.clear();
    state = { ops: ops.map(snapOp) };
    for (const fn of [...listeners]) fn();
  }

  /** Progress changes are throttled to one emit per 100 ms; state changes pass `urgent`. */
  function emit(urgent = false) {
    if (destroyed) return;
    if (urgent) {
      flush();
      return;
    }
    const elapsed = now() - lastEmit;
    if (elapsed >= EMIT_MS) {
      flush();
    } else if (trailing == null) {
      trailing = setTimer(() => {
        trailing = null;
        flush();
      }, EMIT_MS - elapsed);
    }
  }

  // -- ops and items ---------------------------------------------------------

  /** @param {Partial<Op> & { kind: OpKind }} fields @returns {Op} */
  function makeOp(fields) {
    return /** @type {Op} */ ({
      id: newId("op"),
      createdAt: now(),
      endedAt: null,
      source: driveSource,
      driveId: "",
      destDriveId: fields.destDriveId ?? fields.driveId ?? "",
      destFolder: "",
      destLabel: "",
      title: "",
      state: "preparing",
      walking: false,
      bytesDone: 0,
      bytesTotal: 0,
      itemsDone: 0,
      itemsTotal: 0,
      policy: null,
      items: [],
      error: null,
      successToast: null,
      shown: false,
      indeterminate: false,
      rootFolder: false,
      cancelled: false,
      ...fields,
    });
  }

  /** @param {Partial<Item> & { name: string }} fields @returns {Item} */
  function makeItem(fields) {
    return /** @type {Item} */ ({
      id: newId("it"),
      relPath: fields.name,
      destPath: "",
      size: 0,
      received: 0,
      state: "queued",
      error: null,
      retryable: false,
      decision: null,
      ...fields,
    });
  }

  function addOp(/** @type {Op} */ op) {
    ops.push(op);
    const r = rt(op);
    if (IMMEDIATE_KINDS.has(op.kind) || op.items.some((i) => i.state === "done")) {
      op.shown = true;
    } else {
      r.showTimer = setTimer(() => {
        r.showTimer = null;
        if (ops.includes(op) && !op.endedAt) {
          op.shown = true;
          touch(op);
          emit(true);
        }
      }, SHOW_AFTER_MS);
    }
    touch(op);
    emit(true);
    return op;
  }

  function addItem(/** @type {Op} */ op, /** @type {Item} */ item) {
    op.items.push(item);
    touch(op, item);
    emit(false);
    return item;
  }

  function patchItem(
    /** @type {Op} */ op,
    /** @type {Item} */ item,
    /** @type {Partial<Item>} */ patch,
    { urgent = false } = {},
  ) {
    const stateChanged = patch.state !== undefined && patch.state !== item.state;
    Object.assign(item, patch);
    touch(op, item);
    emit(urgent || stateChanged);
  }

  function patchOp(/** @type {Op} */ op, /** @type {Partial<Op>} */ patch, urgent = true) {
    Object.assign(op, patch);
    touch(op);
    emit(urgent);
  }

  function removeItem(/** @type {Op} */ op, /** @type {Item} */ item) {
    const i = op.items.indexOf(item);
    if (i < 0) return;
    op.items.splice(i, 1);
    touch(op);
    emit(true);
  }

  function removeOp(/** @type {Op} */ op) {
    const i = ops.indexOf(op);
    if (i < 0) return;
    const r = rt(op);
    for (const t of [r.invTimer, r.clearTimer, r.showTimer]) if (t != null) clearTimer(t);
    ops.splice(i, 1);
    dirtyOps.delete(op);
    emit(true);
  }

  // -- side effects shared by the runners ------------------------------------

  /** A folder this op touched; list queries refresh at most once a second. */
  function noteFolder(/** @type {Op} */ op, /** @type {string} */ folder) {
    const r = rt(op);
    let f = folder || "";
    for (;;) {
      r.touched.add(f);
      if (!f || f === op.destFolder) break;
      f = parentPath(f) ?? "";
    }
    if (r.invTimer == null) {
      r.invTimer = setTimer(() => {
        r.invTimer = null;
        flushFolders(op);
      }, INVALIDATE_GAP_MS);
    }
  }

  function flushFolders(/** @type {Op} */ op) {
    const r = rt(op);
    for (const folder of r.touched) {
      queryClient.invalidateQueries({ queryKey: fileListKey(op.source, op.driveId, folder) });
    }
    r.touched.clear();
  }

  function invalidate(/** @type {unknown[][]} */ keys) {
    for (const queryKey of keys) queryClient.invalidateQueries({ queryKey });
  }

  /** Warning (a decision) and error (a failure) buzz at most once per op per 2 s. */
  function notify(/** @type {Op} */ op, /** @type {"warning"|"error"} */ type) {
    const r = rt(op);
    const at = now();
    if (at - r.hapticAt[type] < HAPTIC_GAP_MS) return;
    r.hapticAt[type] = at;
    haptic(type);
  }

  // -- finishing -------------------------------------------------------------

  /**
   * Re-derive the op's state from its items. Runners call this after any item
   * changes. Finishing fires the toast, final invalidation and the auto-clear.
   */
  function settle(/** @type {Op} */ op) {
    if (!ops.includes(op)) return;
    const r = rt(op);
    const items = op.items;
    const active = items.some((i) => ACTIVE.has(i.state));
    const deciding = items.some((i) => i.state === "needs-decision");
    const problems = items.some((i) => i.state === "needs-decision" || i.state === "failed");
    const wasEnded = op.endedAt != null;

    if (problems) op.shown = true;

    if (op.walking || active) {
      op.state = items.length ? "running" : "preparing";
      if (wasEnded) {
        op.endedAt = null;
        r.toasted = false;
        if (r.clearTimer != null) {
          clearTimer(r.clearTimer);
          r.clearTimer = null;
        }
      }
    } else if (deciding) {
      op.state = "waiting";
    } else {
      const done = items.filter((i) => i.state === "done" && !i.isDir).length;
      const failed = items.some((i) => i.state === "failed");
      if (op.cancelled) op.state = "cancelled";
      else if (!failed) op.state = "done";
      else op.state = done > 0 ? "partial" : "failed";
      if (op.error) op.state = "failed";
      if (!wasEnded) finish(op, done);
    }
    touch(op);
    emit(true);
  }

  function finish(/** @type {Op} */ op, /** @type {number} */ done) {
    const r = rt(op);
    op.endedAt = now();
    op.shown = op.shown || op.state === "partial" || op.state === "failed";
    if (r.showTimer != null) {
      clearTimer(r.showTimer);
      r.showTimer = null;
    }
    if (r.invTimer != null) {
      clearTimer(r.invTimer);
      r.invTimer = null;
    }
    flushFolders(op);
    if (op.kind === "upload" || op.kind === "gallery") invalidate([["recents"]]);
    invalidate(r.invalidateKeys);
    if (!r.toasted && done > 0 && op.state !== "cancelled" && op.state !== "failed") {
      r.toasted = true;
      const message =
        typeof r.toastFn === "function"
          ? r.toastFn(done, op.itemsTotal ?? op.items.length)
          : op.successToast || successToast(op, done);
      if (message) addToast({ type: "success", message });
    }
    if (done > 0 && typeof r.afterFinish === "function") {
      try {
        Promise.resolve(r.afterFinish()).catch(() => {});
      } catch {
        // A follow-up like a rescan must never break the card.
      }
    }
    const problems = op.items.some((i) => i.state === "failed" || i.state === "needs-decision");
    if (!problems && !op.error && op.state !== "failed") {
      if (r.clearTimer != null) clearTimer(r.clearTimer);
      r.clearTimer = setTimer(() => {
        r.clearTimer = null;
        if (op.endedAt && !op.items.some((i) => i.state === "failed" || i.state === "needs-decision")) {
          runners.jobs.forget(op);
          removeOp(op);
        }
      }, AUTO_CLEAR_MS);
    }
  }

  // -- runners ---------------------------------------------------------------

  const env = {
    api,
    queryClient,
    now,
    setTimer,
    clearTimer,
    storage,
    ops,
    rt,
    newId,
    makeOp,
    makeItem,
    addItem,
    patchItem,
    patchOp,
    removeItem,
    touch,
    settle,
    emit,
    noteFolder,
    flushFolders,
    invalidate,
    notify,
    getOp: (/** @type {string} */ id) => ops.find((o) => o.id === id),
    isAlive: (/** @type {Op} */ op) => !destroyed && ops.includes(op),
  };

  const runners = {
    uploads: createUploadRunner(env),
    jobs: createJobRunner(env),
    requests: createRequestRunner(env),
  };

  /** @param {Op} op */
  function runnerFor(op) {
    if (op.kind === "upload" || op.kind === "gallery") return runners.uploads;
    if (op.kind === "copy" || op.kind === "move") return runners.jobs;
    return runners.requests;
  }

  // -- public actions --------------------------------------------------------

  /**
   * Upload files or a dropped/picked folder. Returns the operation id.
   * @param {{
   *   source: import("../fileSource.jsx").FileSource, driveId: string, destFolder?: string, destLabel?: string,
   *   dropped?: { entries: any[], files: File[] }, files?: File[],
   *   kind?: "upload"|"gallery", invalidateKeys?: unknown[][], afterFinish?: () => unknown,
   * }} input
   */
  function startUpload({ source, driveId, destFolder = "", destLabel, dropped, files, kind = "upload", invalidateKeys, afterFinish }) {
    const op = addOp(
      makeOp({
        kind,
        source,
        driveId,
        destFolder,
        destLabel: destLabel ?? (destFolder ? pathBasename(destFolder) : ""),
      }),
    );
    const r = rt(op);
    r.invalidateKeys = invalidateKeys || [];
    r.afterFinish = afterFinish || null;
    runners.uploads.start(op, { dropped, files });
    return op.id;
  }

  /**
   * Copy or move items through Luna's job queue.
   * @param {{
   *   kind: "copy"|"move", fromDrive: string, items: { path: string, name?: string }[],
   *   toDrive: string, toPath?: string, toLabel?: string,
   *   source?: import("../fileSource.jsx").FileSource,
   * }} input
   */
  function startJobs({ kind, fromDrive, items, toDrive, toPath = "", toLabel, source = driveSource }) {
    const op = makeOp({
      kind,
      source,
      driveId: fromDrive,
      destDriveId: toDrive,
      destFolder: toPath,
      destLabel: toLabel ?? (toPath ? pathBasename(toPath) : ""),
      title: items.length === 1 ? items[0].name || pathBasename(items[0].path) : "",
      state: "running",
    });
    for (const it of items) {
      op.items.push(
        makeItem({
          name: it.name || pathBasename(it.path),
          relPath: it.path,
          destPath: toPath,
        }),
      );
    }
    addOp(op);
    runners.jobs.start(op);
    return op.id;
  }

  /**
   * One-shot or batch request (empty trash, delete permanently, batch trash/restore, backup restore).
   * Items run one after another and continue past failures. With a single `run`, the bar is indeterminate.
   * @param {{
   *   kind: OpKind, title?: string, destLabel?: string,
   *   source?: import("../fileSource.jsx").FileSource, driveId?: string,
   *   items?: { name: string, run: (ctx?: { signal?: AbortSignal, confirmBroaden?: boolean }) => Promise<unknown> }[],
   *   run?: (ctx?: { signal?: AbortSignal, confirmBroaden?: boolean }) => Promise<unknown>,
   *   successToast?: string | ((done: number, total: number) => string),
   *   invalidateKeys?: unknown[][],
   * }} input
   */
  function startRequest({ kind, title = "", destLabel = "", source = driveSource, driveId = "", items, run, successToast: toast, invalidateKeys }) {
    const list = items && items.length ? items : [{ name: title, run }];
    const op = makeOp({
      kind,
      source,
      driveId,
      destLabel,
      title: title || (list.length === 1 ? list[0].name : ""),
      state: "running",
      indeterminate: !(items && items.length),
      successToast: typeof toast === "string" ? toast : null,
    });
    for (const it of list) op.items.push(makeItem({ name: it.name, run: it.run }));
    const r = rt(op);
    r.invalidateKeys = invalidateKeys || [];
    if (typeof toast === "function") r.toastFn = toast;
    addOp(op);
    runners.requests.start(op);
    return op.id;
  }

  /** Answer one decision. Uploads and jobs: "replace" | "keep_both" | "skip"; broadens: "confirm" | "skip". */
  function decide(/** @type {string} */ opId, /** @type {string} */ itemId, /** @type {string} */ choice) {
    const op = env.getOp(opId);
    const item = op?.items.find((i) => i.id === itemId);
    if (!op || !item || item.state !== "needs-decision") return;
    runnerFor(op).decide(op, item, choice);
  }

  /** "Replace all" / "Keep both for all" / "Skip all": sets the op's policy and answers every waiting decision that allows it. */
  function decideAll(/** @type {string} */ opId, /** @type {"replace"|"keep_both"|"skip"} */ choice) {
    const op = env.getOp(opId);
    if (!op) return;
    patchOp(op, { policy: choice });
    const runner = runnerFor(op);
    for (const item of [...op.items]) {
      if (item.state !== "needs-decision" || !item.decision) continue;
      const allowed = item.decision.type === "broadens" ? choice === "skip" : item.decision.options.includes(choice);
      if (allowed) runner.decide(op, item, choice);
    }
  }

  /** Try again: one failed item, or every retryable failed item of the op. */
  function retry(/** @type {string} */ opId, /** @type {string|undefined} */ itemId = undefined) {
    const op = env.getOp(opId);
    if (!op) return;
    const targets = op.items.filter((i) => i.state === "failed" && i.retryable && (!itemId || i.id === itemId));
    if (!targets.length) return;
    runnerFor(op).retry(op, targets);
  }

  /** Retry every failed item that failed because the connection was down (the `online` event). */
  function retryOffline() {
    for (const op of [...ops]) {
      const targets = op.items.filter((i) => i.state === "failed" && i.retryable && i.offline);
      if (targets.length) runnerFor(op).retry(op, targets);
    }
  }

  /**
   * Cancel the whole operation, or one item. A failed or waiting item is simply removed.
   */
  function cancel(/** @type {string} */ opId, /** @type {string|undefined} */ itemId = undefined) {
    const op = env.getOp(opId);
    if (!op) return;
    const runner = runnerFor(op);
    if (!itemId) {
      op.cancelled = true;
      runner.cancel(op);
      settle(op);
      return;
    }
    const item = op.items.find((i) => i.id === itemId);
    if (!item) return;
    if (item.state === "failed" || item.state === "needs-decision") {
      runner.cancel(op, item);
      removeItem(op, item);
      settle(op);
      return;
    }
    runner.cancel(op, item);
    settle(op);
  }

  /** Remove every failed item of an operation ("Clear failed"). */
  function clearFailed(/** @type {string} */ opId) {
    const op = env.getOp(opId);
    if (!op) return;
    op.items = op.items.filter((i) => i.state !== "failed");
    op.error = null;
    touch(op);
    settle(op);
  }

  /** Remove an operation from the dock. A running one is cancelled first. */
  function dismiss(/** @type {string} */ opId) {
    const op = env.getOp(opId);
    if (!op) return;
    if (!op.endedAt) {
      op.cancelled = true;
      runnerFor(op).cancel(op);
    }
    runners.jobs.forget(op);
    removeOp(op);
  }

  /**
   * True while leaving the page would lose work: uploads queued, uploading or
   * finishing; a decision waiting on an upload; a folder walk; a client batch
   * still sending; a job Luna hasn't accepted yet. Accepted jobs and blocking
   * requests already sent keep running on Luna, so they don't count.
   */
  function hasBrowserWork() {
    return runners.uploads.hasWork() || runners.jobs.hasWork() || runners.requests.hasWork();
  }

  /** Open chunked upload sessions, for the `pagehide` clean-up. */
  function openUploadSessions() {
    return runners.uploads.sessions();
  }

  function subscribe(/** @type {() => void} */ fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getState() {
    return state;
  }

  function destroy() {
    destroyed = true;
    runners.jobs.stop();
    if (trailing != null) clearTimer(trailing);
    for (const op of ops) {
      const r = rt(op);
      for (const t of [r.invTimer, r.clearTimer, r.showTimer]) if (t != null) clearTimer(t);
    }
    listeners.clear();
  }

  // -- startup ---------------------------------------------------------------

  for (const raw of initialOps) {
    const op = makeOp({ kind: "upload", ...raw, items: [], shown: raw.shown ?? true });
    op.items = (raw.items || []).map((it) => makeItem(/** @type {any} */ (it)));
    ops.push(op);
    touch(op);
  }
  if (restoreJobs && storage !== null) runners.jobs.restore(addOp);
  flush();

  return {
    startUpload,
    startJobs,
    startRequest,
    decide,
    decideAll,
    retry,
    retryOffline,
    cancel,
    clearFailed,
    dismiss,
    hasBrowserWork,
    openUploadSessions,
    subscribe,
    getState,
    destroy,
  };
}
