import { describe, expect, it } from "vitest";
import {
  clearTableCells,
  decodeTableCell,
  deleteTableCols,
  deleteTableRows,
  duplicateTableCols,
  duplicateTableRows,
  encodeTableCell,
  fillTableCells,
  insertTableRows,
  moveTableCols,
  moveTableRows,
  parseDelimitedRows,
  parseMarkdownTable,
  parseTableClipboard,
  parseTableDocument,
  pasteTableRows,
  serializeDelimitedRows,
  serializeMarkdownTable,
  setTableAlign,
  setTableCell,
  sortTableRows,
  splitTableLine,
  tableCellValue,
  tableSelection,
  validateTableRows,
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

  it("inserts and deletes body rows, never the header", () => {
    expect(insertTableRows(m(), 2).body).toHaveLength(3);
    expect(deleteTableRows(m(), 0, 0)).toBeNull();
    expect(deleteTableRows(m(), 1, 1).body).toEqual([["3", "4"]]);
  });

  it("moves a contiguous row block by one step", () => {
    const three = parseMarkdownTable(
      "| A |\n| --- |\n| 1 |\n| 2 |\n| 3 |",
    );
    expect(moveTableRows(three, 1, 2, 1).body).toEqual([["3"], ["1"], ["2"]]);
    expect(moveTableRows(three, 2, 3, -1).body).toEqual([["2"], ["3"], ["1"]]);
    expect(moveTableRows(three, 1, 1, -1)).toBeNull();
  });

  it("duplicates rows and columns", () => {
    expect(duplicateTableRows(m(), 1, 1).body).toEqual([
      ["1", "2"],
      ["1", "2"],
      ["3", "4"],
    ]);
    const dup = duplicateTableCols(m(), 0, 0);
    expect(dup.header).toEqual(["A", "A", "B"]);
    expect(dup.body[0]).toEqual(["1", "1", "2"]);
  });

  it("moves a column block and keeps alignment attached", () => {
    const moved = moveTableCols(m(), 1, 1, -1);
    expect(moved.header).toEqual(["B", "A"]);
    expect(moved.align).toEqual(["right", ""]);
    expect(moved.body[0]).toEqual(["2", "1"]);
  });

  it("refuses to delete the last column", () => {
    const one = parseMarkdownTable("| A |\n| --- |\n| 1 |");
    expect(deleteTableCols(one, 0, 0)).toBeNull();
    expect(deleteTableCols(m(), 0, 1)).toBeNull();
    expect(deleteTableCols(m(), 0, 0).header).toEqual(["B"]);
  });

  it("clears and fills rectangular selections", () => {
    const sel = tableSelection({ r: 0, c: 0 }, { r: 2, c: 1 });
    const cleared = clearTableCells(m(), sel);
    expect(cleared.header).toEqual(["", ""]);
    expect(cleared.body).toEqual([["", ""], ["", ""]]);
    const filled = fillTableCells(
      m(),
      tableSelection({ r: 1, c: 0 }, { r: 1, c: 1 }),
      "x",
    );
    expect(filled.body[0]).toEqual(["x", "x"]);
    expect(filled.body[1]).toEqual(["3", "4"]);
  });

  it("pastes a rectangle, expanding rows and columns once", () => {
    const pasted = pasteTableRows(m(), 2, 1, [
      ["p", "q", "r"],
      ["s", "t", "u"],
    ]);
    expect(pasted.header).toEqual(["A", "B", "", ""]);
    expect(pasted.body).toEqual([
      ["1", "2", "", ""],
      ["3", "p", "q", "r"],
      ["", "s", "t", "u"],
    ]);
  });

  it("pastes over the header row too", () => {
    const pasted = pasteTableRows(m(), 0, 0, [["H1", "H2"]]);
    expect(pasted.header).toEqual(["H1", "H2"]);
    expect(pasted.body).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
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

  it("sets alignment over a column interval", () => {
    const a = setTableAlign(m(), 0, 1, "center");
    expect(a.align).toEqual(["center", "center"]);
  });

  it("reads and writes cells in r-space (0 = header)", () => {
    expect(tableCellValue(m(), 0, 1)).toBe("B");
    expect(tableCellValue(m(), 2, 0)).toBe("3");
    expect(setTableCell(m(), 0, 0, "H").header[0]).toBe("H");
    expect(setTableCell(m(), 1, 1, "x").body[0][1]).toBe("x");
  });
});

describe("clipboard formats", () => {
  it("parses TSV with empty trailing cells and rows intact", () => {
    const { rows } = parseDelimitedRows("a\tb\t\n\t\n1\t2\t3", "\t");
    expect(rows).toEqual([
      ["a", "b", ""],
      ["", ""],
      ["1", "2", "3"],
    ]);
  });

  it("round-trips a terminal empty row losslessly", () => {
    // A lone empty row serializes as `""` so a trailing newline can't
    // silently drop it.
    const t = serializeDelimitedRows([["a"], [""]], "\t");
    expect(t).toBe('a\n""');
    expect(parseDelimitedRows(t, "\t").rows).toEqual([["a"], [""]]);
    expect(
      parseDelimitedRows(serializeDelimitedRows([[""]], "\t"), "\t").rows,
    ).toEqual([[""]]);
    expect(
      parseDelimitedRows(
        serializeDelimitedRows([["", ""], ["", ""]], "\t"),
        "\t",
      ).rows,
    ).toEqual([
      ["", ""],
      ["", ""],
    ]);
    // ...while a spreadsheet-style trailing newline stays one row.
    expect(parseDelimitedRows("a\n", "\t").rows).toEqual([["a"]]);
  });

  it("reports an unmatched quote instead of swallowing the input", () => {
    const { error, rows } = parseDelimitedRows('"a,b\nc,d', ",");
    expect(error).toMatch(/unmatched/i);
    expect(rows).toEqual([]);
  });

  it("honours quoted delimiters and quoted newlines", () => {
    const { rows, normalizedLineBreaks } = parseDelimitedRows(
      '"a\tb"\t"multi\nline"',
      "\t",
    );
    expect(rows).toEqual([["a\tb", "multi\nline"]]);
    expect(normalizedLineBreaks).toBe(true);
  });

  it("parses a Markdown table from the clipboard", () => {
    const p = parseTableClipboard(SRC, "auto");
    expect(p.format).toBe("markdown");
    expect(p.rows).toEqual([
      ["A", "B"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("auto-detects TSV but never comma prose", () => {
    expect(parseTableClipboard("a\tb", "auto").rows).toEqual([["a", "b"]]);
    const prose = parseTableClipboard("hello, world", "auto");
    expect(prose.rows).toEqual([["hello, world"]]);
    // The import dialog opts in to comma detection.
    const csv = parseTableClipboard("a,b\nc,d", "auto", { sniffCsv: true });
    expect(csv.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("treats multi-line single-column paste as one row per line", () => {
    expect(parseTableClipboard("one\ntwo\nthree", "auto").rows).toEqual([
      ["one"],
      ["two"],
      ["three"],
    ]);
  });

  it("keeps leading zeros as text", () => {
    expect(parseTableClipboard("001\tx", "auto").rows[0][0]).toBe("001");
  });

  it("reports empty or invalid input", () => {
    expect(parseTableClipboard("", "auto").error).toBeTruthy();
    expect(parseTableClipboard("not a table", "markdown").error).toBeTruthy();
  });

  it("serializes RFC-quoted delimited output", () => {
    expect(
      serializeDelimitedRows(
        [
          ["a\tb", "c"],
          ["say", '"hi"'],
        ],
        "\t",
      ),
    ).toBe('"a\tb"\tc\nsay\t"""hi"""');
  });

  it("prefixes formula-looking cells only when safe export is on", () => {
    const rows = [["=1+1", " plain"], ["-2", "@x"]];
    expect(serializeDelimitedRows(rows, ",", true)).toBe(
      "'=1+1, plain\n'-2,'@x",
    );
    expect(serializeDelimitedRows(rows, ",", false)).toBe(
      "=1+1, plain\n-2,@x",
    );
    // Tab- and CR-leading formula values are guarded too (the CR value is
    // also newline-quoted since it contains a raw carriage return).
    expect(serializeDelimitedRows([["\t=x"], ["\r+1"]], ",", true)).toBe(
      `'\t=x\n"'\r+1"`,
    );
    // A leading tab/CR/LF is prefixed even when no formula char follows —
    // some apps evaluate the trimmed text.
    expect(serializeDelimitedRows([["\tplain"], ["\n9"]], ",", true)).toBe(
      `'\tplain\n"'\n9"`,
    );
  });
});

describe("validateTableRows bounds", () => {
  it("accepts a small rectangle and reports null", () => {
    expect(
      validateTableRows([
        ["a", "b"],
        ["c"],
      ]),
    ).toBeNull();
  });

  it("rejects the padded product, not just the ragged sum", () => {
    // 200 rows summing to 399 cells but squaring up to 40,000.
    const rows = [
      Array.from({ length: 200 }, () => "x"),
      ...Array.from({ length: 199 }, () => ["y"]),
    ];
    expect(validateTableRows(rows)).toMatch(/squared up|cells/i);
  });

  it("rejects malformed structure instead of throwing", () => {
    expect(validateTableRows(null)).toBeTruthy();
    expect(validateTableRows([])).toBeTruthy();
    expect(validateTableRows([null])).toBeTruthy();
    expect(validateTableRows([[]])).toBeTruthy();
    expect(validateTableRows([["a"], ["b", 5]])).toBeTruthy();
  });

  it("rejects over-wide rows", () => {
    const rows = [Array.from({ length: 201 }, () => "x")];
    expect(validateTableRows(rows)).toMatch(/columns/);
  });

  it("bounds TSV import by the padded cell product", () => {
    const text = [
      Array.from({ length: 200 }, () => "x").join("\t"),
      ...Array.from({ length: 199 }, () => "y"),
    ].join("\n");
    const res = parseTableClipboard(text, "tsv");
    expect(res.error).toBeTruthy();
    expect(res.rows).toBeUndefined();
  });

  it("bounds Markdown table import by the padded cell product", () => {
    const text = [
      `|${" x |".repeat(200)}`,
      `|${" --- |".repeat(200)}`,
      ...Array.from({ length: 198 }, () => "| y |"),
    ].join("\n");
    const res = parseTableClipboard(text, "markdown");
    expect(res.error).toMatch(/cells/i);
    expect(res.rows).toBeUndefined();
  });
});
