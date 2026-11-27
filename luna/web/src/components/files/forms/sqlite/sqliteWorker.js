/**
 * sql.js worker for the forms database editor.
 *
 * The main thread sends one request at a time; this file owns the single
 * SQLite database and answers with plain structured-clone data. Requests are
 * chained so a slow `export` can never overtake an `exec` that started first.
 *
 * Protocol:
 *   open { bytes }            → { tables }   (bytes is a Uint8Array/ArrayBuffer)
 *   exec { sql, params?, now? } → { columns, rows, rowCount, changes, truncated }
 *   apply { sql, params?, now? } → { changes }  (a shared edit from another
 *                               person: runs even on a read-only copy)
 *   schema                    → { tables }
 *   export                    → { bytes }    (transferred)
 *   close                     → {}
 *
 * `tables` entries: { name, columns, primaryKey, rowCount }, where each
 * column is { name, type, notNull, defaultValue, pk, hidden, generated }.
 */

import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  MAX_RESULT_BYTES,
  MAX_RESULT_ROWS,
  valueBytes,
  capResult,
  classifyStatement,
  splitStatements,
  statementMutates,
} from "./sqliteModel.js";
import { quoteIdent } from "./sqliteSql.js";

const scope = /** @type {any} */ (self);

/** @type {Promise<any> | null} */
let sqlPromise = null;
/** @type {any} */
let database = null;

function loadSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl }).catch((error) => {
      sqlPromise = null;
      throw error;
    });
  }
  return sqlPromise;
}

/** @param {unknown} bytes */
function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(0);
}

/** @param {any} db */
function readSchema(db) {
  const tablesResult = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE",
  );
  const names = tablesResult[0]?.values?.map((row) => String(row[0])) ?? [];
  return names.map((name) => readTable(db, name));
}

/** @param {any} db @param {string} name */
function readTable(db, name) {
  const quoted = quoteIdent(name);
  let info;
  try {
    info = db.exec(`PRAGMA table_xinfo(${quoted})`);
  } catch {
    // Older SQLite builds know table_info but not table_xinfo.
    info = db.exec(`PRAGMA table_info(${quoted})`);
  }
  const rows = info[0]?.values ?? [];
  const columns = rows
    .map((row) => {
      const hidden = Number(row[6] ?? 0);
      return {
        name: String(row[1]),
        type: row[2] ? String(row[2]) : "",
        notNull: Boolean(row[3]),
        defaultValue: row[4] == null ? null : String(row[4]),
        pk: Number(row[5] ?? 0),
        hidden: hidden === 1,
        generated: hidden === 2 || hidden === 3,
      };
    })
    // Hidden virtual-table columns are absent from SELECT *, so leaving them
    // in the schema would shift every cell one place.
    .filter((column) => !column.hidden);
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  let rowCount = 0;
  try {
    const count = db.exec(`SELECT COUNT(*) FROM ${quoted}`);
    rowCount = Number(count[0]?.values?.[0]?.[0] ?? 0);
  } catch {
    rowCount = 0;
  }
  return { name, columns, primaryKey, rowCount };
}

/**
 * @param {any} db
 * @param {string} sql
 * @param {any[]} params
 */
function runPrepared(db, sql, params) {
  const kind = classifyStatement(sql);
  if (kind === "read") {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const columns = statement.getColumnNames();
      const mutates = statementMutates(sql);
      /** @type {any[][]} */
      const rows = [];
      let bytes = columns.reduce((total, name) => total + String(name).length * 2, 0);
      let truncated = false;
      while (statement.step()) {
        if (rows.length >= MAX_RESULT_ROWS) {
          truncated = true;
          if (!mutates) break;
          continue;
        }
        const row = statement.get();
        const rowBytes =
          16 +
          row.length * 8 +
          row.reduce((total, value) => total + valueBytes(value), 0);
        if (rows.length > 0 && bytes + rowBytes > MAX_RESULT_BYTES) {
          truncated = true;
          if (!mutates) break;
          continue;
        }
        if (rows.length === 0 && rowBytes > MAX_RESULT_BYTES) {
          truncated = true;
          if (!mutates) break;
          continue;
        }
        rows.push(row);
        bytes += rowBytes;
      }
      return {
        columns,
        rows,
        rowCount: rows.length,
        changes: mutates ? db.getRowsModified() : 0,
        truncated,
      };
    } finally {
      statement.free();
    }
  }
  db.run(sql, params);
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    changes: db.getRowsModified(),
    truncated: false,
  };
}

