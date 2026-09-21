/** Join a relative backup path with a child name. */
export function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

/** Parent of a relative path, or null at the backup root. */
export function parentPath(path) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

/** Human-readable size (decimal). */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

/** Short date for a unix timestamp. */
export function fmtWhen(unix) {
  const n = Number(unix) || 0;
  if (n <= 0) return "";
  return new Date(n * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Immediate children of `path` from a flat backup object list.
 * Folders first, then files. Folder size is the sum of files under it.
 *
 * @param {Array<{ device_id?: string, relative_path?: string, size?: number, updated_at?: number, content_hash?: string }>} objects
 * @param {string} [path]
 */
export function listBackupFolder(objects, path = "") {
  const prefix = path ? `${path}/` : "";
  const dirs = new Map();
  const files = [];
  const seenFile = new Set();

  for (const o of objects || []) {
    const rel = String(o.relative_path || "").replace(/^\/+/, "");
    if (!rel) continue;
    if (path && !rel.startsWith(prefix)) continue;
    const rest = path ? rel.slice(prefix.length) : rel;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const key = `${o.device_id || ""}:${rel}`;
      if (seenFile.has(key)) continue;
      seenFile.add(key);
      files.push({
        name: rest,
        kind: "file",
        path: rel,
        size: Number(o.size) || 0,
        updated_at: Number(o.updated_at) || 0,
        device_id: o.device_id || "",
        relative_path: rel,
        content_hash: o.content_hash || "",
      });
      continue;
    }
    const name = rest.slice(0, slash);
    const cur = dirs.get(name) || {
      name,
      kind: "dir",
      path: joinPath(path, name),
      size: 0,
      updated_at: 0,
      fileCount: 0,
    };
    cur.size += Number(o.size) || 0;
    cur.fileCount += 1;
    const updated = Number(o.updated_at) || 0;
    if (updated > cur.updated_at) cur.updated_at = updated;
    dirs.set(name, cur);
  }

  const dirList = [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirList, ...files];
}

/**
 * Files under `path`. Recursive includes nested folders.
 *
 * @param {Array<{ relative_path?: string }>} objects
 * @param {string} [path]
 * @param {{ recursive?: boolean }} [opts]
 */
export function filesInFolder(objects, path = "", opts = {}) {
  const recursive = Boolean(opts.recursive);
  const prefix = path ? `${path}/` : "";
  return (objects || []).filter((o) => {
    const rel = String(o.relative_path || "").replace(/^\/+/, "");
    if (!rel) return false;
    if (!path) return recursive || !rel.includes("/");
    if (!rel.startsWith(prefix)) return false;
    if (recursive) return true;
    return !rel.slice(prefix.length).includes("/");
  });
}
