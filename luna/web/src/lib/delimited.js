/** RFC-4180-ish delimited text (csv/tsv) parsing for the table preview. */

const SNIFF_CANDIDATES = [",", "\t", ";", "|"];

/**
 * Pick the most likely delimiter by counting occurrences outside quotes on
 * the first non-empty lines. The winner must appear on every sampled line —
 * a delimiter that's only sometimes present is just punctuation in a field.
 * @param {string} text
 * @returns {string}
 */
export function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "").slice(0, 10);
  if (lines.length === 0) return ",";
  let best = ",";
  let bestCount = 0;
  for (const d of SNIFF_CANDIDATES) {
    const count = countOutsideQuotes(lines[0], d);
    if (count === 0) continue;
    const consistent = lines.every((l) => countOutsideQuotes(l, d) === count);
    if (consistent && count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** @param {string} line @param {string} d */
function countOutsideQuotes(line, d) {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && ch === d) {
      count++;
    }
  }
  return count;
}

/**
 * Parse delimited text into rows of strings. Handles `"…"` quoting, `""`
 * escapes, CRLF/LF line endings, and a UTF-8 BOM. An empty delimiter means
 * "sniff it" — pass "\t" explicitly for .tsv so a tab in data can't be
 * confused for structure.
 * @param {string} text
 * @param {string} [delimiter]
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? sniffDelimiter(src);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  // A quote only opens a field at position 0 — embedded quotes stay literal.
  let fieldStart = true;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStart = true;
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
          i++;
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
    } else if (ch === d) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  // Trailing row: a file ending in a newline leaves `row` empty with no
  // field content — only push when something was actually read.
  if (field !== "" || row.length > 0) endRow();
  // Drop a fully-empty trailing row from a final bare newline.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
    rows.pop();
  }
  return rows;
}
