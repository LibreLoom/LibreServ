// Files: browsing, trash, uploads, recents, search. Every handler copies the matching
// handler in crates/lunad/src/api/files.rs (and uploads.rs, search.rs) — its checks,
// status codes, messages and JSON shape — and asks policy.js who may do what.
// Copy/move jobs are in ../jobs.js; backups in backups.js.
import { del, fail, get, post, put, raw } from "../engine.js";
import {
  CAP_EDIT, CAP_UPLOAD, CAP_VIEW, TRASH, canInspectPath, capsOnPath, capsToStr, checkAccess, checkInspect, hasCap, hasDriveAccess,
  hasWriteOnDrive, holdsUnreachablePrivate, isAdmin, isTrashPath, privateBoundary,
} from "../policy.js";
import {
  base, clean, descendants, driveReady, driveUsable, driveRow, ensureDirs, fsOf, fsOpts, join, moveToTrash, nowS, parentOf,
  pathExists, recordMove, resolveMove, trashEntry, uniqueName, under,
} from "../fsmodel.js";
import { broadensAccess, cancelJob, enqueueJob, findJob, jobJson, tickJobs, visibleJobs } from "../jobs.js";
import { nextId } from "../world.js";

// Scenario seeds build trees with these.
export { addDir, addFile, addMany, demoTree, fsOf, fsOpts, fsRaw, viewerSamples, TRASH, BACKUPS } from "../fsmodel.js";

// ── Messages (api/files.rs map_files_err and friends) ───────────────────────
const UNKNOWN_DRIVE = "Luna can't find this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.";
export const MISSING_DRIVE_DB = "Luna's database for this drive is missing. The drive is still plugged in. On the Files page, remove this drive, then add it again. Your files stay on the drive, but items in its Trash won't show up after you add it again.";
const notFound = () => fail(404, "Luna can't find that file or folder.", "not_found");
const gone = () => fail(404, "This file doesn't exist anymore.", "not_found");
const badPath = () => fail(400, "Luna can't open that path.");
const readOnlyDrive = () => fail(409, "This drive is read-only right now, so Luna can't change it.");

/** files::drive_root. */
export function needDrive(world, id) {
  if (!driveUsable(world, id)) throw fail(404, UNKNOWN_DRIVE, "unknown_drive");
  if (world.driveDbMissing?.includes(id)) throw fail(500, MISSING_DRIVE_DB, "missing_drive_db");
  return driveRow(world, id);
}
/** Anything that changes the drive fails the way the OS fails on a read-only drive. */
function needWritable(world, id) {
  if (driveRow(world, id)?.state === "readonly") throw readOnlyDrive();
}

const ILLEGAL = /^\.luna-[0-9a-f]{8}/;
/** files::safe_name. */
function safeName(name) {
  const n = String(name ?? "");
  const t = n.trim();
  if (/[/\\\0]/.test(n) || !t || t === "." || t === ".." || t.length > 255 || ILLEGAL.test(t) || t === TRASH) throw badPath();
  return t;
}

/** files::canonical_rel: `..` and backslashes are refused. */
function requestPath(raw) {
  const text = String(raw ?? "");
  if (text.includes("\\") || text.split("/").includes("..")) throw badPath();
  return clean(text);
}

const spread = (world, user, driveId, path) => capsToStr(capsOnPath(world, user, driveId, path));

function privateFlags(world, driveId, path, node) {
  if (node.private) return { private: true };
  return privateBoundary(world, driveId, path) ? { in_private: true } : {};
}

function entryOf(world, user, driveId, path, node, extra = {}) {
  return {
    name: base(path),
    kind: node.kind,
    size: node.kind === "file" ? node.size || 0 : 0,
    modified: node.modified,
    hidden: Boolean(node.hidden) || base(path).startsWith("."),
    ...(node.saving ? { saving: true } : {}),
    caps: spread(world, user, driveId, path),
    ...privateFlags(world, driveId, path, node),
    ...extra,
  };
}

