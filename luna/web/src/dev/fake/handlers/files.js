// Files: browsing, trash, uploads, copy/move jobs, drive backups, private folders
// and search. A drive's contents live in `world.fs[driveId]` as a flat map of
// path → node, so a rename, delete or upload really changes what the next
// listing shows. Scenario seeds build trees with the helpers exported here.
import { del, fail, get, json, post, put, raw } from "../engine.js";
import { backup as makeBackup, cloudBackup as makeCloudBackup, nextId } from "../world.js";

export const TRASH = ".luna-trash";
export const BACKUPS = ".luna-backups";

const nowS = () => Math.floor(Date.now() / 1000);
const isAdmin = (u) => u?.role === "admin";
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (a, b) => (a ? `${a}/${b}` : b);
const clean = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const under = (p, dir) => (dir ? p.startsWith(`${dir}/`) : true);

// ── The world's file system ─────────────────────────────────────────────────
/** @typedef {{ kind: "file"|"dir", size?: number, modified: number, text?: string, sample?: string, hidden?: boolean, private?: boolean, owner?: string }} Node */

/** A drive's tree as a seed sees it: starts empty. */
export function fsRaw(world, driveId) {
  world.fs ??= {};
  world.fs[driveId] ??= { nodes: {}, trash: [] };
  return world.fs[driveId];
}

/** Same for handlers, except the main drive shows the demo tree when no seed touched it. */
export function fsOf(world, driveId) {
  if (!world.fs?.[driveId] && driveId === "d1") demoTree(world, driveId);
  return fsRaw(world, driveId);
}

/** Knobs scenarios can turn: job speed and where a job fails, fake bytes, search behavior. */
export function fsOpts(world) {
  world.fsOpts ??= { jobMs: 6000, jobFailAt: null, jobFailMessage: "", search: {} };
  return world.fsOpts;
}

function ensureDirs(fs, path) {
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) {
    const p = parts.slice(0, i).join("/");
    fs.nodes[p] ??= { kind: "dir", modified: nowS() };
  }
}

/** Put a file on a drive, creating any folders above it. */
export function addFile(world, driveId, path, over = {}) {
  const fs = fsRaw(world, driveId);
  ensureDirs(fs, parentOf(path));
  fs.nodes[path] = { kind: "file", size: 1200, modified: nowS() - 3600, ...over };
  if (over.text != null && over.size == null) fs.nodes[path].size = over.text.length;
  return fs.nodes[path];
}

export function addDir(world, driveId, path, over = {}) {
  const fs = fsRaw(world, driveId);
  ensureDirs(fs, path);
  Object.assign(fs.nodes[path], over);
  return fs.nodes[path];
}

/** `count` generated files in a folder; `name(i)` / `over(i)` customize each. */
/** @param {{ name?: (i: number) => string, over?: (i: number) => object }} [options] */
export function addMany(world, driveId, folder, count, options = {}) {
  const { name = (i) => `File ${String(i).padStart(5, "0")}.txt`, over = (_i) => ({}) } = options;
  const fs = fsRaw(world, driveId);
  ensureDirs(fs, folder);
  for (let i = 0; i < count; i += 1) {
    fs.nodes[join(folder, name(i))] = { kind: "file", size: 500 + ((i * 7919) % 90000), modified: nowS() - ((i * 977) % 8_000_000), ...over(i) };
  }
}

/** A believable family drive: Photos, Documents, a few loose files. */
export function demoTree(world, driveId = "d1") {
  addDir(world, driveId, "Photos/2024/Spain");
  addDir(world, driveId, "Photos/2025");
  addDir(world, driveId, "Documents/Taxes");
  addDir(world, driveId, "Music");
  addFile(world, driveId, "Photos/2024/Spain/beach.jpg", { size: 2_400_000, sample: "png" });
  addFile(world, driveId, "Photos/2024/Spain/dinner.jpg", { size: 1_900_000, sample: "png" });
  addFile(world, driveId, "Documents/notes.txt", { text: "Shopping list\n- eggs\n- tea\n- batteries\n" });
  addFile(world, driveId, "Documents/readme.md", { text: "# Family handbook\n\nWelcome. **Wi-Fi** is on the fridge.\n\n- Bins on Tuesday\n- Cat food in the cupboard\n" });
  addFile(world, driveId, "Documents/Taxes/2025 return.pdf", { size: 180_000, sample: "pdf" });
  addFile(world, driveId, "Documents/budget.csv", { text: "Month,Rent,Food\nJan,900,310\nFeb,900,295\nMar,900,330\n" });
  addFile(world, driveId, "Music/song.mp3", { size: 4_100_000, sample: "bin" });
  addFile(world, driveId, "holiday.mp4", { size: 52_000_000, sample: "bin" });
  addFile(world, driveId, "book.epub", { size: 800_000, sample: "bin" });
  addFile(world, driveId, "backup.bin", { size: 9_000_000, sample: "bin" });
}

