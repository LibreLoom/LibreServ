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

const TRANSACTION_VERBS = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

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
 * @typedef {{ id: string, sql: string, params?: any[] }} LogEntry
 */

/**
 * @typedef {object} InnerClient
 * @property {(bytes: Uint8Array, options?: { readOnly?: boolean }) => Promise<any>} open
 * @property {(sql: string, params?: any[]) => Promise<any>} exec
 * @property {(sql: string, params?: any[], readOnly?: boolean) => Promise<any>} apply
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

  /** @returns {LogEntry[]} entries this copy is responsible for replaying */
  _pendingEntries() {
    const all = /** @type {LogEntry[]} */ (this.log.toArray());
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
    const existing = /** @type {LogEntry[]} */ (this.log.toArray());
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
      try {
        await this.inner.apply(entry.sql, entry.params, this.readOnly);
      } catch {
        // A statement that fails here failed the same way for the person who sent it,
        // so everyone skips it and stays in step.
      }
      this.applied.push(entry.id);
    }
    if (notify && (fresh.length || rebuilt)) this.onRemoteChange?.({ rebuilt });
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
      }));
      if (!plan.some((step) => step.mutates)) return this.inner.exec(sql, params);

      for (const step of plan) {
        if (step.mutates && TRANSACTION_VERBS.has(firstVerb(step.statement))) {
          throw new Error(
            "Transactions aren't available while editing together. Run each change on its own.",
          );
        }
      }
      /** @param {number} count statements that ran, from the start */
      const entriesFor = (count) =>
        plan
          .slice(0, count)
          .filter((step) => step.mutates)
          .map((step) => ({
            id: newId(),
            sql: step.statement,
            ...(Array.isArray(params) ? { params } : {}),
          }));
      const entries = entriesFor(plan.length);
      if (entries.some((entry) => JSON.stringify(entry).length > MAX_ENTRY_BYTES)) {
        throw new Error(
          "This change is too large to share live. Split it into smaller steps.",
        );
      }

      try {
        const result = await this.inner.exec(sql, params);
        this._record(entries);
        return result;
      } catch (error) {
        // A script stops at its first failing statement and keeps what ran
        // before it. Share that part, or other people's copies would miss it.
        const failedAt = Number(/^Statement (\d+):/.exec(String(error?.message))?.[1]);
        if (failedAt > 1) this._record(entriesFor(failedAt - 1));
        throw error;
      }
    });
  }

  /** @param {LogEntry[]} entries */
  _record(entries) {
    if (!entries.length) return;
    for (const entry of entries) this.applied.push(entry.id);
    this.log.push(entries);
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
