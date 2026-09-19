/**
 * Pure pipe-table model for the Markdown table editor: source-span parsing,
 * rectangular selections, clipboard formats (TSV/CSV/Markdown) and structure
 * operations. No DOM or CodeMirror imports — the CM side lives in
 * markdownTables.js and the React grid in MarkdownTableEditor.jsx.
 *
 * Coordinates are grid-space: r = 0 is the header row, r >= 1 are body rows.
 * The delimiter row is structural only — it carries `align` and is never a
 * selectable cell.
 *
 * Cell values are INLINE MARKDOWN SOURCE: the trimmed raw text between the
 * cell's pipes, escapes included. `a \| b` stays `a \| b`, `\*x\*` stays
 * `\*x\*` — the grid renders it through real GFM parsing and structural
 * edits re-emit it unchanged, so existing escapes are never doubled.
 */

import { parser as markdownParser, GFM } from "@lezer/markdown";

const gfmParser = markdownParser.configure([GFM]);

const MIN_CELL_DASHES = /^:?-+:?$/;

// Paste/import safety bounds — checked before any allocation.
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_CLIPBOARD_CELLS = 20000;
export const MAX_CLIPBOARD_COLS = 200;
export const MAX_PASTE_EXPANSION = 20000;

// The editor's own clipboard MIME — a rectangular copy also rides along as
// JSON so a one-column block pastes back as rows, not a single blob.
export const TABLE_CLIPBOARD_MIME = "application/x-luna-table+json";

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
 * all fail — the source dialog may never replace the range with prose.
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
 * @param {{ strict?: boolean, maxCells?: number }} [opts]
 *   `maxCells` refuses (returns null) before the padded model is allocated
 *   when the squared-up grid would exceed it — the clipboard/import cap.
 * @returns {null | {
 *   model: { header: string[], align: string[], body: string[][] },
 *   cells: { from: number, to: number, raw: string, missing?: boolean }[][],
 *   delimiter: { from: number, to: number },
 * }}
 */
