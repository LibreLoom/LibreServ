/**
 * Main-thread half of the SQLite worker protocol.
 *
 * One request is in flight per call; the worker serialises them. Every
 * rejection carries the plain message the worker produced, so callers can
 * show it without unwrapping anything.
 */

/** @typedef {{
 *   tables: any[],
 * }} SchemaResult
 *
 * @typedef {{
 *   columns: string[],
 *   rows: any[][],
 *   rowCount: number,
 *   changes: number,
 *   truncated: boolean,
 * }} ExecResult
 */

function defaultWorkerFactory() {
  if (typeof Worker === "undefined") {
    throw new Error("This browser can't run the database editor. Try a newer browser.");
  }
  return new Worker(new URL("./sqliteWorker.js", import.meta.url), {
    type: "module",
  });
}

export class SqliteClient {
  /**
   * @param {() => Worker} [workerFactory]
   */
  constructor(workerFactory = defaultWorkerFactory) {
    this.worker = workerFactory();
    this.nextId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    this.closed = false;

    this.worker.addEventListener("message", (event) => {
      const message = event.data || {};
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.ok) {
        waiting.resolve(message.result);
      } else {
        waiting.reject(new Error(message.error || "The database editor stopped."));
      }
    });

    this.worker.addEventListener("error", (event) => {
      const error = new Error(
        event?.message || "The database editor stopped. Reload the form to try again.",
      );
      this.rejectAll(error);
      this.dispose();
    });
    this.worker.addEventListener("messageerror", () => {
      this.rejectAll(new Error("The database editor couldn't read its own reply."));
      this.dispose();
    });
  }

  /** @param {Error} error */
  rejectAll(error) {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  /**
   * @param {string} type
   * @param {Record<string, any>} [payload]
   * @param {Transferable[]} [transfer]
   * @returns {Promise<any>}
   */
  request(type, payload = {}, transfer = []) {
    if (this.closed) {
      return Promise.reject(new Error("The database editor is closed."));
    }
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** @param {Uint8Array} bytes @returns {Promise<SchemaResult>} */
  open(bytes, { readOnly = false } = {}) {
    // Copy before transferring: detaching the caller's array would be a
    // surprise to whoever passed it in.
    const copy = bytes.slice();
    return this.request("open", { bytes: copy, readOnly }, [copy.buffer]);
  }

  /**
   * @param {string} sql
   * @param {any[]} [params]
   * @param {number} [now] stop SQLite's clock at this time (ms) while it runs
   * @returns {Promise<ExecResult>}
   */
  exec(sql, params, now) {
    const payload = { sql, ...(params ? { params } : {}), ...(now != null ? { now } : {}) };
    return this.request("exec", payload);
  }

  /**
   * Replay an edit someone else made. Unlike `exec` it also runs on a
   * read-only copy, so viewers still see live changes.
   *
   * @param {string} sql
   * @param {any[]} [params]
   * @param {boolean} [readOnly] true when this copy was opened read-only
   * @param {number} [now] stop SQLite's clock at this time (ms) while it runs
   * @returns {Promise<{ changes: number }>}
   */
  apply(sql, params, readOnly = false, now) {
    const payload = {
      sql,
      readOnly,
      ...(params ? { params } : {}),
      ...(now != null ? { now } : {}),
    };
    return this.request("apply", payload);
  }

  /** @returns {Promise<SchemaResult>} */
  schema() {
    return this.request("schema");
  }

  /** @returns {Promise<Uint8Array>} */
  async exportBytes() {
    const result = await this.request("export");
    return result?.bytes instanceof Uint8Array
      ? result.bytes
      : new Uint8Array(result?.bytes || 0);
  }

  async close() {
    if (this.closed) return;
    try {
      await this.request("close");
    } finally {
      this.dispose();
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("The database editor is closed."));
    this.worker.terminate();
  }
}

export function createSqliteClient() {
  return new SqliteClient();
}
