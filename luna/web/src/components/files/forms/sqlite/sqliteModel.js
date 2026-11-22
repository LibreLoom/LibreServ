/**
 * Pure helpers for the in-browser SQLite editor: size limits, statement
 * splitting and classification, result capping, value formatting, and the
 * save-conflict test.
 *
 * Nothing here imports sql.js or DOM APIs, so the worker, the React surface,
 * and the unit tests all share one definition without loading WASM.
 */

/** The largest database the editor will open. */
export const MAX_DATABASE_BYTES = 16 * 1024 * 1024;

/** A result set is cut at this many rows … */
export const MAX_RESULT_ROWS = 500;

/** … or this many approximate bytes, whichever comes first. */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Rows per page in the table grid. */
export const GRID_PAGE_SIZE = 100;

/** @param {unknown} value */
export function isBlob(value) {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value))
  );
}

/** @param {unknown} value @returns {Uint8Array} */
export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

/** Locale-independent thousands separators, for tests and tabular numbers. */
export function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Math.trunc(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Remove leading whitespace and comments so the first word is the verb.
 * @param {string} sql
 */
function stripLeadingComments(sql) {
  let text = String(sql ?? "").trim();
  for (;;) {
    if (text.startsWith("--")) {
      const newline = text.indexOf("\n");
      if (newline < 0) return "";
      text = text.slice(newline + 1).trimStart();
      continue;
    }
    if (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      if (end < 0) return "";
      text = text.slice(end + 2).trimStart();
      continue;
    }
    return text;
  }
}

/**
 * Blank out string contents and comments so keyword tests can't match text
 * that happens to spell INSERT or RETURNING.
 * @param {string} sql
 */
function maskLiterals(sql) {
  return String(sql ?? "")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, "``")
    .replace(/\[[^\]]*\]/g, "[]")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** @param {string} sql */
function firstVerb(sql) {
  const match = stripLeadingComments(sql).match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : "";
}

const READ_VERBS = new Set(["SELECT", "VALUES", "EXPLAIN"]);
const SCHEMA_VERBS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "ATTACH",
  "DETACH",
]);
const WRITE_VERBS = new Set([
  "INSERT",
  "REPLACE",
  "UPDATE",
  "DELETE",
]);
const WRITE_TOKEN = /\b(INSERT|REPLACE|UPDATE|DELETE)\b/i;

/** @param {string} ch */
function isWordChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Split a SQL script on statement terminators. Semicolons inside strings,
 * quoted identifiers, comments, and `CREATE TRIGGER … BEGIN … END` bodies do
 * not split. Empty and comment-only fragments are dropped.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const text = String(sql ?? "");
  /** @type {string[]} */
  const statements = [];
  let start = 0;
  let index = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  let triggerBody = false;
  let caseDepth = 0;

  /** @param {number} end */
  const push = (end) => {
    const statement = text.slice(start, end).trim();
    if (statement && stripLeadingComments(statement)) statements.push(statement);
  };

  const startsTrigger = () => {
    const head = stripLeadingComments(text.slice(start, index)).toUpperCase();
    return /^CREATE\b/.test(head) && /\bTRIGGER\b/.test(head);
  };

  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (quote) {
      if (quote === "]") {
        if (ch === "]") quote = "";
        index += 1;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        quote = "";
      }
      index += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      index += 1;
      continue;
    }

    if (isWordChar(ch) && (index === 0 || !isWordChar(text[index - 1]))) {
      let end = index;
      while (end < text.length && isWordChar(text[end])) end += 1;
      const word = text.slice(index, end).toUpperCase();
      if (word === "BEGIN" && startsTrigger()) {
        triggerBody = true;
      } else if (triggerBody && word === "CASE") {
        caseDepth += 1;
      } else if (triggerBody && word === "END") {
        if (caseDepth > 0) caseDepth -= 1;
        else triggerBody = false;
      }
      index = end;
      continue;
    }

    if (ch === ";" && !triggerBody) {
      push(index);
      start = index + 1;
    }
    index += 1;
  }

  push(text.length);
  return statements;
}

