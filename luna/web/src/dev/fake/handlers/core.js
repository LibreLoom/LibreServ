// Sign-in, setup, users, drives, system and the dashboard's data. Each handler copies
// its lunad counterpart in crates/lunad/src/api/ — who may call it, the status codes, the
// messages and the JSON shape. Who-may-do-what lives in ../policy.js.
import { del, fail, get, json, patch, post, put } from "../engine.js";
import {
  CAP_VIEW, capsOnPath, capsToStr, grantRows, hasCap, hasDriveAccess, hasWriteOnDrive, isAdmin, ownedPrivatePaths, privateUnder, requireAdmin,
} from "../policy.js";
import { nextId, smartHealth, summary, user as makeUser } from "../world.js";
import { interruptJobs } from "../jobs.js";
import { fsOf, nowS } from "../fsmodel.js";

const unmounted = (id) => ({ id, mounted: false, total_bytes: null, free_bytes: null, used_bytes: null, shortcuts: [] });
const healthy = () => smartHealth();
const lastAdmin = (world, id) => world.users.filter((u) => u.role === "admin").every((u) => u.id === id);
const DEVICE_TOKEN_REJECTED = "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token.";

/** crate::password::validate_password. */
const badPassword = (pw) => {
  if (pw === undefined) return null;
  const text = String(pw);
  if (text.length < 12) return fail(400, "Passwords need at least 12 characters.");
  if (!/[a-zA-Z]/.test(text) || !/[0-9]/.test(text)) return fail(400, "Passwords need at least one letter and one number.");
  return null;
};
const USERNAME_RULE = "Usernames are 3-32 letters, numbers, dots, dashes, or underscores.";
const badUsername = (name) => (/^[a-z0-9._-]{3,32}$/.test(String(name ?? "").trim().toLowerCase()) ? null : fail(400, USERNAME_RULE));
const userJson = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role });

// ── Auth ────────────────────────────────────────────────────────────────────
get("/api/v1/auth/me", ({ user, world }) => (user ? { ...userJson(user), phrase_set: Boolean(world.phrase?.set) } : null), { public: true });
get("/api/v1/auth/status", ({ world }) => ({ has_admin: world.users.length > 0 && world.hasAdmin, connect_active: world.connectActive }), { public: true });

post("/api/v1/auth/login", ({ world, body }) => {
  const u = world.users.find((x) => x.username === String(body.username ?? "").trim().toLowerCase());
  if (!u || body.password === "wrong" || !body.password) return fail(401, "That username or password is wrong.");
  world.sessionUserId = u.id;
  return { ok: true, ...userJson(u) };
}, { public: true });

post("/api/v1/auth/logout", ({ world }) => { world.sessionUserId = null; return { ok: true }; }, { public: true });

post("/api/v1/auth/register", ({ world, user, body }) => {
  const hasUsers = world.users.length > 0;
  if (hasUsers) {
    if (!user) return fail(401, "Sign in to Luna first.");
    if (!isAdmin(user)) return fail(403, "Only an Admin can manage accounts.");
  } else if (world.setupSecret && body.setup_secret !== world.setupSecret) {
    return fail(403, "That device token doesn't match. Paste the device token from connect.luna.libreloom.org, or check the card that came with Luna.");
  }
  const bad = badUsername(body.username) || badPassword(body.password);
  if (bad) return bad;
  const username = String(body.username).trim().toLowerCase();
  if (world.users.some((u) => u.username === username)) return fail(409, "That username is already taken.");
  const created = makeUser({ username, display_name: body.display_name || body.username, role: hasUsers ? "user" : "admin" });
  world.users.push(created);
  if (!hasUsers) { world.hasAdmin = true; world.sessionUserId = created.id; world.phrase = { ...world.phrase, set: false }; }
  return userJson(created);
}, { public: true });

