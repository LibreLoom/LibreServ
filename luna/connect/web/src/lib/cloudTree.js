/** Helpers for the cloud backup browser: a flat list of files with `/` paths, folders implied. */

const SIZE_UNITS = ["B", "KB", "MB", "GB"];
const NAME_ORDER = { numeric: true, sensitivity: "base" };

/** Parent folder of a path ("" for top level). */
export function parentFolder(path) {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

/** Last segment of a path. */
export function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Direct children of `folder` ("" = top).
 * Folders: { name, path, size (sum of files below), files (count below) }.
 * Files: the entries themselves plus `name`.
 * Both lists are sorted by name.
 *
 * @param {Array<{ path: string, size: number, mtime: number, chunks: Array }>} entries
 * @param {string} folder
 * @returns {{ folders: Array<{ name: string, path: string, size: number, files: number }>, files: Array<object> }}
 */
export function listFolder(entries, folder) {
  const prefix = folder ? `${folder}/` : "";
  const folderMap = new Map();
  const files = [];

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ ...entry, name: rest });
      continue;
    }
    const name = rest.slice(0, slash);
    let dir = folderMap.get(name);
    if (!dir) {
      dir = { name, path: `${prefix}${name}`, size: 0, files: 0 };
      folderMap.set(name, dir);
    }
    dir.size += entry.size;
    dir.files += 1;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, NAME_ORDER);
  return {
    folders: [...folderMap.values()].sort(byName),
    files: files.sort(byName),
  };
}

/**
 * Every entry below `folder` (all entries when folder is "").
 *
 * @param {Array<{ path: string }>} entries
 * @param {string} folder
 */
export function filesUnder(entries, folder) {
  if (!folder) return [...entries];
  const prefix = `${folder}/`;
  return entries.filter((entry) => entry.path.startsWith(prefix));
}

/**
 * "0 B", "512 B", "1.5 KB", "12 MB", "3.4 GB" (1000-based, one decimal under 10).
 *
 * @param {number} bytes
 */
export function formatSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1000) return `${Math.round(n)} B`;
  // Move up a unit before rounding would show "1000 KB".
  let unit = 1;
  while (unit < SIZE_UNITS.length - 1 && n / 1000 ** unit >= 999.95) unit += 1;
  const value = n / 1000 ** unit;
  const text = value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  return `${text} ${SIZE_UNITS[unit]}`;
}

/**
 * Unix seconds to "16 Oct 2026, 14:02".
 *
 * @param {number} unixSeconds
 */
export function formatWhen(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Version picker label: index 0 is "Latest · <when>", others are just the time.
 *
 * @param {number} createdAt unix seconds
 * @param {number} index
 */
export function versionLabel(createdAt, index) {
  const when = formatWhen(createdAt);
  return index === 0 ? `Latest · ${when}` : when;
}
