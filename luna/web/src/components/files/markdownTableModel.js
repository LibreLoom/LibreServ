/**
 * Pure pipe-table model for the Markdown table editor: source-span parsing,
 * serialization and the structure operations the table menus offer. No DOM
 * or CodeMirror imports — the CM side lives in markdownTables.js and the
 * React table in MarkdownTableEditor.jsx.
 *
 * Coordinates are grid-space: r = 0 is the header row, r >= 1 are body rows.
 * The delimiter row is structural only — it carries `align`.
 *
 * Cell values are INLINE MARKDOWN SOURCE: the trimmed raw text between the
 * cell's pipes, escapes included. `a \| b` stays `a \| b`, `\*x\*` stays
 * `\*x\*` — the table renders it through real GFM parsing and structural
 * edits re-emit it unchanged, so existing escapes are never doubled.
 */

import { parser as markdownParser, GFM } from "@lezer/markdown";

const gfmParser = markdownParser.configure([GFM]);

const MIN_CELL_DASHES = /^:?-+:?$/;

/** True when `s[i]` is preceded by an odd run of backslashes. */
function isEscaped(s, i) {
  let n = 0;
  let j = i - 1;
  while (j >= 0 && s[j] === "\\") {
    n += 1;
    j -= 1;
  }
  return n % 2 === 1;
}

/**
 * A cell's value is its trimmed inline-Markdown source — escapes stay
 * exactly as written so `\|`, `\*` and `\\` sequences round-trip untouched.
 */
export function decodeTableCell(raw) {
  return raw.trim();
}

/**
 * Encode user-entered inline source for a cell span. Line breaks flatten
 * (GFM cells are single-line); a `\` is added only before an UNESCAPED
 * pipe — existing backslash runs and escapes pass through unchanged.
 * @param {string} value
 */
export function encodeTableCell(value) {
  const s = String(value ?? "").replace(/\r\n|\r|\n/g, " ");
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "|" && !isEscaped(s, i)) out += "\\";
    out += s[i];
  }
  return out;
}

/**
 * Split one table line into raw cell spans. Offsets are relative to the line
 * start and cover the text between delimiters, padding included — replacing a
 * span rewrites that cell and nothing else.
 * @param {string} line
 * @returns {{ from: number, to: number, raw: string }[]}
 */
function splitLineSpans(line) {
  const lead = /^\s*/.exec(line)[0].length;
  const end = line.length - /\s*$/.exec(line)[0].length;
  /** @type {number[]} */
  const delims = [];
  for (let i = lead; i < end; i += 1) {
    if (line[i] === "|" && !isEscaped(line, i)) delims.push(i);
  }
  let open = -1;
  let close = -1;
  if (delims.length > 0 && delims[0] === lead) open = delims[0];
  if (
    delims.length > 0 &&
    delims[delims.length - 1] === end - 1 &&
    delims[delims.length - 1] !== open
  ) {
    close = delims[delims.length - 1];
  }
  /** @type {{ from: number, to: number, raw: string }[]} */
  const cells = [];
  let segStart = open >= 0 ? open + 1 : 0;
  for (const d of delims) {
    if (d === open || d === close) continue;
    cells.push({ from: segStart, to: d, raw: line.slice(segStart, d) });
    segStart = d + 1;
  }
  const lastEnd = close >= 0 ? close : end;
  cells.push({ from: segStart, to: lastEnd, raw: line.slice(segStart, lastEnd) });
  return cells;
}

/** Split one pipe-table line into cell sources (escapes preserved). */
export function splitTableLine(line) {
  return splitLineSpans(line).map((c) => decodeTableCell(c.raw));
}

/** @param {string} cell one delimiter cell, already trimmed */
function alignmentOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

/**
 * Whole-source check through the real GFM parser: the source must contain
 * exactly one top-level Table node and nothing but whitespace around it.
 * Setext headings (`a\n---\nb`), a table plus a paragraph, and two tables
 * all fail — a widget range is never treated as a table unless it is one.
 * @returns {import("@lezer/common").SyntaxNode | null}
 */