patch("/api/v1/auth/me", ({ user, body }) => {
  if (body.display_name !== undefined) {
    const name = String(body.display_name).trim();
    if (!name || name.length > 80) return fail(400, "Names are 1-80 characters.");
  }
  let changedPassword = false;
  if (body.new_password !== undefined) {
    if (body.current_password === "wrong" || !body.current_password) return fail(403, "That's not your current password.");
    const weak = badPassword(body.new_password);
    if (weak) return weak;
    changedPassword = true;
  }
  if (body.display_name !== undefined) user.display_name = String(body.display_name).trim();
  return { ok: true, ...userJson(user), signed_out: changedPassword, message: changedPassword ? "Password changed. Sign in again with your new password." : "Saved." };
});
post("/api/v1/auth/revoke-sessions", ({ world, user }) => {
  if (!user) return fail(401, "Sign in to Luna first.");
  world.sessionUserId = null;
  return { ok: true, message: "Every browser is signed out. Sign in again on this one if you still need it." };
});
post("/api/v1/auth/revoke-devices", ({ world }) => {
  world.tokens = [];
  return { ok: true, message: "Apps on phones and computers need a new access token." };
});

// ── Setup ───────────────────────────────────────────────────────────────────
get("/api/v1/setup", ({ world, user }) => {
  if (world.users.length > 0 && !user) return fail(401, "Sign in to Luna first.");
  return world.setup;
}, { public: true });
post("/api/v1/setup", ({ world, user, body }) => {
  if (world.users.length > 0) {
    if (!user) return fail(401, "Sign in to Luna first.");
    if (!isAdmin(user)) return fail(403, "Only an Admin can change setup.");
  }
  // Setup can't finish until the signed-in Admin has a recovery phrase.
  if (body.setup_completed === true && !world.phrase?.set) {
    return fail(409, world.users.length > 0 ? "Set up your recovery phrase before you finish setup." : "Create your Luna account and its recovery phrase before you finish setup.", "needs_phrase");
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 40) return fail(400, "Give your Luna a name between 1 and 40 characters.");
    world.name = name;
    body = { ...body, name };
  }
  world.setup = { ...world.setup, ...body };
  if (body.setup_completed === true) world.setup = { ...world.setup, current_step: "done", step_data: {} };
  return world.setup;
}, { public: true });
// world.preflight can be a list of answers: each run gets the next one, the last repeats.
// Calls within 1.5 s count as one run (React dev mode asks twice on mount).
get("/api/v1/setup/preflight", ({ world }) => {
  let result = world.preflight;
  if (Array.isArray(result)) {
    const now = Date.now();
    if (world.preflightRun === undefined) world.preflightRun = 0;
    else if (now - (world.preflightAt ?? 0) > 1500) world.preflightRun += 1;
    world.preflightAt = now;
    result = result[Math.min(world.preflightRun, result.length - 1)];
  }
  return json(result, result.healthy ? 200 : 503);
}, { public: true });
post("/api/v1/setup/fetch-mag", () => ({}), { public: true });

// ── Users ───────────────────────────────────────────────────────────────────
const USERS_ONLY = "Only an Admin can manage users.";
const gate = (user) => requireAdmin(user, USERS_ONLY);

get("/api/v1/users", ({ world, user }) => { gate(user); return world.users.map(userJson); });
get("/api/v1/users/directory", ({ world, user }) => world.users.map((u) => ({
  id: u.id, username: u.username, display_name: u.display_name, shareable: u.id !== user.id, admin: u.role === "admin",
})));
post("/api/v1/users", ({ world, user, body }) => {
  gate(user);
  const bad = badUsername(body.username) || badPassword(body.password);
  if (bad) return bad;
  const username = String(body.username).trim().toLowerCase();
  if (world.users.some((u) => u.username === username)) return fail(409, "That username is already taken.");
  const created = makeUser({ username, display_name: body.display_name || body.username, role: body.role || "user" });
  world.users.push(created);
  return userJson(created);
});
get("/api/v1/users/:id/private-count", ({ world, user, params }) => {
  gate(user);
  const owned = Object.keys(world.fs || {}).reduce((n, d) => n + privateUnder(world, d, "").filter((i) => i.owner === params.id).length, 0);
  return { count: world.privateCounts?.[params.id] ?? owned };
});
get("/api/v1/private/ownerless", ({ world, user }) => {
  gate(user);
  return { count: ownerlessItems(world).length };
});