/**
 * @param {any} db
 * @param {string} sql
 * @param {any[] | undefined} params
 */
function runScript(db, sql, params) {
  if (Array.isArray(params)) return runPrepared(db, sql, params);

  const statements = splitStatements(sql);
  if (!statements.length) throw new Error("Write a query first.");

  let changes = 0;
  let truncated = false;
  let columns = [];
  /** @type {any[][]} */
  let rows = [];

  statements.forEach((statement, index) => {
    try {
      if (classifyStatement(statement) === "read") {
        // Prepare and step so the row/byte caps bound memory, not just the
        // message that goes back to the page.
        const result = runPrepared(db, statement, []);
        if (result.columns.length) {
          columns = result.columns;
          rows = result.rows;
        }
        changes += result.changes;
        if (result.truncated) truncated = true;
      } else {
        db.run(statement);
        changes += db.getRowsModified();
      }
    } catch (error) {
      const message = String(error?.message || error || "The query didn't run.");
      if (statements.length > 1) {
        throw new Error(`Statement ${index + 1}: ${message}`);
      }
      throw new Error(message);
    }
  });

  const capped = capResult(columns, rows);
  return {
    columns,
    rows: capped.rows,
    rowCount: capped.total,
    changes,
    truncated: truncated || capped.truncated,
  };
}

/**
 * Run `fn` with the clock stopped at `now` (ms). SQLite reads the time from
 * `Date.now`, so `CURRENT_TIMESTAMP`, `'now'` and column defaults all give
 * the same answer for everyone replaying one shared edit.
 *
 * @template T
 * @param {number | undefined} now
 * @param {() => T} fn
 * @returns {T}
 */
function withClock(now, fn) {
  if (typeof now !== "number" || !Number.isFinite(now)) return fn();
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** @param {{ type: string, bytes?: any, sql?: string, params?: any[], readOnly?: boolean, now?: number }} message */
async function handle(message) {
  switch (message.type) {
    case "open": {
      const SQL = await loadSql();
      if (database) {
        database.close();
        database = null;
      }
      const bytes = toBytes(message.bytes);
      if (!bytes.byteLength) throw new Error("This database is empty.");
      database = new SQL.Database(bytes);
      // The server opens every form database with foreign keys on; the
      // browser must match, or deleting a response leaves its answers.
      database.run("PRAGMA foreign_keys = ON");
      // Read-only is enforced by SQLite, not just by the statement
      // classifier. A classifier miss must never write to a Read member's
      // copy.
      if (message.readOnly) database.run("PRAGMA query_only = ON");
      const tables = readSchema(database);
      return { tables };
    }
    case "exec": {
      if (!database) throw new Error("No database is open.");
      const db = database;
      return withClock(message.now, () =>
        runScript(db, String(message.sql || ""), message.params),
      );
    }
    case "apply": {
      if (!database) throw new Error("No database is open.");
      // Edits other people made arrive here. A read-only copy must still
      // show them, so lift query_only for exactly this call.
      const lifted = Boolean(message.readOnly);
      if (lifted) database.run("PRAGMA query_only = OFF");
      try {
        const db = database;
        const result = withClock(message.now, () =>
          runScript(db, String(message.sql || ""), message.params),
        );
        return { changes: result.changes };
      } finally {
        if (lifted) database.run("PRAGMA query_only = ON");
      }
    }
    case "schema": {
      if (!database) throw new Error("No database is open.");
      return { tables: readSchema(database) };
    }
    case "export": {
      if (!database) throw new Error("No database is open.");
      const bytes = database.export();
      return { bytes };
    }
    case "close": {
      if (database) {
        database.close();
        database = null;
      }
      return {};
    }
    default:
      throw new Error("Unknown database request.");
  }
}

let chain = Promise.resolve();

scope.onmessage = (event) => {
  const request = event?.data || {};
  const { id } = request;
  chain = chain
    .then(() => handle(request))
    .then((result) => {
      const transfer = result?.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
      scope.postMessage({ id, ok: true, result }, transfer);
    })
    .catch((error) => {
      scope.postMessage({
        id,
        ok: false,
        error: String(error?.message || error || "The database editor stopped."),
      });
    });
};
