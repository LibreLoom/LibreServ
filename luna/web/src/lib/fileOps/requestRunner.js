// One-shot and batch requests: empty trash, delete permanently, batch trash
// and restore, backup restore. Items run one after another and the run
// continues past failures. With no item count the bar is indeterminate.

import { classifyError } from "./errors.js";

/** @param {any} env */
export function createRequestRunner(env) {
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();
  /** @type {Set<string>} */
  const driving = new Set();

  async function drive(/** @type {any} */ op) {
    if (driving.has(op.id)) return;
    driving.add(op.id);
    const controller = new AbortController();
    controllers.set(op.id, controller);
    try {
      for (;;) {
        if (!env.isAlive(op)) break;
        const item = op.items.find((i) => i.state === "queued");
        if (!item) break;
        if (op.cancelled) {
          env.patchItem(op, item, { state: "cancelled" });
          continue;
        }
        env.patchItem(op, item, { state: "running", error: null, decision: null });
        try {
          await item.run?.({ signal: controller.signal, confirmBroaden: item.confirmBroaden });
          env.patchItem(op, item, { state: "done" });
        } catch (err) {
          const c = classifyError(err, op.kind);
          if (c.aborted) {
            env.patchItem(op, item, { state: "cancelled" });
          } else if (c.decision?.type === "broadens") {
            env.patchItem(op, item, { state: "needs-decision", decision: c.decision, error: null });
            env.notify(op, "warning");
          } else {
            env.patchItem(op, item, {
              state: "failed",
              error: c.message,
              retryable: true,
              offline: c.offline,
            });
            env.notify(op, "error");
          }
        }
        env.settle(op);
      }
    } finally {
      driving.delete(op.id);
      controllers.delete(op.id);
    }
    env.settle(op);
  }

  return {
    start(/** @type {any} */ op) {
      void drive(op);
    },

    decide(/** @type {any} */ op, /** @type {any} */ item, /** @type {string} */ choice) {
      if (choice === "confirm") {
        env.patchItem(op, item, { state: "queued", decision: null, confirmBroaden: true });
        void drive(op);
      } else {
        env.patchItem(op, item, { state: "skipped", decision: null });
        env.settle(op);
      }
    },

    retry(/** @type {any} */ op, /** @type {any[]} */ targets) {
      for (const item of targets) {
        env.patchItem(op, item, { state: "queued", error: null, offline: false });
      }
      env.settle(op);
      void drive(op);
    },

    cancel(/** @type {any} */ op, /** @type {any|undefined} */ item = undefined) {
      if (item) {
        if (item.state === "queued") env.patchItem(op, item, { state: "cancelled" });
        return;
      }
      controllers.get(op.id)?.abort();
      for (const i of op.items) {
        if (i.state === "queued" || i.state === "needs-decision") env.patchItem(op, i, { state: "cancelled", decision: null });
      }
    },

    /** Items not yet sent: a reload would drop them. */
    hasWork() {
      return env.ops.some(
        (op) =>
          !op.indeterminate &&
          !["upload", "gallery", "copy", "move"].includes(op.kind) &&
          op.items.some((i) => i.state === "queued"),
      );
    },
  };
}