/** One of every kind the viewer knows, in a folder called Viewers. */
export function viewerSamples(world, driveId = "d1") {
  const f = (name, over) => addFile(world, driveId, `Viewers/${name}`, over);
  f("notes.txt", { text: "Plain text.\nSecond line.\n" });
  f("config.json", { text: '{\n  "name": "Luna",\n  "drives": 2\n}\n' });
  f("readme.md", { text: "# Heading\n\nSome *markdown* with a [link](https://example.com).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" });
  f("photo.png", { size: 70, sample: "png" });
  f("paper.pdf", { size: 600, sample: "pdf" });
  f("clip.mp4", { size: 3_000_000, sample: "bin" });
  f("song.mp3", { size: 3_000_000, sample: "bin" });
  f("novel.epub", { size: 500_000, sample: "bin" });
  f("table.csv", { text: "name,qty,price\nTea,2,3.50\nEggs,12,2.10\n\"Salt, fine\",1,0.80\n" });
  f("mystery.dat", { size: 4096, sample: "bin" });
  f("report.docx", { size: 22_000, sample: "bin" });
  f("sheet.xlsx", { size: 18_000, sample: "bin" });
  f("sketch.drawio", { size: 3_000, text: "<mxfile></mxfile>" });
  f("board.whiteboard", { size: 2_000, text: "{}" });
}

// ── Lookups and checks ──────────────────────────────────────────────────────
const driveRow = (world, id) => world.drives.find((d) => d.id === id);

function needDrive(world, id, { write = false } = {}) {
  const d = driveRow(world, id);
  const s = world.summaries[id];
  if (!d || d.state === "missing" || d.state === "ejected" || (s && s.mounted === false)) {
    throw fail(404, "Luna can't find this drive. Make sure it's plugged in.", "unknown_drive");
  }
  if (d.state === "failed") throw fail(503, "This drive has stopped answering.", "drive_failed");
  if (write && d.state === "readonly") throw fail(403, "This drive is read-only, so nothing can be changed on it.", "read_only");
  return d;
}

function needSpace(world, id, bytes) {
  const s = world.summaries[id];
  if (s && s.free_bytes != null && bytes > s.free_bytes) throw fail(507, "This drive is full. Free some space and try again.", "drive_full");
}

/** Member rows from world.access; admins pass. Returns the caps bits for a path. */
function canMember(world, user, driveId, path, bit) {
  if (isAdmin(user)) return true;
  const rows = world.access || [];
  const bitsOf = (c) => {
    const s = String(c || "").toLowerCase();
    if (s.startsWith("full")) return 7;
    let b = 0;
    if (s.includes("view") || s.includes("read")) b |= 1;
    if (s.includes("upload") || s === "write" || s === "read_write") b |= 3;
    if (s === "write" || s === "read_write") b |= 3;
    return b;
  };
  let bits = 0;
  for (const r of rows) {
    if ((r.drive_id || r.driveId) !== driveId) continue;
    const g = clean(r.path);
    if (!g || path === g || path.startsWith(`${g}/`)) bits |= bitsOf(r.caps);
  }
  return (bits & bit) !== 0;
}
const needView = (w, u, d, p) => { if (!canMember(w, u, d, p, 1)) throw fail(403, "You don't have access to this folder.", "forbidden"); };
const needEdit = (w, u, d, p) => { if (!canMember(w, u, d, p, 4)) throw fail(403, "You can look at this, but not change it.", "forbidden"); };
const needUpload = (w, u, d, p) => { if (!canMember(w, u, d, p, 2)) throw fail(403, "You can't add files here.", "forbidden"); };

function privateAncestor(fs, path) {
  const parts = path.split("/");
  for (let i = parts.length; i >= 1; i -= 1) {
    const p = parts.slice(0, i).join("/");
    if (fs.nodes[p]?.private) return { path: p, node: fs.nodes[p] };
  }
  return null;
}
function needPrivateAccess(fs, user, path) {
  const anc = privateAncestor(fs, path);
  if (anc && anc.node.owner !== user.id) throw fail(403, "This is a private folder. Only its owner can open it.", "private");
}

function descendants(fs, path) {
  return Object.keys(fs.nodes).filter((p) => p === path || under(p, path));
}
function sizeOf(fs, path) {
  const n = fs.nodes[path];
  if (!n) return 0;
  if (n.kind === "file") return n.size || 0;
  return descendants(fs, path).reduce((t, p) => t + (fs.nodes[p].kind === "file" ? fs.nodes[p].size || 0 : 0), 0);
}
function entryOf(fs, path, node, extra = {}) {
  const priv = Boolean(node.private);
  return {
    name: base(path),
    kind: node.kind,
    size: node.kind === "file" ? node.size || 0 : 0,
    modified: node.modified,
    hidden: Boolean(node.hidden) || base(path).startsWith("."),
    ...(priv ? { private: true } : {}),
    ...(!priv && privateAncestor(fs, path) ? { in_private: true } : {}),
    ...(node.saving ? { saving: true } : {}),
    ...extra,
  };
}

