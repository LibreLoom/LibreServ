import { describe, expect, it } from "vitest";
import {
  buildAddColumnSql,
  buildCountQuery,
  buildDeleteRowSql,
  buildDropColumnSql,
  buildInsertRowSql,
  buildRenameColumnSql,
  buildRowsQuery,
  buildUpdateCellSql,
  cleanColumnName,
  cleanColumnType,
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