// ── Trash gates (check_trash_list / check_trash_item) ───────────────────────
function checkTrashList(world, user, driveId) {
  if (!hasWriteOnDrive(world, user, driveId)) throw fail(403, "You don't have permission to view trash on this drive.");
}
function checkTrashItem(world, user, driveId, path) {
  if (!path.startsWith(`${TRASH}/`)) throw fail(400, "Luna only works with files that are already in the trash.");
  const { entry, sub } = trashEntry(fsOf(world, driveId), path);
  const hidden = () => fail(404, "Luna can't find that file or folder.");
  if (entry?.private_boundary) {
    if (!hasCap(world, user, driveId, path, CAP_EDIT)) throw hidden();
    return;
  }
  if (isAdmin(user)) return;
  if (!entry) throw hidden();
  const original = sub ? join(entry.original_path, sub) : entry.original_path;
  if (!original || !hasCap(world, user, driveId, original, CAP_EDIT)) throw hidden();
}
/** Refuse to delete a folder that holds private items only their owners can change. */
function checkNoForeignPrivate(world, user, driveId, path) {
  if (holdsUnreachablePrivate(world, user, driveId, path)) throw fail(403, "This folder holds private items that only their owners can delete.");
}

function trashRows(world, user, driveId, rel) {
  const fs = fsOf(world, driveId);
  const top = rel === TRASH;
  let rows;
  if (top) {
    rows = fs.trash.map((t) => ({ t, rel: "", node: t.nodes[""], name: t.key, trashPath: `${TRASH}/${t.key}`, original: t.original_path }));
  } else {
    const { entry, sub } = trashEntry(fs, rel);
    if (!entry) throw notFound();
    rows = Object.entries(entry.nodes)
      .filter(([r]) => r && parentOf(r) === sub)
      .map(([r, node]) => ({ t: entry, rel: r, node, name: base(r), trashPath: `${rel}/${base(r)}`, original: join(entry.original_path, r) }));
  }
  return rows
    .filter((r) => {
      const protectedItem = r.node.private || r.t.private_boundary;
      if (protectedItem) return hasCap(world, user, driveId, r.trashPath, CAP_EDIT);
      return r.original ? hasCap(world, user, driveId, r.original, CAP_EDIT) : isAdmin(user);
    })
    .map((r) => ({
      name: r.name,
      kind: r.node.kind,
      size: r.node.kind === "file" ? r.node.size || 0 : 0,
      modified: r.node.modified,
      hidden: base(r.name).startsWith("."),
      ...(r.node.private || r.t.private_boundary ? { private: Boolean(r.node.private) } : {}),
      caps: spread(world, user, driveId, r.trashPath),
      original_path: r.original,
      ...(top ? { original_name: base(r.original) } : {}),
    }));
}

// ── Browsing ────────────────────────────────────────────────────────────────
get("/api/v1/drives/:id/files", ({ world, user, params, query }) => {
  const driveId = params.id;
  const rel = requestPath(query.path);
  if (isTrashPath(rel)) {
    if (rel === TRASH) checkTrashList(world, user, driveId); else checkTrashItem(world, user, driveId, rel);
    needDrive(world, driveId);
    return trashRows(world, user, driveId, rel);
  }
  checkInspect(world, user, driveId, rel);
  needDrive(world, driveId);
  const fs = fsOf(world, driveId);
  const node = rel ? fs.nodes[rel] : { kind: "dir" };
  if (!node) throw notFound();
  if (node.kind === "file") {
    checkAccess(world, user, driveId, rel, CAP_VIEW);
    return [entryOf(world, user, driveId, rel, node)];
  }
  const out = [];
  for (const [p, n] of Object.entries(fs.nodes)) {
    if (parentOf(p) !== rel) continue;
    // Admins see everything except other people's private items.
    if (!isAdmin(user) || n.private) {
      if (!canInspectPath(world, user, driveId, p)) continue;
    }
    out.push(entryOf(world, user, driveId, p, n));
  }
  return out;
});

function totalsOf(fs, path, allow) {
  const all = descendants(fs, path).filter((p) => p !== path && allow(p));
  const files = all.filter((p) => fs.nodes[p].kind === "file");
  const bytes = files.reduce((t, p) => t + (fs.nodes[p].size || 0), 0);
  return { bytes, dirs: all.length - files.length, files: files.length, other: 0, complete: true };
}