function uniqueName(fs, folder, name) {
  if (!fs.nodes[join(folder, name)]) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 500; i += 1) {
    const n = `${stem} (${i})${ext}`;
    if (!fs.nodes[join(folder, n)]) return n;
  }
  return name;
}

function checkName(name) {
  const n = String(name ?? "");
  if (!n.trim()) throw fail(400, "Give it a name first.", "bad_name");
  if (n.includes("/") || n === "." || n === "..") throw fail(400, "A name can't contain a slash.", "bad_name");
  if (n.length > 255) throw fail(400, "That name is too long. Use 255 characters or fewer.", "bad_name");
}
const exists = (name) => fail(409, `There's already something called "${name}" here.`, "exists");

function needFolder(fs, path) {
  if (path && fs.nodes[path]?.kind !== "dir") throw fail(404, "That folder doesn't exist.", "not_found");
}

// ── Trash ───────────────────────────────────────────────────────────────────
function moveToTrash(fs, path) {
  const keys = descendants(fs, path);
  const key = `${Date.now()}${Math.floor(Math.random() * 1000)}-${base(path)}`;
  const nodes = {};
  for (const k of keys) { nodes[k === path ? "" : k.slice(path.length + 1)] = fs.nodes[k]; delete fs.nodes[k]; }
  fs.trash.push({ key, original_path: path, trashed_at: nowS(), nodes });
}

function trashEntry(fs, path) {
  const rest = path.slice(TRASH.length + 1);
  const key = rest.split("/")[0];
  return { entry: fs.trash.find((t) => t.key === key), sub: rest.slice(key.length + 1) };
}

function listTrash(fs, path) {
  if (path === TRASH) {
    return fs.trash.map((t) => entryOf(fs, t.original_path, t.nodes[""], {
      name: t.key, original_name: base(t.original_path), original_path: t.original_path, modified: t.trashed_at,
      size: t.nodes[""].kind === "file" ? t.nodes[""].size || 0 : 0,
    }));
  }
  const { entry, sub } = trashEntry(fs, path);
  if (!entry) throw fail(404, "That isn't in the trash anymore.", "not_found");
  const out = [];
  for (const [rel, n] of Object.entries(entry.nodes)) {
    if (!rel || parentOf(rel) !== sub) continue;
    out.push(entryOf(fs, rel, n, { original_name: base(rel) }));
  }
  return out;
}

// ── Browsing ────────────────────────────────────────────────────────────────
get("/api/v1/drives/:id/files", ({ world, user, params, query }) => {
  needDrive(world, params.id);
  const fs = fsOf(world, params.id);
  const path = clean(query.path);
  if (path === TRASH || path.startsWith(`${TRASH}/`)) {
    if (!canMember(world, user, params.id, "", 4)) throw fail(403, "You can't open the trash on this drive.", "forbidden");
    return listTrash(fs, path);
  }
  needView(world, user, params.id, path);
  const node = path ? fs.nodes[path] : { kind: "dir" };
  if (!node) throw fail(404, "This folder isn't here anymore.", "not_found");
  if (node.kind === "file") return [entryOf(fs, path, node)];
  needPrivateAccess(fs, user, path);
  const out = [];
  for (const [p, n] of Object.entries(fs.nodes)) {
    if (parentOf(p) === path) out.push(entryOf(fs, p, n));
  }
  return out;
});

get("/api/v1/drives/:id/files/stat", ({ world, user, params, query }) => {
  needDrive(world, params.id);
  const fs = fsOf(world, params.id);
  const path = clean(query.path);
  const writable = driveRow(world, params.id).state !== "readonly" && canMember(world, user, params.id, path, 4);
  if (path === TRASH || path.startsWith(`${TRASH}/`)) {
    if (path === TRASH) {
      const bytes = fs.trash.reduce((t, e) => t + Object.values(e.nodes).reduce((a, n) => a + (n.kind === "file" ? n.size || 0 : 0), 0), 0);
      return { name: "Trash", kind: "dir", writable, trashed_from: "", totals: { bytes, dirs: fs.trash.filter((t) => t.nodes[""].kind === "dir").length, files: fs.trash.filter((t) => t.nodes[""].kind === "file").length, other: 0, complete: true } };
    }
    const { entry, sub } = trashEntry(fs, path);
    if (!entry) throw fail(404, "That isn't in the trash anymore.", "not_found");
    const n = entry.nodes[sub];
    return { name: base(sub || entry.original_path), kind: n?.kind || "dir", writable, trashed_from: sub ? join(entry.original_path, sub) : entry.original_path, size: n?.size || 0, modified: entry.trashed_at };
  }
  if (!path) {
    const keys = Object.keys(fs.nodes);
    const files = keys.filter((k) => fs.nodes[k].kind === "file");
    return { name: driveRow(world, params.id).label, kind: "dir", writable, modified: nowS(), totals: { bytes: sizeOf(fs, ""), dirs: keys.length - files.length, files: files.length, other: 0, complete: true } };
  }
  const node = fs.nodes[path];
  if (!node) throw fail(404, "This file doesn't exist anymore.", "not_found");
  needPrivateAccess(fs, user, path);
  const out = { name: base(path), kind: node.kind, size: node.size || 0, modified: node.modified, writable, hidden: base(path).startsWith("."), private: Boolean(node.private), saving: Boolean(node.saving) };
  if (node.kind === "dir") {
    const all = descendants(fs, path).filter((p) => p !== path);
    const files = all.filter((p) => fs.nodes[p].kind === "file");
    out.totals = { bytes: sizeOf(fs, path), dirs: all.length - files.length, files: files.length, other: 0, complete: all.length < 50000 };
  }
  return out;
});

