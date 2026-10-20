// Sign-in, setup, users, drives, system and the dashboard's data.
import { del, empty, fail, get, json, patch, post, put } from "../engine.js";
import { HOUR, nextId, summary, user as makeUser } from "../world.js";

const unmounted = (id) => ({ id, mounted: false, total_bytes: null, free_bytes: null, used_bytes: null, shortcuts: [] });
const healthy = () => ({ available: true, overall: "passed", reallocated_sectors: 0, temperature_c: 30 });
const isAdmin = (u) => u?.role === "admin";
const needAdmin = (u) => (isAdmin(u) ? null : fail(403, "Only an Admin can do this."));

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
  if (world.users.some((u) => u.username === body.username)) return fail(409, "That username is taken.");
  const created = makeUser({ username: body.username, display_name: body.display_name, role: world.hasAdmin ? "user" : "admin" });
  world.users.push(created);
  if (!world.hasAdmin) { world.hasAdmin = true; world.sessionUserId = created.id; }
  return created;
}, { public: true });

patch("/api/v1/auth/me", ({ user, body, world }) => {
  if (body.display_name !== undefined) user.display_name = body.display_name;
  if (body.new_password !== undefined && body.current_password === "wrong") return fail(403, "Your current password isn't right.");
  if (body.new_password !== undefined) world.sessionUserId = user.id;
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
get("/api/v1/setup/preflight", ({ world }) => json(world.preflight, world.preflight.healthy ? 200 : 503), { public: true });
post("/api/v1/setup/fetch-mag", () => ({}), { public: true });

// ── Users ───────────────────────────────────────────────────────────────────
get("/api/v1/users", ({ world, user }) => needAdmin(user) || world.users);
get("/api/v1/users/directory", ({ world }) => world.users.map(({ id, username, display_name }) => ({ id, username, display_name })));
post("/api/v1/users", ({ world, user, body }) => {
  const denied = needAdmin(user);
  if (denied) return denied;
  if (world.users.some((u) => u.username === body.username)) return fail(409, "That username is taken.");
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
  Object.assign(target, body);
  return target;
});
del("/api/v1/users/:id", ({ world, user, params }) => {
  const denied = needAdmin(user);
  if (denied) return denied;
  if (params.id === user.id) return fail(409, "You can't remove yourself.");
  world.users = world.users.filter((u) => u.id !== params.id);
  return {};
});
post("/api/v1/users/:id/adopt-private", () => ({}));

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
  world.recents = [{ ...body, at: Math.floor(Date.now() / 1000) }, ...world.recents].slice(0, 12);
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
post("/api/v1/cloud/backups/:id/run", ({ world, params }) => {
  const b = world.cloudBackups.find((x) => x.id === params.id);
  if (b) b.last_ok_at = Math.floor(Date.now() / 1000) - 0 * HOUR;
  return {};
});
del("/api/v1/cloud/backups/:id", ({ world, params }) => { world.cloudBackups = world.cloudBackups.filter((b) => b.id !== params.id); return {}; });
get("/api/v1/cloud/phrase", ({ world }) => world.phrase);

// Reference so unused-helper lint stays quiet when a handler set shrinks.
void empty;
