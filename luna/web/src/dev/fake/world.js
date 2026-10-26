// The fake lunad's memory. A scenario is a seed (this object with some fields
// changed) plus fault rules; the handlers read and change it so every action a
// tester takes — rename, add a user, run a backup — sticks until the page reloads.

export const HOUR = 3600;
export const DAY = 24 * HOUR;
/** 2026-10-18 12:00 UTC. Scenarios that need another "now" override scenario.now. */
export const DEFAULT_NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

let counter = 0;
export const nextId = (prefix = "x") => `${prefix}${++counter}`;

export function user(over = {}) {
  const id = over.id || nextId("u");
  return {
    id,
    username: over.username || `user${id}`,
    display_name: over.display_name || over.username || `User ${id}`,
    role: "user",
    created_at: Math.floor(DEFAULT_NOW / 1000) - 30 * DAY,
    ...over,
  };
}

export function drive(over = {}) {
  const id = over.id || nextId("d");
  return {
    id,
    label: over.label || `Drive ${id}`,
    state: "as_is",
    device: `sd${id}`,
    fs_type: "exfat",
    ...over,
  };
}

export function summary(id, over = {}) {
  return {
    id,
    mounted: true,
    total_bytes: 64_000_000_000,
    free_bytes: 30_000_000_000,
    used_bytes: 34_000_000_000,
    shortcuts: ["Photos", "Documents"],
    ...over,
  };
}

export function backup(over = {}) {
  return {
    id: nextId("b"),
    kind: "drive",
    source_drive: "d1",
    source_drive_name: "Photos drive",
    source_path: "Photos",
    source_name: "Photos",
    target_drive: "d2",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_ok_at: Math.floor(DEFAULT_NOW / 1000) - HOUR,
    last_error: "",
    hard: false,
    first_done: true,
    created_by: "u1",
    can_delete: true,
    ...over,
  };
}

export function cloudBackup(over = {}) {
  return backup({
    id: nextId("c"),
    kind: "cloud",
    source_name: "Documents",
    source_path: "Documents",
    target_drive: undefined,
    target_drive_name: undefined,
    last_checked_at: Math.floor(DEFAULT_NOW / 1000) - 3 * DAY,
    check_problem: "",
    source_missing: false,
    ...over,
  });
}

const admin = user({ id: "u1", username: "max", display_name: "Max", role: "admin" });
const photosDrive = drive({ id: "d1", label: "Family photos" });

/** A healthy, ordinary Luna with one admin, one drive and nothing to fix. */
export function baseWorld() {
  return {
    name: "Luna",
    setup: { name: "Luna", setup_completed: true, current_step: "done", step_data: {} },
    preflight: { healthy: true, checks: { disk: { status: "passed", message: "Plenty of space" }, network: { status: "passed", message: "Connected" } } },
    users: [admin],
    sessionUserId: "u1",
    hasAdmin: true,
    connectActive: false,
    drives: [photosDrive],
    detected: [],
    summaries: { d1: summary("d1", { shortcuts: ["Photos", "Documents"] }) },
    health: {},
    systemChecks: { overall_pass: true, checks: {} },
    updates: { update_available: false, current_version: "1.4.2" },
    updateSource: { source: "default" },
    backups: [],
    cloudBackups: [],
    phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false },
    connect: { enabled: false },
    network: { ethernet_connected: true, has_default_route: true },
    access: [],
    albums: [],
    recents: [],
    jobs: [],
    tokens: [],
    privateSummary: { owners: [] },
  };
}

/** Builds a world: the base, then the scenario's seed function edits it. */
export function createWorld(seed) {
  const w = baseWorld();
  if (typeof seed === "function") seed(w);
  // Scenario tokens belong to the initially signed-in user unless seeded
  // with an explicit owner. Switching users must not transfer those tokens.
  for (const token of w.tokens) token.user_id ??= w.sessionUserId;
  return w;
}