// Followed links for things that were moved: the fake remembers renames and moves.
get("/api/v1/drives/:id/files/resolve", ({ world, params, query }) => {
  const fs = fsOf(world, params.id);
  const from = clean(query.path);
  const hit = (fs.moved || {})[from];
  if (!hit) throw fail(404, "Not found.", "not_found");
  return { path: hit, kind: fs.nodes[hit]?.kind || "file" };
});
function noteMoved(fs, from, to) {
  fs.moved ??= {};
  fs.moved[from] = to;
}

// ── File contents ───────────────────────────────────────────────────────────
// A 1×1 PNG, a one-page PDF, and filler for everything the browser can't really play.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PDF = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 40 100 Td (Luna sample PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

function bytesFor(node) {
  if (node.text != null) return [node.text, "text/plain; charset=utf-8"];
  if (node.sample === "png") return [PNG, "image/png"];
  if (node.sample === "pdf") return [PDF, "application/pdf"];
  return [new Uint8Array(Math.min(node.size || 64, 4096)), "application/octet-stream"];
}

get("/api/v1/drives/:id/files/content", ({ world, user, params, query }) => {
  needDrive(world, params.id);
  const fs = fsOf(world, params.id);
  const path = clean(query.path);
  needView(world, user, params.id, path);
  let node;
  if (path.startsWith(`${TRASH}/`)) {
    const { entry, sub } = trashEntry(fs, path);
    node = entry?.nodes[sub];
  } else {
    node = fs.nodes[path];
    needPrivateAccess(fs, user, path);
  }
  if (!node) throw fail(404, "This file doesn't exist anymore.", "not_found");
  if (node.kind === "dir") return raw(new Uint8Array(22), "application/zip", 200, { "Content-Disposition": `attachment; filename="${base(path)}.zip"` });
  const [data, type] = bytesFor(node);
  return raw(data, type, 200, query.download ? { "Content-Disposition": `attachment; filename="${base(path)}"` } : {});
});

// ── Changes: create, mkdir, rename, delete ──────────────────────────────────
function newItem(kind) {
  return ({ world, user, params, body }) => {
    needDrive(world, params.id, { write: true });
    const fs = fsOf(world, params.id);
    const path = clean(body.path);
    const folder = parentOf(path);
    checkName(base(path));
    needUpload(world, user, params.id, folder);
    needFolder(fs, folder);
    needPrivateAccess(fs, user, folder);
    if (fs.nodes[path]) throw exists(base(path));
    if (kind === "file") needSpace(world, params.id, 1);
    fs.nodes[path] = { kind, ...(kind === "file" ? { size: 0, text: "" } : {}), modified: nowS(), ...(body.private ? { private: true, owner: user.id } : {}) };
    if (fs.nodes[folder]) fs.nodes[folder].modified = nowS();
    return { path };
  };
}
post("/api/v1/drives/:id/files/create", newItem("file"));
post("/api/v1/drives/:id/files/mkdir", newItem("dir"));

post("/api/v1/drives/:id/files/rename", ({ world, user, params, body }) => {
  needDrive(world, params.id, { write: true });
  const fs = fsOf(world, params.id);
  const path = clean(body.path);
  needEdit(world, user, params.id, path);
  const node = fs.nodes[path];
  if (!node) throw fail(404, "This file doesn't exist anymore.", "not_found");
  needPrivateAccess(fs, user, path);
  checkName(body.new_name);
  const to = join(parentOf(path), body.new_name);
  if (to === path) return { path };
  if (fs.nodes[to]) throw exists(body.new_name);
  for (const k of descendants(fs, path)) {
    fs.nodes[k === path ? to : to + k.slice(path.length)] = fs.nodes[k];
    delete fs.nodes[k];
  }
  noteMoved(fs, path, to);
  return { path: to };
});

del("/api/v1/drives/:id/files", ({ world, user, params, query }) => {
  needDrive(world, params.id, { write: true });
  const fs = fsOf(world, params.id);
  const path = clean(query.path);
  needEdit(world, user, params.id, path);
  if (!fs.nodes[path]) throw fail(404, "This file doesn't exist anymore.", "not_found");
  needPrivateAccess(fs, user, path);
  moveToTrash(fs, path);
  return {};
});

