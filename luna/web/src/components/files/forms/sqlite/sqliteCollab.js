/**
 * Live editing for a SQLite database, on the same collab hub as text files.
 *
 * Every change to the database is a statement. Statements go into a shared,
 * append-only log (a Yjs array, synced by `CollabDocSync`), and every
 * person's copy of the database is the file they opened plus that log
 * replayed in order. Yjs gives everyone the same order, so everyone ends up
 * with the same database.
 *
 * A change you make runs on your copy first, so it feels instant, and joins
 * the log only once it worked. If another person's change lands ahead of
 * yours in the log, your copy no longer matches the log's order, and it is
 * rebuilt from the opened file plus the whole log.
 *
 * Each step carries the time it ran at, and replays with SQLite's clock
 * stopped there, so `CURRENT_TIMESTAMP` and column defaults match everywhere.
 * A transaction is shared as one unit when it commits (nothing at all when it
 * rolls back). An edit too big for one message is split into pieces that the
 * log reassembles.
 *
 * Saving still writes the whole file. The saver records which log entry the
 * file covers and its new revision in a shared map, so people who open the
 * database later start from the right place and nobody gets a false
 * "changed on the drive" conflict.
 */

import * as Y from "yjs";
import { firstVerb, splitStatements, statementMutates } from "./sqliteModel.js";

const LOG_KEY = "sqliteLog";
const META_KEY = "sqliteMeta";
/** The hub drops frames over 256 KB; keep a safe margin for the envelope. */
export const MAX_ENTRY_BYTES = 150 * 1024;
/** Size of one piece of an entry that is too big for a single message. */
const PIECE_CHARS = 100 * 1024;
/** The most one edit (or one transaction) may add to the shared log. */
export const MAX_SHARED_BYTES = 8 * 1024 * 1024;

/**
 * Savepoints nest, which one flat log entry can't express.
 * @param {{ verb: string, statement: string }} step
 */
function isSavepoint(step) {
  return (
    step.verb === "SAVEPOINT" ||
    step.verb === "RELEASE" ||
    (step.verb === "ROLLBACK" && /\bTO\b/i.test(step.statement))
  );
}

/**
 * Doc adapter for `CollabDocSync`. The file is never put into the doc, so
 * seeding does nothing; the doc starts empty and only the log fills it.
 *
 * @returns {import("../../collabDocSync.js").DocAdapter}
 */
export function sqliteLogAdapter() {
  return {
    isEmpty: (ydoc) =>
      ydoc.getArray(LOG_KEY).length === 0 && ydoc.getMap(META_KEY).size === 0,
    seed: () => {},
    serialize: (ydoc) => String(ydoc.getArray(LOG_KEY).length),
    matchesSeed: () => true,
    clear: () => {},
  };
}

/** @returns {string} */
function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One statement and the time it ran at (ms).
 * @typedef {{ sql: string, params?: any[], t: number }} Step
 */
/**
 * One shared edit. `atomic` entries are a committed transaction: they replay
 * inside BEGIN/COMMIT so they land all or nothing.
 * @typedef {{ id: string, steps: Step[], atomic: boolean }} LogEntry
 */

/** @param {Uint8Array} bytes */
function toB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** @param {string} b64 */
function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The text form of an entry's steps, with blobs as base64 so it can be cut
 * into pieces.
 * @param {{ steps: Step[], atomic: boolean }} body
 */
function encodeBody(body) {
  return JSON.stringify(body, (_key, value) =>
    value instanceof Uint8Array ? { $blob: toB64(value) } : value,
  );
}

/** @param {string} text @returns {{ steps: Step[], atomic: boolean }} */
function decodeBody(text) {
  return JSON.parse(text, (_key, value) =>
    value && typeof value === "object" && typeof value.$blob === "string"
      ? fromB64(value.$blob)
      : value,
  );
}

/**
 * Turn the raw log items into whole entries. An entry sent in pieces counts
 * once its last piece arrives, and sits where that piece sits, so every copy
 * orders it the same way.
 *
 * @param {any[]} items
 * @returns {LogEntry[]}
 */
