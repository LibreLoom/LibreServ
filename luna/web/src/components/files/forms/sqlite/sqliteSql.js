/**
 * SQL construction for the table grid.
 *
 * Identifiers cannot be bound as parameters, so they are quoted here after a
 * shape check; values are always parameters. Column types come from a fixed
 * list because SQLite has no parameter slot for a type name either.
 */

/** The types the Add column dialog offers. */
export const COLUMN_TYPES = /** @type {const} */ ([
  "TEXT",
  "INTEGER",
  "REAL",
  "BLOB",
  "NUMERIC",
]);

/** @param {unknown} name */
export function quoteIdent(name) {
  const text = typeof name === "string" ? name : "";
  if (!text) throw new Error("A table or column name is required.");
  if (text.includes("\0")) throw new Error("That name contains a character SQLite can't store.");
  return `"${text.replace(/"/g, '""')}"`;
}

/** @param {unknown} name */
export function cleanColumnName(name) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw new Error("Enter a column name.");
  if (text.includes("\0")) throw new Error("That name contains a character SQLite can't store.");
  return text;
}

/** @param {unknown} name */
export function cleanTableName(name) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw new Error("Enter a table name.");
  if (text.includes("\0")) throw new Error("That name contains a character SQLite can't store.");
  if (/^sqlite_/i.test(text)) throw new Error("Names starting with sqlite_ are reserved.");
  return text;
}

/** @param {unknown} type */
export function cleanColumnType(type) {
  const text = typeof type === "string" ? type.trim().toUpperCase() : "";
  if (!COLUMN_TYPES.includes(/** @type {any} */ (text))) {
    throw new Error("Choose a column type.");
  }
  return text;
}

/**
 * @param {{ table: string, orderBy?: string[], limit?: number, offset?: number }} options
 * @returns {{ sql: string, params: (string|number)[] }}
 */
export function buildRowsQuery({ table, orderBy = [], limit = 100, offset = 0 }) {
  const order = orderBy.length
    ? ` ORDER BY ${orderBy.map(quoteIdent).join(", ")}`
    : "";
  return {
    sql: `SELECT * FROM ${quoteIdent(table)}${order} LIMIT ? OFFSET ?`,
    params: [Math.max(0, Math.trunc(limit)), Math.max(0, Math.trunc(offset))],
  };
}

/** @param {string} table */
export function buildCountQuery(table) {
  return {
    sql: `SELECT COUNT(*) FROM ${quoteIdent(table)}`,
    params: [],
  };
}

/**
 * @param {{
 *   table: string,
 *   column: string,
 *   primaryKey: string[],
 *   keyValues: any[],
 *   value: any,
 * }} options
 * @returns {{ sql: string, params: any[] }}
 */
export function buildUpdateCellSql({ table, column, primaryKey, keyValues, value }) {
  if (!primaryKey.length) {
    throw new Error("This table has no primary key, so its rows can't be changed.");
  }
  const where = primaryKey.map((name) => `${quoteIdent(name)} = ?`).join(" AND ");
  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE ${where}`,
    params: [value, ...keyValues],
  };
}

/**
 * @param {{ table: string, primaryKey: string[], keyValues: any[] }} options
 * @returns {{ sql: string, params: any[] }}
 */
export function buildDeleteRowSql({ table, primaryKey, keyValues }) {
  if (!primaryKey.length) {
    throw new Error("This table has no primary key, so rows can't be deleted here.");
  }
  const where = primaryKey.map((name) => `${quoteIdent(name)} = ?`).join(" AND ");
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE ${where}`,
    params: [...keyValues],
  };
}

/**
 * Create a table from the New table dialog. A single primary key is inline;
 * several become a table-level composite key.
 * @param {{ table: string, columns: { name: string, type: string, primaryKey?: boolean, notNull?: boolean }[] }} options
 */
export function buildCreateTableSql({ table, columns }) {
  const tableName = cleanTableName(table);
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("Add at least one column.");
  }
  const seen = new Set();
  const cleaned = columns.map((column) => {
    const name = cleanColumnName(column?.name);
    if (seen.has(name.toLowerCase())) {
      throw new Error(`There are two columns named "${name}".`);
    }
    seen.add(name.toLowerCase());
    return {
      name,
      type: cleanColumnType(column?.type),
      primaryKey: Boolean(column?.primaryKey),
      notNull: Boolean(column?.notNull),
    };
  });
  const keys = cleaned.filter((column) => column.primaryKey);
  const singleKey = keys.length === 1 ? keys[0].name : "";
  const definitions = cleaned.map((column) => {
    let sql = `${quoteIdent(column.name)} ${column.type}`;
    if (column.name === singleKey) sql += " PRIMARY KEY";
    if (column.notNull) sql += " NOT NULL";
    return sql;
  });
  if (keys.length > 1) {
    definitions.push(
      `PRIMARY KEY (${keys.map((column) => quoteIdent(column.name)).join(", ")})`,
    );
  }
  return {
    sql: `CREATE TABLE ${quoteIdent(tableName)} (${definitions.join(", ")})`,
    params: [],
  };
}

/**
 * Insert a row with every column at its default. INTEGER PRIMARY KEY assigns
 * itself, and NOT NULL columns with a default keep it.
 * @param {string} table
 */
export function buildInsertRowSql(table) {
  return {
    sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`,
    params: [],
  };
}

/**
 * @param {{ table: string, column: string, type: string }} options
 */
export function buildAddColumnSql({ table, column, type }) {
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(cleanColumnName(column))} ${cleanColumnType(type)}`,
    params: [],
  };
}

/**
 * @param {{ table: string, newName: string }} options
 */
export function buildRenameTableSql({ table, newName }) {
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} RENAME TO ${quoteIdent(cleanTableName(newName))}`,
    params: [],
  };
}

/**
 * @param {{ table: string, column: string, newName: string }} options
 */
export function buildRenameColumnSql({ table, column, newName }) {
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(column)} TO ${quoteIdent(cleanColumnName(newName))}`,
    params: [],
  };
}

/**
 * @param {{ table: string, column: string }} options
 */
export function buildDropColumnSql({ table, column }) {
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} DROP COLUMN ${quoteIdent(column)}`,
    params: [],
  };
}

/**
 * The ORDER BY for a stable page: the primary key when there is one. A table
 * without one keeps SQLite's own order (and its rows are read-only here).
 * @param {{ primaryKey: string[] }} table
 */
export function pageOrder(table) {
  return Array.isArray(table?.primaryKey) ? table.primaryKey : [];
}