function soleTableNode(source) {
  const tree = gfmParser.parse(source);
  /** @type {import("@lezer/common").SyntaxNode | null} */
  let table = null;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Table") {
      if (table) return null;
      table = node;
    } else if (source.slice(node.from, node.to).trim() !== "") {
      return null;
    }
  }
  return table;
}

/**
 * Parse a GFM table's source text into an editable model plus per-cell
 * source spans (offsets relative to the block start). The source is first
 * validated by the real @lezer/markdown GFM parser (one top-level Table,
 * whitespace only outside it). With `strict`, the header and delimiter
 * rows must carry the same cell count and a real pipe must be present.
 * Ragged body rows are legal — short rows pad out with `missing` spans
 * that the editor materializes on first write.
 *
 * @param {string} source
 * @param {{ strict?: boolean }} [opts]
 * @returns {null | {
 *   model: { header: string[], align: string[], body: string[][] },
 *   cells: { from: number, to: number, raw: string, missing?: boolean }[][],
 *   delimiter: { from: number, to: number },
 * }}
 */
export function parseTableDocument(source, opts = {}) {
  // CodeMirror docs are \n-normalized, but pasted source can arrive with
  // CRLF — and lezer's GFM table extension doesn't recognize it.
  source = source.replace(/\r\n?/g, "\n");
  const tableNode = soleTableNode(source);
  if (!tableNode) return null;

  const lines = source.split("\n");
  /** @type {{ line: string, start: number }[]} */
  const recs = [];
  let off = 0;
  for (const line of lines) {
    recs.push({ line, start: off });
    off += line.length + 1;
  }
  const inTable = recs.filter(
    (r) =>
      r.line.trim() !== "" &&
      r.start >= tableNode.from &&
      r.start < tableNode.to,
  );
  if (inTable.length < 2) return null;

  const [headerRec, delimRec] = inTable;
  const headerSpans = splitLineSpans(headerRec.line);
  const delimSpans = splitLineSpans(delimRec.line);
  if (headerSpans.length === 0 || delimSpans.length === 0) return null;
  /** @type {string[]} */
  const align = [];
  for (const s of delimSpans) {
    const t = s.raw.trim();
    if (!MIN_CELL_DASHES.test(t)) return null;
    align.push(alignmentOf(t));
  }
  if (opts.strict) {
    if (headerSpans.length !== delimSpans.length) return null;
    if (!headerRec.line.includes("|") && !delimRec.line.includes("|")) {
      return null;
    }
  }

  const bodyRecs = inTable.slice(2);
  const bodySpans = bodyRecs.map((r) => splitLineSpans(r.line));
  const cols = Math.max(
    headerSpans.length,
    align.length,
    ...bodySpans.map((r) => r.length),
  );
  if (cols === 0) return null;

  /** Pad `spans` to `cols` with zero-width missing markers at line end. */
  const pad = (spans, rec) => {
    /** @type {{ from: number, to: number, raw: string, missing?: boolean }[]} */
    const out = [];
    for (let c = 0; c < cols; c += 1) {
      const s = spans[c];
      if (s) {
        out.push({ from: rec.start + s.from, to: rec.start + s.to, raw: s.raw });
      } else {
        const at = rec.start + rec.line.length;
        out.push({ from: at, to: at, raw: "", missing: true });
      }
    }
    return out;
  };

  const cells = [pad(headerSpans, headerRec)];
  for (let i = 0; i < bodyRecs.length; i += 1) {
    cells.push(pad(bodySpans[i], bodyRecs[i]));
  }

  const model = {
    header: headerSpans.map((s) => decodeTableCell(s.raw)),
    align,
    body: bodySpans.map((row) => row.map((s) => decodeTableCell(s.raw))),
  };
  while (model.header.length < cols) model.header.push("");
  while (model.align.length < cols) model.align.push("");
  for (const row of model.body) while (row.length < cols) row.push("");

  return {
    model,
    cells,
    delimiter: {
      from: delimRec.start,
      to: delimRec.start + delimRec.line.length,
    },
  };
}

