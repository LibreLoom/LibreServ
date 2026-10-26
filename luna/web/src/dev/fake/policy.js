// Who may do what — a copy of lunad's rules (crate::access and crate::auth), used by
// every handler so the fake never invents a permission. Keep it in step with:
//   caps_from_str / caps_to_str      access.rs
//   caps_on_path, private_caps       auth.rs  (the Admin role does not cross a private wall)
//   has_drive_access, has_write_on_drive, can_inspect_path, holds_unreachable_private
import { fail } from "./router.js";

export const CAP_VIEW = 1;
export const CAP_UPLOAD = 2;
export const CAP_EDIT = 4;
export const CAP_RESPOND = 8;
export const CAP_SHARE = 16;
export const CAP_ALL = CAP_VIEW | CAP_UPLOAD | CAP_EDIT;
export const CAP_MANAGE = CAP_ALL | CAP_SHARE;

export const TRASH = ".luna-trash";

export const isAdmin = (user) => user?.role === "admin";
const norm = (p) => String(p ?? "").replace(/\\/g, "/").split("/").filter((s) => s && s !== ".").join("/");
/** `a` holds `b`: the same path or anything beneath it ("" holds everything). */
export const pathContains = (a, b) => a === "" || b === a || b.startsWith(`${a}/`);
const leaf = (p) => p.slice(p.lastIndexOf("/") + 1);
export const isTrashPath = (p) => p === TRASH || p.startsWith(`${TRASH}/`);

export function capsFromStr(text) {
  const s = String(text ?? "").trim().toLowerCase();
  switch (s) {
    case "read_write": case "write": return CAP_VIEW | CAP_UPLOAD;
    case "full": case "edit": return CAP_ALL;
    case "full+share": case "edit+share": return CAP_MANAGE;
    case "respond": return CAP_RESPOND;
    case "none": return 0;
    default:
  }
  let bits = 0;
  for (const part of s.split("+")) {
    if (part === "view" || part === "read") bits |= CAP_VIEW;
    else if (part === "upload") bits |= CAP_UPLOAD;
    else if (part === "share") bits |= CAP_SHARE;
    else if (part !== "") return null;
  }
  return bits || null;
}

export function capsToStr(caps) {
  const body = caps & ~CAP_SHARE;
  let base;
  if (body === CAP_ALL) base = "full";
  else if (body === CAP_RESPOND) base = "respond";
  else if (body === (CAP_VIEW | CAP_UPLOAD)) base = "view+upload";
  else if (body === CAP_UPLOAD) base = "upload";
  else if (body === 0) base = "none";
  else base = "view";
  return caps & CAP_SHARE ? `${base}+share` : base;
}

const bitsOf = (caps) => (typeof caps === "number" ? caps : capsFromStr(caps) ?? 0);

/** The signed-in person's grant rows: world.access rows (for them, or for any Member when no user_id) and shares made to them. */
export function grantRows(world, user) {
  if (!user) return [];
  const rows = [];
  for (const r of world.access || []) {
    if (r.kind && r.kind !== "path") continue;
    if (r.user_id && r.user_id !== user.id) continue;
    rows.push({ drive_id: r.drive_id ?? r.driveId, path: norm(r.path), caps: bitsOf(r.caps) });
  }
  for (const s of world.sharing?.subjects || []) {
    if (s.kind !== "path" || s.exists === false) continue;
    for (const m of s.members || []) {
      if (m.user_id === user.id) rows.push({ drive_id: s.drive_id, path: norm(s.path), caps: bitsOf(m.caps) });
    }
  }
  return rows;
}

/** "active" (a person here), "deleted" (a removed person) or "foreign" (nobody this Luna knows). */
export function ownerState(world, owner) {
  if (owner && world.users.some((u) => u.id === owner)) return "active";
  if (owner && (world.deletedUsers || []).some((u) => u.id === owner)) return "deleted";
  return "foreign";
}

const nodesOf = (world, driveId) => world.fs?.[driveId]?.nodes || {};

/** The nearest private item at or above `path`, as { path, owner }. */
export function privateBoundary(world, driveId, path) {
  const nodes = nodesOf(world, driveId);
  const parts = norm(path).split("/").filter(Boolean);
  for (let i = parts.length; i >= 1; i -= 1) {
    const p = parts.slice(0, i).join("/");
    if (nodes[p]?.private) return { path: p, owner: nodes[p].owner || "" };
  }
  return null;
}

/** Private items at or beneath `path`. */
export function privateUnder(world, driveId, path) {
  const base = norm(path);
  return Object.entries(nodesOf(world, driveId))
    .filter(([p, n]) => n.private && pathContains(base, p))
    .map(([p, n]) => ({ path: p, owner: n.owner || "" }));
}