get("/api/v1/drives/:id/files/stat", ({ world, user, params, query }) => {
  const driveId = params.id;
  const rel = requestPath(query.path);
  const inTrash = isTrashPath(rel);
  if (inTrash) {
    if (rel === TRASH) checkTrashList(world, user, driveId); else checkTrashItem(world, user, driveId, rel);
  } else {
    checkInspect(world, user, driveId, rel);
  }
  needDrive(world, driveId);
  const fs = fsOf(world, driveId);
  const caps = spread(world, user, driveId, rel);
  if (inTrash) {
    if (rel === TRASH) {
      return { name: "Trash", kind: "dir", size: 0, modified: nowS(), hidden: false, writable: hasWriteOnDrive(world, user, driveId), caps };
    }
    const { entry, sub } = trashEntry(fs, rel);
    if (!entry) throw notFound();
    const n = entry.nodes[sub];
    if (!n) throw notFound();
    const from = sub ? join(entry.original_path, sub) : entry.original_path;
    /** @type {any} */
    const out = {
      name: sub ? base(sub) : base(entry.original_path), kind: n.kind, size: n.kind === "file" ? n.size || 0 : 0, modified: entry.trashed_at,
      hidden: false, writable: hasCap(world, user, driveId, from, CAP_EDIT), trashed_from: from, caps,
      ...(sub ? {} : { original_name: base(entry.original_path) }),
    };
    if (n.kind === "dir") {
      const kids = Object.entries(entry.nodes).filter(([r]) => r && under(r, sub));
      const files = kids.filter(([, x]) => x.kind === "file");
      out.totals = { bytes: files.reduce((t, [, x]) => t + (x.size || 0), 0), dirs: kids.length - files.length, files: files.length, other: 0, complete: true };
    }
    return out;
  }
  if (!rel) {
    const kids = Object.entries(fs.nodes).filter(([p]) => !p.includes("/") && canInspectPath(world, user, driveId, p));
    return {
      name: driveRow(world, driveId).label, kind: "dir", size: 0, modified: nowS(), hidden: false,
      children: { dirs: kids.filter(([, n]) => n.kind === "dir").length, files: kids.filter(([, n]) => n.kind === "file").length, other: 0 },
      writable: hasCap(world, user, driveId, "", CAP_EDIT),
      totals: totalsOf(fs, "", (p) => hasCap(world, user, driveId, p, CAP_VIEW)),
      caps,
    };
  }
  const node = fs.nodes[rel];
  if (!node) throw notFound();
  /** @type {any} */
  const out = {
    name: base(rel), kind: node.kind, size: node.kind === "file" ? node.size || 0 : 0, modified: node.modified,
    hidden: base(rel).startsWith("."), ...(node.saving ? { saving: true } : {}),
    writable: hasCap(world, user, driveId, rel, CAP_EDIT), caps, ...privateFlags(world, driveId, rel, node),
  };
  if (node.kind === "dir") {
    const kids = Object.entries(fs.nodes).filter(([p]) => parentOf(p) === rel && canInspectPath(world, user, driveId, p));
    out.children = { dirs: kids.filter(([, n]) => n.kind === "dir").length, files: kids.filter(([, n]) => n.kind === "file").length, other: 0 };
    out.totals = totalsOf(fs, rel, (p) => hasCap(world, user, driveId, p, CAP_VIEW));
  }
  return out;
});

/** Where a moved or renamed file went. Only for paths that no longer exist; every miss is the same 404. */
get("/api/v1/drives/:id/files/resolve", ({ world, user, params, query }) => {
  const miss = () => fail(404, "Luna can't find where this file went. It may have been deleted.");
  const rel = requestPath(query.path);
  const exists = (d, p) => driveUsable(world, d) && pathExists(world, d, p);
  if (exists(params.id, rel)) throw miss();
  const hit = resolveMove(world, params.id, rel, exists);
  if (!hit || !canInspectPath(world, user, hit.drive_id, hit.path)) throw miss();
  return { drive_id: hit.drive_id, path: hit.path, kind: fsOf(world, hit.drive_id).nodes[hit.path].kind };
});

