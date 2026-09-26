import { describe, expect, it } from "vitest";
import {
  decodeTableCell,
  deleteTableCol,
  deleteTableRow,
  encodeTableCell,
  insertTableCol,
  insertTableRow,
  parseMarkdownTable,
  parseTableDocument,
  serializeMarkdownTable,
  setTableAlign,
  sortTableRows,
  splitTableLine,
  tableCellValue,
} from "./markdownTableModel.js";

const SRC = "| A | B |\n| --- | ---: |\n| 1 | 2 |\n| 3 | 4 |";

describe("splitTableLine", () => {
  it("splits on unescaped pipes; cell values keep their raw inline source", () => {
    expect(splitTableLine("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableLine("a | b")).toEqual(["a", "b"]);
    expect(splitTableLine("| a \\| x | b |")).toEqual(["a \\| x", "b"]);
    expect(splitTableLine("|  |")).toEqual([""]);
  });

  it("does not eat a real delimiter after an escaped backslash", () => {
    // `a \\|` is the cell source `a \\` plus a closing pipe — the source
    // keeps both backslashes (raw inline source, not decoded text).
    expect(splitTableLine("| a \\\\|")).toEqual(["a \\\\"]);
    expect(splitTableLine("| a \\\\| b |")).toEqual(["a \\\\", "b"]);
  });

  it("still requires escaped pipes inside code spans (GFM rule)", () => {
    expect(splitTableLine("| `x\\|y` | z |")).toEqual(["`x\\|y`", "z"]);
    // An unescaped pipe inside backticks is a real delimiter.
    expect(splitTableLine("| `x|y` | z |")).toEqual(["`x", "y`", "z"]);
  });
});

describe("encode/decode round-trip", () => {
  it("escapes only unescaped pipes; decode is raw.trim()", () => {
    expect(encodeTableCell("x|y")).toBe("x\\|y");
    expect(decodeTableCell("x\\|y")).toBe("x\\|y");
    // An already-escaped pipe is never double-escaped.
    expect(encodeTableCell("x\\|y")).toBe("x\\|y");
    expect(encodeTableCell("a \\| b")).toBe("a \\| b");
  });

  it("keeps existing inline escapes untouched through a round-trip", () => {
    for (const v of ["a \\| b", "\\", "\\\\", "a\\", "\\|", "\\*literal\\*"]) {
      const m = parseTableDocument(serializeMarkdownTable({
        header: ["h"],
        align: [""],
        body: [[v]],
      }));
      expect(m?.model.body[0][0]).toBe(v);
    }
    // `a \\| b` is `a \` + a REAL delimiter in GFM — storing it in one cell
    // has to escape that pipe, and the stored source reflects it.
    const m = parseTableDocument(serializeMarkdownTable({
      header: ["h"],
      align: [""],
      body: [["a \\\\| b"]],
    }));
    expect(m?.model.body[0][0]).toBe("a \\\\\\| b");
  });

  it("flattens line breaks to spaces", () => {
    expect(encodeTableCell("a\nb\r\nc")).toBe("a b c");
  });
});

describe("parseTableDocument", () => {
  it("returns a model plus source spans relative to the block", () => {
    const p = parseTableDocument(SRC);
    expect(p?.model.header).toEqual(["A", "B"]);
    expect(p?.model.align).toEqual(["", "right"]);
    expect(p?.model.body).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    // Header row is cells[0]; body rows follow.
    const a = p.cells[0][0];
    expect(SRC.slice(a.from, a.to)).toBe(" A ");
    const two = p.cells[1][1];
    expect(SRC.slice(two.from, two.to)).toBe(" 2 ");
  });

  it("marks ragged-row cells as missing spans", () => {
    const p = parseTableDocument("| A | B |\n| --- | --- |\n| 1 |");
    expect(p?.model.body[0]).toEqual(["1", ""]);
    expect(p?.cells[1][1]?.missing).toBe(true);
    expect(p?.cells[1][0]?.missing).toBeUndefined();
  });

  it("rejects an invalid delimiter row", () => {
    expect(parseTableDocument("| A | B |\n| no | way |")).toBeNull();
    expect(parseTableDocument("a\nb")).toBeNull();
  });

  it("validates the whole source: exactly one GFM table, whitespace outside only", () => {
    // Whitespace around the table is fine.
    expect(
      parseTableDocument("\n\n| A |\n| --- |\n| 1 |\n\n"),
    ).not.toBeNull();
    // Prose, a second table, or a Setext heading are not.
    expect(
      parseTableDocument("| A |\n| --- |\n| 1 |\n\nextra paragraph"),
    ).toBeNull();
    expect(
      parseTableDocument("| A |\n| --- |\n\n| B |\n| --- |"),
    ).toBeNull();
    expect(parseTableDocument("a\n---\nb")).toBeNull();
    expect(parseTableDocument("# heading\n\n| A |\n| --- |")).toBeNull();
  });

  it("accepts a header-only table and empty header cells", () => {
    const p = parseTableDocument("|  | B |\n| --- | --- |");
    expect(p?.model.header).toEqual(["", "B"]);
    expect(p?.model.body).toEqual([]);
  });

  it("parses CRLF source", () => {
    const p = parseTableDocument("| A |\r\n| --- |\r\n| 1 |");
    expect(p?.model.header).toEqual(["A"]);
    expect(p?.model.body).toEqual([["1"]]);
  });

  it("strict mode refuses Setext-heading-shaped prose", () => {
    expect(parseTableDocument("a\n---\nb", { strict: true })).toBeNull();
    expect(
      parseTableDocument("a | b\n--- | ---", { strict: true }),
    ).not.toBeNull();
  });
});

describe("structure operations", () => {
  const m = () => parseMarkdownTable(SRC);

  it("inserts body rows at a position, clamped below the header", () => {
    expect(insertTableRow(m(), 2).body).toEqual([["1", "2"], ["", ""], ["3", "4"]]);
    expect(insertTableRow(m(), 0).body[0]).toEqual(["", ""]);
    expect(insertTableRow(m(), 99).body[2]).toEqual(["", ""]);
  });

  it("deletes body rows, never the header", () => {
    expect(deleteTableRow(m(), 0)).toBeNull();
    expect(deleteTableRow(m(), 1).body).toEqual([["3", "4"]]);
    expect(deleteTableRow(m(), 3)).toBeNull();
  });

  it("inserts a column with its own alignment slot", () => {
    const t = insertTableCol(m(), 1);
    expect(t.header).toEqual(["A", "", "B"]);
    expect(t.align).toEqual(["", "", "right"]);
    expect(t.body[1]).toEqual(["3", "", "4"]);
  });

  it("deletes a column, but never the last one", () => {
    const t = deleteTableCol(m(), 0);
    expect(t.header).toEqual(["B"]);
    expect(t.align).toEqual(["right"]);
    expect(deleteTableCol(t, 0)).toBeNull();
  });

  it("sorts stably with numeric collation, header fixed, empties last", () => {
    const t = parseMarkdownTable(
      "| N | L |\n| --- | --- |\n| 10 | a |\n| 2 | b |\n|  | c |\n| 10 | d |",
    );
    const asc = sortTableRows(t, 0, 1);
    expect(asc.header).toEqual(["N", "L"]);
    expect(asc.body.map((r) => r[0])).toEqual(["2", "10", "10", ""]);
    // Stable: the two "10" rows keep their original order.
    expect(asc.body[1][1]).toBe("a");
    expect(asc.body[2][1]).toBe("d");
    const desc = sortTableRows(t, 0, -1);
    expect(desc.body.map((r) => r[0])).toEqual(["10", "10", "2", ""]);
  });

  it("sets one column's alignment", () => {
    expect(setTableAlign(m(), 0, "center").align).toEqual(["center", "right"]);
  });

  it("reads cells in r-space (0 = header)", () => {
    expect(tableCellValue(m(), 0, 1)).toBe("B");
    expect(tableCellValue(m(), 2, 0)).toBe("3");
  });

  it("round-trips through serialize", () => {
    expect(serializeMarkdownTable(m())).toBe(SRC);
  });
});
