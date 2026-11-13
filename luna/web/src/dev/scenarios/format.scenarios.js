// Erasing a drive (FormatDriveFlow). Handlers live in ../fake/handlers/format.js.
// The flow has no button of its own: in the app it opens only from the Add-drive
// window (a drive Luna can't use as it is) and, later, the encryption hand-offs.
// Scenarios that need it for any other drive open it through the dev page
// /__flow/format?device=<name>[&password=<pw>] (dev/flows/FormatFlowHarness.jsx).
// Every erase runs a phase every 1.5 s unless a scenario says otherwise, so a whole
// run takes about ten seconds; the refresh scenarios stretch it so there is time to reload.
import { seedRun } from "../fake/handlers/format.js";

const A = "Drive erase";
const photos = [
  { kind: "folder", name: "Family photos" }, { kind: "folder", name: "Tax 2024" }, { kind: "folder", name: "Music" },
  { kind: "file", name: "passport-scan.pdf" }, { kind: "file", name: "notes.txt" },
];
const stick = (over = {}) => ({ name: "sdb", model: "SanDisk USB stick", size_bytes: 32_000_000_000, fs_type: "exfat", readable: true, entries: photos, ...over });
const FLOW = "/__flow/format";
const walk = ["Preview names the drive, its size, and its folders and files", "Erase drive sits under the contents, disabled with a countdown from 30; nothing to fill in", "After the countdown: Erase drive → named steps move along → Drive is ready", "Open drive lands on the new, empty drive"];

/** @type {import("./registry.js").Scenario[]} */
export default [
  {
    id: "format/empty-drive", area: A, title: "Blank USB stick: no wait", url: "/files",
    seed: (w) => { w.detected = [stick({ model: "Blank USB stick", fs_type: null, readable: false, needs_setup: true, entries: [] })]; },
    check: ["The card says the drive is blank and that using it erases what's on it", "Add drive → Erase and set up opens the erase window: This drive is blank", "The Erase drive button is enabled at once, with no countdown", "Erase → steps → Drive is ready → Open drive", "The Unrecognized drives card is gone and the drive is on the Files page"],
  },
  {
    id: "format/drive-with-files", area: A, title: "USB stick with files: 30 second wait", url: `${FLOW}?device=sdb`,
    seed: (w) => { w.detected = [stick({ volume_label: "BACKUP2019" })]; },
    check: ["(Opened on the dev page: a readable stick is added as it is, so the app never erases it)", ...walk, "On /files, Add drive offers Add this drive and no erase"],
  },
  {
    id: "format/preview-states", area: A, title: "Unreadable, locked, installer and mixed drives", url: FLOW,
    seed: (w) => {
      w.detected = [
        stick({ name: "sdb", model: "Damaged SD card", fs_type: "ntfs", readable: false, entries: [] }),
        stick({ name: "sdc", model: "Ubuntu installer", fs_type: "iso9660", readable: true, needs_setup: true, entries: [] }),
        stick({
          name: "sdd", model: "Old two-part disk", fs_type: "exfat",
          preview: {
            empty: false,
            partitions: [
              { name: "sdd1", size_bytes: 500_000_000, fs_type: "vfat", label: "BOOT", state: "empty", used_bytes: 0, folders: 0, files: 0, unreadable: 0, entries: [] },
              { name: "sdd2", size_bytes: 15_000_000_000, fs_type: "LVM2_member", label: "", state: "unknown_filesystem", used_bytes: null, folders: 0, files: 0, unreadable: 0, entries: [] },
              { name: "sdd3", size_bytes: 16_000_000_000, fs_type: "crypto_LUKS", label: "", state: "locked", used_bytes: null, folders: 0, files: 0, unreadable: 0, entries: [] },
            ],
          },
        }),
      ];
    },
    check: ["Open each drive from the dev page's list", "Each drive's preview opens with a plain headline: Luna can't read this drive / installer disk", "Each part says in one sentence why its contents can't be shown", "Every one of them waits 30 seconds before the erase button works", "No word like filesystem, partition or LUKS appears anywhere"],
  },
  {
    id: "format/failure-mid-run", area: A, title: "The erase fails while writing", url: `${FLOW}?device=sdb`,
    seed: (w) => { w.detected = [stick({ formatFailAt: "formatting", formatFailMessage: "This drive stopped responding, so Luna couldn't erase it. Unplug it, plug it back in, and try again." })]; },
    check: ["Steps move along, then the window says The erase didn't finish", "It says the old files may already be gone", "Look at the drive again returns to the preview", "No toast appears for the failure, and on /files the drive is still in Unrecognized drives"],
  },
  {
    id: "format/fails-before-erasing", area: A, title: "The erase fails before anything is touched", url: `${FLOW}?device=sdb`,
    seed: (w) => { w.detected = [stick({ formatFailAt: "releasing" })]; },
    check: ["The window says Nothing was erased. The drive is as it was.", "Close, then on /files Add drive works as before"],
  },
  {
    id: "format/start-refused", area: A, title: "Start refused (old preview, wrong drive, busy)", url: `${FLOW}?device=sdb`,
    seed: (w) => { w.detected = [stick({ swappedAtStart: true })]; },
    check: ["After the countdown, Erase drive shows: This isn't the drive that was shown", "The button becomes Look at the drive again and gives a fresh preview", "Other codes: break the request in Break things, or set busy / missingTool / filesAppearedAtStart on the detected drive"],
  },
  {
    id: "format/erase-registered", area: A, title: "Erase a drive Luna already has", url: FLOW,
    check: ["(The app has no Erase drive button; encryption's Protect / Remove protection will open this)", "Open the Family photos drive from the dev page's list", "The preview lists its real top-level folders", "The screen says share links and folder access go and whole-drive access stays", "After the erase it is still called Family photos, and Browse files shows it empty"],
  },
  {
    id: "format/with-password", area: A, title: "Erase with a password (as the encryption sheet will)", url: `${FLOW}?device=sdb&password=correct%20horse%2042`,
    seed: (w) => { w.detected = [stick({ model: "Blank USB stick", fs_type: null, readable: false, needs_setup: true, entries: [] })]; },
    check: ["The screen says there is no way to recover the password", "Still no choice of format or encryption anywhere", "The steps include protecting the drive with the password"],
  },
  {
    id: "format/refresh-mid-format", area: A, title: "Reload while a new drive is being erased", url: "/files",
    seed: (w) => {
      w.detected = [stick({ formatPhaseMs: 8000 })];
      seedRun(w, { device: "sdb", label: "SanDisk USB stick", agoMs: 3000, phaseMs: 8000 });
    },
    check: ["The card says it is being erased, with a Show progress button, and no Add drive", "Show progress opens the named steps where they actually are", "Press F5 inside the frame (not the gallery's Reload, which starts over): the run carries on where the clock says", "When it finishes: Drive is ready, one toast, and the card turns into a drive"],
  },
  {
    id: "format/refresh-mid-erase", area: A, title: "Reload while a drive Luna has is being erased", url: "/files",
    seed: (w) => { seedRun(w, { device: "sdd1", driveId: "d1", label: "Family photos", agoMs: 3000, phaseMs: 8000 }); },
    check: ["The Family photos card says it is being erased and offers Show progress, and no Browse files", "As a Member (Sign in as) the card says so but has no button", "Browse files comes back after it finishes, empty"],
  },
];