// ── Recents ─────────────────────────────────────────────────────────────────
const RECENTS_LIMIT = 50;

get("/api/v1/me/recents", ({ world, user }) => {
  const mine = world.recents.filter((r) => r.user_id === user.id).sort((a, b) => b.at - a.at);
  const items = [];
  const drop = [];
  const retarget = [];
  for (const r of mine) {
    if (!driveRow(world, r.driveId)) { drop.push(r); continue; }
    // A drive that is only temporarily not ready keeps its rows.
    if (!driveReady(world, r.driveId)) continue;
    if (!r.path) {
      if (hasDriveAccess(world, user, r.driveId) && items.length < 10) items.push({ kind: "drive", driveId: r.driveId, path: "", at: r.at });
      continue;
    }
    if (pathExists(world, r.driveId, r.path)) {
      if (items.length < 10 && canInspectPath(world, user, r.driveId, r.path)) items.push({ kind: r.kind, driveId: r.driveId, path: r.path, at: r.at });
      continue;
    }
    const hit = resolveMove(world, r.driveId, r.path, (d, p) => driveUsable(world, d) && pathExists(world, d, p));
    if (hit && driveReady(world, hit.drive_id) && canInspectPath(world, user, hit.drive_id, hit.path)) {
      retarget.push([r, hit]);
      if (items.length < 10) items.push({ kind: r.kind, driveId: hit.drive_id, path: hit.path, at: r.at });
    } else {
      drop.push(r);
    }
  }
  for (const [r, hit] of retarget) { r.driveId = hit.drive_id; r.path = hit.path; }
  if (drop.length) world.recents = world.recents.filter((r) => !drop.includes(r));
  const seen = new Set();
  return items.filter((i) => { const k = `${i.kind}\0${i.driveId}\0${i.path}`; return !seen.has(k) && seen.add(k); }).slice(0, 10);
});

post("/api/v1/me/recents", ({ world, user, body }) => {
  const driveId = body.driveId ?? body.drive_id;
  const path = requestPath(body.path);
  if (!path) {
    if (!driveRow(world, driveId)) throw fail(404, "Luna can't find that drive.");
    if (!hasDriveAccess(world, user, driveId)) throw fail(403, "Luna can't open that.");
  } else if (!canInspectPath(world, user, driveId, path)) {
    throw fail(403, "Luna can't open that.");
  }
  if (isTrashPath(path) || !driveId) return { ok: true };
  const kind = ["file", "folder", "drive"].includes(body.kind) ? body.kind : path ? "file" : "drive";
  // Upsert on (user, drive, path).
  const row = world.recents.find((r) => r.user_id === user.id && r.driveId === driveId && r.path === path);
  if (row) Object.assign(row, { kind, at: Date.now() });
  else world.recents.push({ user_id: user.id, kind, driveId, path, at: Date.now() });
  const mine = world.recents.filter((r) => r.user_id === user.id).sort((a, b) => b.at - a.at);
  for (const old of mine.slice(RECENTS_LIMIT)) world.recents = world.recents.filter((r) => r !== old);
  return { ok: true };
});

del("/api/v1/me/recents", ({ world, user, query }) => {
  const driveId = query.driveId ?? query.drive_id;
  if (driveId && query.path != null) {
    const path = requestPath(query.path);
    world.recents = world.recents.filter((r) => !(r.user_id === user.id && r.driveId === driveId && r.path === path));
  } else {
    world.recents = world.recents.filter((r) => r.user_id !== user.id);
  }
  return { ok: true };
});

// ── File contents ───────────────────────────────────────────────────────────
// A 1×1 PNG, a one-page PDF, and filler for everything the browser can't really play.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PDF = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 40 100 Td (Luna sample PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

export function bytesFor(node) {
  if (node.text != null) return [node.text, "text/plain; charset=utf-8"];
  if (node.sample === "png") return [PNG, "image/png"];
  if (node.sample === "pdf") return [PDF, "application/pdf"];
  return [new Uint8Array(Math.min(node.size || 64, 4096)), "application/octet-stream"];
}

