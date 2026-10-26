// Backups: the folder backups on a drive (api/backups.rs), the Backups folder on the
// backup drive (api/backup_folder.rs), cloud backups (api/cloud_backups.rs) and the
// private-item views (api/private_backups.rs). Rows are world.backups / world.cloudBackups
// and look like lunad's protections: `state` is the health (ok / failing / stale), `status`
// the lifecycle (active / stopped / source gone), and `private_owner` the person whose
// private item or folder-inside-one the backup holds ("" for a shared folder).
import { del, fail, get, post } from "../engine.js";
import { CAP_EDIT, CAP_VIEW, hasCap, isAdmin, ownerState, pathContains, privateBoundary, privateUnder } from "../policy.js";
import { backup as makeBackup, cloudBackup as makeCloudBackup } from "../world.js";
import { base, clean, descendants, driveRow, driveUsable, fsOf, fsOpts, join, nowS, parentOf } from "../fsmodel.js";
import { bytesFor } from "./files.js";
import { raw } from "../router.js";

const GRACE = 60 * 60;
const STALE = 24 * 60 * 60;

/** status::state: ok / failing / stale from what the row has recorded. */
function healthOf(row, now) {
  if (row.last_error) {
    const since = Math.max(row.failing_since || 0, row.created_at || 0);
    if (row.hard || now - since >= GRACE) return "failing";
  }
  if (now - Math.max(row.last_ok_at || 0, row.created_at || 0) >= STALE) return "stale";
  return "ok";
}

const label = (world, id) => driveRow(world, id)?.label?.trim() || "Unnamed drive";
const folderName = (path, drive) => path.split("/").filter(Boolean).pop() || drive;

/** The backup of a bigger folder that holds this one (db::covering_protection). */
function coveringBackup(world, row) {
  const child = clean(row.source_path);
  if (!child) return null;
  const list = row.kind === "cloud" ? world.cloudBackups : world.backups;
  const parents = list.filter((p) => p.id !== row.id && p.source_drive === row.source_drive && (p.target_drive || "") === (row.target_drive || "")
    && (p.private_owner || "") === (row.private_owner || "") && (p.status || "active") === "active" && p.first_done !== false
    && clean(p.source_path) !== child && pathContains(clean(p.source_path), child));
  return parents.sort((a, b) => clean(b.source_path).length - clean(a.source_path).length)[0] || null;
}

/** Who may see a backup: its access list. Private: the owner. Shared: Admins, its maker, anyone who can read the folder. */
function visibleTo(world, row, user) {
  if (row.private_owner) return user.id === row.private_owner;
  return isAdmin(user) || row.created_by === user.id || hasCap(world, user, row.source_drive, clean(row.source_path), CAP_VIEW);
}
function canDelete(world, row, user) {
  if (row.private_owner) return user.id === row.private_owner || (isAdmin(user) && ownerState(world, row.private_owner) !== "active");
  return isAdmin(user) || (row.created_by === user.id && visibleTo(world, row, user));
}

function backupJson(world, row, user) {
  const now = nowS();
  const srcLabel = label(world, row.source_drive);
  const parent = coveringBackup(world, row);
  const { private_owner: owner, access: _access, created_at: _c, failing_since: _f, ...rest } = row;
  return {
    ...rest,
    covered_by: parent ? { path: parent.source_path, name: folderName(parent.source_path, srcLabel) } : null,
    source_drive_name: row.source_drive_name ?? srcLabel,
    source_name: row.source_name ?? folderName(row.source_path, srcLabel),
    ...(row.kind === "cloud" ? { next_check: (row.last_checked_at ? row.last_checked_at + 14 * 86400 : now), size: row.size ?? 0, old_phrase_copies: row.old_phrase_copies ?? null, moving: row.moving ?? null } : { target_drive_name: row.target_drive_name ?? label(world, row.target_drive) }),
    state: row.state ?? healthOf(row, now),
    can_delete: canDelete(world, row, user),
    private: Boolean(owner),
    running: Boolean(row.running),
    notes: row.notes ?? [],
  };
}

