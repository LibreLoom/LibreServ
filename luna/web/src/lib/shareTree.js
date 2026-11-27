/** Strip slashes so `/photos/` and `photos` are the same folder. */
import { CAP, KIND_ALBUM, capsBits } from "./access.js";
import {
  fileHref,
  folderHref,
  parentPath,
  searchResultHref,
} from "./paths.js";

export function pathKey(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Parent (or same folder, or whole drive) contains the child path. */
export function pathContains(ancestor, descendant) {
  const parent = pathKey(ancestor);
  const child = pathKey(descendant);
  if (parent === child) return true;
  if (!parent) return true;
  return child.startsWith(`${parent}/`);
}

function driveIdOf(row) {
  return row.drive_id || row.driveId || "";
}

/** True when `parent`'s capabilities cover everything in `child`. */
function capsGe(parent, child) {
  const p = capsBits(parent);
  const c = capsBits(child);
  return c !== 0 && (p & c) === c;
}

/**
 * A member row is redundant when another row on the same subject (or a
 * containing folder, for path rows) already covers all of its capabilities.
 */
function rowCovers(parent, row) {
  if (parent === row) return false;
  if (driveIdOf(parent) !== driveIdOf(row)) return false;
  if (!capsGe(parent.caps, row.caps)) return false;
  if (row.kind === KIND_ALBUM || parent.kind === KIND_ALBUM) {
    return row.kind === KIND_ALBUM
      && parent.kind === KIND_ALBUM
      && row.album_id === parent.album_id;
  }
  return pathContains(parent.path, row.path);
}

/**
 * Highest subjects a member can open, plus any child that has capabilities
 * its parent lacks (e.g. full access on a folder under a view-only parent).
 */
export function memberAccessRoots(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byDrive = new Map();
  for (const row of list) {
    const drive = driveIdOf(row);
    let groups = byDrive.get(drive);
    if (!groups) {
      groups = { paths: new Map(), albums: new Map() };
      byDrive.set(drive, groups);
    }
    const album = row.kind === KIND_ALBUM;
    const group = album ? groups.albums : groups.paths;
    const key = album ? row.album_id : pathKey(row.path);
    const entries = group.get(key);
    if (entries) entries.push(row);
    else group.set(key, [row]);
  }
  return list.filter((row) => {
    const groups = byDrive.get(driveIdOf(row));
    const coveredBy = (candidates) => candidates?.some((parent) => rowCovers(parent, row));
    if (row.kind === KIND_ALBUM) return !coveredBy(groups.albums.get(row.album_id));
    let path = pathKey(row.path);
    while (path) {
      if (coveredBy(groups.paths.get(path))) return false;
      path = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    }
    return !coveredBy(groups.paths.get(""));
  });
}

// Query results are immutable. Each render can check every visible path
// against the same table without repeatedly scanning unrelated grants.
const indexedGrants = new WeakMap();
function grantsByPath(rows, driveId) {
  if (!Array.isArray(rows)) return undefined;
  let byDrive = indexedGrants.get(rows);
  if (!byDrive) {
    byDrive = new Map();
    for (const row of rows) {
      if (row.kind === KIND_ALBUM) continue;
      const bits = capsBits(row.caps);
      if (!bits) continue;
      const id = driveIdOf(row);
      let drive = byDrive.get(id);
      if (!drive) {
        drive = { paths: new Map(), bits: 0 };
        byDrive.set(id, drive);
      }
      const path = pathKey(row.path);
      drive.paths.set(path, (drive.paths.get(path) || 0) | bits);
      drive.bits |= bits;
    }
    indexedGrants.set(rows, byDrive);
  }
  return byDrive.get(driveId);
}

/**
 * Union of capability bits covering `path` on `driveId` — a row on the path
 * itself or on any containing folder/drive counts. Album rows don't apply
 * to filesystem paths.
 */
export function capsOnPath(rows, driveId, path) {
  const drive = grantsByPath(rows, driveId);
  if (!drive) return 0;
  let target = pathKey(path);
  let bits = drive.paths.get("") || 0;
  while (target && bits !== drive.bits) {
    bits |= drive.paths.get(target) || 0;
    target = target.slice(0, Math.max(0, target.lastIndexOf("/")));
  }
  return bits;
}

/** True when any path row on this drive grants `bit` somewhere. */
export function hasCapOnDrive(rows, driveId, bit) {
  return ((grantsByPath(rows, driveId)?.bits || 0) & bit) !== 0;
}

/**
 * The member's virtual root while browsing `path` on `driveId`: the
 * SHALLOWEST path row that contains it. Ancestors of a grant are not
 * browsable, so this floor is the top of the member's world — breadcrumbs
 * and Up must never offer a path above it.
 *
 * Returns "" when a whole-drive row covers `path` (normal drive root) or
 * the member holds no path rows on this drive at all ("" disables the
 * floor). When rows exist on the drive but none cover `path`, returns
 * `path` itself — nothing above it can be reached anyway.
 */
export function memberPathFloor(rows, driveId, path) {
  const drive = grantsByPath(rows, driveId);
  if (!drive || drive.paths.has("")) return "";
  const target = pathKey(path);
  let floor = target;
  for (let candidate = target; candidate; candidate = candidate.slice(0, Math.max(0, candidate.lastIndexOf("/")))) {
    if (drive.paths.has(candidate)) floor = candidate;
  }
  return floor;
}

/**
 * A member's writable destination roots — where a move/copy/folder-create
 * can actually land: every grant root with upload or edit bits on a
 * present drive.
 *
 * @param rows   member access rows (`/me/access`)
 * @param isPresent  (driveId) => the drive is mounted and usable
 * @param driveLabel (driveId) => display label for a drive
 */
export function memberWritableRoots(rows, isPresent, driveLabel) {
  const roots = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    // A file grant isn't a folder anything can move into.
    if (row.kind === KIND_ALBUM || row.is_file) continue;
    const driveId = driveIdOf(row);
    if (!driveId || !isPresent(driveId)) continue;
    if ((capsBits(row.caps) & (CAP.UPLOAD | CAP.EDIT)) === 0) continue;
    const path = pathKey(row.path);
    const key = `${driveId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = row.name
      || (path ? path.split("/").pop() : "")
      || driveLabel(driveId)
      || "Shared folder";
    roots.push({ driveId, path, label });
  }
  return roots;
}

/**
 * Router href to a file for a member whose folders may not be browsable.
 * When the file's parent isn't covered by a view grant, the file itself is
 * the deepest browsable path — `list` answers it with a one-entry "folder"
 * (the same shape a guest file link serves), so the file path becomes the
 * `path` param and `?file=` carries the full path for the viewer.
 */
export function memberFileHref(rows, driveId, filePath) {
  const parent = parentPath(filePath) ?? "";
  if ((capsOnPath(rows, driveId, parent) & CAP.VIEW) !== 0) {
    return fileHref(driveId, filePath);
  }
  return `${folderHref(driveId, filePath)}&file=${encodeURIComponent(filePath)}`;
}

/**
 * Router href for a search hit a member clicked. Folders the search
 * returned are viewable, so they keep the folder link; files keep the
 * parent-folder link only when that folder is browsable — otherwise the
 * file is its own root (see `memberFileHref`).
 */
export function memberSearchHref(rows, item) {
  if (item.kind === "dir") return searchResultHref(item);
  const parent = item.parent != null ? item.parent : parentPath(item.path) ?? "";
  if ((capsOnPath(rows, item.drive_id, parent) & CAP.VIEW) !== 0) {
    return searchResultHref(item);
  }
  return memberFileHref(rows, item.drive_id, item.path);
}

export { CAP };
export const CAP_FULL = CAP.VIEW | CAP.UPLOAD | CAP.EDIT;