get("/api/v1/drives/:id/files/content", ({ world, user, params, query }) => {
  const driveId = params.id;
  const rel = requestPath(query.path);
  if (rel === TRASH) checkTrashList(world, user, driveId);
  else if (isTrashPath(rel)) checkTrashItem(world, user, driveId, rel);
  else checkAccess(world, user, driveId, rel, CAP_VIEW);
  needDrive(world, driveId);
  const fs = fsOf(world, driveId);
  let node;
  if (isTrashPath(rel)) {
    const { entry, sub } = trashEntry(fs, rel);
    node = entry?.nodes[sub];
  } else {
    node = rel ? fs.nodes[rel] : { kind: "dir" };
  }
  if (!node) throw gone();
  if (node.kind === "dir") {
    if (query.download !== "1") throw fail(400, "That's a folder. Use Download to save it as a zip file.");
    return raw(new Uint8Array(22), "application/zip", 200, { "Content-Disposition": `attachment; filename="${base(rel) || "drive"}.zip"` });
  }
  const [data, type] = bytesFor(node);
  return raw(data, type, 200, query.download === "1" ? { "Content-Disposition": `attachment; filename="${base(rel)}"` } : {});
});

// ── Changes: create, mkdir, rename, delete ──────────────────────────────────
function newItem(kind) {
  return ({ world, user, params, body }) => {
    const driveId = params.id;
    const path = requestPath(body.path);
    if (!path) throw fail(400, kind === "dir" ? "Choose a name for the new folder." : "Choose a name for the new file.");
    if (kind === "file" && body.private) throw fail(400, "Only folders can be private. Put this file in a private folder instead.");
    const folder = parentOf(path);
    checkAccess(world, user, driveId, folder, CAP_UPLOAD);
    needDrive(world, driveId);
    needWritable(world, driveId);
    const name = base(path);
    if (ILLEGAL.test(name) || name === TRASH) throw badPath();
    const fs = fsOf(world, driveId);
    if (folder && fs.nodes[folder]?.kind !== "dir") throw fail(404, "Luna can't find the parent folder. Open it and try again.");
    if (fs.nodes[path]) throw fail(409, kind === "dir" ? "A folder with this name is already here. Choose another name." : "A file with this name is already here. Choose another name.");
    fs.nodes[path] = { kind, ...(kind === "file" ? { size: 0, text: "" } : {}), modified: nowS(), ...(kind === "dir" && body.private ? { private: true, owner: user.id } : {}) };
    if (fs.nodes[folder]) fs.nodes[folder].modified = nowS();
    return { ok: true, path };
  };
}
post("/api/v1/drives/:id/files/create", newItem("file"));
post("/api/v1/drives/:id/files/mkdir", newItem("dir"));

post("/api/v1/drives/:id/files/rename", ({ world, user, params, body }) => {
  const driveId = params.id;
  const path = requestPath(body.path);
  checkAccess(world, user, driveId, path, CAP_EDIT);
  needDrive(world, driveId);
  const newName = safeName(body.new_name);
  if (ILLEGAL.test(newName)) throw badPath();
  needWritable(world, driveId);
  const fs = fsOf(world, driveId);
  if (!path || isTrashPath(path) && path === TRASH) throw badPath();
  if (!fs.nodes[path]) throw notFound();
  const to = join(parentOf(path), newName);
  if (to === path) return { ok: true };
  if (fs.nodes[to]) throw fail(409, "A file with this name is already here. Choose another name.");
  for (const k of descendants(fs, path)) {
    fs.nodes[k === path ? to : to + k.slice(path.length)] = fs.nodes[k];
    delete fs.nodes[k];
  }
  recordMove(world, driveId, path, driveId, to);
  return { ok: true };
});

del("/api/v1/drives/:id/files", ({ world, user, params, query }) => {
  const driveId = params.id;
  const path = requestPath(query.path);
  checkAccess(world, user, driveId, path, CAP_EDIT);
  checkNoForeignPrivate(world, user, driveId, path);
  needDrive(world, driveId);
  needWritable(world, driveId);
  if (!path) throw badPath();
  const fs = fsOf(world, driveId);
  if (!fs.nodes[path]) throw notFound();
  const trashPath = moveToTrash(world, driveId, path);
  return { ok: true, trash_path: trashPath };
});

