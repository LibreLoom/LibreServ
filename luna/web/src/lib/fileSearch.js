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
 *   drives_failed?: number, dirs_indexed: number | null,
 * }} ScanStatus
 */

/**
 * The `/api/v1/search` answer in a predictable shape.
 * @param {any} data
 * @returns {{ hits: SearchHit[], closeOnly: boolean, truncated: boolean, scan: ScanStatus | null }}
 */
export function parseSearchResponse(data) {
  return {
    hits: Array.isArray(data?.hits) ? data.hits : [],
    closeOnly: Boolean(data?.close_only),
    truncated: Boolean(data?.truncated),
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

const KINDS = ["all", "dir", "file"];
const KIND_KEY = "luna.fileSearch.kind";

/** The Folders / Files choice from last time ("all" when none or unreadable). */
export function loadSearchKind() {
  try {
    const saved = window.localStorage.getItem(KIND_KEY);
    return KINDS.includes(saved) ? /** @type {"all" | "dir" | "file"} */ (saved) : "all";
  } catch {
    return "all";
  }
}

/** @param {"all" | "dir" | "file"} kind */
export function saveSearchKind(kind) {
  try {
    window.localStorage.setItem(KIND_KEY, kind);
  } catch {
    // Remembering is a convenience; private windows may refuse.
  }
}

/**
 * Where a hit lives, ending on the folder it is in: `Drive / … / 2024 / Spain`.
 * Long paths drop their middle so the part that tells folders apart stays.
 * @param {string} driveLabel
 * @param {string} folder drive-relative folder path ("" for the top)
 */
export function locationParts(driveLabel, folder) {
  const parts = folder ? folder.split("/").filter(Boolean) : [];
  const shown = parts.length > 2 ? ["…", ...parts.slice(-2)] : parts;
  return [driveLabel, ...shown];
}

/**
 * When the hit last changed, e.g. "3 h ago", "Mar 4", or "Mar 4, 2023" once
 * it is a year old. `modified` is Unix seconds, as the index stores it.
 * @param {number} modified
 * @param {number} [now] milliseconds
 * @returns {string} "" when unknown
 */
export function searchWhen(modified, now = Date.now()) {
  const seconds = Number(modified) || 0;
  if (seconds <= 0) return "";
  const at = seconds * 1000;
  const diff = Math.max(0, now - at);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}