function ownerlessItems(world) {
  const out = [];
  for (const driveId of Object.keys(world.fs || {})) {
    for (const item of privateUnder(world, driveId, "")) {
      if (!world.users.some((u) => u.id === item.owner) && !(world.deletedUsers || []).some((u) => u.id === item.owner)) out.push({ driveId, ...item });
    }
  }
  return out;
}
post("/api/v1/users/:id/adopt-private", ({ world, user, params }) => {
  gate(user);
  if (!world.users.some((u) => u.id === params.id)) return fail(404, "Luna doesn't know that person.");
  const items = ownerlessItems(world);
  for (const it of items) world.fs[it.driveId].nodes[it.path].owner = params.id;
  return { count: items.length };
});

patch("/api/v1/users/:id", ({ world, user, params, body }) => {
  gate(user);
  if (body.password !== undefined) {
    const weak = badPassword(body.password);
    if (weak) return weak;
  }
  const target = world.users.find((u) => u.id === params.id);
  if (!target) return fail(404, "Luna doesn't know that person.");
  if (body.username !== undefined) {
    const bad = badUsername(body.username);
    if (bad) return bad;
    const name = String(body.username).trim().toLowerCase();
    if (name !== target.username && world.users.some((u) => u.username === name)) return fail(409, "That username is already taken.");
    target.username = name;
  }
  if (body.display_name !== undefined) {
    const name = String(body.display_name).trim();
    if (!name || name.length > 80) return fail(400, "Names are 1-80 characters.");
    target.display_name = name;
  }
  if (body.role !== undefined) {
    const role = String(body.role).trim().toLowerCase();
    if (role !== "admin" && role !== "user") return fail(400, "Roles are admin or member.");
    if (role !== target.role) {
      if (user.id === target.id && role !== "admin") return fail(400, "You can't take away your own admin rights.");
      if (target.role === "admin" && lastAdmin(world, target.id)) return fail(400, "Luna needs at least one Admin. Make someone else an Admin first.");
      target.role = role;
    }
  }
  return userJson(target);
});
del("/api/v1/users/:id", ({ world, user, params }) => {
  gate(user);
  if (params.id === user.id) return fail(400, "You can't remove your own account.");
  const target = world.users.find((u) => u.id === params.id);
  if (target?.role === "admin" && lastAdmin(world, target.id)) {
    return fail(409, "Luna needs at least one Admin with a recovery phrase while cloud backups exist.");
  }
  if (target) {
    world.users = world.users.filter((u) => u.id !== params.id);
    (world.deletedUsers ??= []).push({ id: target.id, username: target.username, display_name: target.display_name, deleted_at: nowS() });
  }
  return { ok: true };
});

/** Private folders a removed person still owns, per drive (private::orphaned). */
get("/api/v1/private/orphans", ({ world, user }) => {
  gate(user);
  const gone = new Map((world.deletedUsers || []).map((u) => [u.id, u]));
  const owners = new Map();
  const offline = [];
  for (const d of world.drives) {
    const mounted = (d.state === "as_is" || d.state === "readonly") && world.summaries[d.id]?.mounted !== false;
    if (!mounted) { offline.push(d.label); continue; }
    const per = new Map();
    for (const item of privateUnder(world, d.id, "")) if (gone.has(item.owner)) per.set(item.owner, (per.get(item.owner) || 0) + 1);
    const trashCount = new Map();
    for (const t of fsOf(world, d.id).trash) {
      const owner = t.private_boundary?.owner;
      if (owner && gone.has(owner) && !t.nodes[""]?.private) {
        per.set(owner, (per.get(owner) || 0) + 1);
        trashCount.set(owner, (trashCount.get(owner) || 0) + 1);
      }
    }
    for (const [owner, count] of per) {
      const g = gone.get(owner);
      const row = owners.get(owner) || { user_id: owner, username: g.username, display_name: g.display_name, deleted_at: g.deleted_at, drives: [] };
      row.drives.push({ drive_id: d.id, drive_label: d.label, count, trash_count: trashCount.get(owner) || 0, readonly: d.state === "readonly" });
      owners.set(owner, row);
    }
  }
  const list = [...owners.values()].map((o) => ({ ...o, total: o.drives.reduce((n, d) => n + d.count, 0) }));
  list.sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));
  return { owners: list, offline_drives: offline };
});