export function parseTableDocument(source, opts = {}) {
  // CodeMirror docs are \n-normalized, but dialog/import input can arrive
  // with CRLF — and lezer's GFM table extension doesn't recognize it.
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
  if (opts.maxCells != null && (bodyRecs.length + 1) * cols > opts.maxCells) {
    return null;
  }

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

// ── selections ───────────────────────────────────────────────

/** @typedef {{ r: number, c: number }} TableCellRef */

/**
 * Normalize an anchor/head pair into a rectangle (r = 0 is the header).
 * @param {TableCellRef} anchor @param {TableCellRef} [head]
 */
export function tableSelection(anchor, head = anchor) {
  return {
    top: Math.min(anchor.r, head.r),
    bottom: Math.max(anchor.r, head.r),
    left: Math.min(anchor.c, head.c),
    right: Math.max(anchor.c, head.c),
  };
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

/**
 * @param {{ header: string[], align: string[], body: string[][] }} m
 * @param {number} r @param {number} c @param {string} value
 */
export function setTableCell(m, r, c, value) {
  const next = cloneTableModel(m);
  if (r === 0) next.header[c] = value;
  else if (next.body[r - 1]) next.body[r - 1][c] = value;
  return next;
}

// ── structure operations (all return a new model) ────────────

const emptyRow = (cols) => Array.from({ length: cols }, () => "");

/**
 * Insert `count` empty body rows before row `atR` (r-space; clamped to the
 * body range, so 1 inserts at the top and rows+1 appends).
 */
export function insertTableRows(m, atR, count = 1) {
  const next = cloneTableModel(m);
  const at = Math.min(Math.max(atR, 1), next.body.length + 1);
  next.body.splice(at - 1, 0, ...Array.from({ length: count }, () => emptyRow(next.header.length)));
  return next;
}

/** Delete body rows whose r index falls in [top, bottom] (header r=0 never). */
export function deleteTableRows(m, top, bottom) {
  const next = cloneTableModel(m);
  const lo = Math.max(top, 1);
  const hi = Math.min(bottom, next.body.length);
  if (lo > hi) return null;
  next.body.splice(lo - 1, hi - lo + 1);
  return next;
}

/** Move the body-row block [top, bottom] one step; dir = -1 up, +1 down. */
export function moveTableRows(m, top, bottom, dir) {
  const lo = Math.max(top, 1);
  const hi = Math.min(bottom, m.body.length);
  if (lo > hi) return null;
  const next = cloneTableModel(m);
  const rows = next.body;
  const i = lo - 1;
  const j = hi - 1;
  if (dir < 0 && i > 0) {
    const [above] = rows.splice(i - 1, 1);
    rows.splice(j, 0, above);
  } else if (dir > 0 && j < rows.length - 1) {
    const [below] = rows.splice(j + 1, 1);
    rows.splice(i, 0, below);
  } else {
    return null;
  }
  return next;
}

/** Duplicate the body-row block [top, bottom] right after it. */
export function duplicateTableRows(m, top, bottom) {
  const lo = Math.max(top, 1);
  const hi = Math.min(bottom, m.body.length);
  if (lo > hi) return null;
  const next = cloneTableModel(m);
  const copy = next.body.slice(lo - 1, hi).map((r) => [...r]);
  next.body.splice(hi, 0, ...copy);
  return next;
}

/**
 * Attach a non-enumerable `colMap` (new index → old index, null for fresh
 * columns) so session-only column widths can follow the data.
 */
const withColMap = (next, map) => {
  Object.defineProperty(next, "colMap", { value: map, enumerable: false });
  return next;
};

/**
 * Remap a widths array across the column op that produced `next` — returns
 * the moved widths, or null when the op didn't reorder columns.
 * @param {(number|undefined)[]} widths @param {object} next
 */
export function moveColumnWidths(widths, next) {
  const map = next?.colMap;
  if (!map) return null;
  /** @type {(number|undefined)[]} */
  const out = [];
  for (let c = 0; c < map.length; c += 1) {
    const w = map[c] == null ? undefined : widths[map[c]];
    if (w !== undefined) out[c] = w;
  }
  return out;
}

/** Insert `count` empty columns before column `atC` (cols appends). */
export function insertTableCols(m, atC, count = 1) {
  const next = cloneTableModel(m);
  const at = Math.min(Math.max(atC, 0), next.header.length);
  const add = emptyRow(count);
  next.header.splice(at, 0, ...add);
  next.align.splice(at, 0, ...emptyRow(count));
  for (const row of next.body) row.splice(at, 0, ...emptyRow(count));
  const map = Array.from({ length: next.header.length }, (_, c) =>
    c < at ? c : c < at + count ? null : c - count,
  );
  return withColMap(next, map);
}

/** Delete columns [left, right]; refuses to remove the last column. */
export function deleteTableCols(m, left, right) {
  const lo = Math.max(left, 0);
  const hi = Math.min(right, m.header.length - 1);
  if (lo > hi || m.header.length - (hi - lo + 1) < 1) return null;
  const next = cloneTableModel(m);
  next.header.splice(lo, hi - lo + 1);
  next.align.splice(lo, hi - lo + 1);
  for (const row of next.body) row.splice(lo, hi - lo + 1);
  const gone = hi - lo + 1;
  const map = Array.from({ length: next.header.length }, (_, c) =>
    c < lo ? c : c + gone,
  );
  return withColMap(next, map);
}

/** Move the column block [left, right] one step; dir = -1 left, +1 right. */
export function moveTableCols(m, left, right, dir) {
  const lo = Math.max(left, 0);
  const hi = Math.min(right, m.header.length - 1);
  if (lo > hi) return null;
  if (dir < 0 && lo === 0) return null;
  if (dir > 0 && hi === m.header.length - 1) return null;
  const next = cloneTableModel(m);
  const shift = (arr) => {
    if (dir < 0) {
      const [item] = arr.splice(lo - 1, 1);
      arr.splice(hi, 0, item);
    } else {
      const [item] = arr.splice(hi + 1, 1);
      arr.splice(lo, 0, item);
    }
  };
  shift(next.header);
  shift(next.align);
  for (const row of next.body) shift(row);
  const n = next.header.length;
  const map = Array.from({ length: n }, (_, c) => {
    if (dir < 0) {
      if (c < lo - 1) return c;
      if (c < hi) return c + 1;
      if (c === hi) return lo - 1;
      return c;
    }
    if (c < lo) return c;
    if (c === lo) return hi + 1;
    if (c <= hi + 1) return c - 1;
    return c;
  });
  return withColMap(next, map);
}

/** Duplicate the column block [left, right] right after it. */
export function duplicateTableCols(m, left, right) {
  const lo = Math.max(left, 0);
  const hi = Math.min(right, m.header.length - 1);
  if (lo > hi) return null;
  const next = cloneTableModel(m);
  const slice = (arr) => arr.slice(lo, hi + 1);
  next.header.splice(hi + 1, 0, ...slice(next.header));
  next.align.splice(hi + 1, 0, ...slice(next.align));
  for (const row of next.body) row.splice(hi + 1, 0, ...slice(row));
  const count = hi - lo + 1;
  const map = Array.from({ length: next.header.length }, (_, c) =>
    c <= hi ? c : c <= hi + count ? lo + (c - hi - 1) : c - count,
  );
  return withColMap(next, map);
}

/** Set alignment on columns [left, right]; align ∈ ""|left|center|right. */
export function setTableAlign(m, left, right, align) {
  const next = cloneTableModel(m);
  const lo = Math.max(left, 0);
  const hi = Math.min(right, next.header.length - 1);
  for (let c = lo; c <= hi; c += 1) next.align[c] = align;
  return next;
}

/** Clear every cell in the rectangle (header cells included). */
export function clearTableCells(m, sel) {
  const next = cloneTableModel(m);
  for (let r = sel.top; r <= sel.bottom; r += 1) {
    for (let c = sel.left; c <= sel.right; c += 1) {
      if (r === 0) next.header[c] = "";
      else if (next.body[r - 1]) next.body[r - 1][c] = "";
    }
  }
  return next;
}

/** Fill every cell in the rectangle with `value`. */
export function fillTableCells(m, sel, value) {
  const next = cloneTableModel(m);
  for (let r = sel.top; r <= sel.bottom; r += 1) {
    for (let c = sel.left; c <= sel.right; c += 1) {
      if (r === 0) next.header[c] = value;
      else if (next.body[r - 1]) next.body[r - 1][c] = value;
    }
  }
  return next;
}

/**
 * Paste a rectangle of cell values with its top-left at (r, c). The final
 * model is allocated once — rows and columns are appended when the
 * clipboard block outgrows the table; header cells can be overwritten.
 */
export function pasteTableRows(m, r, c, rows) {
  if (!rows.length) return null;
  const width = Math.max(...rows.map((row) => row.length));
  const cols = Math.max(m.header.length, c + width);
  const bodyLen = Math.max(m.body.length, r + rows.length - 1);
  const next = {
    header: Array.from({ length: cols }, (_, i) => m.header[i] ?? ""),
    align: Array.from({ length: cols }, (_, i) => m.align[i] ?? ""),
    body: Array.from({ length: bodyLen }, (_, i) => {
      const src = m.body[i];
      return Array.from({ length: cols }, (_, j) => src?.[j] ?? "");
    }),
  };
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < rows[i].length; j += 1) {
      const rr = r + i;
      const cc = c + j;
      if (rr === 0) next.header[cc] = rows[i][j];
      else next.body[rr - 1][cc] = rows[i][j];
    }
  }
  return next;
}