/** Who owns the private item that holds `path` ("" for a shared folder). */
function privateOwnerOf(world, driveId, path) {
  return privateBoundary(world, driveId, path)?.owner ?? "";
}

// ── Folder backups ──────────────────────────────────────────────────────────
get("/api/v1/backups", ({ world, user, query }) => world.backups
  .filter((b) => visibleTo(world, b, user))
  .filter((b) => !query.drive || b.source_drive === query.drive)
  .filter((b) => query.path == null || clean(b.source_path) === clean(query.path))
  .map((b) => backupJson(world, b, user)));

/** Which backups of a bigger folder already hold this one, per kind and place they go to. */
get("/api/v1/backups/covered", ({ world, user, query }) => {
  const drive = query.drive || "";
  const path = clean(query.path);
  if (!hasCap(world, user, drive, path, CAP_VIEW)) throw fail(404, "Luna can't find this folder.");
  const owner = privateOwnerOf(world, drive, path);
  const out = [];
  const seen = new Set();
  for (const row of [...world.backups, ...world.cloudBackups]) {
    if (row.source_drive !== drive || (row.private_owner || "") !== owner) continue;
    const key = `${row.kind}\0${row.target_drive || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = { ...row, id: "probe", source_path: path, first_done: true, status: "active" };
    const parent = coveringBackup(world, probe);
    if (parent) out.push({ kind: row.kind, target_drive: row.target_drive || "", path: parent.source_path, name: folderName(parent.source_path, label(world, drive)) });
  }
  return out;
});

const refusal = (msg) => {
  const whoMay = msg.startsWith("You need") || msg.startsWith("Only an Admin") || (msg.startsWith("Only ") && msg.endsWith("can back up this item."));
  return fail(whoMay ? 403 : 400, msg);
};

post("/api/v1/backups", ({ world, user, body }) => {
  const src = body.source_drive_id;
  const target = body.target_drive_id;
  const norm = clean(body.source_path);
  if (!norm && !isAdmin(user)) throw fail(403, "Only an Admin can back up a whole drive.");
  if (!hasCap(world, user, src, norm, CAP_VIEW)) throw fail(403, "You need Read access to this folder to back it up.");
  const existing = world.backups.find((b) => b.source_drive === src && clean(b.source_path) === norm && b.target_drive === target);
  if (existing && !visibleTo(world, existing, user)) throw fail(403, "Someone already backs this folder up to that drive.");
  if (!hasCap(world, user, target, "", CAP_EDIT)) throw refusal("You need Write access to the backup drive to back up to it.");
  if (src === target) throw refusal("A backup has to go on a different drive from the folder it copies.");
  const owner = privateOwnerOf(world, src, norm);
  if (owner && owner !== user.id) {
    const who = world.users.find((u) => u.id === owner);
    throw refusal(`Only ${who?.display_name || who?.username || owner} can back up this item.`);
  }
  if (!driveUsable(world, src)) throw refusal(`Connect ${label(world, src)} first, then try again.`);
  const node = norm ? fsOf(world, src).nodes[norm] : { kind: "dir" };
  if (!node) throw refusal(`Luna can't find "${folderName(norm, label(world, src))}" on ${label(world, src)}.`);
  if (node.kind !== "dir") throw refusal("Only folders and whole drives can be backed up.");
  if (!driveUsable(world, target)) throw refusal(`Connect ${label(world, target)} first, then try again.`);
  if (existing) {
    if (existing.status === "source_gone") { existing.status = "active"; existing.stop_reason = ""; }
    return backupJson(world, existing, user);
  }
  const probe = { id: "probe", kind: "drive", source_drive: src, source_path: norm, target_drive: target, private_owner: owner };
  const parent = coveringBackup(world, probe);
  if (parent) throw refusal(`Included in the backup of "${folderName(parent.source_path, label(world, src))}".`);
  const row = makeBackup({
    source_drive: src, source_drive_name: label(world, src), source_path: norm, source_name: folderName(norm, label(world, src)),
    target_drive: target, target_drive_name: label(world, target), state: "ok", status: "active", last_ok_at: 0, first_done: false,
    created_by: user.id, created_at: nowS(), private_owner: owner,
  });
  world.backups.push(row);
  return backupJson(world, row, user);
});

const noBackup = () => fail(404, "This backup doesn't exist anymore.");

post("/api/v1/backups/:id/run", ({ world, user, params }) => {
  const row = world.backups.find((b) => b.id === params.id);
  if (!row) throw noBackup();
  if (!visibleTo(world, row, user)) throw noBackup();
  const problem = fsOpts(world).backupProblem;
  if (problem) return { done: false, problem };
  Object.assign(row, { last_ok_at: nowS(), state: "ok", first_done: true, last_error: "", hard: false });
  return { done: true };
});

del("/api/v1/backups/:id", ({ world, user, params }) => {
  const row = world.backups.find((b) => b.id === params.id);
  if (!row) throw noBackup();
  if (!canDelete(world, row, user)) throw fail(403, "Only an Admin or the person who made this backup can delete it.");
  world.backups = world.backups.filter((b) => b !== row);
  return { ok: true };
});

// ── Cloud backups ───────────────────────────────────────────────────────────
get("/api/v1/cloud/backups", ({ world, user }) => world.cloudBackups.filter((b) => visibleTo(world, b, user)).map((b) => backupJson(world, b, user)));

post("/api/v1/cloud/backups", ({ world, user, body }) => {
  const src = body.source_drive_id;
  const norm = clean(body.source_path);
  if (!norm && !isAdmin(user)) throw fail(403, "Only an Admin can back up a whole drive.");
  if (!hasCap(world, user, src, norm, CAP_VIEW)) throw fail(403, "You need Read access to this folder to back it up.");
  if (!world.phrase?.set) throw fail(409, "You need a recovery phrase first. Reload this page to set one up.", "needs_phrase");
  const owner = privateOwnerOf(world, src, norm);
  if (owner && owner !== user.id) {
    const who = world.users.find((u) => u.id === owner);
    throw refusal(`Only ${who?.display_name || who?.username || owner} can back up this item.`);
  }
  const existing = world.cloudBackups.find((b) => b.source_drive === src && clean(b.source_path) === norm);
  if (existing) {
    if (!visibleTo(world, existing, user)) throw fail(403, "Someone already backs this folder up to the cloud.");
    return backupJson(world, existing, user);
  }
  if (!world.connect?.enabled && !world.connectActive) throw fail(400, "Luna could not set up its backup identity. Try again, or contact your Admin.");
  const parent = coveringBackup(world, { id: "probe", kind: "cloud", source_drive: src, source_path: norm, target_drive: "", private_owner: owner });
  if (parent) throw refusal(`Included in the backup of "${folderName(parent.source_path, label(world, src))}".`);
  const row = makeCloudBackup({
    source_drive: src, source_drive_name: label(world, src), source_path: norm, source_name: folderName(norm, label(world, src)),
    state: "ok", status: "active", last_ok_at: 0, first_done: false, created_by: user.id, created_at: nowS(), private_owner: owner,
  });
  world.cloudBackups.push(row);
  return backupJson(world, row, user);
});

post("/api/v1/cloud/backups/:id/check", ({ world, user, params }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (!b || !visibleTo(world, b, user)) throw noBackup();
  b.last_checked_at = nowS();
  b.check_problem = "";
  return {};
});

post("/api/v1/cloud/backups/:id/run", ({ world, user, params, query }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (!b || !visibleTo(world, b, user)) throw noBackup();
  if (b.source_missing && query.accept_missing !== "true") {
    return { done: false, source_missing: true, problem: "The folder this backup copies is gone. Run it anyway to remove the cloud copy too, or stop the backup." };
  }
  Object.assign(b, { last_ok_at: nowS(), state: "ok", last_error: "", first_done: true });
  return { done: true };
});

del("/api/v1/cloud/backups/:id", ({ world, user, params }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (!b) throw noBackup();
  if (!canDelete(world, b, user)) throw fail(403, "Only an Admin or the person who made this backup can delete it.");
  world.cloudBackups = world.cloudBackups.filter((x) => x !== b);
  return { ok: true };
});

// ── The Backups folder on a backup drive ────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (secs) => { const d = new Date(secs * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const notFoundBackup = () => fail(404, "Luna couldn't find that backup on this drive.");
const invalidPath = () => fail(400, "That path is not valid. Choose it from the list instead.");

function cleanRel(rawPath) {
  const text = String(rawPath ?? "");
  if (text.includes("\0") || text.includes("\\") || text.startsWith("/")) throw invalidPath();
  const parts = [];
  for (const part of text.split("/")) {
    if (part === "..") throw invalidPath();
    if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function findVisible(world, user, driveId, id) {
  if (!driveUsable(world, driveId)) throw fail(409, "Connect that drive to see its backups.");
  const row = world.backups.find((b) => b.id === id && b.target_drive === driveId);
  if (!row || !visibleTo(world, row, user)) throw notFoundBackup();
  return row;
}

get("/api/v1/drives/:id/backups", ({ world, user, params }) => {
  if (!driveUsable(world, params.id)) throw fail(409, "Connect that drive to see its backups.");
  const now = nowS();
  return world.backups.filter((b) => b.target_drive === params.id && visibleTo(world, b, user)).map((b) => ({
    id: b.id,
    source_name: b.source_name ?? folderName(b.source_path, b.source_drive_name),
    source_drive_name: b.source_drive_name ?? label(world, b.source_drive),
    source_path: b.source_path,
    last_ok_at: b.last_ok_at,
    status: b.status || "active",
    stop_reason: b.stop_reason || "",
    state: b.state ?? healthOf(b, now),
    size_bytes: b.size_bytes ?? 2_500_000,
  }));
});

get("/api/v1/drives/:id/backups/:bid/list", ({ world, user, params, query }) => {
  const row = findVisible(world, user, params.id, params.bid);
  const rel = cleanRel(query.path);
  const src = fsOf(world, row.source_drive);
  const root = clean(row.source_path);
  const folder = join(root, rel);
  const folderNode = folder ? src.nodes[folder] : { kind: "dir" };
  const deletedHere = src.trash.filter((t) => pathContains(folder, t.original_path) && t.original_path !== folder);
  if ((!folderNode || folderNode.kind !== "dir") && !deletedHere.length) throw fail(404, "Luna couldn't find that folder in this backup.");
  const rows = [];
  if (folderNode?.kind === "dir") {
    for (const [p, n] of Object.entries(src.nodes)) {
      if (parentOf(p) !== folder || (root && !pathContains(root, p))) continue;
      rows.push({ name: base(p), is_dir: n.kind === "dir", size: n.kind === "dir" ? 0 : n.size || 0, mtime: n.modified, deleted: false, deleted_at: null });
    }
  }
  const dirs = new Map();
  for (const t of deletedHere) {
    const tail = t.original_path.slice(folder ? folder.length + 1 : 0);
    if (tail.includes("/")) { const d = tail.split("/")[0]; dirs.set(d, Math.max(dirs.get(d) || 0, t.trashed_at)); continue; }
    if (rows.some((r) => r.name === tail)) continue;
    const top = t.nodes[""];
    if (top.kind === "dir") dirs.set(tail, Math.max(dirs.get(tail) || 0, t.trashed_at));
    else rows.push({ name: tail, is_dir: false, size: top.size ?? null, mtime: top.modified ?? null, deleted: true, deleted_at: t.trashed_at });
  }
  for (const [name, at] of dirs) rows.push({ name, is_dir: true, size: 0, mtime: null, deleted: true, deleted_at: at });
  return rows.sort((a, b) => (Number(a.deleted) - Number(b.deleted)) || (Number(!a.is_dir) - Number(!b.is_dir)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
});

/** A file of the backup at a path: the live source file, or the newest trashed copy. */
function backedUpFile(world, row, rel) {
  const full = join(clean(row.source_path), rel);
  const src = fsOf(world, row.source_drive);
  if (src.nodes[full]?.kind === "file") return { node: src.nodes[full], current: true };
  const t = src.trash.find((x) => x.original_path === full && x.nodes[""].kind === "file");
  return t ? { node: t.nodes[""], current: false } : null;
}

get("/api/v1/drives/:id/backups/:bid/versions", ({ world, user, params, query }) => {
  const rel = cleanRel(query.path);
  if (!rel) throw fail(400, "Choose a file to see its versions.");
  const row = findVisible(world, user, params.id, params.bid);
  const file = backedUpFile(world, row, rel);
  const out = [];
  if (file?.current) out.push({ at: null, size: file.node.size || 0, mtime: file.node.modified });
  if (file && !fsOpts(world).noVersions) {
    const t = nowS();
    for (const [i, days] of [5, 21].entries()) {
      const at = t - days * 86400;
      out.push({ at, size: Math.max(0, (file.node.size || 0) - 600 * (i + 1)), mtime: at - 3600 });
    }
  }
  return out;
});

get("/api/v1/drives/:id/backups/:bid/download", ({ world, user, params, query }) => {
  const row = findVisible(world, user, params.id, params.bid);
  const rel = cleanRel(query.path);
  if (query.at && !/^\d+$/.test(String(query.at))) throw fail(400, "That version is not valid. Choose one from the list.");
  const file = backedUpFile(world, row, rel);
  if (!file) {
    const dir = fsOf(world, row.source_drive).nodes[join(clean(row.source_path), rel)];
    if (dir?.kind === "dir") return raw(new Uint8Array(22), "application/zip", 200, { "Content-Disposition": `attachment; filename="${base(rel)}.zip"` });
    throw fail(404, query.at ? "Luna couldn't find that version of this file." : "Luna couldn't find that in this backup.");
  }
  const [data, type] = bytesFor(file.node);
  return raw(data, type, 200, { "Content-Disposition": `attachment; filename="${base(rel)}"` });
});

post("/api/v1/drives/:id/backups/:bid/restore", ({ world, user, params, body }) => {
  const rel = cleanRel(body.path);
  if (!rel) throw fail(400, "Choose a file or folder to restore.");
  if (body.at != null && !/^\d+$/.test(String(body.at))) throw fail(400, "That version is not valid. Choose one from the list.");
  const row = findVisible(world, user, params.id, params.bid);
  const file = backedUpFile(world, row, rel);
  const srcFs = fsOf(world, row.source_drive);
  const sub = srcFs.nodes[join(clean(row.source_path), rel)];
  if (!file && !sub) throw fail(404, "Luna couldn't find that in this backup.");
  const srcLabel = driveRow(world, row.source_drive)?.label || row.source_drive_name || "the original drive";
  if (!driveUsable(world, row.source_drive)) throw fail(409, `Connect ${srcLabel} to restore to the original folder.`);
  const parentRel = parentOf(rel);
  const destDir = join(clean(row.source_path), parentRel);
  if (row.private_owner) {
    if (user.id !== row.private_owner) throw fail(403, "Only the owner of this private item can restore it.");
  } else if (!hasCap(world, user, row.source_drive, destDir, CAP_EDIT)) {
    throw fail(403, "You need Write access to that folder to restore into it.");
  }
  if (destDir && srcFs.nodes[destDir]?.kind !== "dir") throw fail(409, `The original folder is missing on ${srcLabel}. Put it back, then try again.`);
  const name = base(rel);
  let finalName = name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const day = shortDate(nowS());
  for (let n = 1; srcFs.nodes[join(destDir, finalName)] && n < 1000; n += 1) finalName = n === 1 ? `${stem} (restored ${day})${ext}` : `${stem} (restored ${day} ${n})${ext}`;
  const target = join(destDir, finalName);
  if (file) srcFs.nodes[target] = { ...file.node, modified: nowS() };
  else for (const k of descendants(srcFs, join(clean(row.source_path), rel))) srcFs.nodes[target + k.slice(join(clean(row.source_path), rel).length)] = { ...srcFs.nodes[k] };
  return { name: finalName, path: join(parentRel, finalName) };
});

// ── Private items (api/private_backups.rs) ──────────────────────────────────
const displayName = (world, id) => {
  const u = world.users.find((x) => x.id === id);
  return u ? (u.display_name?.trim() || u.username) : "";
};

get("/api/v1/private-backups/item", ({ world, user, query }) => {
  const path = clean(query.path);
  if (!hasCap(world, user, query.drive, path, CAP_VIEW)) throw fail(404, "Luna can't find this folder.");
  const b = privateBoundary(world, query.drive, path);
  const priv = Boolean(b);
  return {
    private: priv,
    inside_private: priv && b.path !== path,
    mine: priv && b.owner === user.id,
    owner_name: priv ? displayName(world, b.owner) : "",
  };
});

get("/api/v1/private-backups/mine", ({ world, user }) => {
  const items = [];
  for (const d of world.drives) {
    if (!(d.state === "as_is" || d.state === "readonly") || world.summaries[d.id]?.mounted === false) continue;
    for (const item of privateUnder(world, d.id, "")) {
      if (item.owner !== user.id) continue;
      const mine = [...world.backups, ...world.cloudBackups].filter((r) => r.private_owner === user.id && r.source_drive === d.id && (r.status || "active") === "active" && pathContains(item.path, clean(r.source_path)));
      items.push({ drive_id: d.id, path: `/${item.path}`, name: base(item.path), drive_backups: mine.filter((r) => r.kind === "drive").length, cloud_backup: mine.some((r) => r.kind === "cloud") });
    }
  }
  return { items };
});

get("/api/v1/private-backups/summary", ({ world, user }) => {
  const now = nowS();
  const owners = new Map();
  for (const r of [...world.backups, ...world.cloudBackups].filter((x) => x.private_owner)) {
    if (!isAdmin(user) && r.private_owner !== user.id) continue;
    owners.set(r.private_owner, [...(owners.get(r.private_owner) || []), r]);
  }
  return {
    owners: [...owners.entries()].map(([owner, list]) => {
      const deleted = ownerState(world, owner) !== "active";
      return {
        owner_id: owner, name: deleted ? "" : displayName(world, owner), deleted, backups: list.length,
        needs_look: list.some((r) => (r.status || "active") !== "active" || (!coveringBackup(world, r) && ((r.state ?? healthOf(r, now)) !== "ok" || (r.kind === "cloud" && r.check_problem)))),
      };
    }),
  };
});

del("/api/v1/private-backups/owners/:owner", ({ world, user, params }) => {
  if (!isAdmin(user)) throw fail(403, "Only an Admin can remove these backups.");
  if (ownerState(world, params.owner) === "active") throw fail(409, "This person still has an account. Only they can remove their private backups.");
  const before = world.backups.length + world.cloudBackups.length;
  world.backups = world.backups.filter((b) => b.private_owner !== params.owner);
  world.cloudBackups = world.cloudBackups.filter((b) => b.private_owner !== params.owner);
  return { removed: before - world.backups.length - world.cloudBackups.length };
});
del("/api/v1/private-backups/old-copies", () => ({ ok: true }));
del("/api/v1/private-backups/older-versions", () => ({ ok: true }));