post("/api/v1/drives/:id/files/restore", ({ world, user, params, body }) => {
  const driveId = params.id;
  const path = requestPath(body.path);
  const dest = requestPath(body.dest);
  checkTrashItem(world, user, driveId, path);
  checkAccess(world, user, driveId, dest, CAP_UPLOAD);
  needDrive(world, driveId);
  const fs = fsOf(world, driveId);
  const { entry, sub } = trashEntry(fs, path);
  if (!entry) throw notFound();
  // Only whole top-level entries restore.
  if (sub) throw fail(400, "Luna can only put files back from the trash on this drive.");
  if (isTrashPath(dest) || !dest) throw fail(400, "Luna can only put files back from the trash on this drive.");
  if (!body.confirm_broaden && broadensAccess(world, driveId, path, driveId, parentOf(dest))) {
    throw fail(409, "Restoring here lets everyone with access to this folder open it.", "broadens_access");
  }
  needWritable(world, driveId);
  if (fs.nodes[dest]) throw fail(409, "A file with this name is already there. Choose another name.");
  // The folders the item came from may be gone by now: make them again.
  ensureDirs(fs, parentOf(dest));
  for (const [rel, n] of Object.entries(entry.nodes)) fs.nodes[rel ? join(dest, rel) : dest] = n;
  fs.trash = fs.trash.filter((t) => t !== entry);
  return { ok: true };
});

post("/api/v1/drives/:id/files/purge", ({ world, user, params, body }) => {
  const driveId = params.id;
  const path = requestPath(body.path);
  const fs = () => fsOf(world, driveId);
  if (path === TRASH) {
    // Everyone empties only the entries they can see; someone else's private item stays.
    needDrive(world, driveId);
    checkTrashList(world, user, driveId);
    for (const row of trashRows(world, user, driveId, TRASH)) {
      const rel = `${TRASH}/${row.name}`;
      if (holdsUnreachablePrivate(world, user, driveId, rel)) continue;
      fs().trash = fs().trash.filter((t) => t.key !== row.name);
    }
    return { ok: true };
  }
  checkTrashItem(world, user, driveId, path);
  checkNoForeignPrivate(world, user, driveId, path);
  needDrive(world, driveId);
  const { entry, sub } = trashEntry(fs(), path);
  if (!entry) throw notFound();
  if (sub) throw fail(400, "Luna only permanently removes files that are already in the trash.");
  fs().trash = fs().trash.filter((t) => t !== entry);
  return { ok: true };
});

// ── Uploads in one request (multipart) ──────────────────────────────────────
/** api/uploads.rs name_clash: a taken name needs a decision. */
function nameClash(kind) {
  const message = kind === "dir" ? "A folder with this name is already here. Choose another name." : "A file with this name is already here. Rename it or choose another.";
  return fail(409, message, "exists", kind ? { existing_kind: kind } : {});
}
const kindOf = (node) => (node.kind === "dir" ? "dir" : "file");
/** files::uploads::find_free_name: "name (1).ext", "name (2).ext", … */
const freeName = (fs, folder, name) => uniqueName(fs, folder, name);

const SAVE_FAIL = "That file name can't be used. Try renaming it.";
const TEXT_FILE = /\.(txt|md|markdown|json|csv|log|ya?ml|html?|css|js|xml)$/i;

/** Drive-level failures a write meets once the drive is chosen (plain_upload_error). */
function saveBlockers(world, driveId, bytes) {
  if (driveRow(world, driveId)?.state === "readonly") {
    throw fail(500, "Luna couldn't save this file. This drive is read-only, so Luna can't save to it.");
  }
  const free = world.summaries[driveId]?.free_bytes;
  if (free != null && bytes > free) throw fail(500, "Luna couldn't save this file. This drive is full. Free up space or choose another drive.");
}

