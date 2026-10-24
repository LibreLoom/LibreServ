// Copy and move jobs on Luna. The tab keeps at most 4 accepted jobs running
// (lunad's MAX_QUEUED_PER_USER) and sends the next item when one ends. One
// poll a second asks Luna how this tab's own jobs are doing. A failed job is
// a failed row with lunad's own words; it is never dropped.
//
// The accepted job ids of this tab are kept in sessionStorage
// (`luna.fileOps.jobs`) so that after a reload the dock picks them back up and
// shows how they ended. Browser uploads cannot survive a reload; accepted jobs
// can, because Luna keeps running them.

import { joinPath, parentPath } from "../paths.js";
import { jobGone, failedText } from "./copy.js";
import { classifyError } from "./errors.js";

export const JOB_PARALLEL = 4;
export const JOB_POLL_MS = 1000;
export const QUEUE_RETRY_MS = 5000;
export const JOBS_STORAGE_KEY = "luna.fileOps.jobs";

// -- sessionStorage, all in one place, every access in its own try/catch ------

/** @param {any} storage */
function pick(storage) {
  if (storage === null) return null;
  if (storage) return storage;
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{
 *   opId: string, itemId: string, jobId: string, kind: "copy"|"move",
 *   name: string, path: string, title: string, fromDrive: string,
 *   toDrive: string, toPath: string, toLabel: string, createdAt: number,
 * }} StoredJob
 */

