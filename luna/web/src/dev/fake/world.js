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
    folders: null,
    files: null,
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
    source_missing: false,
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
    ...over,
  });
}

const admin = user({ id: "u1", username: "max", display_name: "Max", role: "admin" });
const photosDrive = drive({ id: "d1", label: "Family photos" });

/** The setup system check's default answer: every probe lunad reports, all passing. */
export function healthyPreflight() {
  const ok = (category, message, extra = {}) => ({ category, message, status: "passed", ...extra });
  return {
    healthy: true,
    timestamp: Math.floor(DEFAULT_NOW / 1000),
    checks: {
      clock: ok("system", "Luna's clock is on time."),
      data_path_writable: ok("storage", "Luna can write to its data folder."),
      database: ok("system", "Accounts, sharing, and settings are readable."),
      diagram_pack: ok("features", "Diagram pack installed.", { more: "" }),
      disk_space: ok("storage", "12.4 GB free on Luna's system disk.", {
        details: { free_bytes: 12_400_000_000, free_human: "12.4 GB" },
      }),
      drive_tools: ok("drives", "Luna can add and eject drives."),
      heic_tools: ok("features", "iPhone photo support installed.", { details: { missing: [] }, more: "" }),
      logs_path_writable: ok("storage", "Luna can write to its log folder."),
      meaning_search: ok("features", "Search also finds documents about what you type, in other words.", { more: "" }),
      network: ok("network", "Connected to your router or modem, with a path to the internet."),
      ntfs_support: ok("drives", "Luna can open drives formatted as NTFS, the format Windows uses for its own drives.", { details: { missing: [] }, more: "" }),
      office_pack: ok("features", "Document pack installed.", { details: { missing: [] }, more: "" }),
      photo_search: ok("features", "Search finds photos by what they show.", { more: "" }),
      search_inside: ok("features", "Search finds words inside documents, scans, and screenshots.", { details: { missing: [] }, more: "" }),
      smart_tool: ok("drives", "Drive health checks are available.", { details: { missing: [] }, more: "" }),
      trim_tool: ok("drives", "Luna can run its weekly SSD (solid-state drive) upkeep."),
      update_signing: ok("system", "Updates are checked against Luna's signing key."),
      video_tools: ok("features", "Video previews installed.", { details: { missing: [] }, more: "" }),
      whiteboard: ok("features", "Whiteboard tools are installed."),
    },
  };
}

/** A healthy, ordinary Luna with one admin, one drive and nothing to fix. */
export function baseWorld() {
  const passed = (category, message) => ({ category, message, status: "passed" });
  return {
    name: "Luna",
    setup: { name: "Luna", setup_completed: true, current_step: "done", step_data: { network_connected: true } },
    preflight: healthyPreflight(),
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
        // A passing check carries only what lunad sends on success: no
        // `details` and no `more` unless the failure path adds them. The
        // contract test compares this shape against lunad's own output, so a
        // tidy-looking `more: ""` here is a lie about the API.
        drive_tools: { category: "Drive tools", message: "Luna can add and eject drives.", status: "passed" },
        heic_tools: { category: "Photos", message: "iPhone photo support installed.", status: "passed" },
        logs_path_writable: passed("Storage", "Luna can write to its log folder."),
        network: { category: "Network", message: "Connected to your router or modem, with a path to the internet.", status: "passed" },
        meaning_search: { category: "features", message: "Search also finds documents about what you type, in other words.", status: "passed" },
        ntfs_support: { category: "Drive tools", message: "Luna can open drives formatted as NTFS, the format Windows uses for its own drives.", status: "passed" },
        office_pack: { category: "Documents", message: "Document pack installed.", status: "passed" },
        photo_search: { category: "features", message: "Search finds photos by what they show.", status: "passed" },
        search_inside: { category: "features", message: "Search finds words inside documents, scans, and screenshots.", status: "passed" },
        smart_tool: { category: "Drive health", message: "Drive health checks are available.", status: "passed" },
        trim_tool: { category: "Drive health", message: "Luna can run its weekly SSD (solid-state drive) upkeep.", status: "passed" },
        update_signing: passed("Updates", "Updates are checked against Luna's signing key."),
        video_tools: { category: "Videos", message: "Video previews installed.", status: "passed" },
        whiteboard: passed("Whiteboard", "Whiteboard tools are installed."),
      },
    },
    // What is using Luna's own disk (GET /system/storage). The software —
    // daemon, cloudflared, editor packs — lives in the OS image, so only data
    // rows appear here; the temporary copies are what "Free up space" clears,
    // so a scenario that wants the button seeds a non-zero one.
    storage: {
      total_bytes: 8_000_000_000,
      free_bytes: 6_752_000_000,
      used_bytes: 1_248_000_000,
      items: [
        { id: "temporary", label: "Temporary files from open documents", bytes: 1_200_000_000, removable: true },
        { id: "settings", label: "Accounts and settings", bytes: 40_000_000, removable: false },
        { id: "logs", label: "Logs", bytes: 8_000_000, removable: false },
      ],
    },
    updates: { update_available: false, current_version: "1.4.2", latest_version: "1.4.2", release_notes: "", binary_name: "lunad", checksum: "", reboot_required: false, feed_is_newer: true, from_new_source: false, applying: false },
    updateSource: { channel: "stable", default_keys: true, defaults: { channel: "stable", feed_url: DEFAULT_FEED_URL, keys: [] }, effective_keys: [], feed_url: DEFAULT_FEED_URL, keys: [] },
    backups: [],
    cloudBackups: [],
    phrase: { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false, last_checked_at: 0, phrase_words: 12, old_phrase_copies: { count: 0, removed_at: null }, resealing: false },
    connect: { state: "unbound", enabled: false, device_token: null, unbind_pending: false },
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
