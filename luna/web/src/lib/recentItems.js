/**
 * Recent files/folders/drives — a per-user MRU list in localStorage so the
 * dashboard can offer "jump back in" links. Items are derived from the
 * router location (see recentItemFromLocation), so every entry point —
 * folder links, search results, shared grants, the file viewer — feeds it.
 */

import { canViewerOpen } from "./officeConvert.js";
import {
  fileHref,
  folderHref,
  isTrashPath,
  joinPath,
  parentPath,
  pathBasename,
} from "./paths.js";

/** At most this many items are remembered per user. */
export const RECENT_ITEMS_LIMIT = 10;

const STORAGE_PREFIX = "luna.recentItems.";

/**
 * @typedef {{
 *   kind: "file" | "folder" | "drive",
 *   driveId: string,
 *   path: string,
 *   driveLabel?: string,
 *   at: number,
 * }} RecentItem
 */

function storageKey(username) {
  return `${STORAGE_PREFIX}${username || "guest"}`;
}

function itemKey(item) {
  return `${item.kind}|${item.driveId}|${item.path}`;
}

function isValidItem(item) {
  return item != null
    && typeof item === "object"
    && (item.kind === "file" || item.kind === "folder" || item.kind === "drive")
    && typeof item.driveId === "string"
    && item.driveId.length > 0
    && typeof item.path === "string"
    && Number.isFinite(item.at);
}

/**
 * @param {string | undefined} username
 * @returns {RecentItem[]}
 */
export function readRecentItems(username) {
  try {
    const raw = window.localStorage.getItem(storageKey(username));
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(isValidItem).slice(0, RECENT_ITEMS_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Push an item to the front of the user's recent list (deduped by
 * kind + drive + path, capped at RECENT_ITEMS_LIMIT). Returns the new list.
 *
 * @param {string | undefined} username
 * @param {Omit<RecentItem, "at">} item
 * @param {number} [now]
 * @returns {RecentItem[]}
 */
export function recordRecentItem(username, item, now = Date.now()) {
  const entry = { ...item, at: now };
  const key = itemKey(entry);
  const next = [
    entry,
    ...readRecentItems(username).filter((existing) => itemKey(existing) !== key),
  ].slice(0, RECENT_ITEMS_LIMIT);
  try {
    window.localStorage.setItem(storageKey(username), JSON.stringify(next));
  } catch {
    // Storage blocked or full — recents are a convenience, never fatal.
  }
  return next;
}

/**
 * Turn a router location into a recent item, or null when the route is not
 * a browsable drive object (drive list, trash, settings, …). Mirrors
 * FilesPage's viewerPath rules: `?file=`/`?open=` or a bare `#name` hash
 * counts as a file only when Luna can actually open it; otherwise the
 * surrounding folder is what the user is really looking at.
 *
 * @param {{ pathname: string, search?: string, hash?: string }} location
 * @returns {Omit<RecentItem, "at"> | null}
 */
export function recentItemFromLocation({ pathname, search = "", hash = "" }) {
  const match = String(pathname || "").match(/^\/drives\/([^/]+)\/?$/);
  if (!match) return null;
  const driveId = decodeURIComponent(match[1]);
  const params = new URLSearchParams(search);
  if (params.get("view") === "trash") return null;

  const path = params.get("path") || "";
  // Trash rows carry generated on-disk names (`{nonce}-file`) — a recent
  // link to one would read as noise and rots on put-back or purge anyway.
  if (isTrashPath(path)) return null;
  const fileParam = params.get("file") || params.get("open") || "";
  const rawHash = hash ? decodeURIComponent(String(hash).replace(/^#/, "")) : "";
  const hashCandidate = rawHash && rawHash !== "main-content" ? rawHash : "";
  const candidate = fileParam || hashCandidate;

  if (candidate) {
    const name = pathBasename(candidate);
    if (name && canViewerOpen(name)) {
      return {
        kind: "file",
        driveId,
        path: candidate.includes("/") ? candidate : joinPath(path, candidate),
      };
    }
  }
  if (path) return { kind: "folder", driveId, path };
  return { kind: "drive", driveId, path: "" };
}

/** Router href that re-opens the item: viewer for files, browser otherwise. */
export function recentItemHref(item) {
  if (item.kind === "file") return fileHref(item.driveId, item.path);
  return folderHref(item.driveId, item.kind === "folder" ? item.path : "");
}

/** Display name — basename for files/folders, drive label at a drive root. */
export function recentItemName(item, driveLabel) {
  const base = pathBasename(item.path);
  if (base) return base;
  return driveLabel || item.driveLabel || "Drive";
}

/**
 * "Drive · containing/folder" context line, or null for a whole-drive item
 * (the name already says it all).
 */
export function recentItemLocationLine(item, driveLabel) {
  if (item.kind === "drive") return null;
  const label = driveLabel || item.driveLabel || "Drive";
  const parent = parentPath(item.path);
  return parent ? `${label} · ${parent}` : label;
}

/** Short relative stamp for the row, e.g. "Just now", "3 h ago", "Mar 4". */
export function formatRecentAgo(at, now = Date.now()) {
  const diff = Math.max(0, now - Number(at) || 0);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