/** @param {any} storage @returns {StoredJob[]} */
export function readStoredJobs(storage) {
  try {
    const raw = pick(storage)?.getItem(JOBS_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return Array.isArray(data?.jobs) ? data.jobs.filter((j) => j && j.jobId && j.opId) : [];
  } catch {
    return [];
  }
}

/** @param {any} storage @param {StoredJob[]} jobs */
function writeStoredJobs(storage, jobs) {
  try {
    const s = pick(storage);
    if (!s) return;
    if (jobs.length) s.setItem(JOBS_STORAGE_KEY, JSON.stringify({ v: 1, jobs }));
    else s.removeItem(JOBS_STORAGE_KEY);
  } catch {
    // Storage can be blocked or full; the card then simply doesn't survive a reload.
  }
}

/** @param {any} env */
export function createJobRunner(env) {
  /** @type {{ op: any, item: any }[]} */
  const queue = [];
  /** @type {Map<string, { op: any, item: any }>} */
  const accepted = new Map();
  let inflight = 0;
  let blockedUntil = 0;
  let pollTimer = null;
  let retryTimer = null;
  let stopped = false;

  const stored = () => readStoredJobs(env.storage);
  const saveJob = (/** @type {StoredJob} */ job) =>
    writeStoredJobs(env.storage, [...stored().filter((j) => j.jobId !== job.jobId), job]);
  const dropJob = (/** @type {string} */ jobId) =>
    writeStoredJobs(env.storage, stored().filter((j) => j.jobId !== jobId));
  const dropOp = (/** @type {string} */ opId) =>
    writeStoredJobs(env.storage, stored().filter((j) => j.opId !== opId));

  // -- sending -----------------------------------------------------------------

  function slotsUsed() {
    return accepted.size + inflight;
  }

  function pump() {
    if (stopped) return;
    if (env.now() < blockedUntil) {
      armRetry();
      return;
    }
    while (queue.length && slotsUsed() < JOB_PARALLEL) {
      const entry = queue.shift();
      if (!entry) break;
      if (entry.item.state !== "queued" && entry.item.state !== "submitting") continue;
      if (!env.isAlive(entry.op)) continue;
      void submit(entry);
    }
  }

  function armRetry() {
    if (retryTimer != null || stopped) return;
    const wait = Math.max(0, blockedUntil - env.now());
    retryTimer = env.setTimer(() => {
      retryTimer = null;
      blockedUntil = 0;
      pump();
    }, wait || QUEUE_RETRY_MS);
  }

  /** A copy into its own folder can't replace anything. */
  function sameFolder(/** @type {any} */ op, /** @type {any} */ item) {
    return op.kind === "copy" && op.driveId === op.destDriveId && (parentPath(item.relPath) ?? "") === op.destFolder;
  }

  async function submit(/** @type {{ op: any, item: any }} */ entry) {
    const { op, item } = entry;
    inflight += 1;
    env.patchItem(op, item, { state: "submitting", waitingForQueue: false, error: null });
    try {
      const job = await env.api.postJson("/api/v1/jobs", {
        kind: op.kind,
        from_drive: op.driveId,
        from_path: item.relPath,
        to_drive: op.destDriveId,
        to_path: op.destFolder,
        ...(item.extra || {}),
      });
      if (!env.isAlive(op) || item.state === "cancelled") {
        void Promise.resolve(env.api.deleteJson(`/api/v1/jobs/${job.id}`)).catch(() => {});
        return;
      }
      env.patchItem(op, item, {
        state: "running",
        jobId: job.id,
        size: Number(job.total) || 0,
        received: Number(job.progress) || 0,
        decision: null,
      });
      accepted.set(job.id, entry);
      saveJob({
        opId: op.id,
        itemId: item.id,
        jobId: job.id,
        kind: op.kind,
        name: item.name,
        path: item.relPath,
        title: op.title,
        fromDrive: op.driveId,
        toDrive: op.destDriveId,
        toPath: op.destFolder,
        toLabel: op.destLabel,
        createdAt: op.createdAt,
      });
      schedulePoll();
    } catch (err) {
      if (item.state === "cancelled") return;
      onSubmitError(op, item, err);
    } finally {
      inflight -= 1;
      env.settle(op);
      pump();
    }
  }

  function onSubmitError(/** @type {any} */ op, /** @type {any} */ item, /** @type {unknown} */ err) {
    const c = classifyError(err, op.kind, { sameFolder: sameFolder(op, item) });
    if (c.queueFull) {
      // Luna's queue is full (other copies, maybe from another tab). Wait for
      // one of ours to end, or five seconds, and send again.
      env.patchItem(op, item, { state: "submitting", waitingForQueue: true });
      queue.unshift({ op, item });
      blockedUntil = env.now() + QUEUE_RETRY_MS;
      armRetry();
      return;
    }
    if (c.decision) {
      const d = c.decision;
      if (op.policy && d.type === "exists" && d.options.includes(op.policy)) {
        decide(op, item, op.policy);
        return;
      }
      env.patchItem(op, item, { state: "needs-decision", decision: d, error: null });
      env.notify(op, "warning");
      return;
    }
    env.patchItem(op, item, {
      state: "failed",
      error: c.message || failedText(op.kind),
      retryable: c.retryable,
      offline: c.offline,
    });
    env.notify(op, "error");
  }

  // -- decisions, retry, cancel --------------------------------------------------

  function decide(/** @type {any} */ op, /** @type {any} */ item, /** @type {string} */ choice) {
    const requeue = (/** @type {Record<string, unknown>} */ extra) => {
      env.patchItem(op, item, {
        state: "queued",
        decision: null,
        error: null,
        extra: { ...(item.extra || {}), ...extra },
      });
      queue.push({ op, item });
      pump();
    };
    if (choice === "skip") {
      env.patchItem(op, item, { state: "skipped", decision: null });
      env.settle(op);
    } else if (choice === "confirm") {
      requeue({ confirm_broaden: true });
    } else if (choice === "keep_both") {
      requeue({ on_conflict: "keep_both" });
    } else if (choice === "replace") {
      // The file that's there goes to Trash first, then the job is sent again.
      env.patchItem(op, item, { state: "submitting", decision: null, error: null });
      Promise.resolve(op.source.remove(op.destDriveId, joinPath(op.destFolder, item.name))).then(
        () => {
          const { on_conflict: _drop, ...rest } = item.extra || {};
          void _drop;
          item.extra = rest;
          item.state = "queued";
          queue.push({ op, item });
          pump();
        },
        (err) => {
          const c = classifyError(err, "trash");
          env.patchItem(op, item, { state: "failed", error: c.message, retryable: false });
          env.notify(op, "error");
          env.settle(op);
        },
      );
    }
  }

  function retry(/** @type {any} */ op, /** @type {any[]} */ targets) {
    for (const item of targets) {
      env.patchItem(op, item, { state: "queued", error: null, offline: false, received: 0, jobId: null });
      queue.push({ op, item });
    }
    env.settle(op);
    pump();
  }

  function cancelItem(/** @type {any} */ op, /** @type {any} */ item) {
    if (item.state === "running" && item.jobId) {
      // Luna reports the end state; the poll turns it into "cancelled".
      void Promise.resolve(env.api.deleteJson(`/api/v1/jobs/${item.jobId}`)).catch(() => {});
    } else if (item.state === "queued" || item.state === "submitting" || item.state === "needs-decision") {
      env.patchItem(op, item, { state: "cancelled", decision: null, waitingForQueue: false });
    }
  }

  // -- polling -------------------------------------------------------------------

  function schedulePoll() {
    if (pollTimer != null || stopped || !accepted.size) return;
    pollTimer = env.setTimer(() => {
      pollTimer = null;
      void poll();
    }, JOB_POLL_MS);
  }

  async function poll() {
    if (stopped || !accepted.size) return;
    let list = null;
    try {
      list = await env.api.getJson("/api/v1/jobs?limit=200");
    } catch {
      list = null; // can't reach Luna right now; try again next second
    }
    if (list && Array.isArray(list)) {
      const byId = new Map(list.map((j) => [j.id, j]));
      await Promise.all(
        [...accepted.entries()].map(async ([id, entry]) => {
          let job = byId.get(id);
          if (!job) {
            try {
              job = await env.api.getJson(`/api/v1/jobs/${id}`);
            } catch (err) {
              if (/** @type {any} */ (err)?.status === 404) gone(id, entry);
              return;
            }
          }
          if (job) handleJob(id, entry, job);
        }),
      );
    }
    schedulePoll();
  }

  function gone(/** @type {string} */ id, /** @type {{ op: any, item: any }} */ { op, item }) {
    accepted.delete(id);
    dropJob(id);
    env.patchItem(op, item, { state: "failed", error: jobGone(op.kind), retryable: false });
    env.notify(op, "error");
    env.settle(op);
    blockedUntil = 0;
    pump();
  }

  function handleJob(/** @type {string} */ id, /** @type {{ op: any, item: any }} */ { op, item }, /** @type {any} */ job) {
    const total = Number(job.total) || 0;
    const progress = Number(job.progress) || 0;
    const jobState = String(job.state || "running");
    // Anything that isn't a known end state (running, or a state we don't know) keeps running.
    if (!["done", "error", "interrupted", "cancelled"].includes(jobState)) {
      env.patchItem(op, item, { size: total, received: progress });
      return;
    }
    accepted.delete(id);
    dropJob(id);
    blockedUntil = 0;
    if (jobState === "done") {
      env.patchItem(op, item, { state: "done", size: total, received: total || progress });
      env.invalidate([
        ["files", op.driveId],
        ["files", op.destDriveId],
        ["trash", op.driveId],
        ["trash", op.destDriveId],
        ["jobs"],
      ]);
    } else if (jobState === "cancelled") {
      env.patchItem(op, item, { state: "cancelled", size: total, received: progress, error: job.error || null });
      env.invalidate([["files", op.driveId], ["files", op.destDriveId], ["jobs"]]);
    } else {
      env.patchItem(op, item, {
        state: "failed",
        size: total,
        received: progress,
        error: job.error || failedText(op.kind),
        retryable: true,
      });
      env.notify(op, "error");
      env.invalidate([["files", op.driveId], ["files", op.destDriveId], ["trash", op.driveId], ["jobs"]]);
    }
    env.settle(op);
    pump();
  }

  // -- the store's actions ----------------------------------------------------------

  return {
    start(/** @type {any} */ op) {
      for (const item of op.items) queue.push({ op, item });
      pump();
    },

    decide,
    retry,

    cancel(/** @type {any} */ op, /** @type {any|undefined} */ item = undefined) {
      if (item) {
        cancelItem(op, item);
        return;
      }
      for (const it of op.items) cancelItem(op, it);
    },

    hasWork() {
      // Accepted jobs keep running on Luna; only items not yet accepted count.
      return env.ops.some(
        (op) =>
          (op.kind === "copy" || op.kind === "move") &&
          op.items.some((i) => i.state === "queued" || i.state === "submitting"),
      );
    },

    /** Forget the stored job ids of an op (dismissed or auto-cleared). */
    forget(/** @type {any} */ op) {
      if (op.kind !== "copy" && op.kind !== "move") return;
      for (const [id, entry] of accepted) if (entry.op === op) accepted.delete(id);
      dropOp(op.id);
    },

    /** After a reload: pick this tab's accepted jobs back up. */
    restore(/** @type {(op: any) => any} */ addOp) {
      const groups = new Map();
      for (const j of stored()) {
        if (!groups.has(j.opId)) groups.set(j.opId, []);
        groups.get(j.opId).push(j);
      }
      for (const [, jobs] of groups) {
        const first = jobs[0];
        const op = env.makeOp({
          id: first.opId,
          kind: first.kind,
          driveId: first.fromDrive,
          destDriveId: first.toDrive,
          destFolder: first.toPath,
          destLabel: first.toLabel,
          title: first.title || (jobs.length === 1 ? first.name : ""),
          state: "running",
          shown: true,
          createdAt: first.createdAt || env.now(),
        });
        for (const j of jobs) {
          const item = env.makeItem({
            id: j.itemId,
            name: j.name,
            relPath: j.path,
            destPath: j.toPath,
            state: "running",
            jobId: j.jobId,
          });
          op.items.push(item);
          accepted.set(j.jobId, { op, item });
        }
        addOp(op);
      }
      schedulePoll();
    },

    stop() {
      stopped = true;
      if (pollTimer != null) env.clearTimer(pollTimer);
      if (retryTimer != null) env.clearTimer(retryTimer);
    },
  };
}