post("/api/v1/drives/:id/files/restore", ({ world, user, params, body }) => {
  needDrive(world, params.id, { write: true });
  const fs = fsOf(world, params.id);
  needEdit(world, user, params.id, "");
  const { entry } = trashEntry(fs, clean(body.path));
  if (!entry) throw fail(404, "That isn't in the trash anymore.", "not_found");
  const dest = clean(body.dest);
  checkName(base(dest));
  needFolder(fs, parentOf(dest));
  if (fs.nodes[dest]) throw exists(base(dest));
  const src = entry.original_path;
  if (privateAncestor(fs, src) == null && privateAncestor(fs, parentOf(dest)) == null && Object.values(entry.nodes).some((n) => n.private) && !body.confirm_broaden) {
    throw fail(409, "Restoring this here would let more people open a private folder.", "broadens_access");
  }
  ensureDirs(fs, parentOf(dest));
  for (const [rel, n] of Object.entries(entry.nodes)) fs.nodes[rel ? join(dest, rel) : dest] = n;
  fs.trash = fs.trash.filter((t) => t !== entry);
  return { path: dest };
});

post("/api/v1/drives/:id/files/purge", ({ world, user, params, body }) => {
  needDrive(world, params.id, { write: true });
  const fs = fsOf(world, params.id);
  needEdit(world, user, params.id, "");
  const path = clean(body.path);
  if (path === TRASH) { fs.trash = []; return {}; }
  const { entry } = trashEntry(fs, path);
  if (!entry) throw fail(404, "That isn't in the trash anymore.", "not_found");
  fs.trash = fs.trash.filter((t) => t !== entry);
  return {};
});

// ── Uploads ─────────────────────────────────────────────────────────────────
async function storeUpload(world, user, driveId, folder, name, file, overwrite) {
  needDrive(world, driveId, { write: true });
  const fs = fsOf(world, driveId);
  checkName(name);
  needUpload(world, user, driveId, folder);
  needFolder(fs, folder);
  needPrivateAccess(fs, user, folder);
  const path = join(folder, name);
  if (fs.nodes[path] && !overwrite) throw exists(name);
  if (fs.nodes[path]?.kind === "dir") throw exists(name);
  const size = file?.size ?? 0;
  needSpace(world, driveId, size);
  const isText = typeof file?.text === "function" && size < 2_000_000 && /\.(txt|md|markdown|json|csv|log|ya?ml|html?|css|js|xml)$/i.test(name);
  fs.nodes[path] = { kind: "file", size, modified: nowS(), ...(isText ? { text: await file.text() } : { sample: "bin" }), ...(fs.nodes[path]?.private ? { private: true, owner: fs.nodes[path].owner } : {}) };
  return { path, name };
}

post("/api/v1/drives/:id/files/upload", ({ world, user, params, query, body }) =>
  storeUpload(world, user, params.id, clean(query.path ?? body.path), body.file?.name || "upload.bin", body.file, query.overwrite === "1"));

post("/api/v1/uploads", ({ world, user, body }) => {
  const driveId = body.drive_id;
  needDrive(world, driveId, { write: true });
  const fs = fsOf(world, driveId);
  const folder = clean(body.path);
  checkName(body.name);
  needUpload(world, user, driveId, folder);
  needFolder(fs, folder);
  if (fs.nodes[join(folder, body.name)]) throw exists(body.name);
  needSpace(world, driveId, Number(body.size) || 0);
  const id = nextId("up");
  world.uploads ??= {};
  world.uploads[id] = { id, drive_id: driveId, path: folder, name: body.name, size: Number(body.size) || 0, received: 0 };
  return { upload_id: id };
});

function uploadOf(world, id) {
  const u = world.uploads?.[id];
  if (!u) throw fail(404, "That upload isn't running anymore.", "not_found");
  return u;
}

put("/api/v1/uploads/:id", ({ world, params, raw: chunk, headers }) => {
  const u = uploadOf(world, params.id);
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers["Content-Range"] || "");
  u.received = m ? Number(m[2]) + 1 : u.received + (chunk?.size || 0);
  return { received: u.received };
});

post("/api/v1/uploads/:id/complete", ({ world, params }) => {
  const u = uploadOf(world, params.id);
  const fs = fsOf(world, u.drive_id);
  const path = join(u.path, u.name);
  fs.nodes[path] = { kind: "file", size: u.size, modified: nowS(), sample: "bin" };
  delete world.uploads[u.id];
  return { path, name: u.name };
});
del("/api/v1/uploads/:id", ({ world, params }) => {
  if (world.uploads) delete world.uploads[params.id];
  return {};
});

// ── Copy / move jobs ────────────────────────────────────────────────────────
function applyJob(world, job, share) {
  // share: 0..1, how much of the work actually happens (a job that fails partway keeps what it did).
  const from = fsOf(world, job.from_drive);
  const to = fsOf(world, job.to_drive);
  const keys = descendants(from, job.from_path).sort();
  const take = Math.max(share < 1 ? Math.floor(keys.length * share) : keys.length, 0);
  const destName = job._dest_name;
  ensureDirs(to, job.to_path);
  for (const k of keys.slice(0, take)) {
    const target = join(job.to_path, destName) + k.slice(job.from_path.length);
    to.nodes[target] = { ...from.nodes[k] };
    if (job.kind === "move") { noteMoved(from, k, target); }
  }
  if (job.kind === "move") for (const k of keys.slice(0, take)) delete from.nodes[k];
}