function privateCaps(world, user, rows, driveId, path, b) {
  const state = ownerState(world, b.owner);
  if (state === "deleted") return 0;
  if (b.owner && b.owner === user.id) return CAP_MANAGE;
  // Nobody here owns it (it came from another Luna): an Admin can reach it, to give it to someone.
  if (isAdmin(user) && state === "foreign") return CAP_MANAGE;
  return rows
    .filter((r) => r.drive_id === driveId && pathContains(r.path, path) && pathContains(b.path, r.path))
    .reduce((caps, r) => caps | r.caps, 0);
}

/** Where a trashed path used to be, and the private wall it sat behind (if any). */
function trashOrigin(world, driveId, path) {
  const rest = path.slice(TRASH.length + 1);
  const key = rest.split("/")[0];
  const entry = world.fs?.[driveId]?.trash?.find((t) => t.key === key);
  if (!entry) return null;
  const sub = rest.slice(key.length + 1);
  return { entry, original: sub ? `${entry.original_path}/${sub}` : entry.original_path, private: entry.private_boundary || null };
}

/** The caps bits `user` holds on `path` of a drive — the single source of truth. */
export function capsOnPath(world, user, driveId, path) {
  if (!user) return 0;
  const rows = grantRows(world, user);
  let p = norm(path);
  if (isTrashPath(p)) {
    const origin = trashOrigin(world, driveId, p);
    if (origin?.private) return privateCaps(world, user, rows, driveId, origin.original, origin.private);
    p = origin ? norm(origin.original) : p;
    if (!origin) return isAdmin(user) && p !== TRASH ? 0 : 0;
  }
  const b = privateBoundary(world, driveId, p);
  if (b) return privateCaps(world, user, rows, driveId, p, b);
  if (isAdmin(user)) return CAP_MANAGE;
  return rows.filter((r) => r.drive_id === driveId && pathContains(r.path, p)).reduce((caps, r) => caps | r.caps, 0);
}

export const hasCap = (world, user, driveId, path, cap) => (capsOnPath(world, user, driveId, path) & cap) === cap;

export function ownedPrivatePaths(world, user, driveId) {
  return privateUnder(world, driveId, "").filter((i) => i.owner && i.owner === user?.id).map((i) => i.path);
}

/** May the person see anything on this drive (the whole drive or one folder)? */
export function hasDriveAccess(world, user, driveId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (ownedPrivatePaths(world, user, driveId).length) return true;
  return grantRows(world, user).some((r) => r.drive_id === driveId);
}

/** May the person change anything on this drive (upload or edit, whole drive or a folder)? */
export function hasWriteOnDrive(world, user, driveId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (ownedPrivatePaths(world, user, driveId).length) return true;
  return grantRows(world, user).some((r) => r.drive_id === driveId && r.caps & (CAP_UPLOAD | CAP_EDIT));
}

/** The HTTP files API's read gate: view rights, the exact folder of a grant, or the root for anyone with a grant. */
export function canInspectPath(world, user, driveId, path) {
  if (!user) return false;
  const p = norm(path);
  if (isTrashPath(p)) {
    const origin = trashOrigin(world, driveId, p);
    return origin ? hasCap(world, user, driveId, p, CAP_VIEW) || isAdmin(user) : false;
  }
  if (capsOnPath(world, user, driveId, p) & CAP_VIEW) return true;
  const b = privateBoundary(world, driveId, p);
  if (isAdmin(user) && !(b && ownerState(world, b.owner) !== "foreign")) return true;
  if (b && ownerState(world, b.owner) === "deleted") return false;
  const rows = grantRows(world, user).filter((r) => r.drive_id === driveId);
  if (p === "") return ownedPrivatePaths(world, user, driveId).length > 0 || rows.length > 0;
  return rows.some((r) => r.path === p);
}

/** Does `path` hold private items this person may not change? Deleting or moving it would destroy someone else's. */
export function holdsUnreachablePrivate(world, user, driveId, path) {
  return privateUnder(world, driveId, path).some((i) => !hasCap(world, user, driveId, i.path, CAP_EDIT));
}

// ── Gates that answer with lunad's own words ───────────────────────────────
/** Admin-only routes. `message` is that route's own refusal. */
export function requireAdmin(user, message) {
  if (!isAdmin(user)) throw fail(403, message);
}

/** files.rs `check_access`. */
export function checkAccess(world, user, driveId, path, cap) {
  if (hasCap(world, user, driveId, path, cap)) return;
  throw fail(403, cap !== CAP_VIEW ? "You don't have permission to change this folder." : "You don't have permission to view this folder.");
}

/** files.rs `check_inspect`. */
export function checkInspect(world, user, driveId, path) {
  if (!canInspectPath(world, user, driveId, path)) throw fail(403, "You don't have permission to view this folder.");
}

export { leaf as _leaf };
