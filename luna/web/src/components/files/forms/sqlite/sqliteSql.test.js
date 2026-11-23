import { describe, expect, it } from "vitest";
import {
  buildAddColumnSql,
  buildCountQuery,
  buildCreateTableSql,
  buildDeleteRowSql,
  buildDropColumnSql,
  buildInsertRowSql,
  buildRenameColumnSql,
  buildRenameTableSql,
  buildRowsQuery,
  buildUpdateCellSql,
  cleanColumnName,
  cleanColumnType,
  cleanTableName,
  quoteIdent,
} from "./sqliteSql.js";

describe("identifier quoting", () => {
  it("double-quotes names and escapes embedded quotes", () => {
    expect(quoteIdent("responses")).toBe('"responses"');
    expect(quoteIdent('odd"name')).toBe('"odd""name"');
    expect(quoteIdent(" schema.answers ")).toBe('" schema.answers "');
  });

  it("refuses an empty name", () => {
    expect(() => quoteIdent("")).toThrow(/name is required/i);
    expect(() => cleanColumnName("")).toThrow(/Enter a column name/);
    expect(cleanColumnName(" email ")).toBe("email");
  });

  it("cleans table names and refuses reserved ones", () => {
    expect(cleanTableName(" members ")).toBe("members");
    expect(() => cleanTableName("")).toThrow(/Enter a table name/);
    expect(() => cleanTableName("sqlite_master")).toThrow(/reserved/);
  });

  it("only accepts the fixed column types", () => {
    expect(cleanColumnType("text")).toBe("TEXT");
    expect(() => cleanColumnType("TEXT; DROP TABLE answers")).toThrow(
      /Choose a column type/,
    );
  });
});

describe("grid queries", () => {
  it("orders by the primary key and binds limit and offset", () => {
    expect(
      buildRowsQuery({
        table: "responses",
        orderBy: ["form_id", "answer_no"],
        limit: 100,
        offset: 200,
      }),
    ).toEqual({
      sql: 'SELECT * FROM "responses" ORDER BY "form_id", "answer_no" LIMIT ? OFFSET ?',
      params: [100, 200],
    });
  });

  it("reads a table without a primary key without an ORDER BY", () => {
    expect(buildRowsQuery({ table: "answers" }).sql).toBe(
      'SELECT * FROM "answers" LIMIT ? OFFSET ?',
    );
  });

  it("counts with no bound values", () => {
    expect(buildCountQuery("answers")).toEqual({
      sql: 'SELECT COUNT(*) FROM "answers"',
      params: [],
    });
  });

  it("creates a table with a single inline primary key", () => {
    expect(
      buildCreateTableSql({
        table: "members",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true, notNull: true },
          { name: "name", type: "TEXT", notNull: true },
        ],
      }),
    ).toEqual({
      sql: 'CREATE TABLE "members" ("id" INTEGER PRIMARY KEY NOT NULL, "name" TEXT NOT NULL)',
      params: [],
    });
  });

  it("creates a composite primary key at the table level", () => {
    expect(
      buildCreateTableSql({
        table: "answers",
        columns: [
          { name: "form_id", type: "INTEGER", primaryKey: true },
          { name: "answer_no", type: "INTEGER", primaryKey: true },
          { name: "body", type: "TEXT" },
        ],
      }).sql,
    ).toBe(
      'CREATE TABLE "answers" ("form_id" INTEGER, "answer_no" INTEGER, "body" TEXT, PRIMARY KEY ("form_id", "answer_no"))',
    );
  });

  it("refuses duplicate column names and an empty table", () => {
    expect(() =>
      buildCreateTableSql({
        table: "members",
        columns: [
          { name: "id", type: "INTEGER" },
          { name: "ID", type: "TEXT" },
        ],
      }),
    ).toThrow(/two columns named/);
    expect(() => buildCreateTableSql({ table: "members", columns: [] })).toThrow(
      /at least one column/,
    );
  });

  it("updates one cell by a composite key", () => {
    expect(
      buildUpdateCellSql({
        table: "answers",
        column: "body",
        primaryKey: ["form_id", "answer_no"],
        keyValues: [3, 2],
        value: "hello",
      }),
    ).toEqual({
      sql: 'UPDATE "answers" SET "body" = ? WHERE "form_id" = ? AND "answer_no" = ?',
      params: ["hello", 3, 2],
    });
  });

  it("refuses to update or delete without a key", () => {
    expect(() =>
      buildUpdateCellSql({
        table: "answers",
        column: "body",
        primaryKey: [],
        keyValues: [],
        value: "x",
      }),
    ).toThrow(/no primary key/i);
    expect(() =>
      buildDeleteRowSql({ table: "answers", primaryKey: [], keyValues: [] }),
    ).toThrow(/no primary key/i);
  });

  it("deletes a row with bound key values", () => {
    expect(
      buildDeleteRowSql({
        table: "answers",
        primaryKey: ["id"],
        keyValues: [42],
      }),
    ).toEqual({
      sql: 'DELETE FROM "answers" WHERE "id" = ?',
      params: [42],
    });
  });

  it("adds a row with every column at its default", () => {
    expect(buildInsertRowSql("answers")).toEqual({
      sql: 'INSERT INTO "answers" DEFAULT VALUES',
      params: [],
    });
  });
});

describe("column changes", () => {
  it("builds add, rename, and drop statements with quoted identifiers", () => {
    expect(
      buildAddColumnSql({ table: "answers", column: "email", type: "TEXT" }),
    ).toEqual({
      sql: 'ALTER TABLE "answers" ADD COLUMN "email" TEXT',
      params: [],
    });
    expect(
      buildRenameColumnSql({
        table: "answers",
        column: "email",
        newName: 'contact"email',
      }),
    ).toEqual({
      sql: 'ALTER TABLE "answers" RENAME COLUMN "email" TO "contact""email"',
      params: [],
    });
    expect(
      buildDropColumnSql({ table: "answers", column: "email" }),
    ).toEqual({
      sql: 'ALTER TABLE "answers" DROP COLUMN "email"',
      params: [],
    });
  });

  it("rejects a type that carries SQL", () => {
    expect(() =>
      buildAddColumnSql({
        table: "answers",
        column: "email",
        type: "TEXT; DROP TABLE answers",
      }),
    ).toThrow(/Choose a column type/);
  });
});

describe("table changes", () => {
  it("renames a table with quoted identifiers", () => {
    expect(
      buildRenameTableSql({ table: "answers", newName: "form answers" }),
    ).toEqual({
      sql: 'ALTER TABLE "answers" RENAME TO "form answers"',
      params: [],
    });
    expect(
      buildRenameTableSql({ table: "answers", newName: 'odd"name' }).sql,
    ).toBe('ALTER TABLE "answers" RENAME TO "odd""name"');
  });

  it("rejects an empty or reserved table name", () => {
    expect(() =>
      buildRenameTableSql({ table: "answers", newName: "   " }),
    ).toThrow(/Enter a table name/);
    expect(() =>
      buildRenameTableSql({ table: "answers", newName: "sqlite_master" }),
    ).toThrow(/reserved/);
  });
});
