// Stands in for lunad while you play with the file operation card: a FileSource
// and a job API that answer the way lunad does, plus the knobs the playground
// turns to make the next operation fail, clash or crawl.
//
// The wording here is copied from the Rust handlers, not invented: a fake that
// says something lunad never says teaches the wrong lesson about the card.

import { ApiError } from "../../lib/api.js";
import { parentPath, pathBasename } from "../../lib/paths.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the next upload does. Labels are the playground's; the values are the fake's. */
export const UPLOAD_MODES = [
  { value: "ok", label: "Works" },
  { value: "full", label: "Full" },
  { value: "offline", label: "Offline" },
  { value: "denied", label: "No permission" },
  { value: "busy", label: "Busy" },
  { value: "retry", label: "Retries" },
];

/** What the next copy or move does. */
export const JOB_MODES = [
  { value: "ok", label: "Works" },
  { value: "full", label: "Full" },
  { value: "queue_full", label: "Queue full" },
  { value: "exists", label: "Name taken" },
  { value: "broadens", label: "Private folder" },
  { value: "offline", label: "Offline" },
];

export function defaultBehaviour() {
  return { upload: "ok", jobs: "ok", uploadMs: 1600, jobMs: 4000, failName: null };
}

// -- errors that look like the ones api.js throws -----------------------------

/** Same shape as `api.js`'s ApiError, so `classifyError` reads it the same way. */
function apiError(status, message, code = null, data = undefined) {
  return new ApiError(status, message, code, data);
}

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

// -- files and dropped folders ------------------------------------------------

/**
 * A File with a size we choose, so a "4 GB video" costs no memory. The upload
 * runner only reads `size`, and the fake source never reads the bytes.
 * @param {string} name
 * @param {number} size
 * @param {string} [relPath] `webkitRelativePath`, for a picked or dropped folder
 */
export function fakeFile(name, size, relPath) {
  const file = new File(["x"], name, { type: "application/octet-stream" });
  try {
    Object.defineProperty(file, "size", { value: size });
    if (relPath) Object.defineProperty(file, "webkitRelativePath", { value: relPath });
  } catch {
    // A browser that freezes File: the upload still runs, just with size 0.
  }
  return file;
}

/** A dropped file the browser can read. */
export function fileEntry(name, size) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok(fakeFile(name, size)),
  };
}

/** A dropped file the browser can't read (locked, moved, or gone). */
export function badEntry(name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (_ok, err) => err(new Error("NotReadableError")),
  };
}

/** A dropped folder. No children means an empty folder, which the card counts. */
export function dirEntry(name, children = []) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let drained = false;
      return {
        readEntries: (ok) => {
          if (drained) return ok([]);
          drained = true;
          return ok(children);
        },
      };
    },
  };
}

// -- the world ----------------------------------------------------------------

/**
 * A fake lunad for the card: what is in each folder, the jobs it is running, and
 * the knobs that decide how the next operation behaves. The knobs are read on
 * every call, so turning one takes effect on the next operation without a reload.
 */
