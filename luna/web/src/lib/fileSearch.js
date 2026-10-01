// The all-files search lives in one place (AppShell). Anything can open it —
// the header button, a keyboard shortcut — by sending this event.
export const OPEN_FILE_SEARCH_EVENT = "luna:open-file-search";

export function openFileSearch() {
  window.dispatchEvent(new Event(OPEN_FILE_SEARCH_EVENT));
}

/** Shortest text Luna will search for. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * @param {string} q
 * @param {"all" | "dir" | "file"} [kind]
 */
export function searchUrl(q, kind = "all") {
  const base = `/api/v1/search?q=${encodeURIComponent(q)}`;
  return kind === "all" ? base : `${base}&kind=${kind}`;
}

/**
 * @typedef {{
 *   drive_id: string, path: string, parent: string, name: string,
 *   kind: string, size: number, modified: number,
 *   match: "name" | "close",
 * }} SearchHit
 * @typedef {{
 *   scanning: boolean, drives_total: number, drives_done: number,
 *   dirs_indexed: number | null,
 * }} ScanStatus
 */

/**
 * The `/api/v1/search` answer in a predictable shape.
 * @param {any} data
 * @returns {{ hits: SearchHit[], closeOnly: boolean, scan: ScanStatus | null }}
 */
export function parseSearchResponse(data) {
  return {
    hits: Array.isArray(data?.hits) ? data.hits : [],
    closeOnly: Boolean(data?.close_only),
    scan: data?.scan ?? null,
  };
}

/**
 * Split a name into runs, flagging the ones that match what was typed so the
 * row can underline them. Matching ignores case; each word is looked up
 * separately.
 * @param {string} name
 * @param {string} query
 * @returns {{ text: string, hit: boolean }[]}
 */
export function highlightParts(name, query) {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
  if (!words.length) return [{ text: name, hit: false }];
  const lower = name.toLowerCase();
  // Same length as `name` only when lowercasing didn't change any letter's
  // width; otherwise skip highlighting rather than underline the wrong letters.
  if (lower.length !== name.length) return [{ text: name, hit: false }];
  /** @type {boolean[]} */
  const marked = new Array(name.length).fill(false);
  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      for (let i = at; i < at + word.length; i += 1) marked[i] = true;
      from = at + word.length;
    }
  }
  /** @type {{ text: string, hit: boolean }[]} */
  const parts = [];
  for (let i = 0; i < name.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marked[i]) last.text += name[i];
    else parts.push({ text: name[i], hit: marked[i] });
  }
  return parts;
}
