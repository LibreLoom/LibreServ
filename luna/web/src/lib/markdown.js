/**
 * Markdown helpers for the drive file editor. Detection lives in
 * fileKinds.js — `openableKind(name)` returns "markdown" for .md/.markdown.
 */

/**
 * Wrap the selection in before/after markers (e.g. `**` for bold). Toggles
 * the markers off when the selection is already wrapped. With an empty
 * selection, inserts `placeholder` and selects it so typing replaces it.
 *
 * @returns {{ text: string, start: number, end: number }}
 */
function wrapSelection(value, start, end, before, after, placeholder) {
  const selected = value.slice(start, end);
  const alreadyWrapped =
    start >= before.length &&
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

function setHeadingLines(value, start, end, level) {
  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", last);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const changes = [];
  let from = lineStart;
  for (const line of value.slice(lineStart, lineEnd).split("\n")) {
    if (line.trim() || start === end) {
      const match = /^( {0,3})(?:#{1,6}(?:[ \t]+|$))?/.exec(line);
      const indent = line.trim() ? match[1] : "";
      const to = from + (line.trim() ? match[0].length : line.length);
      changes.push({ from, to, insert: `${indent}${"#".repeat(level)} ` });
    }
    from += line.length + 1;
  }
  const mapPosition = (pos) => {
    let delta = 0;
    for (const change of changes) {
      if (pos < change.from) break;
      if (pos <= change.to) return change.from + delta + change.insert.length;
      delta += change.insert.length - (change.to - change.from);
    }
    return pos + delta;
  };
  let text = "";
  let offset = 0;
  for (const change of changes) {
    text += value.slice(offset, change.from) + change.insert;
    offset = change.to;
  }
  text += value.slice(offset);
  return { text, start: mapPosition(start), end: mapPosition(end) };
}

/**
 * Apply a toolbar formatting action to `value` around selection [start, end).
 * Returns the new text plus the selection range to restore after render.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {string} action One of "bold" | "italic" | "strikethrough" | "code" |
 *   "link" | "heading" | "list" | "task" | "quote" | "codeblock" | "table" | "hr".
 *   Unknown actions return the input unchanged.
 * @returns {{ text: string, start: number, end: number }}
 */
export function applyMarkdownAction(value, start, end, action) {
  if (/^heading[1-6]$/.test(action)) {
    return setHeadingLines(value, start, end, Number(action.slice(-1)));
  }
  switch (action) {
    case "bold":
      return wrapSelection(value, start, end, "**", "**", "bold text");
    case "italic":
      return wrapSelection(value, start, end, "*", "*", "italic text");
    case "strikethrough":
      return wrapSelection(value, start, end, "~~", "~~", "crossed-out text");
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
    case "task":
      return prefixLines(value, start, end, "- [ ] ");
    case "quote":
      return prefixLines(value, start, end, "> ");
    case "codeblock": {
      const selected = value.slice(start, end) || "code";
      const needsLeadBreak = start > 0 && value[start - 1] !== "\n";
      const lead = needsLeadBreak ? "\n" : "";
      const block = `${lead}\`\`\`\n${selected}\n\`\`\`\n`;
      const text = value.slice(0, start) + block + value.slice(end);
      const innerStart = start + lead.length + 4;
      return { text, start: innerStart, end: innerStart + selected.length };
    }
    case "table": {
      const needsLeadBreak = start > 0 && value[start - 1] !== "\n";
      const lead = needsLeadBreak ? "\n" : "";
      const table = `${lead}| Column | Column |\n| ------ | ------ |\n|        |        |\n`;
      const text = value.slice(0, start) + table + value.slice(end);
      // Cursor lands after the block so the live preview renders the
      // editable grid right away instead of revealing the raw pipes.
      const pos = start + table.length;
      return { text, start: pos, end: pos };
    }
    case "hr": {
      const lead = start > 0 && value[start - 1] !== "\n" ? "\n\n" : start > 0 ? "\n" : "";
      const rule = `${lead}---\n`;
      const text = value.slice(0, start) + rule + value.slice(end);
      const pos = start + rule.length;
      return { text, start: pos, end: pos };
    }
    default:
      return { text: value, start, end };
  }
}
