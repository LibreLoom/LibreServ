// Sign-in, setup, users, drives, system and the dashboard's data.
import { del, empty, fail, get, json, patch, post, put } from "../engine.js";
import { HOUR, nextId, summary, user as makeUser } from "../world.js";

const unmounted = (id) => ({ id, mounted: false, total_bytes: null, free_bytes: null, used_bytes: null, shortcuts: [] });
const healthy = () => ({ available: true, overall: "passed", reallocated_sectors: 0, temperature_c: 30 });
const isAdmin = (u) => u?.role === "admin";
const needAdmin = (u) => (isAdmin(u) ? null : fail(403, "Only an Admin can do this."));
/** Same rule as the real server: 12+ characters with a letter and a number. */
const badPassword = (pw) =>
  pw !== undefined && !(String(pw).length >= 12 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw))
    ? fail(400, "Password must be at least 12 characters with a letter and a number.")
    : null;
const lastAdmin = (world, id) => world.users.filter((u) => u.role === "admin").every((u) => u.id === id);

// ── Auth ────────────────────────────────────────────────────────────────────
get("/api/v1/auth/me", ({ user }) => json(user), { public: true });
get("/api/v1/auth/status", ({ world }) => ({ has_admin: world.hasAdmin, connect_active: world.connectActive }), { public: true });

post("/api/v1/auth/login", ({ world, body }) => {
  const u = world.users.find((x) => x.username === body.username);
  if (!u || body.password === "wrong" || !body.password) return fail(401, "That username or password isn't right.");
  world.sessionUserId = u.id;
  return u;
}, { public: true });

post("/api/v1/auth/logout", ({ world }) => { world.sessionUserId = null; return {}; }, { public: true });

post("/api/v1/auth/register", ({ world, body }) => {
  if (!world.hasAdmin && world.setupSecret && body.setup_secret !== world.setupSecret) return fail(403, "That device token isn't right.");
  const weak = badPassword(body.password);
  if (weak) return weak;
  if (world.users.some((u) => u.username === body.username)) return fail(409, "That username is taken.");
  const created = makeUser({ username: body.username, display_name: body.display_name, role: world.hasAdmin ? "user" : "admin" });
  world.users.push(created);
  if (!world.hasAdmin) { world.hasAdmin = true; world.sessionUserId = created.id; }
  return created;
}, { public: true });

patch("/api/v1/auth/me", ({ user, body }) => {
  if (body.new_password !== undefined) {
    if (body.current_password === "wrong" || !body.current_password) return fail(403, "Your current password isn't right.");
    const weak = badPassword(body.new_password);
    if (weak) return weak;
  }
  if (body.display_name !== undefined) user.display_name = body.display_name;
  return user;
});
post("/api/v1/auth/revoke-sessions", ({ world }) => { world.sessionUserId = null; return {}; });
post("/api/v1/auth/revoke-devices", ({ world }) => { world.tokens = []; return {}; });

// ── Setup ───────────────────────────────────────────────────────────────────
get("/api/v1/setup", ({ world }) => world.setup, { public: true });
post("/api/v1/setup", ({ world, body }) => {
  world.setup = { ...world.setup, ...body };
  if (body.name) world.name = body.name;
  return world.setup;
}, { public: true });
// world.preflight can be a list of answers: each run gets the next one, the last repeats.
get("/api/v1/setup/preflight", ({ world }) => {
  const result = Array.isArray(world.preflight) ? (world.preflight.length > 1 ? world.preflight.shift() : world.preflight[0]) : world.preflight;
  return json(result, result.healthy ? 200 : 503);
}, { public: true });
post("/api/v1/setup/fetch-mag", () => ({}), { public: true });

// ── Users ───────────────────────────────────────────────────────────────────
get("/api/v1/users", ({ world, user }) => needAdmin(user) || world.users);
get("/api/v1/users/directory", ({ world }) => world.users.map(({ id, username, display_name }) => ({ id, username, display_name })));
post("/api/v1/users", ({ world, user, body }) => {
  const denied = needAdmin(user);
  if (denied) return denied;
  if (world.users.some((u) => u.username === body.username)) return fail(409, "That username is taken.");
  const weak = badPassword(body.password);
  if (weak) return weak;
  const created = makeUser({ username: body.username, display_name: body.display_name, role: body.role || "user" });
  world.users.push(created);
  return created;
});
get("/api/v1/users/:id/private-count", ({ world, params }) => ({ count: world.privateCounts?.[params.id] ?? 0 }));
patch("/api/v1/users/:id", ({ world, user, params, body }) => {
  const denied = needAdmin(user);
  if (denied) return denied;
  const target = world.users.find((u) => u.id === params.id);
  if (!target) return fail(404, "That user no longer exists.");
  const weak = badPassword(body.password);
  if (weak) return weak;
  if (body.role === "user" && target.role === "admin" && lastAdmin(world, target.id)) return fail(409, "Luna needs at least one Admin.");
  const { password: _password, ...changes } = body;
  Object.assign(target, changes);
  return target;
});
del("/api/v1/users/:id", ({ world, user, params }) => {
  const denied = needAdmin(user);
  if (denied) return denied;
  if (params.id === user.id) return fail(409, "You can't remove yourself.");
  const target = world.users.find((u) => u.id === params.id);
  if (!target) return fail(404, "That user no longer exists.");
  if (target.role === "admin" && lastAdmin(world, target.id)) return fail(409, "Luna needs at least one Admin.");
  world.users = world.users.filter((u) => u.id !== params.id);
  return {};
});
post("/api/v1/users/:id/adopt-private", ({ world }) => {
  const count = world.ownerless ?? 0;
  world.ownerless = 0;
  return { count };
});