del("/api/v1/private/orphans/:owner", ({ world, user, params }) => {
  gate(user);
  if (!(world.deletedUsers || []).some((u) => u.id === params.owner)) {
    return fail(400, "Luna can only clear private folders after their owner is removed.");
  }
  const skipped = [];
  const offline = [];
  for (const d of world.drives) {
    const mounted = (d.state === "as_is" || d.state === "readonly") && world.summaries[d.id]?.mounted !== false;
    if (!mounted) { offline.push(d.label); continue; }
    const fs = fsOf(world, d.id);
    const mine = privateUnder(world, d.id, "").filter((i) => i.owner === params.owner);
    if (d.state === "readonly") { if (mine.length) skipped.push(d.label); continue; }
    for (const item of mine) for (const k of Object.keys(fs.nodes)) if (k === item.path || k.startsWith(`${item.path}/`)) delete fs.nodes[k];
    fs.trash = fs.trash.filter((t) => t.private_boundary?.owner !== params.owner);
  }
  return { ok: !skipped.length && !offline.length, skipped_readonly: skipped, failed_drives: [], offline_drives: offline };
});

// ── Drives ──────────────────────────────────────────────────────────────────
const DRIVES_ONLY = "Only an Admin can manage drives.";
const driveGate = (user) => requireAdmin(user, DRIVES_ONLY);

get("/api/v1/drives", ({ world, user }) => world.drives
  .filter((d) => isAdmin(user) || hasDriveAccess(world, user, d.id))
  .map((d) => {
    const admin = isAdmin(user);
    return {
      id: d.id, label: d.label, state: d.state, fs_type: d.fs_type,
      // Device node and OS mount path are server plumbing.
      device: admin ? d.device : "", mount_point: admin ? (d.mount_point ?? `/mnt/${d.id}`) : "",
      mounted: d.mounted !== false && world.summaries[d.id]?.mounted !== false,
      writable: admin || hasWriteOnDrive(world, user, d.id),
      caps: capsToStr(capsOnPath(world, user, d.id, "")),
    };
  }));

get("/api/v1/drives/detected", ({ world, user }) => {
  driveGate(user);
  return world.detected.map((d) => ({
    name: d.name, model: d.model ?? "", size_bytes: d.size_bytes ?? 0, removable: d.removable ?? true, usb: d.usb ?? true,
    mount_point: d.mount_point ?? null, fs_type: d.fs_type ?? null, read_only: Boolean(d.read_only),
  }));
});

const findDetected = (world, name) => {
  const found = world.detected.find((d) => d.name === name);
  if (!found) throw fail(404, "Luna can't see a drive with that name.");
  return found;
};

