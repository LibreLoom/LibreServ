import { backup, cloudBackup, DAY, DEFAULT_NOW, drive, HOUR, summary, user } from "../fake/world.js";

const at = (s, now = DEFAULT_NOW) => Math.floor(now / 1000) - s;
const GB = 1_000_000_000;

const member = (w, over = {}) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user", ...over }));
  w.sessionUserId = "u2";
};

const manyDrives = (w, n) => {
  w.drives = Array.from({ length: n }, (_, i) => drive({ id: `d${i + 1}`, label: `Drive ${i + 1}` }));
  w.summaries = Object.fromEntries(w.drives.map((d, i) => [d.id, summary(d.id, { used_bytes: (10 + i * 5) * GB })]));
  w.health = {};
};

const NEEDS = "Needs you row appears with plain wording and a button that goes somewhere real";

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── Needs you ─────────────────────────────────────────────────────────────
  {
    id: "dashboard/calm",
    area: "Dashboard",
    title: "Nothing needs you",
    check: ["No Needs you section at all", "One drive card, recent files, no warnings"],
  },
  {
    id: "dashboard/backup-stale",
    area: "Dashboard",
    title: "Needs you: backup not copied in a day",
    seed: (w) => {
      w.drives.push(drive({ id: "d2", label: "Backup drive" }));
      w.summaries.d2 = summary("d2");
      w.backups = [backup({ state: "stale", last_ok_at: at(2 * DAY) })];
    },
    check: [NEEDS, "Row says the backup hasn't been copied in a day", "Its button opens that backup"],
  },
  {
    id: "dashboard/backup-failed",
    area: "Dashboard",
    title: "Needs you: backup failed",
    seed: (w) => {
      w.drives.push(drive({ id: "d2", label: "Backup drive" }));
      w.summaries.d2 = summary("d2");
      w.backups = [backup({ state: "failing", last_error: "The backup drive is full." })];
    },
    check: [NEEDS, "The error text is shown as the detail"],
  },
  {
    id: "dashboard/backup-source-missing",
    area: "Dashboard",
    title: "Needs you: cloud backup's folder is gone",
    seed: (w) => { w.cloudBackups = [cloudBackup({ source_missing: true })]; },
    check: [NEEDS, "Row explains the folder is missing", "Button opens the backup"],
  },
  {
    id: "dashboard/cloud-check-problem",
    area: "Dashboard",
    title: "Needs you: cloud backup check found a problem",
    seed: (w) => { w.cloudBackups = [cloudBackup({ check_problem: "The cloud copy could not be read." })]; },
    check: [NEEDS, "Detail repeats the check's problem"],
  },
  {
    id: "dashboard/check-overdue",
    area: "Dashboard",
    title: "Needs you: recovery phrase check is overdue",
    now: Date.UTC(2027, 3, 1),
    seed: (w) => {
      w.cloudBackups = [cloudBackup({ last_checked_at: at(200 * DAY), last_ok_at: at(HOUR) })];
      w.phrase = { ...w.phrase, check_due: true };
    },
    check: [NEEDS, "Row asks you to check your recovery phrase", "Check now opens the Check my phrase dialog", "It accepts any 12 or 24 words and the row clears"],
  },
  {
    id: "dashboard/drive-failed",
    area: "Dashboard",
    title: "Needs you: a drive ran into a problem",
    seed: (w) => { w.drives[0].state = "failed"; },
    check: [NEEDS, "Row names the drive and opens Files"],
  },
  {
    id: "dashboard/drive-unhealthy",
    area: "Dashboard",
    title: "Needs you: drive health warning and error",
    seed: (w) => {
      manyDrives(w, 2);
      w.health = {
        d1: { available: true, overall: "failed", reallocated_sectors: 120, temperature_c: 55 },
        d2: { available: true, overall: "warning", reallocated_sectors: 4, temperature_c: 48 },
      };
    },
    check: [NEEDS, "'needs attention' for the failing one, 'working, with a warning' for the other"],
  },
  {
    id: "dashboard/drive-full",
    area: "Dashboard",
    title: "Needs you: drive almost full",
    seed: (w) => { w.summaries.d1 = summary("d1", { total_bytes: 64 * GB, free_bytes: 2 * GB, used_bytes: 62 * GB }); },
    check: [NEEDS, "Row shows '2 GB free of 64 GB'", "Drive card shows a nearly full bar"],
  },
  {
    id: "dashboard/drive-readonly",
    area: "Dashboard",
    title: "Drive is read-only",
    seed: (w) => { w.drives[0].state = "readonly"; },
    check: ["Card says it is read-only", "Files can be opened but nothing says it can be changed"],
  },
  {
    id: "dashboard/drive-unmounted",
    area: "Dashboard",
    title: "Drive unplugged (not mounted)",
    seed: (w) => { w.summaries.d1 = { id: "d1", mounted: false, total_bytes: null, free_bytes: null, used_bytes: null, shortcuts: [] }; },
    check: ["Card says the drive isn't connected, not 0 bytes", "No crash or NaN"],
  },
  {
    id: "dashboard/new-drive-found",
    area: "Dashboard",
    title: "A new, unrecognised drive was plugged in",
    seed: (w) => {
      w.detected = [{ name: "sdb", model: "SanDisk Ultra", size_bytes: 128 * GB, fs_type: "ntfs" }];
    },
    check: ["A 'new drive' card appears", "Adding it works and the card becomes a normal drive"],
  },
  {
    id: "dashboard/no-drives",
    area: "Dashboard",
    title: "No drives at all",
    seed: (w) => { w.drives = []; w.summaries = {}; },
    check: ["Needs you says 'No drives yet' and how to fix it", "Empty states elsewhere on the page make sense"],
  },
  {
    id: "dashboard/update-available",
    area: "Dashboard",
    title: "Update available",
    seed: (w) => { w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0", notes: "Faster photo scanning." }; },
    check: ["Update card shows the new version in plain words", "Starting it shows progress, not a freeze"],
  },
  {
    id: "dashboard/update-failed",
    area: "Dashboard",
    title: "System update failed earlier",
    seed: (w) => { w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0", os_update_failed: true }; },
    check: ["Failure is explained", "Dismissing it works"],
  },
  {
    id: "dashboard/update-applying",
    area: "Dashboard",
    title: "Update is installing",
    seed: (w) => { w.updates = { update_available: true, applying: true, current_version: "1.4.2", latest_version: "1.5.0" }; },
    check: ["Shows that an update is being installed", "No second install button"],
  },
  {
    id: "dashboard/no-internet",
    area: "Dashboard",
    title: "Needs you: Luna can't reach the internet",
    seed: (w) => { w.network = { ethernet_connected: false, has_default_route: false }; },
    check: [NEEDS, "Says to check the router or modem"],
  },
  {
    id: "dashboard/connect-token-error",
    area: "Dashboard",
    title: "Needs you: Connect device token rejected",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, device_token_error: "Luna Connect no longer accepts this device token." }; },
    check: [NEEDS, "Button goes to Settings → About where the token can be replaced"],
  },
  {
    id: "dashboard/system-check-failed",
    area: "Dashboard",
    title: "Needs you: system checks failed and warned",
    seed: (w) => {
      w.systemChecks = {
        overall_pass: false,
        checks: {
          disk_space: { status: "failed", message: "Storage space is nearly gone.", category: "storage" },
          clock: { status: "warning", message: "The clock may be wrong.", category: "system" },
          video_tools: { status: "warning", message: "Video previews are off.", category: "features" },
        },
      };
    },
    check: [NEEDS + " (failed check)", "Warnings show in the header pill only, not as rows"],
  },
  {
    id: "dashboard/everything-wrong",
    area: "Dashboard",
    title: "Needs you: every problem at once",
    seed: (w) => {
      manyDrives(w, 3);
      w.drives[2].state = "failed";
      w.health = { d1: { available: true, overall: "failed", reallocated_sectors: 99, temperature_c: 60 } };
      w.summaries.d2 = summary("d2", { total_bytes: 64 * GB, free_bytes: GB, used_bytes: 63 * GB });
      w.network = { ethernet_connected: true, has_default_route: false };
      w.connect = { enabled: true, connect_active: true, device_token_error: "Device token rejected." };
      w.systemChecks = { overall_pass: false, checks: { disk_space: { status: "failed", message: "Storage nearly gone.", category: "storage" } } };
      w.backups = [backup({ state: "failing", last_error: "Drive full." }), backup({ state: "stale", source_name: "Documents" })];
      w.cloudBackups = [cloudBackup({ source_missing: true })];
      w.phrase = { ...w.phrase, check_due: true };
      w.detected = [{ name: "sdb", model: "USB stick", size_bytes: 16 * GB, fs_type: "fat32" }];
      w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0" };
    },
    check: ["Rows are ordered most urgent first", "Page stays readable and scrolls on a phone", "Each row's button works"],
  },
  // ── Amounts and names ─────────────────────────────────────────────────────
  {
    id: "dashboard/many-drives",
    area: "Dashboard",
    title: "Eight drives",
    seed: (w) => manyDrives(w, 8),
    check: ["Cards wrap cleanly", "Nothing overflows on a phone"],
  },
  {
    id: "dashboard/long-names",
    area: "Dashboard",
    title: "Very long and unusual names",
    seed: (w) => {
      w.drives[0].label = "Family photos and videos from every holiday we ever took together including the long summer trip";
      w.recents = [
        { driveId: "d1", path: "Photos/IMG_000001-with-a-very-long-descriptive-name-that-keeps-going-and-going.jpeg", name: "IMG_000001-with-a-very-long-descriptive-name-that-keeps-going-and-going.jpeg", kind: "file", at: (at(HOUR)) * 1000 },
        { driveId: "d1", path: "Dokumente/Übersicht 日本語 😀.pdf", name: "Übersicht 日本語 😀.pdf", kind: "file", at: (at(DAY)) * 1000 },
      ];
      w.backups = [backup({ source_name: "A folder name that is far too long to ever fit on one line of a card", state: "stale" })];
      w.drives.push(drive({ id: "d2", label: "Backup drive" }));
      w.summaries.d2 = summary("d2");
    },
    check: ["Names truncate or wrap, never push the layout wider", "Unicode and emoji display"],
  },
  {
    id: "dashboard/recents-none",
    area: "Dashboard",
    title: "Nothing opened recently",
    check: ["Recent files card has a friendly empty state"],
  },
  {
    id: "dashboard/recents-many",
    area: "Dashboard",
    title: "Lots of recent files",
    seed: (w) => {
      w.recents = Array.from({ length: 12 }, (_, i) => ({ driveId: "d1", path: `Documents/Report ${i + 1}.pdf`, name: `Report ${i + 1}.pdf`, kind: "file", at: (at(i * HOUR)) * 1000 }));
    },
    check: ["List is capped sensibly", "Clicking one opens it"],
  },
  {
    id: "dashboard/albums-many",
    area: "Dashboard",
    title: "Shared albums: none, then many",
    seed: (w) => {
      w.albums = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: `Album ${i + 1}`, drive_id: "d1", count: i * 7, shared: true, owner_name: i % 2 ? "Max" : "Sam" }));
    },
    check: ["Albums card handles nine albums", "Open one to see it work"],
  },
  // ── Who ───────────────────────────────────────────────────────────────────
  {
    id: "dashboard/member-calm",
    area: "Dashboard",
    title: "Member, nothing wrong",
    seed: (w) => member(w),
    check: ["No admin-only rows or cards", "No 403 errors shown to the Member"],
  },
  {
    id: "dashboard/member-with-problems",
    area: "Dashboard",
    title: "Member while the Luna has problems",
    seed: (w) => {
      member(w);
      w.drives[0].state = "failed";
      w.network = { ethernet_connected: true, has_default_route: false };
      w.backups = [backup({ state: "failing", created_by: "u2", last_error: "Drive full." }), backup({ state: "stale", created_by: "u1", can_delete: false })];
    },
    check: ["Member sees only their own backup problem", "Never sees drive, network or update rows"],
  },
  // ── Failures ──────────────────────────────────────────────────────────────
  {
    id: "dashboard/connect-403",
    area: "Dashboard",
    title: "Connect status refuses (403)",
    faults: [{ match: "GET /api/v1/connect/status", mode: "403" }],
    check: ["Page behaves as if Connect were off", "No error banner"],
  },
  {
    id: "dashboard/network-error",
    area: "Dashboard",
    title: "Network status fails (500)",
    faults: [{ match: "GET /api/v1/network/status", mode: "500" }],
    check: ["The rest of the dashboard still loads", "No raw error text"],
  },
  {
    id: "dashboard/drives-fail",
    area: "Dashboard",
    title: "The drive list fails to load",
    faults: [{ match: "GET /api/v1/drives", mode: "500" }],
    check: ["A clear message says the drives didn't load, with a way to retry"],
  },
  {
    id: "dashboard/slow",
    area: "Dashboard",
    title: "Everything is slow",
    latency: 3000,
    check: ["Loading placeholders show, no layout jumping", "No empty-state flash before data arrives"],
  },
  {
    id: "dashboard/phone-dark",
    area: "Dashboard",
    title: "Dashboard on a phone, dark mode, with problems",
    viewport: "phone",
    theme: "dark",
    seed: (w) => {
      w.drives[0].state = "failed";
      w.backups = [backup({ state: "failing", last_error: "Drive full." })];
    },
    check: ["Text is readable on every surface", "Buttons don't blend into their backgrounds"],
  },
];
