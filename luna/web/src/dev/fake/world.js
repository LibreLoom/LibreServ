// The fake lunad's memory. A scenario is a seed (this object with some fields
// changed) plus fault rules; the handlers read and change it so every action a
// tester takes — rename, add a user, run a backup — sticks until the page reloads.

export const HOUR = 3600;
export const DAY = 24 * HOUR;
/** 2026-10-18 12:00 UTC. Scenarios that need another "now" override scenario.now. */
export const DEFAULT_NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
/** lunad's default update feed (system/updates.rs DEFAULT_FEED_URL). */
export const DEFAULT_FEED_URL = "https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds";

// Ids: one counter per prefix, and an id that a seed (or an earlier call) already
// holds is never handed out again. The state is saved with the world so ids made
// after a page reload cannot collide with ids made before it.
let counters = {};
let used = new Set();
/** Marks an id you chose yourself as taken. Returns it. */
export const claimId = (id) => { used.add(id); return id; };
export const nextId = (prefix = "x") => {
  let id;
  do { counters[prefix] = (counters[prefix] || 0) + 1; id = `${prefix}${counters[prefix]}`; } while (used.has(id));
  used.add(id);
  return id;
};
export const idState = () => ({ counters: { ...counters }, used: [...used] });
export function restoreIdState(state) {
  counters = { ...(state?.counters || {}) };
  used = new Set(state?.used || []);
}
/** Forget everything but the ids the built-in base world owns (a fresh scenario start). */
export function resetIds() {
  counters = {};
  used = new Set(["u1", "d1"]);
}

export function user(over = {}) {
  const id = over.id ? claimId(over.id) : nextId("u");
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
  const id = over.id ? claimId(over.id) : nextId("d");
  return {
    id,
    label: over.label || `Drive ${id}`,
    state: "as_is",
    device: `sd${id}`,
    fs_type: "exfat",
    mounted: true,
    ...over,
  };
}

/** A drive health report as lunad's drives/smart.rs sends it. The default is a healthy hard drive. */
export function smartHealth(over = {}) {
  return {
    available: true, reason: null, verdict: "ok", overall: "passed", model: "WD20EZRZ", serial: "FAKE1",
    temperature_c: 34, temperature_max_c: 60, temperature_max_source: "typical",
    reallocated_sectors: 0, pending_sectors: 0, uncorrectable_sectors: 0, status_bits: 0, signals: [],
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
    id: over.id ? claimId(over.id) : nextId("b"),
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
    created_at: Math.floor(DEFAULT_NOW / 1000) - 30 * DAY,
    private_owner: "",
    ...over,
  };
}

export function cloudBackup(over = {}) {
  return backup({
    id: over.id ? claimId(over.id) : nextId("c"),
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
  const passed = (category, message) => ({ category, message, status: "passed" });
  return {
    name: "Luna",
    setup: { name: "Luna", setup_completed: true, current_step: "done", step_data: { network_connected: true } },
    preflight: { healthy: true, checks: { disk_space: { status: "passed", message: "12.4 GB free on Luna's system disk." }, network: { status: "passed", message: "Connected to your router or modem, with a path to the internet." } } },
    users: [{ ...admin }],
    sessionUserId: "u1",
    hasAdmin: true,
    connectActive: false,
    drives: [{ ...photosDrive }],
    detected: [],
    summaries: { d1: summary("d1", { shortcuts: ["Photos", "Documents"] }) },
    health: {},
    systemChecks: {
      overall_pass: true,
      status: "ok",
      timestamp: Math.floor(DEFAULT_NOW / 1000),
      summary: { total_checks: 17, passed: 17, warnings: 0, failed: 0 },
      checks: {
        clock: passed("Clock", "Luna's clock is on time."),
        data_path_writable: passed("Storage", "Luna can write to its data folder."),
        database: passed("Database", "Luna's database is healthy."),
        diagram_pack: { category: "Diagrams", message: "Diagram pack installed.", more: "", status: "passed" },
        disk_space: { category: "Storage", message: "Plenty of room left.", status: "passed", details: { free_bytes: 30_000_000_000, free_human: "30.0 GB" } },
        drive_tools: passed("Drive tools", "Drive tools are installed."),
        erase_tools: passed("Erase tools", "Erase tools are installed."),
        heic_tools: { category: "Photos", message: "iPhone photo support installed.", more: "", status: "passed", details: { missing: [] } },
        logs_path_writable: passed("Storage", "Luna can write to its log folder."),
        network: passed("Network", "Connected to your router or modem, with a path to the internet."),
        ntfs_support: passed("Drive tools", "Windows-formatted drives are supported."),
        office_pack: { category: "Documents", message: "Document pack installed.", more: "", status: "passed", details: { missing: [] } },
        smart_tool: { category: "Drive health", message: "Drive health checks are available.", more: "", status: "passed", details: { missing: [] } },
        trim_tool: passed("Drive health", "Drive maintenance is available."),
        update_signing: passed("Updates", "Updates are checked against Luna's signing key."),
        video_tools: { category: "Videos", message: "Video previews installed.", more: "", status: "passed", details: { missing: [] } },
        whiteboard: passed("Whiteboard", "Whiteboard tools are installed."),
      },
    },
    updates: { update_available: false, current_version: "1.4.2", latest_version: "1.4.2", release_notes: "", binary_name: "lunad", checksum: "", reboot_required: false },
    updateSource: { channel: "stable", default_keys: true, defaults: { channel: "stable", feed_url: DEFAULT_FEED_URL, keys: [] }, effective_keys: [], feed_url: DEFAULT_FEED_URL, keys: [] },
    backups: [],
    cloudBackups: [],
    phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false, last_checked_at: 0, phrase_words: 12, moving: null, old_phrase_copies: { count: 0, removed_at: null }, resealing: false },
    connect: { enabled: false, device_code: null },
    network: { ethernet_connected: true, wifi_connected: false, has_default_route: true },
    access: [],
    albums: [],
    recents: [],
    deletedUsers: [],
    jobs: [],
    tokens: [],
    privateSummary: { owners: [] },
  };
}

/** Builds a world: the base, then the scenario's seed function edits it. */
export function createWorld(seed) {
  resetIds();
  const w = baseWorld();
  if (typeof seed === "function") seed(w);
  // Rows a seed wrote without an owner belong to whoever is signed in.
  for (const r of w.recents) r.user_id ??= w.sessionUserId ?? "u1";
  return w;
}