function tickJobs(world) {
  const o = fsOpts(world);
  const t = Date.now();
  for (const job of world.jobs) {
    if (job.state !== "queued" && job.state !== "running") continue;
    const p = Math.min(1, (t - job._t0) / (job._ms || o.jobMs));
    job.progress = Math.round(job.total * Math.min(p, job._failAt ?? 1));
    if (p > 0.05) job.state = "running";
    if (job._failAt != null && p >= job._failAt) {
      applyJob(world, job, job._failAt);
      job.state = "failed";
      job.error = job._failMessage || "Luna couldn't finish this. Some files were left where they were.";
    } else if (p >= 1) {
      applyJob(world, job, 1);
      job.state = "done";
      job.progress = job.total;
    }
  }
}

get("/api/v1/jobs", ({ world }) => {
  tickJobs(world);
  return world.jobs.map(({ _t0, _ms, _failAt, _failMessage, _dest_name, ...pub }) => pub);
});
get("/api/v1/jobs/:id", ({ world, params }) => {
  tickJobs(world);
  const job = world.jobs.find((j) => j.id === params.id);
  if (!job) throw fail(404, "That job isn't running anymore.", "not_found");
  return job;
});
del("/api/v1/jobs/:id", ({ world, params }) => {
  tickJobs(world);
  const job = world.jobs.find((j) => j.id === params.id);
  if (job && (job.state === "running" || job.state === "queued")) job.state = "cancelled";
  return {};
});

post("/api/v1/jobs", ({ world, user, body }) => {
  const o = fsOpts(world);
  const kind = body.kind === "move" ? "move" : "copy";
  const fromPath = clean(body.from_path);
  const toPath = clean(body.to_path);
  needDrive(world, body.from_drive, { write: kind === "move" });
  needDrive(world, body.to_drive, { write: true });
  const from = fsOf(world, body.from_drive);
  const to = fsOf(world, body.to_drive);
  needEdit(world, user, body.to_drive, toPath);
  let source = from.nodes[fromPath];
  if (fromPath.startsWith(`${TRASH}/`)) {
    const { entry } = trashEntry(from, fromPath);
    if (!entry) throw fail(404, "That isn't in the trash anymore.", "not_found");
    ensureDirs(from, "");
    source = entry.nodes[""];
    // A trashed item is moved out by putting it back where it is going.
    const name = uniqueName(to, toPath, base(entry.original_path));
    for (const [rel, n] of Object.entries(entry.nodes)) to.nodes[join(toPath, rel ? join(name, rel) : name)] = n;
    from.trash = from.trash.filter((t) => t !== entry);
    return { id: nextId("j"), kind, state: "done", from_drive: body.from_drive, from_path: fromPath, to_drive: body.to_drive, to_path: toPath, progress: 1, total: 1 };
  }
  if (!source) throw fail(404, "That file doesn't exist anymore.", "not_found");
  needFolder(to, toPath);
  if (body.from_drive === body.to_drive && (toPath === fromPath || toPath.startsWith(`${fromPath}/`))) {
    throw fail(400, "A folder can't go inside itself.", "bad_destination");
  }
  const leavingPrivate = privateAncestor(from, fromPath) && !privateAncestor(to, toPath);
  if (leavingPrivate && !body.confirm_broaden) {
    throw fail(409, "Everyone who can open the destination would be able to open this.", "broadens_access");
  }
  const total = Math.max(sizeOf(from, fromPath), 1);
  const destName = uniqueName(to, toPath, base(fromPath));
  needSpace(world, body.to_drive, kind === "copy" || body.from_drive !== body.to_drive ? total : 0);
  const job = {
    id: nextId("j"), kind, state: "queued", from_drive: body.from_drive, from_path: fromPath,
    to_drive: body.to_drive, to_path: toPath, progress: 0, total, error: "", created_at: nowS(),
    _t0: Date.now(), _ms: o.jobMs, _failAt: o.jobFailAt, _failMessage: o.jobFailMessage, _dest_name: destName,
  };
  world.jobs.push(job);
  return { id: job.id, kind, state: job.state, from_path: fromPath, to_path: toPath };
});

// ── Backups of a drive and the Protect sheet ────────────────────────────────
// These override the plainer ones in core.js (this file loads first): they filter by drive and path.
const cleanPath = clean;
get("/api/v1/backups", ({ world, query }) => {
  if (!query.drive) return world.backups;
  const p = cleanPath(query.path);
  return world.backups.filter((b) => b.source_drive === query.drive && cleanPath(b.source_path) === p);
});

