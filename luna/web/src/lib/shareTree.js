/** Strip slashes so `/photos/` and `photos` are the same folder. */
import { CAP, KIND_ALBUM, capsBits } from "./access.js";

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
  return list.filter((row) => !list.some((parent) => rowCovers(parent, row)));
}

/**
 * Union of capability bits covering `path` on `driveId` — a row on the path
 * itself or on any containing folder/drive counts. Album rows don't apply
 * to filesystem paths.
 */
export function capsOnPath(rows, driveId, path) {
  const list = Array.isArray(rows) ? rows : [];
  const target = pathKey(path);
  let bits = 0;
  for (const row of list) {
    if (row.kind === KIND_ALBUM) continue;
    if (driveIdOf(row) !== driveId) continue;
    if (pathContains(row.path, target)) bits |= capsBits(row.caps);
  }
  return bits;
}

/** True when any path row on this drive grants `bit` somewhere. */
export function hasCapOnDrive(rows, driveId, bit) {
  const list = Array.isArray(rows) ? rows : [];
  return list.some((row) => (
    row.kind !== KIND_ALBUM
    && driveIdOf(row) === driveId
    && (capsBits(row.caps) & bit) !== 0
  ));
}

export { CAP };
export const CAP_FULL = CAP.VIEW | CAP.UPLOAD | CAP.EDIT;