post("/api/v1/drives/:name/inspect", ({ world, user, params }) => {
  driveGate(user);
  const d = findDetected(world, params.name);
  if (d.inspectFails) return fail(500, "Luna couldn't look at this drive safely. Make sure it's plugged in and try again.");
  const entries = d.entries ?? [{ kind: "folder", name: "Photos" }, { kind: "file", name: "readme.txt" }];
  return {
    device: d.name, model: d.model ?? "", fs_type: d.fs_type ?? null, mount_point: d.mount_point ?? `/run/luna/inspect/${d.name}`,
    mounted_by_luna: true, has_marker: Boolean(d.has_marker), folders: entries.filter((e) => e.kind === "folder").length,
    files: entries.filter((e) => e.kind === "file").length, unreadable: d.unreadable ?? 0, entries,
    needs_erase: Boolean(d.needs_erase), readable: d.readable ?? true, writable: d.writable ?? !d.read_only,
  };
});
get("/api/v1/drives/:name/peek", ({ world, user, params }) => {
  driveGate(user);
  const d = findDetected(world, params.name);
  const entries = d.entries ?? [{ kind: "folder", name: "Photos" }, { kind: "file", name: "readme.txt" }];
  const sample = [...entries].sort((a, b) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || a.name.localeCompare(b.name));
  const folders = sample.filter((e) => e.kind === "folder").length;
  return {
    readable: d.readable ?? true, fs_type: d.fs_type ?? null, has_marker: Boolean(d.has_marker), needs_erase: Boolean(d.needs_erase),
    folders, files: sample.length - folders, sample: sample.slice(0, 5),
  };
});
post("/api/v1/drives/:name/release", ({ user, params, world }) => {
  driveGate(user);
  findDetected(world, params.name);
  return { ok: true };
});
post("/api/v1/drives/:name/adopt", ({ world, user, params, body }) => {
  driveGate(user);
  const label = String(body.label ?? "").trim();
  if (!label || label.length > 80) return fail(400, "Give this drive a name between 1 and 80 characters.");
  const found = findDetected(world, params.name);
  world.detected = world.detected.filter((d) => d.name !== params.name);
  const id = nextId("d");
  const row = { id, label, state: "as_is", device: params.name, fs_type: found.fs_type || "ext4", mount_point: `/mnt/${id}` };
  world.drives.push(row);
  world.summaries[id] = summary(id, { shortcuts: [] });
  return { id, label, state: row.state, fs_type: row.fs_type, device: row.device, mount_point: row.mount_point, writable: true, caps: "full+share" };
});
post("/api/v1/drives/:id/eject", ({ world, user, params }) => {
  driveGate(user);
  const d = world.drives.find((x) => x.id === params.id);
  if (!d) return fail(400, "Luna doesn't know this drive.");
  d.state = "ejected";
  world.summaries[params.id] = unmounted(params.id);
  return { ok: true };
});
post("/api/v1/drives/:id/remove", ({ world, user, params }) => {
  driveGate(user);
  if (!world.drives.some((x) => x.id === params.id)) return fail(400, "Luna doesn't know this drive.");
  world.drives = world.drives.filter((d) => d.id !== params.id);
  delete world.summaries[params.id];
  return { ok: true };
});
get("/api/v1/drives/:id/health", ({ world, user, params }) => {
  driveGate(user);
  if (!world.drives.some((d) => d.id === params.id)) return fail(404, "Luna doesn't know this drive.");
  return Object.hasOwn(world.health, params.id) ? world.health[params.id] : healthy();
});
get("/api/v1/drives/:id/summary", ({ world, user, params }) => {
  const id = params.id;
  if (!world.drives.some((d) => d.id === id)) return fail(404, "Luna doesn't know this drive.");
  if (!hasDriveAccess(world, user, id)) return fail(403, "You don't have permission to view this drive.");
  const s = world.summaries[id] || unmounted(id);
  const canList = hasCap(world, user, id, "", CAP_VIEW);
  if (s.mounted === false || world.drives.find((d) => d.id === id)?.mounted === false) return { ...unmounted(id), id, shortcuts: canList ? [] : s.shortcuts ?? [] };
  const seesSpace = isAdmin(user) || canList || grantRows(world, user).some((r) => r.drive_id === id && r.caps & CAP_VIEW) || ownedPrivatePaths(world, user, id).length > 0;
  return {
    ...s,
    total_bytes: seesSpace ? s.total_bytes : null,
    free_bytes: seesSpace ? s.free_bytes : null,
    used_bytes: seesSpace ? s.used_bytes : null,
    ...(canList ? {} : { folders: null, files: null, shortcuts: s.shortcuts ?? [] }),
  };
});

