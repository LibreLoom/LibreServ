/** Strip slashes so `/photos/` and `photos` are the same folder. */
export function pathKey(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function permRank(permission) {
  return permission === "write" ? 2 : permission === "read" ? 1 : 0;
}

export function permGe(next, previous) {
  return permRank(next) >= permRank(previous);
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

function grantIdentity(grant) {
  const perm = grant.permission === "write" ? "write" : "read";
  return `${grant.user_id || ""}|${driveIdOf(grant)}|${pathKey(grant.path)}|${perm}`;
}

/** Same person, drive, folder, and access — keep the first row. */
export function dedupeIdenticalGrants(grants) {
  const list = Array.isArray(grants) ? grants : [];
  const seen = new Set();
  return list.filter((grant) => {
    const key = grantIdentity(grant);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Highest folders a member can open, plus a child that has stronger access
 * than its parent (write under a read parent).
 */
export function memberAccessRoots(grants) {
  const unique = dedupeIdenticalGrants(grants);
  return unique.filter((grant) => !unique.some((parent) => (
    parent !== grant
    && (parent.user_id || "") === (grant.user_id || "")
    && driveIdOf(parent) === driveIdOf(grant)
    && pathContains(parent.path, grant.path)
    && permGe(parent.permission, grant.permission)
  )));
}

/** Write is allowed on this file or folder, or on a parent that includes it. */
export function canWriteOnPath(grants, driveId, path) {
  const list = Array.isArray(grants) ? grants : [];
  return list.some((grant) => (
    driveIdOf(grant) === driveId
    && grant.permission === "write"
    && pathContains(grant.path, path)
  ));
}