// ── Drives ──────────────────────────────────────────────────────────────────
get("/api/v1/drives", ({ world }) => world.drives);
get("/api/v1/drives/detected", ({ world }) => world.detected);
get("/api/v1/drives/:id/summary", ({ world, params }) => world.summaries[params.id] || unmounted(params.id));
get("/api/v1/drives/:id/health", ({ world, params }) => (Object.hasOwn(world.health, params.id) ? world.health[params.id] : healthy()));
get("/api/v1/drives/:name/inspect", ({ params }) => ({
  device: params.name, model: "SanDisk", fs_type: "exfat", readable: true, writable: true,
  needs_erase: false, has_marker: false, folders: 1, files: 2,
  entries: [{ kind: "folder", name: "Photos" }, { kind: "file", name: "readme.txt" }],
}));
post("/api/v1/drives/:name/adopt", ({ world, params, body }) => {
  const found = world.detected.find((d) => d.name === params.name);
  world.detected = world.detected.filter((d) => d.name !== params.name);
  const id = nextId("d");
  world.drives.push({ id, label: body.label || found?.model || "New drive", state: "adopted", device: params.name, fs_type: "ext4" });
  world.summaries[id] = summary(id, { shortcuts: [] });
  return { id };
});
post("/api/v1/drives/:id/eject", ({ world, params }) => {
  world.summaries[params.id] = unmounted(params.id);
  return {};
});
post("/api/v1/drives/:id/remove", ({ world, params }) => {
  world.drives = world.drives.filter((d) => d.id !== params.id);
  delete world.summaries[params.id];
  return {};
});

// ── System, network, connect ────────────────────────────────────────────────
get("/api/v1/system/health/check", ({ world }) => world.systemChecks);
get("/api/v1/system/updates", ({ world }) => world.updates);
post("/api/v1/system/updates/apply", ({ world }) => { world.updates = { ...world.updates, applying: true }; return {}; });
post("/api/v1/system/updates/os-failed/clear", ({ world }) => { world.updates = { ...world.updates, os_update_failed: false }; return {}; });
get("/api/v1/system/updates/source", ({ world }) => world.updateSource);
put("/api/v1/system/updates/source", ({ world, body }) => { world.updateSource = body; return body; });
post("/api/v1/system/factory-reset", ({ world }) => {
  world.sessionUserId = null;
  world.users = [];
  world.hasAdmin = false;
  world.setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} };
  return {};
});
get("/api/v1/network/status", ({ world, user }) => (isAdmin(user) ? world.network : fail(403, "Only an Admin can see this.")));
get("/api/v1/connect/status", ({ world, user }) => (isAdmin(user) ? world.connect : fail(403, "Only an Admin can see this.")));

// ── Dashboard data ──────────────────────────────────────────────────────────
get("/api/v1/me/recents", ({ world }) => world.recents);
post("/api/v1/me/recents", ({ world, body }) => {
  world.recents = [{ ...body, at: Date.now() }, ...world.recents].slice(0, 12);
  return {};
});
// /api/v1/me/access and /api/v1/gallery/albums live in access.js and gallery.js.
get("/api/v1/private-backups/summary", ({ world }) => world.privateSummary);
get("/api/v1/private-backups/item", () => ({ private: false, inside_private: false, mine: false, owner_name: "" }));

// ── Backups ─────────────────────────────────────────────────────────────────
get("/api/v1/backups", ({ world }) => world.backups);
post("/api/v1/backups/:id/run", ({ world, params }) => {
  const b = world.backups.find((x) => x.id === params.id);
  if (b) b.last_ok_at = Math.floor(Date.now() / 1000);
  return {};
});
del("/api/v1/backups/:id", ({ world, params }) => { world.backups = world.backups.filter((b) => b.id !== params.id); return {}; });
get("/api/v1/cloud/backups", ({ world }) => world.cloudBackups);
post("/api/v1/cloud/backups/:id/check", ({ world, params }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (b) { b.last_checked_at = Math.floor(Date.now() / 1000); b.check_problem = ""; }
  return {};
});
post("/api/v1/cloud/backups/:id/run", ({ world, params, query }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (!b) return fail(404, "That backup no longer exists.");
  if (b.source_missing && query.accept_missing !== "true") {
    return { done: false, source_missing: true, problem: "The folder this backup copies is gone. Run it anyway to remove the cloud copy too, or stop the backup." };
  }
  b.last_ok_at = Math.floor(Date.now() / 1000);
  b.state = "ok";
  b.last_error = "";
  return { done: true };
});
del("/api/v1/cloud/backups/:id", ({ world, params }) => { world.cloudBackups = world.cloudBackups.filter((b) => b.id !== params.id); return {}; });
get("/api/v1/cloud/phrase", ({ world }) => world.phrase);

// Reference so unused-helper lint stays quiet when a handler set shrinks.
void empty;