/**
 * Stable body-row sort on one column. Empties sink to the bottom in either
 * direction; the header is untouched. No type coercion — Intl.Collator's
 * numeric option only orders digit runs inside strings.
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

// ── clipboard / delimited formats ────────────────────────────

/**
 * Lossless delimited parse (RFC-4180-ish). Unlike lib/delimited's
 * parseDelimited, empty trailing cells AND rows survive — a copied 3×2
 * rectangle pastes back as 3×2, and a terminal `""` keeps an empty final
 * row. Fields may contain embedded newlines when quoted; callers get
 * `normalizedLineBreaks` so they can warn. An unterminated quoted field is
 * a hard error rather than silently swallowing the rest of the file.
 * @param {string} text @param {string} d single-char delimiter
 * @returns {{ rows: string[][], normalizedLineBreaks: boolean, error?: string }}
 */
export function parseDelimitedRows(text, d) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let rowTouched = false;
  let normalizedLineBreaks = false;

  const endField = () => {
    if (/[\r\n]/.test(field)) normalizedLineBreaks = true;
    row.push(field);
    field = "";
    fieldStart = true;
    rowTouched = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
      rowTouched = true;
    } else if (ch === d) {
      endField();
      rowTouched = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRow();
    } else {
      field += ch;
      fieldStart = false;
      rowTouched = true;
    }
  }
  if (quoted) {
    return {
      rows,
      normalizedLineBreaks,
      error:
        'The data has an unmatched " — check the quoting and try again.',
    };
  }
  if (rowTouched) endRow();
  return { rows, normalizedLineBreaks };
}

