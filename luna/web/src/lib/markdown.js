/**
 * Markdown helpers for the drive file editor. Detection lives in
 * fileKinds.js — `openableKind(name)` returns "markdown" for .md/.markdown.
 */

/**
 * Count how many times `char` repeats immediately left of `index` (dir < 0)
 * or starting at `index` going right (dir > 0).
 * @param {string} value
 * @param {number} index
 * @param {string} char
 * @param {-1|1} dir
 */
function countRun(value, index, char, dir) {
  let n = 0;
  if (dir < 0) {
    for (let i = index - 1; i >= 0 && value[i] === char; i -= 1) n += 1;
  } else {
    for (let i = index; i < value.length && value[i] === char; i += 1) n += 1;
  }
  return n;
}

/**
 * Toggle bold (`**`) or italic (`*`) around the selection using star-run
 * counts so the two markers nest instead of stealing each other's edges.
 * Bold is on when both sides have at least two `*`; italic is on when both
 * sides have an odd count. That way italic on `**bold**` becomes
 * `***bold***`, and bold on `***x***` leaves `*x*`.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {1|2} markerLen
 * @param {string} placeholder
 * @returns {{ text: string, start: number, end: number }}
 */
function wrapStarEmphasis(value, start, end, markerLen, placeholder) {
  const selected = value.slice(start, end);
  const left = countRun(value, start, "*", -1);
  const right = countRun(value, end, "*", 1);
  const active =
    markerLen === 2
      ? left >= 2 && right >= 2
      : left > 0 && right > 0 && left % 2 === 1 && right % 2 === 1;

  if (active) {
    const text =
      value.slice(0, start - markerLen) + selected + value.slice(end + markerLen);
    const nextStart = start - markerLen;
    return { text, start: nextStart, end: nextStart + selected.length };
  }

  const marker = markerLen === 2 ? "**" : "*";
  const inner = selected || placeholder;
  const text = value.slice(0, start) + marker + inner + marker + value.slice(end);
  return {
    text,
    start: start + markerLen,
    end: start + markerLen + inner.length,
  };
}

/**
 * Wrap the selection in before/after markers (e.g. backticks for code).
 * Toggles the markers off when the selection is already wrapped. With an
 * empty selection, inserts `placeholder` and selects it so typing replaces it.
 *
 * @returns {{ text: string, start: number, end: number }}
 */
function wrapSelection(value, start, end, before, after, placeholder) {
  const selected = value.slice(start, end);
  const alreadyWrapped =
    start >= before.length &&
    end + after.length <= value.length &&
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after;
  if (alreadyWrapped) {
    const text = value.slice(0, start - before.length) + selected + value.slice(end + after.length);
    const nextStart = start - before.length;
    return { text, start: nextStart, end: nextStart + selected.length };
  }
  const inner = selected || placeholder;
  const text = value.slice(0, start) + before + inner + after + value.slice(end);
  return { text, start: start + before.length, end: start + before.length + inner.length };
}

/**
 * Add a line prefix (e.g. "## " or "- ") to every line touching the
 * selection. Toggles the prefix off when every non-blank line already has
 * it. Selects the affected block afterwards.
 *
 * @returns {{ text: string, start: number, end: number }}
 */
function prefixLines(value, start, end, prefix) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const nonBlank = lines.filter((line) => line.trim() !== "");
  const remove = nonBlank.length > 0 && nonBlank.every((line) => line.startsWith(prefix));
  const nextBlock = lines
    .map((line) => {
      if (line.trim() === "") return line;
      return remove ? line.slice(prefix.length) : prefix + line;
    })
    .join("\n");
  const text = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
  return { text, start: lineStart, end: lineStart + nextBlock.length };
}

/**
 * Apply a toolbar formatting action to `value` around selection [start, end).
 * Returns the new text plus the selection range to restore after render.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {string} action One of "bold" | "italic" | "code" | "link" | "heading" | "list".
 *   Unknown actions return the input unchanged.
 * @returns {{ text: string, start: number, end: number }}
 */
export function applyMarkdownAction(value, start, end, action) {
  switch (action) {
    case "bold":
      return wrapStarEmphasis(value, start, end, 2, "bold text");
    case "italic":
      return wrapStarEmphasis(value, start, end, 1, "italic text");
    case "code":
      return wrapSelection(value, start, end, "`", "`", "code");
    case "link": {
      const label = value.slice(start, end) || "link text";
      const url = "https://";
      const text = `${value.slice(0, start)}[${label}](${url})${value.slice(end)}`;
      // Select the placeholder scheme so pasting or typing replaces it.
      const urlStart = start + label.length + 3;
      return { text, start: urlStart, end: urlStart + url.length };
    }
    case "heading":
      return prefixLines(value, start, end, "## ");
    case "list":
      return prefixLines(value, start, end, "- ");
    default:
      return { text: value, start, end };
  }
}