post("/api/v1/drives/:id/files/upload", async ({ world, user, params, query, body, checkAbort }) => {
  const driveId = params.id;
  const folder = requestPath(query.path ?? body.path);
  checkAccess(world, user, driveId, folder, CAP_UPLOAD);
  const file = body.file;
  if (!file || typeof file === "string") throw fail(400, "Choose a file to upload first.");
  const name = (() => { try { return safeName(file.name || "file"); } catch { throw fail(400, SAVE_FAIL); } })();
  if (ILLEGAL.test(name)) throw fail(400, SAVE_FAIL);
  needDrive(world, driveId);
  const fs = fsOf(world, driveId);
  let path = join(folder, name);
  let finalName = name;
  const overwrite = query.overwrite === "1";
  const keepBoth = query.keep_both === "1" && !overwrite;
  if (fs.nodes[path]) {
    if (keepBoth) finalName = freeName(fs, folder, name);
    else if (!overwrite) throw nameClash(kindOf(fs.nodes[path]));
    else if (!hasCap(world, user, driveId, path, CAP_EDIT)) throw fail(403, "You don't have permission to change this file.");
  }
  path = join(folder, finalName);
  const size = file.size ?? 0;
  saveBlockers(world, driveId, size);
  const text = typeof file.text === "function" && size < 2_000_000 && TEXT_FILE.test(name) ? await file.text() : null;
  // An upload cancelled while it was being read changes nothing.
  checkAbort();
  ensureDirs(fs, folder);
  const old = fs.nodes[path];
  fs.nodes[path] = { kind: "file", size, modified: nowS(), ...(text != null ? { text } : { sample: "bin" }), ...(old?.private ? { private: true, owner: old.owner } : {}) };
  return { name: finalName, kind: "file", size, modified: fs.nodes[path].modified, hidden: false, caps: spread(world, user, driveId, path) };
});

// ── Uploads in pieces (api/uploads.rs) ──────────────────────────────────────
const MAX_FILE_BYTES = 1024 * 1024 * 1024 * 1024;
const NO_SAVE = "You don't have permission to save here.";

function uploadOf(world, user, id) {
  const u = world.uploads?.[id];
  if (!u) throw fail(404, "Luna doesn't know this upload.");
  if (!isAdmin(user) && u.principal !== `user:${user.id}`) throw fail(403, "That upload belongs to someone else.");
  if (!hasCap(world, user, u.drive_id, u.path, CAP_UPLOAD)) throw fail(403, NO_SAVE);
  return u;
}

post("/api/v1/uploads", ({ world, user, body }) => {
  const driveId = body.drive_id;
  const folder = requestPath(body.path);
  if (!hasCap(world, user, driveId, folder, CAP_UPLOAD)) throw fail(403, NO_SAVE);
  if (Number(body.size) > MAX_FILE_BYTES) throw fail(400, "Luna can't accept files larger than 1 TB.");
  needDrive(world, driveId);
  let name;
  try { name = safeName(body.name); } catch { throw fail(500, "Luna couldn't finish this upload. Check the drive and try again."); }
  // Look before taking the bytes: a taken name needs a decision, and a drive with too little room says so now.
  const taken = fsOf(world, driveId).nodes[join(folder, name)];
  if (taken && !body.on_conflict) throw nameClash(kindOf(taken));
  const free = world.summaries[driveId]?.free_bytes;
  if (free != null && free < (Number(body.size) || 0)) throw fail(507, "This drive is full. Free up some space and try again.");
  const id = nextId("up");
  world.uploads ??= {};
  world.uploads[id] = { id, drive_id: driveId, path: folder, name, size: Number(body.size) || 0, received: 0, principal: `user:${user.id}`, on_conflict: body.on_conflict || "" };
  return { upload_id: id, received: 0, size: world.uploads[id].size, name };
});

put("/api/v1/uploads/:id", ({ world, user, params, raw: chunk, headers }) => {
  const u = uploadOf(world, user, params.id);
  const m = /^bytes (\d+)-(\d+)(?:\/(\d+|\*))?$/.exec(headers["content-range"] || "");
  if (!m) throw fail(400, "Each chunk needs a Content-Range header (bytes start-end/total).");
  const start = Number(m[1]);
  const end = Number(m[2]);
  const length = chunk?.size ?? chunk?.byteLength ?? end - start + 1;
  if (length !== end - start + 1) throw fail(400, "The chunk size doesn't match its range.");
  if (end + 1 > u.size) throw fail(400, "That chunk doesn't fit this upload.");
  if (start <= u.received) u.received = Math.max(u.received, end + 1);
  return { upload_id: u.id, received: u.received };
});

