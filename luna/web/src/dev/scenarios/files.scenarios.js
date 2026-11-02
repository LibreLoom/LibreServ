// Files: browsing, trash, uploads, copy/move, private folders, backups, search,
// viewers and editors. Handlers live in ../fake/handlers/files.js.
import { drive, smartHealth, summary, user, backup, cloudBackup } from "../fake/world.js";
import { addDir, addFile, addMany, demoTree, fsOpts, viewerSamples } from "../fake/handlers/files.js";

const ago = (s) => Math.floor(Date.now() / 1000) - s;

/** Start with a blank main drive (the default shows the demo tree). */
const blank = (w) => { w.fs = { ...(w.fs || {}), d1: { nodes: {}, trash: [] } }; };
const withBackupDrive = (w, over = {}) => {
  w.drives.push(drive({ id: "d2", label: "Backup drive", ...over }));
  w.summaries.d2 = summary("d2", { total_bytes: 128_000_000_000, free_bytes: 100_000_000_000, used_bytes: 28_000_000_000, shortcuts: [] });
  w.fs = { ...(w.fs || {}), d2: { nodes: {}, trash: [] } };
};
const asMember = (w, rows) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
  w.sessionUserId = "u2";
  // The grants belong to Sam (u2); anyone else who signs in starts with none.
  w.access = rows.map((r) => ({ user_id: "u2", ...r }));
};
const trashed = (w, name, folder = "") => {
  const fs = w.fs.d1;
  const path = folder ? `${folder}/${name}` : name;
  fs.trash.push({ key: `17${Math.floor(Math.random() * 1e6)}-${name}`, original_path: path, trashed_at: ago(2 * 86400), nodes: { "": { kind: "file", size: 4200, modified: ago(9 * 86400), text: `Contents of ${name}` } } });
};
const demo = (w) => { demoTree(w, "d1"); };
const open = (file) => `/files/d1?path=Viewers&file=${encodeURIComponent(file)}`;
const A = "Files";

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── What is on the drive ──────────────────────────────────────────────────
  {
    id: "files/overview", area: A, title: "Normal drive, a few folders", url: "/files",
    check: ["Files page lists Family photos", "Open it: folders first, then files, sizes and ages look right", "Breadcrumbs go back up", "Up and Back keys behave"],
  },
  {
    id: "files/empty-drive", area: A, title: "Drive with nothing on it", url: "/files/d1",
    seed: (w) => { blank(w); w.summaries.d1 = summary("d1", { used_bytes: 0, free_bytes: 63_000_000_000, shortcuts: [] }); },
    check: ["Empty state explains what to do next", "New menu still offers folder, file and upload", "Dropping a file works and it shows up", "Trash link shows an empty trash"],
  },
  {
    id: "files/one-file", area: A, title: "Exactly one file", url: "/files/d1",
    seed: (w) => { blank(w); addFile(w, "d1", "only.txt", { text: "Just me." }); },
    check: ["Singular wording (1 item, not 1 items)", "Select-all and bulk actions still make sense"],
  },
  {
    id: "files/thousands", area: A, title: "5,000 files in one folder", url: "/files/d1?path=Big",
    seed: (w) => { blank(w); addMany(w, "d1", "Big", 5000); },
    check: ["List stays smooth while scrolling", "Sorting by name, size, age is quick", "Filter box narrows instantly", "Select-all says how many are selected"],
  },
  {
    id: "files/long-names", area: A, title: "Very long file names", url: "/files/d1?path=Long",
    seed: (w) => {
      blank(w);
      const long = "A".repeat(80) + " " + "very-long-name-".repeat(14);
      addFile(w, "d1", `Long/${long}.txt`, { text: "x" });
      addDir(w, "d1", `Long/${"Folder with a name that keeps going ".repeat(5).trim()}`);
      addFile(w, "d1", `Long/${"x".repeat(200)}.jpg`, { sample: "png" });
    },
    check: ["Names cut off with … and never push buttons off screen", "Full name is readable somewhere (hover, details or rename)", "Phone width still scrolls vertically only"],
  },
  {
    id: "files/unicode-emoji", area: A, title: "Unicode, emoji and odd characters", url: "/files/d1?path=Odd",
    seed: (w) => {
      blank(w);
      for (const n of ["日本語のファイル.txt", "Ünïcödé résumé.docx", "🌈 holiday 🏖️.jpg", "عربى.txt", "a&b #1 %20 ?.txt", "  leading space.txt", "trailing dot.", "quote's \"double\".txt", "é (combining).txt"]) {
        addFile(w, "d1", `Odd/${n}`, { text: n, sample: undefined });
      }
      addDir(w, "d1", "Odd/📁 Ordner");
    },
    check: ["Every name shows exactly as written", "Open, rename and delete work on each", "Links with # ? % in the name open the right file", "Search finds them"],
  },
  {
    id: "files/deep-nesting", area: A, title: "Folders nested 25 deep", url: "/files/d1?path=" + encodeURIComponent(Array.from({ length: 25 }, (_, i) => `level${i + 1}`).join("/")),
    seed: (w) => { blank(w); const p = Array.from({ length: 25 }, (_, i) => `level${i + 1}`).join("/"); addFile(w, "d1", `${p}/deep.txt`, { text: "deep" }); },
    check: ["Breadcrumbs shorten instead of overflowing", "Each crumb still goes to the right folder"],
  },
  {
    id: "files/hidden-files", area: A, title: "Hidden (dot) files", url: "/files/d1",
    seed: (w) => { blank(w); addFile(w, "d1", ".secret", { text: "x" }); addFile(w, "d1", ".config/app.json", { text: "{}" }); addFile(w, "d1", "visible.txt", { text: "x" }); },
    check: ["Dot files are hidden until you choose to show them", "The toggle says what it does", "Hidden items look different once shown"],
  },
  {
    id: "files/missing-folder", area: A, title: "Link to a folder that no longer exists", url: "/files/d1?path=Gone%2FForever",
    check: ["Says the folder isn't here anymore, not 'unplugged'", "Offers a way back to Files"],
  },
  {
    id: "files/moved-link", area: A, title: "Old link to a moved folder", url: "/files/d1?path=Old%20place",
    seed: (w) => { demo(w); w.moves = [{ drive_id: "d1", old_path: "Old place", new_drive: "d1", new_path: "Documents" }]; },
    check: ["Opens Documents on its own, not \"Drive not found\"", "A notice says it moved and to update bookmarks"],
  },

  // ── Making things and name collisions ─────────────────────────────────────
  {
    id: "files/create-collision", area: A, title: "New folder / file with a name already taken", url: "/files/d1?path=Documents",
    check: ["New → Folder, type: Taxes  → clear message that it exists", "New → text file, type: notes.txt → same", "The dialog stays open with your text", "Blank name and a name with / are refused in plain words"],
  },
  {
    id: "files/rename-collision", area: A, title: "Rename onto an existing name", url: "/files/d1?path=Documents",
    check: ["Rename notes.txt to readme.md → refused, original name kept", "Rename to a new name → list updates at once", "Changing the file ending warns first"],
  },
  {
    id: "files/rename-while-open", area: A, title: "Rename a file, old link still works", url: "/files/d1?path=Documents&file=notes.txt",
    check: ["Rename it from the viewer if offered", "Toast confirms the rename", "Reload the old URL: follows to the new name with a notice"],
  },

  // ── Drive condition ───────────────────────────────────────────────────────
  {
    id: "files/readonly-drive", area: A, title: "Read-only drive", url: "/files/d1",
    seed: (w) => { demo(w); w.drives[0].state = "readonly"; },
    check: ["Browsing and opening work", "New, upload, rename, delete are hidden or disabled with a reason", "Trying anyway (drag a file in) gives a plain 'read-only' message"],
  },
  {
    id: "files/full-drive", area: A, title: "Drive with no space left", url: "/files/d1",
    seed: (w) => { demo(w); w.summaries.d1 = summary("d1", { free_bytes: 0, used_bytes: 64_000_000_000 }); },
    check: ["Upload a file → says the drive is full, offers what to do", "Creating a folder still works", "Nothing half-uploaded is left in the list"],
  },
  {
    id: "files/unplugged-at-start", area: A, title: "Drive is unplugged", url: "/files/d1",
    seed: (w) => { demo(w); w.drives[0].state = "missing"; w.summaries.d1.mounted = false; },
    check: ["Says the drive can't be found and to plug it in", "Admin and Member get different wording", "Files page doesn't show a broken list"],
  },
  {
    id: "files/unplugged-mid-browse", area: A, title: "Drive pulled out while browsing", url: "/files/d1?path=Documents",
    faults: [{ match: "GET /api/v1/drives/d1/files", mode: "404", code: "unknown_drive", message: "Luna can't find this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.", on: false }],
    check: ["In Break things, tick the prepared rule (GET /api/v1/drives/d1/files → 404), then open a folder", "The unplugged message shows, not a blank list", "Untick the rule and press Try again: the list returns"],
  },
  {
    id: "files/drive-database-missing", area: A, title: "Drive plugged in but Luna's database for it is gone", url: "/files/d1",
    seed: (w) => { demo(w); w.driveDbMissing = ["d1"]; },
    check: ["Explains the database is missing and the drive is fine", "Does not say 'unplugged'"],
  },
  {
    id: "files/failing-drive", area: A, title: "Drive reports it is failing", url: "/files/d1",
    seed: (w) => { demo(w); w.health.d1 = smartHealth({ verdict: "failing", overall: "failed", status_bits: 8, reallocated_sectors: 120, temperature_c: 55, signals: [{ kind: "self_check_failed", level: "failing", value: null, limit: null }, { kind: "reallocated_sectors", level: "failing", value: 120, limit: 100 }, { kind: "temperature", level: "note", value: 55, limit: 60 }] }); },
    check: ["A notice above the files says the drive is failing, with a link to what's wrong", "Drive health on Files lists what tripped and What to do", "Browsing still works"],
  },
  {
    id: "files/health-unknown", area: A, title: "Drive gives no health report", url: "/files/d1",
    seed: (w) => { demo(w); w.health.d1 = smartHealth({ available: false, reason: "no_report", verdict: "unknown", overall: "unknown", model: null, serial: null, temperature_c: null, reallocated_sectors: null, pending_sectors: null, uncorrectable_sectors: null }); },
    check: ["Drive health says Luna got no report from this drive, in plain words", "No warning notice above the files"],
  },
  {
    id: "files/drive-healthy-details", area: A, title: "Healthy drive, a little warm", url: "/files/d1",
    seed: (w) => { demo(w); w.health.d1 = smartHealth({ temperature_c: 52, signals: [{ kind: "temperature", level: "note", value: 52, limit: 60 }] }); },
    check: ["Health details show a warm row for 52°C", "No warning notice above the files"],
  },
  {
    id: "files/listing-slow", area: A, title: "Folder takes ages to open", url: "/files/d1",
    faults: [{ match: "GET /api/v1/drives/d1/files", mode: "slow:7000" }],
    check: ["Loading state shows, then a 'still working' notice", "Can still go elsewhere while waiting"],
  },
  {
    id: "files/listing-error", area: A, title: "Listing fails with a server error", url: "/files/d1",
    faults: [{ match: "GET /api/v1/drives/d1/files", mode: "500", message: "Luna couldn't read this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in." }],
    check: ["Only the folder listing fails (the rest of the page still loads)", "Plain message and a Try again button", "No raw JSON or status codes"],
  },

  // ── Trash ─────────────────────────────────────────────────────────────────
  {
    id: "files/trash-empty", area: A, title: "Trash with nothing in it", url: "/files/d1?path=.luna-trash",
    check: ["Empty state says so", "Empty trash is disabled", "Crumbs read 'Trash'"],
  },
  {
    id: "files/trash-with-items", area: A, title: "Trash with files and a folder", url: "/files/d1?path=.luna-trash",
    seed: (w) => { demo(w); trashed(w, "old-notes.txt", "Documents"); trashed(w, "photo copy.jpg", "Photos"); w.fs.d1.trash.push({ key: "17999-Old trip", original_path: "Photos/Old trip", trashed_at: ago(5 * 86400), nodes: { "": { kind: "dir", modified: ago(9e5) }, "a.jpg": { kind: "file", size: 5000, modified: ago(9e5), sample: "png" } } }); },
    check: ["Names show without numbers in front", "Each row shows where it came from", "Restore puts it back and removes it from Trash", "Open the trashed folder: crumbs read Trash / Photos / Old trip", "Delete permanently asks first and says it can't be undone"],
  },
  {
    id: "files/trash-restore-conflict", area: A, title: "Restore when the name is taken again", url: "/files/d1?path=.luna-trash",
    seed: (w) => { demo(w); trashed(w, "notes.txt", "Documents"); },
    check: ["Restore notes.txt → message that it already exists", "Change the name in the dialog → restore works"],
  },
  {
    id: "files/trash-restore-folder-gone", area: A, title: "Restore into a folder that was deleted", url: "/files/d1?path=.luna-trash",
    seed: (w) => { demo(w); trashed(w, "lost.txt", "Vanished/Deep"); },
    check: ["Restore re-creates Vanished/Deep and puts lost.txt back there", "Nothing breaks"],
  },
  {
    id: "files/trash-empty-all", area: A, title: "Empty the whole trash", url: "/files/d1?path=.luna-trash",
    seed: (w) => { demo(w); for (let i = 0; i < 12; i += 1) trashed(w, `junk ${i}.txt`); },
    check: ["Empty trash asks first and counts the items", "After confirming the list is empty and the toast says so", "Fail it (fault on POST …/files/purge) → error stays visible"],
  },
  {
    id: "files/trash-empty-slow", area: A, title: "Emptying a big trash takes a while", url: "/files/d1?path=.luna-trash",
    seed: (w) => { demo(w); for (let i = 0; i < 12; i += 1) trashed(w, `junk ${i}.txt`); },
    faults: [{ match: "POST /api/v1/drives/d1/files/purge", mode: "slow:6000" }],
    check: ["Confirming shows a spinner on the button and the row says it is working", "Nothing else is blocked while it runs", "When it ends the trash is empty and the toast says so"],
  },
  {
    id: "files/delete-to-trash", area: A, title: "Delete a file, then find it in Trash", url: "/files/d1?path=Documents",
    check: ["Delete notes.txt → toast says Moved to Trash", "It's gone from the list and present in Trash", "Delete a folder with files inside, restore it whole"],
  },

  // ── Uploads ───────────────────────────────────────────────────────────────
  {
    id: "files/upload-ok", area: A, title: "Upload a few files", url: "/files/d1?path=Documents",
    check: ["Upload panel lists each file with progress", "Three at a time, rest wait", "Finished files appear in the list", "Panel can be closed and reopened"],
  },
  {
    id: "files/upload-slow", area: A, title: "Upload crawls", url: "/files/d1?path=Documents",
    faults: [{ match: "POST /api/v1/drives/d1/files/upload", mode: "slow:15000" }],
    check: ["Progress moves, does not look frozen", "Cancel stops it and nothing is left behind", "Leaving the page with an upload running asks first", "Navigate to Dashboard and back: the same upload is still running in the card"],
  },
  {
    id: "files/upload-fails", area: A, title: "Upload fails (server error)", url: "/files/d1?path=Documents",
    faults: [{ match: "POST /api/v1/drives/d1/files/upload", mode: "500", message: "Luna couldn't save this file. Check that the drive is connected and try again." }],
    check: ["Row shows the failure in plain words", "Retry is offered; Remove clears the row", "File does not appear in the list"],
  },
  {
    id: "files/upload-duplicate", area: A, title: "Upload a file that already exists", url: "/files/d1?path=Documents",
    check: ["Upload a file called notes.txt → Luna says it exists and offers Replace / Keep both / Skip (or a clear error)", "Choosing keeps the right one", "Folder drop with half duplicates behaves per file"],
  },
  {
    id: "files/upload-huge", area: A, title: "Huge file (over 32 MB, goes in pieces)", url: "/files/d1?path=Documents",
    check: ["Pick a file larger than 32 MB (any big file)", "Progress is smooth across pieces", "Cancel mid-way removes the partial upload"],
  },
  {
    id: "files/upload-huge-flaky", area: A, title: "Huge upload, connection drops once", url: "/files/d1?path=Documents",
    faults: [{ match: "PUT /api/v1/uploads/*", mode: "503", once: true }],
    check: ["Pick a file larger than 32 MB", "First piece fails, Luna retries by itself after a pause", "Upload completes without you doing anything"],
  },
  {
    id: "files/upload-no-space-huge", area: A, title: "Huge upload that can't fit", url: "/files/d1?path=Documents",
    seed: (w) => { demo(w); w.summaries.d1.free_bytes = 10_000_000; },
    check: ["Pick a file larger than 32 MB → refused up front: \"This drive is full. Free up some space and try again.\"", "No endless retry"],
  },
  {
    id: "files/upload-offline", area: A, title: "Go offline during an upload", url: "/files/d1?path=Documents",
    check: ["Start an upload, then use Break things → Go offline", "Row says it can't reach Luna, not a raw error", "Back online + Retry works"],
  },
  {
    id: "files/upload-into-readonly", area: A, title: "Upload into a read-only drive", url: "/files/d1",
    seed: (w) => { demo(w); w.drives[0].state = "readonly"; },
    check: ["Drop a file anyway → the failure says the drive is read-only", "No row stuck at 100%"],
  },
  {
    id: "files/upload-folder", area: A, title: "Upload a whole folder", url: "/files/d1?path=Documents",
    check: ["Drag a folder with sub-folders onto the list", "Structure is kept", "Empty folders are handled sensibly"],
  },
  {
    id: "files/upload-many-clashes", area: A, title: "Upload 15 files whose names are taken", url: "/files/d1?path=Documents",
    seed: (w) => { demo(w); for (let i = 1; i <= 15; i += 1) addFile(w, "d1", `Documents/scan ${String(i).padStart(2, "0")}.pdf`, { sample: "pdf" }); },
    check: [
      "Drop 15 files named scan 01.pdf to scan 15.pdf → each asks for a decision, not one at a time",
      "Only one problem shows in the card, with \"14 more problems →\" to see the rest",
      "Keep both for all: each lands as \"scan 01 (1).pdf\" and so on, and the originals are untouched",
      "Checking the list again shows no duplicates or lost files",
    ],
  },
  {
    id: "files/upload-folder-mixed", area: A, title: "Upload a folder with clashes and a refused name", url: "/files/d1?path=Documents",
    seed: (w) => { demo(w); addFile(w, "d1", "Documents/Trip/Lisbon/tram.jpg", { sample: "png" }); addFile(w, "d1", "Documents/Trip/Lisbon/notes.txt", { text: "Old notes" }); addDir(w, "d1", "Documents/Trip/Photos"); },
    faults: [{ match: "POST /api/v1/drives/d1/files/upload", mode: "400", message: "That file name can't be used. Try renaming it.", once: true }],
    check: [
      "Drop a folder called Trip that holds Lisbon/notes.txt, a Photos folder and new files",
      "One file is refused with \"That file name can't be used. Try renaming it.\", and the row says which file",
      "Folder clashes offer Keep both or Skip only, never Replace",
      "Every other file uploads, and new folders are created on the drive",
    ],
  },

  // ── Copy and move ─────────────────────────────────────────────────────────
  {
    id: "files/copy-job", area: A, title: "Copy a folder to another drive", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); withBackupDrive(w); fsOpts(w).jobMs = 8000; },
    check: ["Copy → pick Backup drive → progress card appears with %", "Card disappears when done, copy exists on the other drive", "Cancel mid-way stops it"],
  },
  {
    id: "files/move-job", area: A, title: "Move a folder to another drive", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); withBackupDrive(w); fsOpts(w).jobMs = 5000; },
    check: ["Move 2025 to Backup drive → the card shows progress while Luna copies", "When done it is on Backup drive and the original is in this drive's Trash", "A move inside one drive (drag notes.txt onto a folder) is a single rename: it finishes at once, with no progress"],
  },
  {
    // A real failure: Backup drive fills up about halfway through copying Spain, so lunad
    // answers with the drive-full words and the "Nothing was moved" suffix. The originals stay put.
    id: "files/move-fails-partway", area: A, title: "Move fails halfway through", url: "/files/d1?path=Photos",
    seed: (w) => {
      demo(w); withBackupDrive(w); addMany(w, "d1", "Photos/2024/Spain", 40); fsOpts(w).jobMs = 6000;
      const spain = Object.entries(w.fs.d1.nodes).filter(([p, n]) => n.kind === "file" && p.startsWith("Photos/2024/Spain/"));
      w.summaries.d2.free_bytes = Math.floor(spain.reduce((t, [, n]) => t + (n.size || 0), 0) / 2);
    },
    check: [
      "Move Spain to Backup drive → starts, then stops at about half",
      "Row says it failed (not silent): \"Backup drive is full. Free up some space on it and try again. Nothing was moved. Your files are still where they were.\"",
      "Spain is untouched in Photos/2024, and Backup drive has no partial copy",
    ],
  },
  {
    id: "files/copy-fails-drive-full", area: A, title: "Copy runs out of space on the other drive", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); withBackupDrive(w); w.summaries.d2.free_bytes = 2_000_000; },
    check: ["Copy Photos to Backup drive → starts, then fails when the drive fills (under half way)", "Message is \"Backup drive is full. Free up some space on it and try again.\"", "It says Luna removed the partial copy, and none is left on Backup drive"],
  },
  {
    id: "files/copy-to-full-drive", area: A, title: "Copy to a drive with no room at all", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); withBackupDrive(w); w.summaries.d2.free_bytes = 1000; },
    check: ["Copy Photos → Luna does not check room first: the job starts and fails almost at once", "Message names Backup drive as full and says the partial copy was removed"],
  },
  {
    id: "files/move-into-itself", area: A, title: "Move a folder into itself", url: "/files/d1",
    check: ["Move Photos into Photos/2024 → refused (\"Luna can't use that path.\"); better still, the app should not offer it", "Nothing changes"],
  },
  {
    id: "files/move-name-clash", area: A, title: "Copy onto a name that exists", url: "/files/d1?path=Documents",
    check: ["Copy notes.txt into the same folder → the copy offers Keep both / Skip, and Keep both lands notes (1).txt", "Without a decision Luna refuses with \"A file or folder with this name is already there. Choose a different destination.\" (code exists)", "Original untouched"],
  },
  {
    id: "files/move-readonly-dest", area: A, title: "Move to a read-only drive", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); withBackupDrive(w, { state: "readonly" }); },
    check: ["Dropping onto the read-only drive fails with an error on the job (lunad words it generically)", "The original is untouched"],
  },
  {
    id: "files/job-server-error", area: A, title: "Starting a copy fails", url: "/files/d1?path=Photos",
    faults: [{ match: "POST /api/v1/jobs", mode: "503", message: "Luna's job queue isn't responding." }],
    check: ["Error is visible next to what you did", "No ghost progress card"],
  },

  // ── Private folders ───────────────────────────────────────────────────────
  {
    id: "files/private-own", area: A, title: "My own private folder", url: "/files/d1",
    seed: (w) => { demo(w); addDir(w, "d1", "Diary", { private: true, owner: "u1" }); addFile(w, "d1", "Diary/day1.txt", { text: "Dear diary" }); },
    check: ["Row has the private badge", "Open it: files show, marked as inside a private folder", "Properties says Private", "Protect says it has no backup yet"],
  },
  {
    id: "files/private-others", area: A, title: "Someone else's private folder (I'm an Admin)", url: "/files/d1",
    seed: (w) => { demo(w); w.users.push(user({ id: "u2", username: "sam", display_name: "Sam" })); addDir(w, "d1", "Sam's stuff", { private: true, owner: "u2" }); addFile(w, "d1", "Sam's stuff/x.txt", { text: "x" }); },
    check: ["The Admin does not see Sam's private folder in the list (the Admin role stops at a private wall)", "Opening its address directly says the Admin has no permission to view this folder — not a blank list or raw error", "Search never shows its contents"],
  },
  {
    id: "files/private-orphaned", area: A, title: "Private folders of a removed person", url: "/settings#users",
    seed: (w) => { demo(w); w.deletedUsers.push({ id: "u9", username: "jo", display_name: "Jo", deleted_at: ago(9 * 86400) }); addDir(w, "d1", "Ex's secrets", { private: true, owner: "u9" }); addFile(w, "d1", "Ex's secrets/y.txt", { text: "y" }); addDir(w, "d1", "Ex's other", { private: true, owner: "u9" }); },
    check: ["Users page offers to clean up leftover private folders for Jo", "Delete asks first and says the files go for good", "Afterwards the folders are gone from Files"],
  },
  {
    id: "files/private-orphaned-readonly", area: A, title: "Orphaned private folders on a read-only drive", url: "/settings#users",
    seed: (w) => { demo(w); w.deletedUsers.push({ id: "u9", username: "jo", display_name: "Jo", deleted_at: ago(9 * 86400) }); w.drives[0].state = "readonly"; addDir(w, "d1", "Left behind", { private: true, owner: "u9" }); },
    check: ["Cleanup warns that the drive is read-only and some content remains", "Toast is a warning, not a success"],
  },
  {
    id: "files/private-ownerless", area: A, title: "Private folders that belong to nobody", url: "/settings#users",
    seed: (w) => { demo(w); w.users.push(user({ id: "u2", username: "sam", display_name: "Sam" })); addDir(w, "d1", "Imported A", { private: true }); addDir(w, "d1", "Imported B", { private: true }); },
    check: ["Admin sees '2 private folders have no owner' and can give them to someone", "After giving, the notice disappears"],
  },
  {
    id: "files/private-move-out", area: A, title: "Move something out of a private folder", url: "/files/d1?path=Diary",
    seed: (w) => { demo(w); addDir(w, "d1", "Diary", { private: true, owner: "u1" }); addFile(w, "d1", "Diary/day1.txt", { text: "Dear diary" }); fsOpts(w).jobMs = 3000; },
    check: ["Move day1.txt to Documents → asks 'Move it out of the private folder?'", "Cancel leaves it; confirming moves it", "Same question for restore from Trash"],
  },

  // ── Protect (backups) ─────────────────────────────────────────────────────
  {
    id: "files/protect-one-drive", area: A, title: "Protect with only one drive", url: "/files/d1",
    check: ["Open Protect on Documents", "Explains a second drive is needed for drive backups", "Cloud section is still there"],
  },
  {
    id: "files/protect-new", area: A, title: "Protect a folder for the first time", url: "/files/d1",
    seed: (w) => { demo(w); withBackupDrive(w); w.connect = { enabled: true, card_on_file: true }; w.connectActive = true; },
    check: ["Pick Backup drive → Back up → toast, row appears as starting", "Back up now makes it 'up to date'", "Delete asks first"],
  },
  {
    id: "files/protect-problem", area: A, title: "A backup reports a problem", url: "/files/d1",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", state: "failing", hard: true, last_error: "Backup drive is full. Free up some space on it and try again." })); fsOpts(w).backupProblem = "Backup drive is full. Free up some space on it and try again."; },
    check: ["Row shows the problem", "Back up now shows the same problem next to the backup, not in a toast"],
  },
  {
    id: "files/protect-cloud-off", area: A, title: "Cloud backup without Luna Connect", url: "/files/d1",
    seed: (w) => { demo(w); w.connect = { enabled: false }; },
    check: ["Cloud backup tells you to turn on Luna Connect first", "Doesn't offer a button that can't work"],
  },
  {
    id: "files/protect-cloud-on", area: A, title: "Cloud backup with Luna Connect on", url: "/files/d1",
    seed: (w) => { demo(w); w.connect = { enabled: true, card_on_file: true }; w.connectActive = true; w.cloudBackups.push(cloudBackup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", source_missing: false })); },
    check: ["Documents shows a cloud backup row with last backed up time", "Photos offers to start one", "Older versions option asks first"],
  },
  {
    id: "files/protect-cloud-no-card", area: A, title: "Cloud backup, no payment card", url: "/files/d1",
    seed: (w) => { demo(w); w.connect = { enabled: true, card_on_file: false }; w.connectActive = true; },
    check: ["Says a card is needed, and where to add it"],
  },
  {
    id: "files/protect-private-own", area: A, title: "Protect my private folder", url: "/files/d1",
    seed: (w) => { demo(w); withBackupDrive(w); addDir(w, "d1", "Diary", { private: true, owner: "u1" }); },
    check: ["Protect on Diary works and mentions it stays private", "Dashboard 'private items' count updates"],
  },
  {
    id: "files/protect-inside-private", area: A, title: "Protect a folder inside your private one", url: "/files/d1",
    seed: (w) => { demo(w); withBackupDrive(w); addDir(w, "d1", "Diary/2025", { private: false }); w.fs.d1.nodes.Diary.private = true; w.fs.d1.nodes.Diary.owner = "u1"; },
    check: ["Protect on Diary/2025 says this folder is private and only you can back it up", "Choose a drive and Back up to the cloud both work"],
  },
  {
    id: "files/protect-covered-by-parent", area: A, title: "Folder already held by a bigger folder's backup", url: "/files/d1",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", target_drive: "d2" })); },
    check: ["Protect on a folder inside Documents says it is included in the backup of Documents", "No Choose a drive or Back up now for that drive", "Deleting the Documents backup lets the folder be backed up again"],
  },
  {
    id: "files/backups-browse", area: A, title: "Browse a backup drive's Backups folder", url: "/files/d2",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", target_drive: "d2" })); trashed(w, "deleted-since.txt", "Documents"); },
    check: ["Backups link appears at the top of Backup drive", "Folder lists the backed-up Documents, deleted files marked", "Versions shows older copies; Restore says 'Restored as …' and never replaces the current file", "Download works"],
  },
  {
    id: "files/backups-no-versions", area: A, title: "Backed up file with no older versions", url: "/files/d2",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", target_drive: "d2" })); fsOpts(w).noVersions = true; },
    check: ["Versions modal says there are none, instead of an empty box"],
  },
  {
    id: "files/backups-restore-fails", area: A, title: "Restoring a version fails", url: "/files/d2",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", target_drive: "d2" })); },
    faults: [{ match: "POST /api/v1/drives/d2/backups/*/restore", mode: "409", message: "Connect Family photos to restore to the original folder." }],
    check: ["Error stays inside the Versions window, in words", "Window can be closed and reopened"],
  },
  {
    id: "files/restore-backup-slow", area: A, title: "Restoring a folder from a backup takes a while", url: "/files/d2",
    seed: (w) => { demo(w); withBackupDrive(w); w.backups.push(backup({ source_drive: "d1", source_path: "Documents", source_name: "Documents", target_drive: "d2" })); },
    faults: [{ match: "POST /api/v1/drives/d2/backups/*/restore", mode: "slow:6000" }],
    check: ["Restore shows a loading state on that row or in the Versions window", "Other rows stay usable while it runs", "Toast says it was restored as a new copy, and the current files are never replaced"],
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    id: "files/search-results", area: A, title: "Search finds a few files", url: "/files",
    check: ["Press / or use the search button, type: notes", "Matching letters are underlined", "Each hit shows where it lives", "Enter opens the folder with the file highlighted"],
  },
  {
    id: "files/search-none", area: A, title: "Search finds nothing", url: "/files",
    check: ["Type: zzzz → says nothing found, suggests what to try", "One letter says to type at least 2"],
  },
  {
    id: "files/search-many", area: A, title: "Search with thousands of matches", url: "/files",
    seed: (w) => { blank(w); addMany(w, "d1", "Reports", 1500, { name: (i) => `report ${i}.txt` }); fsOpts(w).search.limit = 100; },
    check: ["Type: report → list is capped and says there are more", "Scrolling stays smooth", "Narrowing the query shrinks the list"],
  },
  {
    id: "files/search-slow", area: A, title: "Search is slow", url: "/files",
    seed: (w) => { demo(w); fsOpts(w).search.delayMs = 6000; },
    check: ["Spinner shows while waiting", "Typing more cancels the old search; old answers don't flash up late"],
  },
  {
    id: "files/search-error", area: A, title: "Search fails", url: "/files",
    seed: (w) => { demo(w); fsOpts(w).search.error = "Luna's index is busy. Try again."; },
    check: ["Plain message in the search box", "Closing and reopening search works"],
  },
  {
    id: "files/search-indexing", area: A, title: "Search while drives are still being scanned", url: "/files",
    seed: (w) => { demo(w); fsOpts(w).search.scanning = true; },
    check: ["A note says Luna is still looking through drives, results may be incomplete"],
  },
  {
    id: "files/search-private", area: A, title: "Search and private folders", url: "/files",
    seed: (w) => { demo(w); w.users.push(user({ id: "u2", username: "sam", display_name: "Sam" })); addFile(w, "d1", "Diary/notes mine.txt", { text: "x" }); w.fs.d1.nodes.Diary.private = true; w.fs.d1.nodes.Diary.owner = "u1"; addFile(w, "d1", "Sam/notes sams.txt", { text: "x" }); w.fs.d1.nodes.Sam.private = true; w.fs.d1.nodes.Sam.owner = "u2"; },
    check: ["Type: notes → my private file shows with a private badge", "Sam's private file never appears"],
  },
  {
    id: "files/search-drive-unplugged", area: A, title: "Search with one drive unplugged", url: "/files",
    seed: (w) => { demo(w); withBackupDrive(w); addFile(w, "d2", "notes on backup.txt", { text: "x" }); w.drives[1].state = "missing"; w.summaries.d2.mounted = false; },
    check: ["Results only come from the plugged-in drive", "No error; ideally a hint that a drive is missing"],
  },

  // ── Viewers ───────────────────────────────────────────────────────────────
  { id: "files/view-text", area: A, title: "Open a text file", url: open("notes.txt"), seed: viewerSamples, check: ["Text shows with line breaks", "Edit button is available for an Admin", "Close returns to the folder"] },
  { id: "files/view-json", area: A, title: "Open a JSON file", url: open("config.json"), seed: viewerSamples, check: ["Monospace, readable, editable"] },
  { id: "files/view-markdown", area: A, title: "Open a markdown file", url: open("readme.md"), seed: viewerSamples, check: ["Rendered heading, link and table", "Switch to editing and back", "Link opens in a new tab safely"] },
  { id: "files/view-image", area: A, title: "Open an image", url: open("photo.png"), seed: viewerSamples, check: ["Image shows in the viewer", "Full-screen button works, Esc leaves", "Next/previous pictures in the folder (if offered)"] },
  { id: "files/view-pdf", area: A, title: "Open a PDF", url: open("paper.pdf"), seed: viewerSamples, check: ["Page renders", "Download works"] },
  {
    id: "files/view-video", area: A, title: "Open a video", url: open("clip.mp4"), seed: viewerSamples,
    check: ["Video player appears with controls", "NOTE: the fake can't stream real video, so the player may show its own 'can't play' notice — judge only the frame, title and buttons"],
  },
  {
    id: "files/view-audio", area: A, title: "Open an audio file", url: open("song.mp3"), seed: viewerSamples,
    check: ["Audio player appears", "NOTE: the fake has no real audio, judge layout only"],
  },
  { id: "files/view-epub", area: A, title: "Open an e-book (epub)", url: open("novel.epub"), seed: viewerSamples, check: ["Reader opens or explains why it can't (the fake file is not a real book — a clear error is the right outcome)"] },
  { id: "files/view-csv", area: A, title: "Open a CSV table", url: open("table.csv"), seed: viewerSamples, check: ["Shows as a table, quoted comma stays in one cell", "Header row is distinct", "Wide tables scroll sideways inside the viewer"] },
  { id: "files/view-unknown", area: A, title: "Open a file Luna can't preview", url: open("mystery.dat"), seed: viewerSamples, check: ["Says it can't be shown and offers Download", "No blank frame"] },
  { id: "files/view-missing", area: A, title: "Open a file that was just deleted", url: "/files/d1?path=Documents&file=ghost.txt", check: ["Says the file isn't here anymore", "Doesn't spin forever"] },
  {
    id: "files/view-load-error", area: A, title: "File contents fail to load", url: open("notes.txt"), seed: viewerSamples,
    faults: [{ match: "GET /api/v1/drives/d1/files/content", mode: "500", message: "Luna couldn't read this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in." }],
    check: ["Plain error with a way to retry or close", "Editor does not open on an empty document"],
  },
  {
    id: "files/view-load-slow", area: A, title: "File contents load slowly", url: open("notes.txt"), seed: viewerSamples,
    faults: [{ match: "GET /api/v1/drives/d1/files/content", mode: "slow:8000" }],
    check: ["Loading screen, then a still-working notice", "Closing during loading is clean"],
  },
  {
    id: "files/view-garbled", area: A, title: "Image bytes that aren't an image", url: open("photo.png"),
    seed: (w) => { viewerSamples(w); w.fs.d1.nodes["Viewers/photo.png"].sample = "bin"; },
    check: ["Viewer shows a broken-image message in words, not a broken-icon"],
  },

  // ── Editors ───────────────────────────────────────────────────────────────
  { id: "files/edit-text-save", area: A, title: "Edit and save a text file", url: open("notes.txt"), seed: viewerSamples, check: ["Type something: 'unsaved' indicator shows", "Save (button and Ctrl+S) → 'Saved just now'", "Close and reopen: change is there", "Autosave kicks in after a pause"] },
  {
    id: "files/edit-text-conflict", area: A, title: "Save conflict (file changed meanwhile)", url: open("notes.txt"), seed: viewerSamples,
    faults: [{ match: "POST /api/v1/drives/d1/files/upload", mode: "409", code: "exists", message: "A file with this name is already here. Rename it or choose another." }],
    check: ["Edit and press Save → conflict explained in plain words", "Your text is NOT lost; you can copy it", "Closing asks before throwing away unsaved work"],
  },
  {
    id: "files/edit-text-save-error", area: A, title: "Save fails (server error)", url: open("notes.txt"), seed: viewerSamples,
    faults: [{ match: "POST /api/v1/drives/d1/files/upload", mode: "500", message: "Luna couldn't save this file. Check that the drive is connected and try again." }],
    check: ["Edit, Save → error shown, still marked unsaved", "Autosave retries without a flood of messages", "Remove the fault, Save works"],
  },
  {
    id: "files/edit-text-save-full", area: A, title: "Save on a full drive", url: open("notes.txt"),
    seed: (w) => { viewerSamples(w); w.summaries.d1 = summary("d1", { free_bytes: 0 }); },
    check: ["Edit, Save → 'drive is full' in words", "Text stays in the editor"],
  },
  {
    id: "files/edit-text-readonly-drive", area: A, title: "Open a text file on a read-only drive", url: open("notes.txt"),
    seed: (w) => { viewerSamples(w); w.drives[0].state = "readonly"; },
    check: ["No Edit button, or it explains why", "Reading works"],
  },
  { id: "files/edit-markdown", area: A, title: "Edit markdown with preview", url: open("readme.md"), seed: viewerSamples, check: ["Toolbar bold/italic/list work", "Table editing works", "Read mode and edit mode show the same text"] },
  {
    id: "files/edit-office", area: A, title: "Open a Word document", url: open("report.docx"), seed: viewerSamples,
    realLunadOnly: "The document editor (EuroOffice) needs the real lunad office service; the fake answers 'not available'.",
    check: ["Shows a clear message that the editor isn't available, not an endless spinner", "Download still works"],
  },
  {
    id: "files/edit-spreadsheet", area: A, title: "Open a spreadsheet", url: open("sheet.xlsx"), seed: viewerSamples,
    realLunadOnly: "Needs the real office service; the fake only exercises the unavailable path.",
    check: ["Same 'editor not available' message as the Word document"],
  },
  {
    id: "files/edit-diagram", area: A, title: "Open a diagram (draw.io)", url: open("sketch.drawio"), seed: viewerSamples,
    realLunadOnly: "draw.io and its save flow need the real lunad; the fake can't host the editor.",
    check: ["Loads or explains clearly why not"],
  },
  {
    id: "files/edit-whiteboard-collab", area: A, title: "Whiteboard with two people", url: open("board.whiteboard"), seed: viewerSamples,
    realLunadOnly: "Live co-editing uses the collab WebSocket; the fake closes it at once.",
    check: ["Whiteboard opens alone", "Banner or state says live editing isn't connected rather than failing silently"],
  },
  {
    id: "files/edit-collab-socket", area: A, title: "Text file when live editing can't connect", url: open("notes.txt"), seed: viewerSamples,
    check: ["The fake always refuses the live-editing socket: editing alone should still work", "No scary error for the lost connection"],
  },

  // ── Who is looking ────────────────────────────────────────────────────────
  {
    id: "files/member-full", area: A, title: "Member with full access to Documents", url: "/files",
    seed: (w) => { demo(w); asMember(w, [{ kind: "path", drive_id: "d1", path: "Documents", caps: "full" }]); },
    check: ["Only Documents (and below) is reachable; the drive root isn't", "Can create, rename, delete, upload inside", "Trash is available for the drive"],
  },
  {
    id: "files/member-view-only", area: A, title: "Member who can only look", url: "/files/d1?path=Documents",
    seed: (w) => { demo(w); asMember(w, [{ kind: "path", drive_id: "d1", path: "Documents", caps: "view" }]); },
    check: ["No New, upload, rename, delete or move", "Open and download work", "Trying the keyboard shortcuts doesn't change anything"],
  },
  {
    id: "files/member-upload-only", area: A, title: "Member with a drop box (upload only)", url: "/files/d1?path=Documents",
    seed: (w) => { demo(w); asMember(w, [{ kind: "path", drive_id: "d1", path: "Documents", caps: "upload" }]); },
    check: ["Can add files but not see or download what's there", "Empty-looking list explains this is a drop box"],
  },
  {
    id: "files/member-no-grant", area: A, title: "Member with no access to this drive", url: "/files/d1",
    seed: (w) => { demo(w); asMember(w, []); },
    check: ["Friendly 'ask an Admin' message, not a blank page or raw 403", "Files page lists nothing they can't open"],
  },
  {
    id: "files/member-deep-link", area: A, title: "Member opens a link above their folder", url: "/files/d1?path=Photos",
    seed: (w) => { demo(w); asMember(w, [{ kind: "path", drive_id: "d1", path: "Documents", caps: "full" }]); },
    check: ["Not blank: explains they can't open Photos", "No way to climb above Documents"],
  },
  {
    id: "files/member-file-only", area: A, title: "Member shared a single file", url: "/files/d1?path=Documents%2Fnotes.txt",
    seed: (w) => { demo(w); asMember(w, [{ kind: "path", drive_id: "d1", path: "Documents/notes.txt", caps: "view" }]); },
    check: ["The file is the whole world: opens and reads, no folder around it"],
  },
  {
    id: "files/session-dies-in-files", area: A, title: "Session ends while browsing files", url: "/files/d1?path=Documents",
    check: ["Faults: Expire session, then open a folder", "Sign-in form appears in place; after signing in you are back in the same folder"],
  },

  // ── Screen sizes and looks ────────────────────────────────────────────────
  { id: "files/look-phone", area: A, title: "Browsing on a phone", url: "/files/d1?path=Documents", viewport: "phone", check: ["Rows are tappable, actions in a menu", "Upload panel and dialogs fit the screen", "Nothing scrolls sideways", "Back gesture/crumbs work"] },
  { id: "files/look-tablet", area: A, title: "Browsing on a tablet", url: "/files/d1?path=Documents", viewport: "tablet", check: ["Layout uses the width sensibly", "Dialogs are not stretched edge to edge"] },
  { id: "files/look-dark", area: A, title: "Dark mode file list", url: "/files/d1?path=Documents", theme: "dark", check: ["Row text, badges and buttons all readable", "Selected row clearly different"] },
  {
    id: "files/look-phone-viewer", area: A, title: "Viewing a file on a phone", url: open("readme.md"), seed: viewerSamples, viewport: "phone",
    check: ["Viewer fills the screen with a visible close button", "Toolbar wraps or scrolls, nothing cut off"],
  },
  {
    id: "files/look-phone-trash", area: A, title: "Trash on a phone", url: "/files/d1?path=.luna-trash", viewport: "phone",
    seed: (w) => { demo(w); trashed(w, "a long file name that will need to wrap on a narrow screen.txt", "Documents"); trashed(w, "b.txt"); },
    check: ["Restore and delete are reachable by touch", "Original-location text wraps cleanly"],
  },
];
