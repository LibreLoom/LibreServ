import { backup, cloudBackup, DAY, DEFAULT_NOW, drive, HOUR, smartHealth, summary, user } from "../fake/world.js";
import { addFile, demoTree } from "../fake/handlers/files.js";

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
      w.backups = [backup({ state: "failing", last_error: "Backup drive is full. Free up some space on it and try again." })];
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
    check: [NEEDS, "Row asks you to check your recovery phrase", "Check now opens Check my phrase with 12 numbered boxes", "Pasting `abandon` ×11 + `about` fills every box", "Check closes the dialog, toasts 'Your recovery phrase is correct.' and the row clears"],
  },
  {
    id: "dashboard/check-paste-file",
    area: "Dashboard",
    title: "Recovery phrase check: pasting the downloaded file",
    now: Date.UTC(2027, 3, 1),
    seed: (w) => {
      w.cloudBackups = [cloudBackup({ last_checked_at: at(200 * DAY), last_ok_at: at(HOUR) })];
      w.phrase = { ...w.phrase, check_due: true };
    },
    check: [NEEDS, "Check now opens Check my phrase", "Pasting the downloaded file's numbered lines (1. abandon, 2. abandon, …) fills the boxes in order"],
  },
  {
    id: "dashboard/drive-unhealthy",
    area: "Dashboard",
    title: "Needs you: drive health warning and error",
    seed: (w) => {
      manyDrives(w, 2);
      w.health = {
        d1: smartHealth({ verdict: "failing", overall: "failed", status_bits: 8, reallocated_sectors: 120, temperature_c: 55, signals: [{ kind: "self_check_failed", level: "failing", value: null, limit: null }, { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 }, { kind: "temperature", level: "note", value: 55, limit: 60 }] }),
        d2: smartHealth({ verdict: "watch", reallocated_sectors: 4, temperature_c: 48, signals: [{ kind: "reallocated_sectors", level: "watch", value: 4, limit: 100 }] }),
      };
    },
    check: [NEEDS, "Drive 1 is failing, with a failing icon, and says why and to copy files off now", "Drive 2 is showing wear, with a warning icon, and says to keep using it and back it up", "Files: Drive 2 health details say 48°C · normal"],
  },
  {
    id: "dashboard/drive-hot",
    area: "Dashboard",
    title: "Drive running hot",
    seed: (w) => { w.health.d1 = smartHealth({ verdict: "watch", temperature_c: 61, signals: [{ kind: "temperature", level: "watch", value: 61, limit: 60 }] }); },
    check: [NEEDS, "The row says the drive is hotter than it should be, in plain words, and what to do"],
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
    seed: (w) => { w.drives[0].mounted = false; },
    check: ["Card pill says Can't open, not Ready", "Needs you: Drive can't be opened, and the button opens Files at that drive", "Files card has no Browse button and says why", "No crash or NaN"],
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
    seed: (w) => { w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0", release_notes: "Faster photo scanning." }; },
    url: "/settings#about",
    check: ["The dashboard shows the new version in plain words", "Settings → System updates → Install: the dialog closes, Luna goes quiet for a few seconds (as lunad restarts), then the page reloads on version 1.5.0", "After the restart you sign in again, as lunad asks"],
  },
  {
    id: "dashboard/update-failed",
    area: "Dashboard",
    title: "System update failed earlier",
    seed: (w) => { w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0", os_update_failed: { version: "1.5.0" } }; },
    check: ["Failure is explained", "Dismissing it works"],
  },
  {
    id: "dashboard/update-applying",
    area: "Dashboard",
    title: "Luna is restarting after an update",
    // lunad has no "installing" flag: the install answers, then Luna restarts and its pages go quiet for a while.
    restart: 8000,
    seed: (w) => { w.updates = { update_available: false, current_version: "1.5.0", latest_version: "1.5.0" }; },
    check: ["For about 8 seconds every request fails, as when lunad restarts", "The app says in plain words that it can't reach Luna, with no raw errors", "When Luna is back the app recovers without a manual reload"],
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
    seed: (w) => { w.connect = { connect_active: false, enabled: false, device_token_error: "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token." }; },
    check: [NEEDS, "Button goes to Settings → About where the token can be replaced", "lunad never sends the saved token back, so the token box is empty even while the error shows — a new token has to be pasted"],
  },
  {
    id: "dashboard/system-check-failed",
    area: "Dashboard",
    title: "Needs you: system checks failed and warned",
    seed: (w) => {
      w.systemChecks = {
        overall_pass: false,
        checks: {
          disk_space: { status: "failed", message: "Luna's own storage (its system disk) is almost full. Free some space on it, or Luna may stop working.", more: "This is the disk where Luna keeps its accounts and settings; your files are on your drives.", category: "system" },
          clock: { status: "warning", message: "The clock may be off.", more: "Luna sets its clock over the internet and hasn't managed to yet, so new and changed files may get wrong dates. Check that your router or modem is online, then check again in a minute.", category: "system" },
          video_tools: { status: "warning", message: "Videos get no preview pictures or length.", more: "Photos shows these for each video, made with video tools that are missing. Videos can still be played and downloaded.", category: "features" },
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
      w.drives[2].mounted = false;
      w.health = { d1: smartHealth({ verdict: "failing", overall: "failed", status_bits: 8, reallocated_sectors: 120, temperature_c: 55, signals: [{ kind: "self_check_failed", level: "failing", value: null, limit: null }, { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 }, { kind: "temperature", level: "note", value: 55, limit: 60 }] }) };
      w.summaries.d2 = summary("d2", { total_bytes: 64 * GB, free_bytes: GB, used_bytes: 63 * GB });
      w.network = { ethernet_connected: true, has_default_route: false };
      w.connect = { connect_active: false, enabled: false, device_token_error: "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token." };
      w.systemChecks = { overall_pass: false, checks: { drive_d1_smart: { status: "failed", message: "Drive 1 is failing. Copy your files to another drive now.", category: "drives" }, disk_space: { status: "failed", message: "Luna's own storage (its system disk) is almost full. Free some space on it, or Luna may stop working.", more: "This is the disk where Luna keeps its accounts and settings; your files are on your drives.", category: "system" } } };
      w.backups = [backup({ state: "failing", last_error: "Backup drive is full. Free up some space on it and try again." }), backup({ state: "stale", source_name: "Documents" })];
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
      // lunad only lists recents whose files still exist, so they have to be on the drive.
      demoTree(w, "d1");
      addFile(w, "d1", "Photos/IMG_000001-with-a-very-long-descriptive-name-that-keeps-going-and-going.jpeg", { sample: "png" });
      addFile(w, "d1", "Dokumente/Übersicht 日本語 😀.pdf", { sample: "pdf" });
      w.recents = [
        { driveId: "d1", path: "Photos/IMG_000001-with-a-very-long-descriptive-name-that-keeps-going-and-going.jpeg", kind: "file", at: (at(HOUR)) * 1000 },
        { driveId: "d1", path: "Dokumente/Übersicht 日本語 😀.pdf", kind: "file", at: (at(DAY)) * 1000 },
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
      demoTree(w, "d1");
      for (let i = 0; i < 12; i += 1) addFile(w, "d1", `Documents/Report ${i + 1}.pdf`, { sample: "pdf" });
      w.recents = Array.from({ length: 12 }, (_, i) => ({ driveId: "d1", path: `Documents/Report ${i + 1}.pdf`, kind: "file", at: (at(i * HOUR)) * 1000 }));
    },
    check: ["lunad lists at most 10 recent items, newest first", "Clicking one opens it", "Opening the same file twice never lists it twice"],
  },
  {
    id: "dashboard/albums-many",
    area: "Dashboard",
    title: "Shared albums: none, then many",
    seed: (w) => {
      w.users.push(user({ id: "u2", username: "sam", display_name: "Sam" }));
      w.albums = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, home_drive_id: "d1", name: `Album ${i + 1}`, owner_user_id: i % 2 ? "u1" : "u2", fakeCount: i * 7, shared_with: ["u1", "u2"], created_at: at(i * DAY) }));
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
      w.drives[0].mounted = false;
      w.network = { ethernet_connected: true, has_default_route: false };
      w.backups = [backup({ state: "failing", created_by: "u2", last_error: "Backup drive is full. Free up some space on it and try again." }), backup({ state: "stale", created_by: "u1" })];
    },
    check: ["Member sees only the backup they made (lunad hides the other one from them)", "Never sees drive or update rows", "Network: lunad answers Members with a reduced status, so a no-internet row may show — if it does, that is an app question, not the fake"],
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
      w.drives[0].mounted = false;
      w.backups = [backup({ state: "failing", last_error: "Backup drive is full. Free up some space on it and try again." })];
    },
    check: ["Text is readable on every surface", "Buttons don't blend into their backgrounds"],
  },
];