post("/api/v1/backups", ({ world, user, body }) => {
  const { source_drive_id: src, source_path: path, target_drive_id: target } = body;
  if (!target) throw fail(400, "Pick a drive to keep the copy on.");
  needDrive(world, src);
  needDrive(world, target, { write: true });
  if (world.backups.some((b) => b.source_drive === src && cleanPath(b.source_path) === cleanPath(path) && b.target_drive === target)) {
    throw fail(409, "That folder is already backed up to this drive.", "exists");
  }
  const tDrive = driveRow(world, target);
  world.backups.push(makeBackup({
    source_drive: src, source_drive_name: driveRow(world, src)?.label, source_path: cleanPath(path),
    source_name: cleanPath(path) ? base(cleanPath(path)) : driveRow(world, src)?.label,
    target_drive: target, target_drive_name: tDrive?.label, state: "pending", last_ok_at: 0, first_done: false, created_by: user.id,
  }));
  return {};
});
post("/api/v1/cloud/backups", ({ world, body }) => {
  if (!world.connect?.enabled && !world.connectActive) throw fail(409, "Turn on Luna Connect first to keep cloud backups.", "connect_off");
  const path = cleanPath(body.source_path);
  if (world.cloudBackups.some((b) => b.source_drive === body.source_drive_id && cleanPath(b.source_path) === path)) throw fail(409, "This is already backed up to the cloud.", "exists");
  world.cloudBackups.push(makeCloudBackup({ source_drive: body.source_drive_id, source_path: path, source_name: path ? base(path) : driveRow(world, body.source_drive_id)?.label, state: "pending", last_ok_at: 0, first_done: false }));
  return {};
});
post("/api/v1/backups/:id/run", ({ world, params, body }) => {
  const b = world.backups.find((x) => x.id === params.id);
  if (!b) throw fail(404, "That backup doesn't exist anymore.", "not_found");
  const o = fsOpts(world);
  if (o.backupProblem) return { done: false, problem: o.backupProblem };
  b.last_ok_at = nowS(); b.state = "ok"; b.first_done = true; b.last_error = "";
  void body;
  return { done: true };
});

get("/api/v1/drives/:id/backups", ({ world, params }) => {
  needDrive(world, params.id);
  return world.backups.filter((b) => b.target_drive === params.id).map((b) => ({ ...b, size_bytes: b.size_bytes ?? 2_500_000 }));
});
get("/api/v1/drives/:id/backups/:bid/list", ({ world, params, query }) => {
  const b = world.backups.find((x) => x.id === params.bid);
  if (!b) throw fail(404, "That backup doesn't exist anymore.", "not_found");
  const src = fsOf(world, b.source_drive);
  const root = cleanPath(b.source_path);
  const folder = join(root, cleanPath(query.path));
  const out = [];
  for (const [p, n] of Object.entries(src.nodes)) {
    if (parentOf(p) === folder && under(p, root) || (!root && parentOf(p) === folder)) out.push({ name: base(p), is_dir: n.kind === "dir", size: n.size || 0, mtime: n.modified, deleted: false });
  }
  for (const t of src.trash) if (parentOf(t.original_path) === folder) out.push({ name: base(t.original_path), is_dir: t.nodes[""].kind === "dir", size: t.nodes[""].size || 0, mtime: t.nodes[""].modified, deleted: true, deleted_at: t.trashed_at });
  return out;
});
get("/api/v1/drives/:id/backups/:bid/versions", ({ world }) => {
  const t = nowS();
  const o = fsOpts(world);
  if (o.noVersions) return [];
  return [{ at: t - 3600, size: 12_000, current: true }, { at: t - 5 * 86400, size: 11_400 }, { at: t - 21 * 86400, size: 9_800 }];
});
get("/api/v1/drives/:id/backups/:bid/download", () => raw("backup copy", "application/octet-stream"));
post("/api/v1/drives/:id/backups/:bid/restore", ({ world, params, body }) => {
  const b = world.backups.find((x) => x.id === params.bid);
  if (!b) throw fail(404, "That backup doesn't exist anymore.", "not_found");
  needDrive(world, b.source_drive, { write: true });
  const fs = fsOf(world, b.source_drive);
  const rel = cleanPath(body.path);
  const full = join(cleanPath(b.source_path), rel);
  const name = uniqueName(fs, parentOf(full), `${base(full)}`.replace(/(\.[^.]+)?$/, " (restored)$1"));
  addFile(world, b.source_drive, join(parentOf(full), name), { size: 12_000, sample: "bin" });
  return { name };
});