/**
 * Serialize rows to CSV/TSV. Fields containing the delimiter, quotes or
 * line breaks are RFC-quoted; a row that is a single empty cell is written
 * as `""` so a trailing empty row survives the round trip (a bare final
 * newline would drop it). With `safe`, a cell whose first non-space
 * character is `=`, `+`, `-` or `@` gets a leading apostrophe so common
 * spreadsheet apps don't execute it as a formula — a mitigation for those
 * apps, not a guarantee; the source Markdown is untouched either way.
 * @param {string[][]} rows @param {string} delimiter @param {boolean} [safe]
 */
export function serializeDelimitedRows(rows, delimiter, safe = false) {
  const lines = rows.map((row) => {
    if (row.length === 1 && (row[0] ?? "") === "") return '""';
    return row
      .map((cell) => {
        let f = String(cell ?? "");
        if (safe && (/^\s*[=+\-@]/.test(f) || /^[\t\r\n]/.test(f))) {
          f = `'${f}`;
        }
        if (f.includes('"') || f.includes(delimiter) || /[\r\n]/.test(f)) {
          f = `"${f.replace(/"/g, '""')}"`;
        }
        return f;
      })
      .join(delimiter);
  });
  return lines.join("\n");
}

/**
 * Cells the padded grid would need for `source`, counted without building
 * the model — nonblank table lines (minus the delimiter row) × the widest
 * row's cell count. Returns 0 when the source isn't a single table.
 * @param {string} source
 */
export function paddedCellEstimate(source) {
  const tableNode = soleTableNode(source);
  if (!tableNode) return 0;
  let off = 0;
  let lines = 0;
  let cols = 0;
  for (const line of source.split("\n")) {
    const start = off;
    off += line.length + 1;
    if (
      line.trim() === "" ||
      start < tableNode.from ||
      start >= tableNode.to
    ) {
      continue;
    }
    lines += 1;
    cols = Math.max(cols, splitLineSpans(line).length);
  }
  return lines > 1 ? (lines - 1) * cols : 0;
}

/**
 * Bounds-check a parsed row block BEFORE any rectangular allocation —
 * the padded product is what the grid actually allocates, not the sum of
 * ragged row lengths. Returns an actionable error string or null.
 * @param {unknown} rows
 */