// ── System, network, connect ────────────────────────────────────────────────
const checkGate = (user) => requireAdmin(user, "Only an Admin can check Luna's system health.");
get("/api/v1/system/health/check", ({ world, user }) => { checkGate(user); return json(world.systemChecks, world.systemChecks.overall_pass ? 200 : 503); });
post("/api/v1/system/health/check/refresh", ({ world, user }) => { checkGate(user); return json(world.systemChecks, world.systemChecks.overall_pass ? 200 : 503); });

const bootTime = Date.now();
const healthBody = ({ world }) => ({
  status: "ok", product: "Luna", version: world.updates.current_version,
  api: { version: 1, oldest_supported: 1 }, uptime_seconds: Math.floor((Date.now() - bootTime) / 1000),
});
get("/health", healthBody, { public: true });
get("/api/v1/health", healthBody, { public: true });

const updatesGate = (user) => requireAdmin(user, "Only an Admin can manage updates.");
get("/api/v1/system/updates", ({ world, user }) => {
  updatesGate(user);
  const { os_update_failed: failed, ...rest } = world.updates;
  return { ...rest, os_update_failed: failed ? (typeof failed === "object" ? failed : { version: world.updates.latest_version ?? "" }) : null };
});
post("/api/v1/system/updates/apply", ({ world, user, fake }) => {
  updatesGate(user);
  const latest = world.updates.latest_version ?? world.updates.current_version;
  // lunad answers once the new software is installed, then restarts a second later.
  // Its pages go quiet for a few seconds, then come back on the new version.
  world.updates = { current_version: latest, update_available: false };
  interruptJobs(world);
  fake.restartServer(1000, 4000);
  return { ok: true, latest_version: latest, reboot_required: false, message: "The new software is installed. Luna will restart in a moment — sign in again after it comes back." };
});
post("/api/v1/system/updates/os-failed/clear", ({ world, user }) => {
  updatesGate(user);
  world.updates = { ...world.updates, os_update_failed: null };
  return { ok: true };
});
get("/api/v1/system/updates/source", ({ world, user }) => { updatesGate(user); return world.updateSource; });
put("/api/v1/system/updates/source", ({ world, user, body }) => {
  updatesGate(user);
  world.updateSource = { ...body, ok: true };
  return world.updateSource;
});
post("/api/v1/system/factory-reset", ({ world, user, body }) => {
  requireAdmin(user, "Only an Admin can reset this Luna.");
  if (!body.confirm) return fail(400, "Confirm that you want to reset this Luna. Everyone will need to sign in again, and remote access will turn off. Files on your drives stay where they are.");
  if (!String(body.password ?? "").trim()) return fail(400, "Type your current password to confirm this reset.");
  if (body.password === "wrong") return fail(401, "That password is wrong. Reset was not started.");
  world.sessionUserId = null;
  world.users = [];
  world.hasAdmin = false;
  world.phrase = { set: false, set_at: 0, luna_id: "", signing_public: "", check_due: false, last_checked_at: 0, phrase_words: 0 };
  world.setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} };
  return { ok: true };
});

// Members get the reduced answer, not a refusal.
get("/api/v1/network/status", ({ world, user }) => {
  if (isAdmin(user)) return world.network;
  return { ethernet_connected: world.network.ethernet_connected, wifi_connected: false, has_default_route: world.network.has_default_route };
}, { public: true });
get("/api/v1/connect/status", ({ world, user }) => {
  const admin = isAdmin(user) || world.users.length === 0;
  const { device_code: _code, ...rest } = world.connect;
  const status = { connect_active: false, enabled: false, base_url: "https://connect.luna.libreloom.org", tunnel_active: false, backup_unlocked: false, paired: false, unclaimed: false, backup_sources: [], card_on_file: true, ...rest };
  if (status.device_token_error) Object.assign(status, { enabled: false, paired: false, unclaimed: false, tunnel_active: false });
  if (!admin) status.backup_sources = [];
  return status;
}, { public: true });

// ── Dashboard data: recents, backups and private items live in files.js / backups.js ──
get("/api/v1/cloud/phrase", ({ world }) => world.phrase);

export { DEVICE_TOKEN_REJECTED };
