/** @param {import("@codemirror/state").Text} doc */
export function countDocumentWords(doc, first = 1, last = doc.lines) {
  const lines = doc.iterLines(first, last + 1);
  let words = 0;
  for (let next = lines.next(); !next.done; next = lines.next()) {
    const text = next.value.trim();
    if (text) words += text.split(/\s+/).length;
  }
  return words;
}

/**
 * Recount only the lines touched by a transaction, including both sides of
 * a split or joined line. Multiple edits on one line count that line once.
 * @param {number} previous
 * @param {import("@codemirror/state").Text} before
 * @param {import("@codemirror/state").Text} after
 * @param {import("@codemirror/state").ChangeSet} changes
 */
export function updateDocumentWords(previous, before, after, changes) {
  let words = previous;
  let lastBefore = 0;
  let lastAfter = 0;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const endBefore = before.lineAt(toA).number;
    const endAfter = after.lineAt(toB).number;
    const startBefore = Math.max(lastBefore + 1, before.lineAt(fromA).number);
    const startAfter = Math.max(lastAfter + 1, after.lineAt(fromB).number);
    if (startBefore <= endBefore) words -= countDocumentWords(before, startBefore, endBefore);
    if (startAfter <= endAfter) words += countDocumentWords(after, startAfter, endAfter);
    lastBefore = endBefore;
    lastAfter = endAfter;
  });
  return words;
}