// ── Private folders ─────────────────────────────────────────────────────────
function privateItems(world, userId) {
  const out = [];
  for (const [driveId, fs] of Object.entries(world.fs || {})) {
    for (const [p, n] of Object.entries(fs.nodes)) {
      if (!n.private || (userId && n.owner !== userId)) continue;
      const mine = world.backups.filter((b) => b.source_drive === driveId && cleanPath(b.source_path) === p).length;
      const cloud = world.cloudBackups.some((b) => b.source_drive === driveId && cleanPath(b.source_path) === p);
      out.push({ drive_id: driveId, path: p, owner: n.owner, drive_backups: mine, cloud_backup: cloud });
    }
  }
  return out;
}
get("/api/v1/private-backups/mine", ({ world, user }) => ({ items: privateItems(world, user.id) }));
get("/api/v1/private-backups/item", ({ world, user, query }) => {
  const fs = fsOf(world, query.drive);
  const path = cleanPath(query.path);
  const node = fs.nodes[path];
  if (node?.private) return { private: true, inside_private: false, mine: node.owner === user.id, owner_name: world.users.find((u) => u.id === node.owner)?.display_name || "" };
  const anc = path ? privateAncestor(fs, path) : null;
  if (anc) return { private: false, inside_private: true, mine: anc.node.owner === user.id, owner_name: world.users.find((u) => u.id === anc.node.owner)?.display_name || "" };
  return { private: false, inside_private: false, mine: false, owner_name: "" };
});
del("/api/v1/private-backups/old-copies", () => ({}));
del("/api/v1/private-backups/older-versions", () => ({ ok: true }));
del("/api/v1/private-backups/owners/:id", ({ world, params }) => {
  world.privateSummary = { ...world.privateSummary, owners: (world.privateSummary?.owners || []).filter((o) => String(o.id ?? o.owner_id) !== params.id) };
  return {};
});

// Removed people whose private folders are still on a drive, and private folders nobody owns.
function orphanOwners(world) {
  const live = new Set(world.users.map((u) => u.id));
  const by = {};
  for (const [driveId, fs] of Object.entries(world.fs || {})) {
    for (const [p, n] of Object.entries(fs.nodes)) {
      if (!n.private || !n.owner || live.has(n.owner)) continue;
      by[n.owner] ??= { owner: n.owner, name: n.ownerName || n.owner, count: 0, drives: [] };
      by[n.owner].count += 1;
      if (!by[n.owner].drives.includes(driveId)) by[n.owner].drives.push(driveId);
      void p;
    }
  }
  return Object.values(by);
}
get("/api/v1/private/orphans", ({ world }) => ({ owners: orphanOwners(world), offline_drives: world.offlinePrivateDrives || [] }));
del("/api/v1/private/orphans/:owner", ({ world, params }) => {
  const skipped = [];
  for (const [driveId, fs] of Object.entries(world.fs || {})) {
    const doomed = Object.keys(fs.nodes).filter((p) => fs.nodes[p].private && fs.nodes[p].owner === params.owner);
    if (doomed.length && driveRow(world, driveId)?.state === "readonly") { skipped.push(driveRow(world, driveId).label); continue; }
    for (const p of doomed) for (const k of descendants(fs, p)) delete fs.nodes[k];
  }
  return { skipped_readonly: skipped, failed_drives: world.failedPrivateDrives || [], offline_drives: world.offlinePrivateDrives || [] };
});
get("/api/v1/private/ownerless", ({ world }) => {
  let count = 0;
  for (const fs of Object.values(world.fs || {})) for (const n of Object.values(fs.nodes)) if (n.private && !n.owner) count += 1;
  return { count };
});
post("/api/v1/users/:id/adopt-private", ({ world, params }) => {
  let count = 0;
  for (const fs of Object.values(world.fs || {})) for (const n of Object.values(fs.nodes)) if (n.private && !n.owner) { n.owner = params.id; count += 1; }
  return { count };
});

// ── Search ──────────────────────────────────────────────────────────────────
get("/api/v1/search", async ({ world, user, query }) => {
  const o = fsOpts(world).search;
  if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
  if (o.error) throw fail(500, o.error);
  const q = String(query.q || "").toLowerCase();
  if (q.length < 2) return { hits: [], scan: null };
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const hits = [];
  for (const [driveId, fs] of Object.entries(world.fs || {})) {
    if (!driveRow(world, driveId) || world.summaries[driveId]?.mounted === false) continue;
    for (const [p, n] of Object.entries(fs.nodes)) {
      if (query.kind === "dir" && n.kind !== "dir") continue;
      if (query.kind === "file" && n.kind === "dir") continue;
      const priv = privateAncestor(fs, p);
      if (priv && priv.node.owner !== user.id) continue;
      const name = base(p).toLowerCase();
      if (!words.every((w) => name.includes(w))) continue;
      hits.push({ drive_id: driveId, path: p, parent: parentOf(p), name: base(p), kind: n.kind, size: n.size || 0, modified: n.modified, match: "name", ...(priv ? { private: true } : {}) });
    }
  }
  const limit = o.limit ?? 100;
  return { hits: hits.slice(0, limit), close_only: false, truncated: hits.length > limit, scan: o.scanning ? { scanning: true, drives_total: 2, drives_done: 1, dirs_indexed: 1200 } : { scanning: false, drives_total: 1, drives_done: 1, dirs_indexed: 100 } };
});

// ── Office editors: the fake has no document server ─────────────────────────
post("/api/v1/office/session", () => fail(503, "The document editor isn't available in this preview. Open it on a real Luna.", "office_unavailable"));

void json;
