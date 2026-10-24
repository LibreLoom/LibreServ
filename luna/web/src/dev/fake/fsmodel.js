// The fake drives' contents. A drive's tree lives in `world.fs[driveId]` as a flat map
// of path → node plus a trash list, so a rename, delete or upload really changes what
// the next listing shows. Scenario seeds build trees with the helpers exported here;
// handlers/files.js answers HTTP from it.
import { TRASH, privateBoundary, pathContains } from "./policy.js";

export { TRASH };
export const BACKUPS = ".luna-backups";

export const nowS = () => Math.floor(Date.now() / 1000);
export const base = (p) => p.slice(p.lastIndexOf("/") + 1);
export const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const join = (a, b) => (a ? `${a}/${b}` : b);
export const clean = (p) => String(p ?? "").replace(/\\/g, "/").split("/").filter((s) => s && s !== ".").join("/");
export const under = (p, dir) => (dir ? p.startsWith(`${dir}/`) : true);

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

export function ensureDirs(fs, path) {
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

// ── Tree queries ────────────────────────────────────────────────────────────
export const driveRow = (world, id) => world.drives.find((d) => d.id === id);

/** files::drive_root: a drive Luna can read from (not missing, not ejected, mounted). */
export function driveUsable(world, id) {
  const d = driveRow(world, id);
  const s = world.summaries[id];
  return Boolean(d) && d.mounted !== false && d.state !== "missing" && d.state !== "ejected" && !(s && s.mounted === false);
}

/** Is the drive plugged in and mounted (listable)? */
export function driveReady(world, id) {
  const d = driveRow(world, id);
  const s = world.summaries[id];
  return Boolean(d) && (d.state === "as_is" || d.state === "readonly") && !(s && s.mounted === false);
}

export const descendants = (fs, path) => Object.keys(fs.nodes).filter((p) => p === path || under(p, path));

export function sizeOf(fs, path) {
  const n = fs.nodes[path];
  if (!n) return 0;
  if (n.kind === "file") return n.size || 0;
  return descendants(fs, path).reduce((t, p) => t + (fs.nodes[p].kind === "file" ? fs.nodes[p].size || 0 : 0), 0);
}

/** A free name beside `name` in `folder`: "name (2).ext". */
export function uniqueName(fs, folder, name) {
  if (!fs.nodes[join(folder, name)]) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 500; i += 1) {
    const n = `${stem} (${i})${ext}`;
    if (!fs.nodes[join(folder, n)]) return n;
  }
  return name;
}

// ── Trash ───────────────────────────────────────────────────────────────────
/**
 * Moves a path (and everything under it) into the drive's trash, the way
 * files::delete_to_trash does: the entry is `{seconds}-{name}`, and an item that was
 * private, or sat inside a private folder, remembers whose wall it was behind.
 * Returns the entry's API path.
 */
export function moveToTrash(world, driveId, path) {
  const fs = fsRaw(world, driveId);
  const boundary = privateBoundary(world, driveId, path);
  const keys = descendants(fs, path);
  let secs = nowS();
  while (fs.trash.some((t) => t.key === `${secs}-${base(path)}`)) secs += 1;
  const key = `${secs}-${base(path)}`;
  const nodes = {};
  for (const k of keys) { nodes[k === path ? "" : k.slice(path.length + 1)] = fs.nodes[k]; delete fs.nodes[k]; }
  fs.trash.push({ key, original_path: path, trashed_at: nowS(), nodes, ...(boundary ? { private_boundary: boundary } : {}) });
  // A trashed item is no longer a recent one.
  world.recents = (world.recents || []).filter((r) => !(r.driveId === driveId && pathContains(path, r.path)));
  return `${TRASH}/${key}`;
}

export function trashEntry(fs, path) {
  const rest = path.slice(TRASH.length + 1);
  const key = rest.split("/")[0];
  return { entry: fs.trash.find((t) => t.key === key), sub: rest.slice(key.length + 1) };
}

/** A trash entry's name without its `{seconds}-` prefix. */
export const originalName = (key) => key.replace(/^\d+-/, "");

// ── Forwarding addresses (files::forwarding) and recents ────────────────────
/** Remembers that (oldDrive, oldPath) now lives at (newDrive, newPath), and re-paths recents. */
export function recordMove(world, oldDrive, oldPath, newDrive, newPath) {
  if (!oldPath || !newPath || isTrashApi(oldPath) || isTrashApi(newPath) || (oldDrive === newDrive && oldPath === newPath)) return;
  world.moves ??= [];
  const row = world.moves.find((m) => m.drive_id === oldDrive && m.old_path === oldPath);
  if (row) Object.assign(row, { new_drive: newDrive, new_path: newPath });
  else world.moves.push({ drive_id: oldDrive, old_path: oldPath, new_drive: newDrive, new_path: newPath });
  repathRecents(world, oldDrive, oldPath, newDrive, newPath);
}
const isTrashApi = (p) => p === TRASH || p.startsWith(`${TRASH}/`);

function nextHop(world, drive, path) {
  let best = null;
  for (const m of world.moves || []) {
    if (m.drive_id !== drive || !(path === m.old_path || path.startsWith(`${m.old_path}/`))) continue;
    if (!best || m.old_path.length > best.old_path.length) best = m;
  }
  return best ? [best.new_drive, best.new_path + path.slice(best.old_path.length)] : null;
}

/** Follows the trail from a missing path to the first place something is really there. */
export function resolveMove(world, drive, path, exists) {
  let d = drive;
  let p = clean(path);
  if (!p) return null;
  const seen = new Set([`${d}\0${p}`]);
  for (let hop = 0; hop < 16; hop += 1) {
    const next = nextHop(world, d, p);
    if (!next) return null;
    const key = `${next[0]}\0${next[1]}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (exists(next[0], next[1])) return { drive_id: next[0], path: next[1] };
    [d, p] = next;
  }
  return null;
}

/** Retargets recents after a move or rename; a row already at the target keeps the newer time. */
export function repathRecents(world, oldDrive, oldPath, newDrive, newPath) {
  const rows = world.recents || [];
  for (const r of rows.filter((x) => x.driveId === oldDrive && pathContains(oldPath, x.path))) {
    const target = newPath + r.path.slice(oldPath.length);
    const dup = rows.find((x) => x !== r && x.user_id === r.user_id && x.driveId === newDrive && x.path === target);
    if (dup) {
      dup.at = Math.max(dup.at, r.at);
      world.recents = world.recents.filter((x) => x !== r);
    } else {
      r.driveId = newDrive;
      r.path = target;
    }
  }
}

/** Does something exist at drive/path (a file, folder, or the drive root)? */
export const pathExists = (world, driveId, path) => !path || Boolean(fsOf(world, driveId).nodes[path]);