export function readEntries(items) {
  /** @type {LogEntry[]} */
  const entries = [];
  /** @type {Map<string, { n: number, parts: Map<number, string> }>} */
  const partial = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    if (Array.isArray(item.steps)) {
      entries.push({ id: item.id, steps: item.steps, atomic: Boolean(item.atomic) });
      continue;
    }
    if (typeof item.data !== "string" || !Number.isInteger(item.i) || !Number.isInteger(item.n)) {
      continue;
    }
    let group = partial.get(item.id);
    if (!group) {
      group = { n: item.n, parts: new Map() };
      partial.set(item.id, group);
    }
    group.parts.set(item.i, item.data);
    if (group.parts.size < group.n) continue;
    try {
      let text = "";
      for (let i = 0; i < group.n; i += 1) text += group.parts.get(i) ?? "";
      const body = decodeBody(text);
      entries.push({ id: item.id, steps: body.steps, atomic: Boolean(body.atomic) });
    } catch {
      // A damaged edit is skipped by everyone alike.
    }
    partial.delete(item.id);
  }
  return entries;
}

/** @param {Step} step */
function stepBytes(step) {
  return encodeBody({ steps: [step], atomic: false }).length;
}

/**
 * @typedef {object} InnerClient
 * @property {(bytes: Uint8Array, options?: { readOnly?: boolean }) => Promise<any>} open
 * @property {(sql: string, params?: any[], now?: number) => Promise<any>} exec
 * @property {(sql: string, params?: any[], readOnly?: boolean, now?: number) => Promise<any>} apply
 * @property {() => Promise<any>} schema
 * @property {() => Promise<Uint8Array>} exportBytes
 * @property {() => Promise<void>} close
 * @property {() => void} dispose
 */