/**
 * Parse a GFM table's source text into an editable model.
 * @param {string} text
 * @returns {{ header: string[], align: string[], body: string[][] } | null}
 */
export function parseMarkdownTable(text) {
  return parseTableDocument(text)?.model ?? null;
}

/**
 * Serialize a model back to a pipe table, preserving column alignment and
 * escaping `|` inside cells.
 * @param {{ header: string[], align: string[], body: string[][] }} table
 */
export function serializeMarkdownTable(table) {
  const cols = Math.max(table.header.length, 1);
  const pad = (r) =>
    Array.from({ length: cols }, (_, i) => encodeTableCell(r[i] ?? "").trim());
  const delims = Array.from({ length: cols }, (_, i) => {
    const a = table.align[i];
    return a === "center"
      ? ":---:"
      : a === "right"
        ? "---:"
        : a === "left"
          ? ":---"
          : "---";
  });
  const row = (cells) => `| ${pad(cells).join(" | ")} |`;
  return [
    row(table.header),
    `| ${delims.join(" | ")} |`,
    ...table.body.map(row),
  ].join("\n");
}

/** @param {{ header: string[], align: string[], body: string[][] }} m */
export function cloneTableModel(m) {
  return { header: [...m.header], align: [...m.align], body: m.body.map((r) => [...r]) };
}

/**
 * @param {{ header: string[], align: string[], body: string[][] }} m
 * @param {number} r @param {number} c
 */
export function tableCellValue(m, r, c) {
  return r === 0 ? (m.header[c] ?? "") : (m.body[r - 1]?.[c] ?? "");
}

// ── structure operations (all return a new model) ────────────

const emptyRow = (cols) => Array.from({ length: cols }, () => "");

/**
 * Insert one empty body row before row `atR` (r-space; clamped to the body
 * range, so 1 inserts at the top and rows+1 appends).
 */
export function insertTableRow(m, atR) {
  const next = cloneTableModel(m);
  const at = Math.min(Math.max(atR, 1), next.body.length + 1);
  next.body.splice(at - 1, 0, emptyRow(next.header.length));
  return next;
}

/** Delete body row `r` — the header row (r = 0) is never removed. */
export function deleteTableRow(m, r) {
  if (r < 1 || r > m.body.length) return null;
  const next = cloneTableModel(m);
  next.body.splice(r - 1, 1);
  return next;
}

/** Insert one empty column before column `atC` (cols appends). */
export function insertTableCol(m, atC) {
  const next = cloneTableModel(m);
  const at = Math.min(Math.max(atC, 0), next.header.length);
  next.header.splice(at, 0, "");
  next.align.splice(at, 0, "");
  for (const row of next.body) row.splice(at, 0, "");
  return next;
}

/** Delete column `c`; refuses to remove the last column. */
export function deleteTableCol(m, c) {
  if (c < 0 || c >= m.header.length || m.header.length <= 1) return null;
  const next = cloneTableModel(m);
  next.header.splice(c, 1);
  next.align.splice(c, 1);
  for (const row of next.body) row.splice(c, 1);
  return next;
}

/** Set column `c`'s alignment; align ∈ ""|left|center|right. */
export function setTableAlign(m, c, align) {
  const next = cloneTableModel(m);
  if (c >= 0 && c < next.align.length) next.align[c] = align;
  return next;
}

/**
 * Stable body-row sort on one column. Empties sink to the bottom in either
 * direction; the header is untouched. Intl.Collator's numeric option orders
 * digit runs naturally ("2" before "10").
 * @param {1|-1} dir
 */
export function sortTableRows(m, c, dir) {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const next = cloneTableModel(m);
  const keyed = next.body.map((row, i) => ({ row, i }));
  keyed.sort((a, b) => {
    const av = a.row[c] ?? "";
    const bv = b.row[c] ?? "";
    if (av === "" && bv === "") return a.i - b.i;
    if (av === "") return 1;
    if (bv === "") return -1;
    const cmp = collator.compare(av, bv);
    return cmp !== 0 ? cmp * dir : a.i - b.i;
  });
  next.body = keyed.map((k) => k.row);
  return next;
}
