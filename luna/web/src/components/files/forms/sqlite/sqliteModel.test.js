import { describe, expect, it } from "vitest";
import {
  MAX_DATABASE_BYTES,
  MAX_RESULT_BYTES,
  MAX_RESULT_ROWS,
  analyzeScript,
  asBytes,
  capResult,
  classifyStatement,
  coerceCellValue,
  formatBytes,
  formatCellValue,
  formatCount,
  isConflictError,
  rowIdentity,
  splitStatements,
  statementMutates,
} from "./sqliteModel.js";

describe("database size cap", () => {
  it("is 16 MiB", () => {
    expect(MAX_DATABASE_BYTES).toBe(16 * 1024 * 1024);
  });

  it("accepts the views and plain arrays the parent may hand over", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const view = new Uint8Array(bytes.buffer, 1, 2);
    expect(Array.from(asBytes(view))).toEqual([2, 3]);
    expect(Array.from(asBytes([5, 6]))).toEqual([5, 6]);
    expect(asBytes("nope")).toHaveLength(0);
  });
});

describe("splitStatements", () => {
  it("splits a script and drops empty fragments", () => {
    expect(splitStatements("SELECT 1; SELECT 2; ;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
    expect(splitStatements("-- only a comment")).toEqual([]);
    expect(splitStatements("")).toEqual([]);
  });

  it("keeps semicolons inside strings, identifiers, and comments", () => {
    expect(splitStatements("SELECT ';' AS semi; SELECT 2")).toEqual([
      "SELECT ';' AS semi",
      "SELECT 2",
    ]);
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 2')).toHaveLength(2);
    expect(
      splitStatements("SELECT 1 -- a ; b\n; SELECT 2 /* ; */"),
    ).toHaveLength(2);
    expect(splitStatements("SELECT 'it''s; fine'")).toHaveLength(1);
  });

  it("keeps a trigger body together, including CASE … END", () => {
    const script = `CREATE TRIGGER bump AFTER INSERT ON answers BEGIN
      UPDATE answers SET score = CASE WHEN new.score > 0 THEN 1 ELSE 0 END;
      UPDATE answers SET seen = 1;
    END;
    SELECT 1;`;
    expect(splitStatements(script)).toHaveLength(2);
  });

  it("still splits transaction control statements", () => {
    expect(
      splitStatements("BEGIN; UPDATE t SET a = 1; COMMIT;"),
    ).toHaveLength(3);
  });
});

describe("statement classification", () => {
  it("separates reads, writes, and schema changes", () => {
    expect(classifyStatement("SELECT * FROM t")).toBe("read");
    expect(classifyStatement("-- note\n  PRAGMA table_info(t)")).toBe("read");
    expect(classifyStatement("INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifyStatement("UPDATE t SET a = 1")).toBe("write");
    expect(classifyStatement("DELETE FROM t")).toBe("write");
    expect(classifyStatement("CREATE TABLE t (a TEXT)")).toBe("schema");
    expect(classifyStatement("ALTER TABLE t ADD COLUMN b TEXT")).toBe("schema");
    expect(classifyStatement("DROP TABLE t")).toBe("schema");
    expect(classifyStatement("PRAGMA journal_mode = WAL")).toBe("write");
  });

  it("gives RETURNING writes their rows but still calls them changes", () => {
    expect(classifyStatement("INSERT INTO t VALUES (1) RETURNING id")).toBe(
      "read",
    );
    expect(statementMutates("INSERT INTO t VALUES (1) RETURNING id")).toBe(
      true,
    );
    expect(statementMutates("SELECT * FROM t")).toBe(false);
    expect(statementMutates("WITH x AS (SELECT 1) DELETE FROM t")).toBe(true);
    expect(
      classifyStatement("WITH x AS (SELECT 'DELETE' AS note) SELECT * FROM x"),
    ).toBe("read");
    expect(
      statementMutates("WITH x AS (SELECT 'DELETE' AS note) SELECT * FROM x"),
    ).toBe(false);
  });

  it("summarizes a whole script", () => {
    const analysis = analyzeScript(
      "CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('a'); SELECT * FROM t;",
    );
    expect(analysis.statements).toHaveLength(3);
    expect(analysis.mutates).toBe(true);
    expect(analysis.schema).toBe(true);
    expect(analysis.empty).toBe(false);
    expect(analyzeScript("  -- nothing here ").empty).toBe(true);
  });
});

describe("capResult", () => {
  it("keeps the first 500 rows and reports truncation", () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS + 25 }, (_, index) => [
      index,
    ]);
    const capped = capResult(["id"], rows);
    expect(capped.rows).toHaveLength(MAX_RESULT_ROWS);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(MAX_RESULT_ROWS + 25);
  });

  it("stops on the byte cap as well as the row cap", () => {
    const huge = "x".repeat(MAX_RESULT_BYTES / 2);
    const capped = capResult(["body"], [["small"], [huge], [huge]]);
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("does not send a single oversized row", () => {
    const capped = capResult(["body"], [["x".repeat(MAX_RESULT_BYTES)]]);
    expect(capped.rows).toHaveLength(0);
    expect(capped.truncated).toBe(true);
  });
});

describe("display helpers", () => {
  it("formats counts, sizes, and values without a locale dependency", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(16 * 1024 * 1024)).toBe("16 MB");
    expect(formatCellValue(null)).toEqual({ kind: "null", text: "NULL" });
    expect(formatCellValue("")).toEqual({ kind: "empty", text: "Empty" });
    expect(formatCellValue(12).kind).toBe("number");
    const blob = formatCellValue(new Uint8Array([0xde, 0xad]));
    expect(blob.kind).toBe("blob");
    expect(blob.text).toBe("de ad · 2 B");
    expect(blob.title).toBe("de ad");
  });

  it("coerces numeric columns and leaves text alone", () => {
    expect(coerceCellValue("42", "INTEGER")).toBe(42);
    expect(coerceCellValue("3.5", "REAL")).toBe(3.5);
    expect(coerceCellValue("042", "TEXT")).toBe("042");
    expect(coerceCellValue("", "INTEGER")).toBe("");
    expect(coerceCellValue("not a number", "INTEGER")).toBe("not a number");
    expect(coerceCellValue("9007199254740993", "INTEGER")).toBe(
      "9007199254740993",
    );
    expect(coerceCellValue("0x10", "INTEGER")).toBe("0x10");
  });

  it("names the row being deleted", () => {
    const table = {
      columns: [
        { name: "form_id" },
        { name: "answer_no" },
        { name: "body" },
      ],
      primaryKey: ["form_id", "answer_no"],
    };
    expect(rowIdentity(table, [3, 2, "hello"])).toBe(
      "form_id = 3, answer_no = 2",
    );
  });
});

describe("save conflicts", () => {
  it("recognises a 409 from the answers route", () => {
    expect(isConflictError({ status: 409 })).toBe(true);
    expect(isConflictError({ code: "conflict" })).toBe(true);
    expect(isConflictError({ code: "stale_revision" })).toBe(true);
    expect(isConflictError({ status: 500 })).toBe(false);
    expect(isConflictError(new Error("nope"))).toBe(false);
    expect(isConflictError(null)).toBe(false);
  });
});
