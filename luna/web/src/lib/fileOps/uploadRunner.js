// Uploads: one global pool for the whole tab (3 at a time, across every
// operation), a cheap name check before any bytes move, decisions for name
// clashes that park one item while the others keep going, and a folder walk
// that streams into the queue.

import { walkDropped } from "../collectUploadFiles.js";
import { joinPath, parentPath } from "../paths.js";
import { classifyError, existsDecision, isAbort } from "./errors.js";
import { text } from "./copy.js";

export const UPLOAD_PARALLEL = 3;

/** @param {string} relPath @returns {{ dir: string, name: string }} */
function splitRel(relPath) {
  const parts = String(relPath || "").replace(/^\/+/, "").split("/").filter(Boolean);
  const name = parts.pop() || "file";
  return { dir: parts.join("/"), name };
}

/** @param {any} env */
export function createUploadRunner(env) {
  /** @type {{ op: any, item: any }[]} */
  const ready = [];
  let active = 0;

  // -- name check ------------------------------------------------------------

  /**
   * The names already in `destPath`, as Map<name, "file"|"dir">, or null when
   * unknown (a listing failed: the server's 409 is the safety net). Nested
   * folders are only listed when their parent has a folder with that name.
   */
  function knownNames(/** @type {any} */ op, /** @type {string} */ destPath) {
    const cache = env.rt(op).nameMaps;
    if (cache.has(destPath)) return cache.get(destPath);
    const promise = (async () => {
      try {
        if (destPath !== op.destFolder) {
          const parent = parentPath(destPath) ?? "";
          const parentNames = await knownNames(op, parent);
          if (!parentNames) return null;
          const leaf = destPath.slice(parent ? parent.length + 1 : 0);
          if (parentNames.get(leaf) !== "dir") return new Map();
        }
        const entries = await op.source.listDir(op.driveId, destPath);
        const map = new Map();
        for (const e of Array.isArray(entries) ? entries : []) {
          if (e?.name) map.set(e.name, e.kind === "dir" ? "dir" : "file");
        }
        return map;
      } catch {
        return null;
      }
    })();
    cache.set(destPath, promise);
    return promise;
  }

  // -- starting an operation ---------------------------------------------------

  function start(/** @type {any} */ op, /** @type {{ dropped?: any, files?: File[] }} */ { dropped, files }) {
    const droppedCount = dropped ? (dropped.entries?.length || 0) + (dropped.files?.length || 0) : 0;
    const count = files ? files.length : droppedCount;

    if (op.source.isFile && count > 1) {
      env.patchOp(op, { error: text.singleFileLink, state: "failed" });
      env.settle(op);
      return;
    }

    // The name shown in the pill: a lone file, or the folder that was dropped.
    if (files && files.length) {
      const firstSegments = new Set(files.map((f) => String(f.webkitRelativePath || "").split("/")[0]));
      const allNested = files.every((f) => String(f.webkitRelativePath || "").includes("/"));
      if (allNested && firstSegments.size === 1) {
        op.title = [...firstSegments][0];
        op.rootFolder = true;
      } else if (files.length === 1) {
        op.title = files[0].name;
      }
    } else if (dropped && droppedCount === 1) {
      if (dropped.entries?.length === 1) {
        op.title = dropped.entries[0].name;
        op.rootFolder = !!dropped.entries[0].isDirectory;
      } else {
        op.title = dropped.files[0].name;
      }
    }

    if (files) {
      for (const file of files) {
        const { dir, name } = splitRel(file.webkitRelativePath || file.name);
        addFile(op, file, dir, name, file.webkitRelativePath || file.name);
      }
      env.settle(op);
      return;
    }

    const controller = new AbortController();
    env.rt(op).walkAbort = controller;
    op.walking = true;
    env.patchOp(op, {});
    walkDropped(dropped || { entries: [], files: [] }, {
      signal: controller.signal,
      onFile(file, relPath) {
        const { dir, name } = splitRel(relPath);
        addFile(op, file, dir, name, relPath);
      },
      onDir(relPath) {
        addFolder(op, relPath);
      },
      onError(relPath, err) {
        const { dir, name } = splitRel(relPath);
        void err; // the person can't act on the browser's reason; the row says what happened
        const item = env.makeItem({
          name,
          relPath,
          destPath: dir ? joinPath(op.destFolder, dir) : op.destFolder,
          state: "failed",
          error: text.unreadable,
          retryable: false,
        });
        env.addItem(op, item);
        env.notify(op, "error");
      },
    })
      .catch(() => {})
      .finally(() => {
        op.walking = false;
        env.settle(op);
      });
  }

  function addFile(
    /** @type {any} */ op,
    /** @type {File} */ file,
    /** @type {string} */ dir,
    /** @type {string} */ name,
    /** @type {string} */ relPath,
  ) {
    const item = env.makeItem({
      name,
      relPath,
      destPath: dir ? joinPath(op.destFolder, dir) : op.destFolder,
      size: file.size,
      file,
      conflict: null,
    });
    env.addItem(op, item);
    env.settle(op);
    void prepare(op, item);
  }

  /** Empty folders become real folders on Luna (every missing level). */
  function addFolder(/** @type {any} */ op, /** @type {string} */ relPath) {
    const { dir, name } = splitRel(relPath);
    const item = env.makeItem({
      name,
      relPath,
      destPath: dir ? joinPath(op.destFolder, dir) : op.destFolder,
      isDir: true,
      state: "running",
    });
    env.addItem(op, item);
    env.settle(op);
    void makeFolders(op, item, relPath);
  }

  async function makeFolders(/** @type {any} */ op, /** @type {any} */ item, /** @type {string} */ relPath) {
    const parts = relPath.split("/").filter(Boolean);
    let path = op.destFolder;
    try {
      for (const part of parts) {
        path = joinPath(path, part);
        try {
          await op.source.mkdir(op.driveId, path);
        } catch (err) {
          const e = /** @type {any} */ (err);
          // "Already there" is what we wanted.
          if (e?.status === 409 || /already/i.test(String(e?.message || ""))) continue;
          throw err;
        }
      }
      env.noteFolder(op, parentPath(path) ?? "");
      env.patchItem(op, item, { state: "done" });
    } catch (err) {
      const c = classifyError(err, op.kind);
      env.patchItem(op, item, { state: "failed", error: c.message, retryable: c.retryable, offline: c.offline });
      env.notify(op, "error");
    }
    env.settle(op);
  }

  // -- name check and queueing -------------------------------------------------

  async function prepare(/** @type {any} */ op, /** @type {any} */ item) {
    if (!op.source.isFile) {
      const names = await knownNames(op, item.destPath);
      if (item.state !== "queued") return; // cancelled meanwhile
      const hit = names?.get(item.name);
      if (hit) {
        clash(op, item, hit);
        return;
      }
    }
    enqueue(op, item);
  }

  function enqueue(/** @type {any} */ op, /** @type {any} */ item) {
    ready.push({ op, item });
    pump();
  }

  /** A clash, found early or answered by the server. The policy decides without asking. */
  function clash(
    /** @type {any} */ op,
    /** @type {any} */ item,
    /** @type {"file"|"dir"} */ existingKind,
    /** @type {{ completeOnly?: boolean, uploadId?: string|null }} */ session = {},
  ) {
    const decision = existsDecision(existingKind);
    if (session.completeOnly) {
      item.completeOnly = true;
      item.uploadId = session.uploadId;
    }
    if (op.policy && decision.options.includes(op.policy)) {
      apply(op, item, op.policy);
      return;
    }
    env.patchItem(op, item, { state: "needs-decision", decision, error: null, retrying: false });
    env.notify(op, "warning");
    env.settle(op);
  }

  function apply(/** @type {any} */ op, /** @type {any} */ item, /** @type {string} */ choice) {
    if (choice === "skip") {
      endSession(op, item);
      env.patchItem(op, item, { state: "skipped", decision: null });
      env.settle(op);
      return;
    }
    env.patchItem(op, item, {
      state: "queued",
      decision: null,
      conflict: choice === "replace" ? "replace" : "keep_both",
    });
    enqueue(op, item);
  }

  /** A chunked upload whose bytes are on Luna but won't be used: drop the session. */
  function endSession(/** @type {any} */ op, /** @type {any} */ item) {
    if (item.uploadId && item.completeOnly) {
      void Promise.resolve(op.source.cancelUpload?.(op.driveId, item.uploadId)).catch(() => {});
    }
    item.uploadId = null;
    item.completeOnly = false;
  }

  // -- the pool ---------------------------------------------------------------

  function pump() {
    while (active < UPLOAD_PARALLEL && ready.length) {
      const entry = ready.shift();
      if (!entry || entry.item.state !== "queued") continue;
      if (!env.isAlive(entry.op)) continue;
      active += 1;
      void run(entry.op, entry.item).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function run(/** @type {any} */ op, /** @type {any} */ item) {
    const controller = new AbortController();
    const completeOnly = !!item.completeOnly;
    env.patchItem(op, item, {
      state: completeOnly ? "finishing" : "uploading",
      abort: controller,
      error: null,
      retrying: false,
    });
    const size = item.size || 0;
    try {
      /** @type {any} */
      let entry;
      if (completeOnly) {
        if (typeof op.source.completeUpload !== "function") throw new Error("This link can't finish an upload.");
        entry = await op.source.completeUpload(op.driveId, item.uploadId, item.conflict);
      } else {
        entry = await op.source.uploadFile(op.driveId, item.file, item.destPath, item.name, {
          signal: controller.signal,
          onConflict: item.conflict || undefined,
          onSession: (/** @type {string} */ id) => {
            item.uploadId = id;
          },
          onProgress: (/** @type {number} */ loaded) => {
            const received = Math.min(loaded, size);
            const finishing = size > 0 && received >= size;
            env.patchItem(op, item, {
              received,
              retrying: false,
              ...(finishing && item.state === "uploading" ? { state: "finishing" } : {}),
            });
          },
          onRetry: () => env.patchItem(op, item, { retrying: true }, { urgent: true }),
        });
      }
      env.noteFolder(op, item.destPath);
      env.patchItem(op, item, {
        state: "done",
        received: size,
        abort: null,
        uploadId: null,
        completeOnly: false,
        retrying: false,
        finalName: typeof entry?.name === "string" ? entry.name : item.name,
      });
    } catch (err) {
      handleError(op, item, err);
    }
    env.settle(op);
  }

  function handleError(/** @type {any} */ op, /** @type {any} */ item, /** @type {unknown} */ err) {
    if (item.state === "cancelled") return;
    if (isAbort(err)) {
      env.patchItem(op, item, { state: "cancelled", abort: null });
      return;
    }
    const e = /** @type {any} */ (err);
    const c = classifyError(err, op.kind);
    if (c.decision?.type === "exists" && !op.source.isFile) {
      env.patchItem(op, item, { abort: null, retrying: false });
      clash(op, item, c.decision.existingKind, {
        completeOnly: !!e?.completeOnly,
        uploadId: e?.uploadId ?? null,
      });
      return;
    }
    env.patchItem(op, item, {
      state: "failed",
      abort: null,
      retrying: false,
      error: c.message,
      retryable: c.retryable,
      offline: c.offline,
    });
    env.notify(op, "error");
  }

  // -- the store's actions -----------------------------------------------------

  return {
    start,

    decide(/** @type {any} */ op, /** @type {any} */ item, /** @type {string} */ choice) {
      apply(op, item, choice);
    },

    retry(/** @type {any} */ op, /** @type {any[]} */ targets) {
      for (const item of targets) {
        if (item.isDir) {
          env.patchItem(op, item, { state: "running", error: null, offline: false });
          void makeFolders(op, item, item.relPath);
          continue;
        }
        if (!item.file) continue;
        item.uploadId = null;
        item.completeOnly = false;
        env.patchItem(op, item, {
          state: "queued",
          error: null,
          offline: false,
          received: 0,
        });
        enqueue(op, item);
      }
      env.settle(op);
    },

    cancel(/** @type {any} */ op, /** @type {any|undefined} */ item = undefined) {
      const stop = (/** @type {any} */ it) => {
        if (it.state === "uploading" || it.state === "finishing") {
          env.patchItem(op, it, { state: "cancelled" });
          it.abort?.abort();
        } else if (it.state === "queued") {
          env.patchItem(op, it, { state: "cancelled" });
        } else if (it.state === "needs-decision") {
          endSession(op, it);
          env.patchItem(op, it, { state: "cancelled", decision: null });
        } else if (it.state === "failed") {
          endSession(op, it);
        }
      };
      if (item) {
        stop(item);
        return;
      }
      env.rt(op).walkAbort?.abort();
      op.walking = false;
      for (const it of op.items) stop(it);
    },

    hasWork() {
      return env.ops.some(
        (op) =>
          (op.kind === "upload" || op.kind === "gallery") &&
          (op.walking ||
            op.items.some((i) => ["queued", "uploading", "finishing", "needs-decision"].includes(i.state))),
      );
    },

    /** Chunked sessions still open on Luna, for the `pagehide` clean-up. */
    sessions() {
      const out = [];
      for (const op of env.ops) {
        if (op.kind !== "upload" && op.kind !== "gallery") continue;
        for (const item of op.items) {
          if (item.uploadId && ["uploading", "finishing", "needs-decision"].includes(item.state)) {
            out.push({ source: op.source, driveId: op.driveId, uploadId: item.uploadId });
          }
        }
      }
      return out;
    },
  };
}