export function validateTableRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "Nothing to paste — the data is empty.";
  }
  if (rows.length > MAX_CLIPBOARD_CELLS) {
    return `That's ${rows.length.toLocaleString()} rows — split the data into chunks under ${MAX_CLIPBOARD_CELLS.toLocaleString()}.`;
  }
  let width = 0;
  let text = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) {
      return "The data has an empty or malformed row — check the paste source.";
    }
    if (row.length > MAX_CLIPBOARD_COLS) {
      return `A row has ${row.length} columns — tables cap at ${MAX_CLIPBOARD_COLS}. Split the data first.`;
    }
    if (row.length > width) width = row.length;
    for (const cell of row) {
      if (typeof cell !== "string") {
        return "The data isn't plain text — paste CSV/TSV or Markdown table text.";
      }
      text += cell.length;
      if (text > MAX_CLIPBOARD_BYTES) {
        return "That's over 1 MB of cell text — split the data up first.";
      }
    }
  }
  if (rows.length * width > MAX_CLIPBOARD_CELLS) {
    return `That's about ${(rows.length * width).toLocaleString()} cells once the rows are squared up — split the data or use Table ▸ Markdown source.`;
  }
  return null;
}

/**
 * Parse clipboard text into table rows.
 *
 * `format` — "auto" | "markdown" | "tsv" | "csv". Auto never guesses CSV
 * (comma-laden prose stays a single cell) unless `opts.sniffCsv` is set —
 * the Import dialog opts in, ordinary paste does not. Auto falls back to a
 * TSV parse with no tabs present, so pasted single-column data becomes one
 * row per line and quoted newlines still flag `normalizedLineBreaks`.
 *
 * @param {string} text
 * @param {string} [format]
 * @param {{ sniffCsv?: boolean }} [opts]
 * @returns {{
 *   rows?: string[][],
 *   normalizedLineBreaks?: boolean,
 *   format?: string,
 *   error?: string,
 * }}
 */
export function parseTableClipboard(text, format = "auto", opts = {}) {
  if (text == null || text === "") {
    return { error: "Nothing to paste — the clipboard is empty." };
  }
  if (text.length > MAX_CLIPBOARD_BYTES) {
    return {
      error:
        "That's over 1 MB of data — split it into chunks or paste it through Table ▸ Markdown source.",
    };
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const asMarkdown = () => {
    const parsed = parseTableDocument(src, {
      strict: true,
      maxCells: MAX_CLIPBOARD_CELLS,
    });
    if (!parsed) {
      // A bounded parse failure on table-shaped text can only be the cell
      // cap — report the real reason instead of "not a table".
      if (paddedCellEstimate(src) > MAX_CLIPBOARD_CELLS) {
        return {
          error: `That table would need over ${MAX_CLIPBOARD_CELLS.toLocaleString()} cells once the rows are squared up — split it first.`,
        };
      }
      return null;
    }
    const rows = [parsed.model.header, ...parsed.model.body];
    const invalid = validateTableRows(rows);
    if (invalid) return { error: invalid };
    return { rows, normalizedLineBreaks: false, format: "markdown" };
  };

  if (format === "markdown") {
    return (
      asMarkdown() ?? {
        error:
          "That isn't a valid Markdown table — it needs a header row and a | --- | divider row, and nothing else.",
      }
    );
  }
  if (format === "auto") {
    const md = asMarkdown();
    if (md) return md;
  }

  let d = null;
  if (format === "csv") d = ",";
  else if (format === "tsv") d = "\t";
  else if (src.includes("\t")) d = "\t";
  else if (opts.sniffCsv && src.includes(",")) d = ",";
  else if (format === "auto") d = "\t";
  if (d) {
    const parsed = parseDelimitedRows(src, d);
    if (parsed.error) return { error: parsed.error };
    const rows = parsed.rows;
    if (rows.length === 0) return { error: "No rows found in that data." };
    const invalid = validateTableRows(rows);
    if (invalid) return { error: invalid };
    return {
      rows,
      normalizedLineBreaks: parsed.normalizedLineBreaks,
      format: d === "\t" ? "tsv" : "csv",
    };
  }

  return { error: "No usable table data found in that text." };
}

/** Flatten one clipboard cell for a single-line Markdown table cell. */
export function normalizeClipboardCell(value) {
  return String(value ?? "").replace(/\r\n|\r|\n/g, " ");
}