post("/api/v1/uploads/:id/complete", ({ world, user, params, query }) => {
  const u = uploadOf(world, user, params.id);
  const overwrite = query.overwrite === "1";
  const keepBoth = query.keep_both === "1" && !overwrite;
  const fs = fsOf(world, u.drive_id);
  if (u.received !== u.size) throw fail(400, "That chunk doesn't fit this upload.");
  needDrive(world, u.drive_id);
  let name = u.name;
  let path = join(u.path, name);
  // A name that appeared since the upload began is decided here, and the session stays usable.
  if (fs.nodes[path]) {
    if (keepBoth) { name = freeName(fs, u.path, name); path = join(u.path, name); }
    else if (!overwrite) throw nameClash(kindOf(fs.nodes[path]));
    else if (!hasCap(world, user, u.drive_id, path, CAP_EDIT)) throw fail(403, "You don't have permission to change this file.");
  }
  saveBlockers(world, u.drive_id, 0);
  ensureDirs(fs, u.path);
  fs.nodes[path] = { kind: "file", size: u.size, modified: nowS(), sample: "bin" };
  delete world.uploads[u.id];
  return { name, kind: "file", size: u.size, modified: nowS(), hidden: false, caps: spread(world, user, u.drive_id, path) };
});

del("/api/v1/uploads/:id", ({ world, user, params }) => {
  const u = uploadOf(world, user, params.id);
  delete world.uploads[u.id];
  return { ok: true };
});

// ── Copy / move jobs (api/jobs.rs) ──────────────────────────────────────────
post("/api/v1/jobs", ({ world, user, body }) => enqueueJob(world, user, body));
get("/api/v1/jobs", ({ world, user, query }) => {
  tickJobs(world);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return visibleJobs(world, user).slice(-limit).reverse().map((j) => jobJson(world, j, user));
});
get("/api/v1/jobs/:id", ({ world, user, params }) => {
  tickJobs(world);
  return jobJson(world, findJob(world, user, params.id), user);
});
del("/api/v1/jobs/:id", ({ world, user, params }) => {
  tickJobs(world);
  cancelJob(world, findJob(world, user, params.id));
  return { ok: true };
});

// ── Search (api/search.rs) ──────────────────────────────────────────────────
get("/api/v1/search", async ({ world, user, query }) => {
  const o = fsOpts(world).search;
  if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
  if (o.error) throw fail(500, o.error);
  const q = String(query.q || "").toLowerCase();
  if (q.trim().length < 2) throw fail(400, "Type at least 2 letters to search.");
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const hits = [];
  for (const driveId of Object.keys(world.fs || {})) {
    if (!driveReady(world, driveId)) continue;
    for (const [p, n] of Object.entries(world.fs[driveId].nodes)) {
      if (query.kind === "dir" && n.kind !== "dir") continue;
      if (query.kind === "file" && n.kind === "dir") continue;
      if (!hasCap(world, user, driveId, p, CAP_VIEW)) continue;
      const name = base(p).toLowerCase();
      if (!words.every((w) => name.includes(w))) continue;
      const priv = privateBoundary(world, driveId, p);
      hits.push({ drive_id: driveId, path: p, parent: parentOf(p), name: base(p), kind: n.kind, size: n.size || 0, modified: n.modified, match: "name", ...(priv ? { private: true } : {}) });
    }
  }
  const limit = o.limit ?? 100;
  return { hits: hits.slice(0, limit), close_only: false, truncated: hits.length > limit, scan: o.scanning ? { scanning: true, drives_total: 2, drives_done: 1, dirs_indexed: 1200 } : { scanning: false, drives_total: 1, drives_done: 1, dirs_indexed: 100 } };
});

// ── Office editors: the fake has no document server ─────────────────────────
post("/api/v1/office/session", () => fail(503, "The document editor isn't available in this preview. Open it on a real Luna.", "office_unavailable"));