/**
 * How a statement should run:
 *   - "read"   — call `db.exec` and show the rows it returns
 *   - "write"  — call `db.run` (data change, transaction control)
 *   - "schema" — call `db.run` (structure change)
 *   - "empty"  — nothing to run
 *
 * A `RETURNING` write classifies as "read" because its rows matter, but
 * `statementMutates` still reports it as a change.
 *
 * @param {string} statement
 * @returns {"read"|"write"|"schema"|"empty"}
 */
export function classifyStatement(statement) {
  const cleaned = stripLeadingComments(statement);
  if (!cleaned) return "empty";
  const verb = firstVerb(cleaned);
  if (!verb) return "write";

  if (verb === "PRAGMA") return /=/.test(cleaned) ? "write" : "read";
  if (verb === "WITH") {
    // A CTE body is SELECT-only in SQLite, so a data-changing verb there is
    // the statement's main verb. WITHOUT RETURNING it produces no rows.
    const masked = maskLiterals(cleaned);
    return WRITE_TOKEN.test(masked) && !/\bRETURNING\b/i.test(masked)
      ? "write"
      : "read";
  }
  if (READ_VERBS.has(verb)) return "read";
  if (SCHEMA_VERBS.has(verb)) return "schema";
  if (WRITE_VERBS.has(verb) && /\bRETURNING\b/i.test(maskLiterals(cleaned))) {
    return "read";
  }
  return "write";
}

/**
 * True when running this statement writes data or structure — including an
 * INSERT/UPDATE/DELETE with RETURNING, which classifies as a read for its
 * result rows.
 *
 * @param {string} statement
 */
export function statementMutates(statement) {
  const kind = classifyStatement(statement);
  if (kind === "write" || kind === "schema") return true;
  const verb = firstVerb(statement);
  if (WRITE_VERBS.has(verb)) return true;
  if (verb === "WITH") return WRITE_TOKEN.test(maskLiterals(statement));
  return false;
}

/**
 * @typedef {{
 *   statements: { sql: string, kind: "read"|"write"|"schema"|"empty", mutates: boolean }[],
 *   mutates: boolean,
 *   schema: boolean,
 *   empty: boolean,
 * }} ScriptAnalysis
 */

/**
 * @param {string} sql
 * @returns {ScriptAnalysis}
 */
export function analyzeScript(sql) {
  const statements = splitStatements(sql).map((statement) => ({
    sql: statement,
    kind: classifyStatement(statement),
    mutates: statementMutates(statement),
  }));
  return {
    statements,
    mutates: statements.some((statement) => statement.mutates),
    schema: statements.some((statement) => statement.kind === "schema"),
    empty: statements.length === 0,
  };
}

/**
 * Approximate the memory a value costs on the wire. Strings are counted at
 * two bytes per character (UTF-16), which is a safe overestimate for the
 * common ASCII case.
 *
 * @param {unknown} value
 */
function valueBytes(value) {
  if (value == null) return 4;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 4;
  if (isBlob(value)) return /** @type {any} */ (value).byteLength;
  return 16;
}

/**
 * Keep a result set under the row and byte caps.
 *
 * @param {string[]} columns
 * @param {any[][]} rows
 * @param {{ maxRows?: number, maxBytes?: number }} [limits]
 * @returns {{ rows: any[][], truncated: boolean, shown: number, total: number, bytes: number }}
 */
export function capResult(columns, rows, limits = {}) {
  const maxRows = limits.maxRows ?? MAX_RESULT_ROWS;
  const maxBytes = limits.maxBytes ?? MAX_RESULT_BYTES;
  const list = Array.isArray(rows) ? rows : [];
  /** @type {any[][]} */
  const kept = [];
  let bytes = (columns || []).reduce(
    (total, name) => total + String(name).length * 2,
    0,
  );

  for (const row of list) {
    if (kept.length >= maxRows) break;
    const rowBytes = Array.isArray(row)
      ? 16 + row.length * 8 + row.reduce((total, value) => total + valueBytes(value), 0)
      : valueBytes(row);
    if (kept.length > 0 && bytes + rowBytes > maxBytes) break;
    if (kept.length === 0 && rowBytes > maxBytes) {
      // One oversized row would still be worth showing, but it breaks the
      // promise of a small clone. Report truncation instead.
      return { rows: [], truncated: true, shown: 0, total: list.length, bytes };
    }
    kept.push(row);
    bytes += rowBytes;
  }

  return {
    rows: kept,
    truncated: kept.length < list.length,
    shown: kept.length,
    total: list.length,
    bytes,
  };
}