export function createFakeWorld() {
  let behaviour = defaultBehaviour();
  /** @type {Map<string, Map<string, "file"|"dir">>} folder path → what is in it */
  const names = new Map();
  /** @type {Map<string, any>} */
  const jobs = new Map();
  const clashed = new Set();
  let seq = 0;
  let timer = null;

  /** The contents of one folder, created on first use. */
  function folder(path) {
    let map = names.get(path);
    if (!map) {
      map = new Map();
      names.set(path, map);
    }
    return map;
  }

  // -- jobs -------------------------------------------------------------------

  const JOB_TICK_MS = 250;

  function tick() {
    let running = 0;
    for (const job of jobs.values()) {
      if (job.state !== "running") continue;
      running += 1;
      const perTick = job.total / Math.max(1, behaviour.jobMs / JOB_TICK_MS);
      job.progress = Math.min(job.total, job.progress + perTick);
      if (behaviour.jobs === "full" && job.progress >= job.total * 0.5) {
        job.state = "error";
        // lunad appends what it did with the partial copy; both endings are real.
        job.error =
          job.kind === "move"
            ? "Backup drive is full. Free up some space on it and try again. Nothing was moved. Your files are still where they were."
            : "Backup drive is full. Free up some space on it and try again. Luna removed the partial copy.";
      } else if (job.progress >= job.total) {
        job.state = "done";
      }
    }
    if (running === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function arm() {
    if (timer == null) timer = setInterval(tick, JOB_TICK_MS);
  }

  const api = {
    async getJson(path) {
      await sleep(40);
      if (path.startsWith("/api/v1/jobs")) return [...jobs.values()];
      throw apiError(404, "Luna doesn't know this.");
    },

    async postJson(path, body) {
      await sleep(140);
      if (path !== "/api/v1/jobs") throw apiError(404, "Luna doesn't know this.");
      const mode = behaviour.jobs;
      const key = `${body.kind}:${body.from_path}`;

      if (mode === "offline") {
        throw apiError(0, "Couldn't reach Luna. Check this device's connection and try again.");
      }
      if (mode === "queue_full" && !clashed.has("queue")) {
        clashed.add("queue");
        throw apiError(
          503,
          "Luna is already working on a lot of copies and moves. Try again when they finish.",
          "queue_full",
        );
      }
      if (mode === "exists" && !body.on_conflict && !clashed.has(key)) {
        clashed.add(key);
        throw apiError(
          409,
          "A file or folder with this name is already there. Choose a different destination.",
          "exists",
          { existing_kind: "file" },
        );
      }
      if (mode === "broadens" && !body.confirm_broaden) {
        throw apiError(
          409,
          "This is in a private folder. Moving or copying it to this folder lets everyone with access to the destination open it.",
          "broadens_access",
        );
      }

      const id = `job${(seq += 1)}`;
      const total = 48_000_000;
      jobs.set(id, { id, kind: body.kind, state: "running", total, progress: 0, error: null });
      arm();
      return { id, total, progress: 0 };
    },

    async deleteJson(path) {
      await sleep(40);
      const job = jobs.get(String(path).split("/").pop());
      if (job && job.state === "running") {
        job.state = "cancelled";
        job.error = "Cancelled.";
      }
      return {};
    },
  };

  // -- the file source --------------------------------------------------------

  const source = {
    kind: "drive",
    guest: false,
    collab: false,
    isFile: false,

    async listDir(_driveId, path) {
      await sleep(50);
      return [...folder(path)].map(([name, kind]) => ({ name, kind }));
    },

    async stat(_driveId, path) {
      await sleep(30);
      const parent = parentPath(path) ?? "";
      const kind = names.get(parent)?.get(pathBasename(path));
      if (!kind) throw apiError(404, "This file doesn't exist anymore.");
      return { kind };
    },

    async mkdir(_driveId, path) {
      await sleep(140);
      const parent = parentPath(path) ?? "";
      const leaf = pathBasename(path);
      const map = folder(parent);
      if (map.has(leaf)) {
        // The runner asks `stat` next, to tell a folder from a file of that name.
        throw apiError(409, "A folder with this name is already here. Choose another name.", "exists");
      }
      map.set(leaf, "dir");
      return {};
    },

    async remove() {
      await sleep(120);
      return {};
    },

    async uploadFile(_driveId, file, destPath, name, opts = {}) {
      const { signal, onProgress, onRetry } = opts;
      const size = file.size || 0;
      const steps = 16;
      const mode = behaviour.upload;
      let retried = false;

      for (let i = 1; i <= steps; i += 1) {
        if (signal?.aborted) throw abortError();
        await sleep(behaviour.uploadMs / steps);
        if (signal?.aborted) throw abortError();

        if (mode === "offline") {
          throw apiError(0, "Couldn't reach Luna. Check this device's connection and try again.");
        }
        if (behaviour.failName && name === behaviour.failName) {
          // One-shot: the bench must not poison every later upload of that name.
          behaviour = { ...behaviour, failName: null };
          throw apiError(500, "Luna couldn't save this file. Try again.");
        }
        if (mode === "full" && i === Math.floor(steps * 0.65)) {
          throw apiError(507, "This drive is full. Free up some space and try again.");
        }
        if (mode === "denied" && i === Math.floor(steps * 0.5)) {
          throw apiError(403, "You don't have permission to save here.");
        }
        if (mode === "busy" && i === Math.floor(steps * 0.5)) {
          throw apiError(503, "Luna's index is busy. Try again.");
        }
        if (mode === "retry" && !retried && i === Math.floor(steps * 0.4)) {
          retried = true;
          onRetry?.();
          await sleep(1400);
        }
        onProgress?.(Math.round((size * i) / steps));
      }

      folder(destPath).set(name, "file");
      return { name };
    },

    async cancelUpload() {
      return {};
    },
  };

  return {
    api,
    // The card only calls the methods above. The rest of FileSource is about
    // content URLs, editors and collab, none of which exist without lunad.
    source: /** @type {import("../../lib/fileSource.jsx").FileSource} */ (
      /** @type {unknown} */ (source)
    ),
    /** Turn a knob. Read by the next operation, not the one already running. */
    setBehaviour(patch) {
      behaviour = { ...behaviour, ...patch };
    },
    /** Put something in a folder, so the next upload of that name clashes. */
    seed(folderPath, name, kind) {
      folder(folderPath).set(name, kind);
    },
    reset() {
      names.clear();
      jobs.clear();
      clashed.clear();
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    dispose() {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