export class CollabSqliteClient {
  /**
   * @param {InnerClient} inner the worker-backed client
   * @param {{
   *   ydoc: Y.Doc,
   *   revision: number | string,
   *   onRemoteChange?: (info: { rebuilt: boolean }) => void,
   *   onPeerSaved?: (info: { revision: string, covered: boolean }) => void,
   * }} options `revision` is the file revision the opened bytes came from.
   */
  constructor(inner, { ydoc, revision, onRemoteChange, onPeerSaved }) {
    this.inner = inner;
    this.ydoc = ydoc;
    this.log = ydoc.getArray(LOG_KEY);
    this.meta = ydoc.getMap(META_KEY);
    this.revision = String(revision ?? "");
    this.onRemoteChange = onRemoteChange;
    this.onPeerSaved = onPeerSaved;
    /** The file as opened — the starting point for a rebuild. */
    this.base = new Uint8Array(0);
    this.readOnly = false;
    /** Log entries before and including this id are already in `base`. */
    this.startId = /** @type {string | null} */ (null);
    /** Ids of the entries this copy's database has run, in order. */
    this.applied = /** @type {string[]} */ ([]);
    /** The last applied id at the moment of the latest export. */
    this.exportMark = /** @type {string | null} */ (null);
    /** A transaction this person has open: its steps wait for COMMIT. */
    this.txn = /** @type {{ steps: Step[], bytes: number } | null} */ (null);
    this.chain = Promise.resolve();
    this.disposed = false;
    this.opened = false;
    /** True when the file on the drive is not the one the log was built on. */
    this.stale = false;

    this._onLog = () => {
      if (this.opened) void this._reconcile();
    };
    this._onMeta = (_event, transaction) => {
      if (transaction.local || !this.opened) return;
      this._handlePeerSaved();
    };
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  _serial(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @returns {LogEntry[]} every whole entry in the log */
  _allEntries() {
    return readEntries(this.log.toArray());
  }

  /** @returns {LogEntry[]} entries this copy is responsible for replaying */
  _pendingEntries() {
    const all = this._allEntries();
    const at = this.startId ? all.findIndex((entry) => entry.id === this.startId) : -1;
    return at >= 0 ? all.slice(at + 1) : all;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{ readOnly?: boolean }} [options]
   */
  async open(bytes, options = {}) {
    this.readOnly = Boolean(options.readOnly);
    this.base = bytes.slice();
    const opened = await this.inner.open(bytes, options);

    const savedRevision = this.meta.get("revision");
    const savedThrough = this.meta.get("savedThrough");
    const existing = this._allEntries();
    if (savedRevision === undefined) {
      // Nobody has saved in this room: the file is the log's starting point.
      this.startId = null;
    } else if (savedRevision === "" || savedRevision === this.revision) {
      this.startId = typeof savedThrough === "string" ? savedThrough : null;
    } else {
      // The file changed outside the room. Replaying the log onto it would
      // be wrong, so this copy only follows changes made from now on.
      this.stale = true;
      this.startId = existing.length ? existing[existing.length - 1].id : null;
    }

    this.opened = true;
    this.log.observe(this._onLog);
    this.meta.observe(this._onMeta);
    await this._serial(() => this._replay(false));
    return this._withSchema(opened);
  }

  /** @param {any} opened */
  async _withSchema(opened) {
    if (!this.applied.length) return opened;
    return { ...opened, tables: (await this.inner.schema()).tables };
  }

  /**
   * Run entries the copy has not applied yet, or rebuild when its history no
   * longer matches the log's order. Must run inside `_serial`.
   *
   * @param {boolean} notify tell the editor when other people's entries ran
   */
  async _replay(notify) {
    // Someone else's edits wait until this person's open transaction ends.
    if (this.txn) return;
    const entries = this._pendingEntries();
    const ids = entries.map((entry) => entry.id);
    const isPrefix = this.applied.every((id, index) => ids[index] === id);
    let rebuilt = false;
    let from = this.applied.length;
    if (!isPrefix) {
      await this.inner.open(this.base.slice(), { readOnly: this.readOnly });
      this.applied = [];
      from = 0;
      rebuilt = true;
    }
    const fresh = entries.slice(from);
    for (const entry of fresh) {
      await this._applyEntry(entry);
      this.applied.push(entry.id);
    }
    if (notify && (fresh.length || rebuilt)) this.onRemoteChange?.({ rebuilt });
  }

  /** @param {LogEntry} entry */
  async _applyEntry(entry) {
    // A step that fails here failed the same way for the person who sent it,
    // so everyone skips it and stays in step.
    const run = async (/** @type {Step} */ step) => {
      await this.inner.apply(step.sql, step.params, this.readOnly, step.t);
    };
    if (!entry.atomic) {
      for (const step of entry.steps) await run(step).catch(() => {});
      return;
    }
    const at = entry.steps[0]?.t;
    try {
      await this.inner.apply("BEGIN", undefined, this.readOnly, at);
      for (const step of entry.steps) await run(step);
      await this.inner.apply("COMMIT", undefined, this.readOnly, at);
    } catch {
      await this.inner.apply("ROLLBACK", undefined, this.readOnly, at).catch(() => {});
    }
  }

  _reconcile() {
    return this._serial(() => this._replay(true));
  }

  /**
   * @param {string} sql
   * @param {any[]} [params]
   */
  exec(sql, params) {
    return this._serial(async () => {
      const statements = Array.isArray(params) ? [String(sql)] : splitStatements(sql);
      const plan = statements.map((statement) => ({
        statement,
        mutates: statementMutates(statement),
        verb: firstVerb(statement),
      }));
      if (!plan.some((step) => step.mutates)) return this.inner.exec(sql, params);

      const t = Date.now();
      let size = this.txn?.bytes ?? 0;
      for (const step of plan) {
        if (!step.mutates) continue;
        if (isSavepoint(step)) {
          throw new Error(
            "Savepoints aren't available while editing together. Use BEGIN and COMMIT instead.",
          );
        }
        size += stepBytes({ sql: step.statement, ...(params ? { params } : {}), t });
      }
      if (size > MAX_SHARED_BYTES) {
        throw new Error(
          "This change is too large to share live. Split it into smaller steps.",
        );
      }

      /** Entries for the first `count` statements, updating the open transaction. */
      const track = (/** @type {number} */ count) => {
        /** @type {LogEntry[]} */
        const out = [];
        for (const step of plan.slice(0, count)) {
          if (!step.mutates) continue;
          if (step.verb === "BEGIN") {
            this.txn = { steps: [], bytes: 0 };
          } else if (step.verb === "COMMIT" || step.verb === "END") {
            if (this.txn?.steps.length) {
              out.push({ id: newId(), steps: this.txn.steps, atomic: true });
            }
            this.txn = null;
          } else if (step.verb === "ROLLBACK") {
            this.txn = null;
          } else {
            /** @type {Step} */
            const logged = {
              sql: step.statement,
              ...(Array.isArray(params) ? { params } : {}),
              t,
            };
            if (this.txn) {
              this.txn.steps.push(logged);
              this.txn.bytes += stepBytes(logged);
            } else {
              out.push({ id: newId(), steps: [logged], atomic: false });
            }
          }
        }
        return out;
      };

      const hadTransaction = Boolean(this.txn);
      /** @param {LogEntry[]} entries */
      const finish = (entries) => {
        this._record(entries);
        // Edits from others that waited for the transaction can run now.
        if (hadTransaction && !this.txn) void this._reconcile();
      };

      try {
        const result = await this.inner.exec(sql, params, t);
        finish(track(plan.length));
        return result;
      } catch (error) {
        // A script stops at its first failing statement and keeps what ran
        // before it. Share that part, or other people's copies would miss it.
        const failedAt = Number(/^Statement (\d+):/.exec(String(error?.message))?.[1]);
        if (failedAt > 1) finish(track(failedAt - 1));
        throw error;
      }
    });
  }

  /** @param {LogEntry[]} entries */
  _record(entries) {
    if (!entries.length) return;
    for (const entry of entries) {
      this.applied.push(entry.id);
      const text = encodeBody({ steps: entry.steps, atomic: entry.atomic });
      if (text.length <= MAX_ENTRY_BYTES) {
        this.log.push([{ id: entry.id, steps: entry.steps, atomic: entry.atomic }]);
        continue;
      }
      // Too big for one message: send it in pieces, each its own update.
      const total = Math.ceil(text.length / PIECE_CHARS);
      for (let i = 0; i < total; i += 1) {
        this.log.push([
          { id: entry.id, i, n: total, data: text.slice(i * PIECE_CHARS, (i + 1) * PIECE_CHARS) },
        ]);
      }
    }
  }

  schema() {
    return this._serial(() => this.inner.schema());
  }

  /** The database as one file, plus a note of which log entry it covers. */
  exportBytes() {
    return this._serial(async () => {
      const bytes = await this.inner.exportBytes();
      this.exportMark = this.applied.length
        ? this.applied[this.applied.length - 1]
        : this.startId;
      return bytes;
    });
  }

  /**
   * The file was written. Tell the room which entry it covers so people who
   * open the database later start from there, and so peers move their
   * "unsaved" state and revision forward.
   *
   * @param {number | string} revision the file's revision after the save
   */
  markSaved(revision) {
    this.revision = String(revision ?? "");
    this.ydoc.transact(() => {
      this.meta.set("revision", this.revision);
      this.meta.set("savedThrough", this.exportMark);
    });
  }

  /** True when this copy has run every entry the latest save covers. */
  coveredBySave() {
    const through = this.meta.get("savedThrough");
    const last = this.applied.length ? this.applied[this.applied.length - 1] : this.startId;
    return (through ?? null) === (last ?? null);
  }

  _handlePeerSaved() {
    const revision = String(this.meta.get("revision") ?? "");
    if (revision) this.revision = revision;
    this.onPeerSaved?.({ revision, covered: this.coveredBySave() });
  }

  async close() {
    this._detach();
    await this.inner.close();
  }

  dispose() {
    this._detach();
    this.inner.dispose();
  }

  _detach() {
    if (this.disposed) return;
    this.disposed = true;
    this.log.unobserve(this._onLog);
    this.meta.unobserve(this._onMeta);
  }
}