/** @param {unknown} value @param {number} [limit] */
export function hexPreview(value, limit = 48) {
  if (!isBlob(value)) return "";
  const bytes = value instanceof Uint8Array ? value : asBytes(value);
  const shown = Math.min(bytes.length, limit);
  let text = "";
  for (let index = 0; index < shown; index += 1) {
    if (index > 0) text += " ";
    text += bytes[index].toString(16).padStart(2, "0");
  }
  if (bytes.length > shown) text += " …";
  return text;
}

/**
 * What a value should look like in a read-only grid or result table.
 * @param {unknown} value
 * @returns {{ kind: "null"|"number"|"blob"|"text"|"empty", text: string, title?: string }}
 */
export function formatCellValue(value) {
  if (value === null || value === undefined) {
    return { kind: "null", text: "NULL" };
  }
  if (typeof value === "number") {
    return { kind: "number", text: String(value) };
  }
  if (isBlob(value)) {
    const bytes = value instanceof Uint8Array ? value : asBytes(value);
    const hex = hexPreview(bytes, 16);
    return {
      kind: "blob",
      text: bytes.byteLength === 0 ? "Empty blob" : `${hex} · ${formatBytes(bytes.byteLength)}`,
      title: hexPreview(bytes, 256),
    };
  }
  const text = String(value);
  if (text === "") return { kind: "empty", text: "Empty" };
  return { kind: "text", text, title: text.length > 240 ? `${text.slice(0, 240)}…` : text };
}

/** @param {unknown} value */
export function formatEditableValue(value) {
  if (value === null || value === undefined) return "";
  if (isBlob(value)) return "";
  return String(value);
}

const NUMERIC_TYPES = /(INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL)/i;
const NUMERIC_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Turn the text in a cell input into a value bound to the UPDATE. SQLite's
 * column affinity handles the rest; numeric columns get real numbers so
 * expressions and comparisons behave, and everything else stays text.
 *
 * @param {string} raw
 * @param {string} [columnType]
 * @returns {string|number}
 */
export function coerceCellValue(raw, columnType = "") {
  if (typeof raw !== "string") return raw;
  if (!NUMERIC_TYPES.test(columnType)) return raw;
  const trimmed = raw.trim();
  if (trimmed === "" || !NUMERIC_INPUT.test(trimmed)) return raw;
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return raw;
  // 64-bit integers beyond 2^53 lose precision as a JS number; let SQLite
  // parse the text and keep every digit.
  if (
    !trimmed.includes(".") &&
    !/[eE]/.test(trimmed) &&
    !Number.isSafeInteger(number)
  ) {
    return raw;
  }
  return number;
}

/**
 * A short row identity for a delete confirmation, e.g. `id = 12` or
 * `form_id = 3, answer_no = 2`.
 *
 * @param {{ columns: any[], primaryKey: string[] }} table
 * @param {any[]} row
 */
export function rowIdentity(table, row) {
  const parts = [];
  for (const name of table.primaryKey) {
    const index = table.columns.findIndex((column) => column.name === name);
    if (index < 0) continue;
    const value = row[index];
    let shown = "NULL";
    if (typeof value === "string") shown = `'${value.replace(/'/g, "''")}'`;
    else if (typeof value === "number") shown = String(value);
    else if (isBlob(value)) shown = hexPreview(value, 8);
    parts.push(`${name} = ${shown}`);
  }
  return parts.join(", ");
}

/**
 * 409 from the save route means another answer landed while this copy was
 * open. It is never safe to retry a blind write.
 *
 * @param {unknown} error
 */
export function isConflictError(error) {
  if (!error || typeof error !== "object") return false;
  const value = /** @type {any} */ (error);
  return (
    value.status === 409 ||
    value.code === "conflict" ||
    value.code === "stale_revision" ||
    value.code === "revision_conflict"
  );
}
