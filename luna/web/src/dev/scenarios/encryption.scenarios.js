// Password-protected drives: locked and unlocked cards, the unlock prompt, the
// Encryption sheet, Protect and Remove protection (both hand off to the
// one erase window), adding an encrypted drive, the dashboard notice and paused
// backups. Handlers live in ../fake/handlers/crypt.js (and format.js for the erase).
//
// The password that opens a drive in these scenarios is correct-horse-1 unless
// a scenario says otherwise. Five wrong tries lock a person out of one drive.
import { backup, drive, summary, user, DEFAULT_NOW } from "../fake/world.js";
import { encryptDrive } from "../fake/handlers/crypt.js";

const A = "Encryption";
const GB = 1_000_000_000;
const SHEET = "Open Encryption from the card's three-dot button";

const second = (w) => {
  w.drives.push(drive({ id: "d2", label: "Backup drive" }));
  w.summaries.d2 = summary("d2", { total_bytes: 128 * GB, free_bytes: 100 * GB, used_bytes: 28 * GB, shortcuts: [] });
  w.fs = { ...(w.fs || {}), d2: { nodes: {}, trash: [] } };
};
/** A Member with a grant to d1, without taking over the gallery's session —
 * "Sign in as" can then try the same drive with their own fresh try count. */
const addMember = (w) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
  w.access = [
    ...(w.access || []),
    { id: "g1", user_id: "u2", kind: "path", drive_id: "d1", drive_label: "Family photos", path: "Photos", caps: "view" },
  ];
};
const asMember = (w) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
  w.sessionUserId = "u2";
  w.access = [{ id: "g1", user_id: "u2", kind: "path", drive_id: "d1", drive_label: "Family photos", path: "Photos", caps: "view" }];
};
const vault = (extra = {}) => ({
  name: "sdq", model: "Samsung portable SSD", size_bytes: 500 * GB, fs_type: "crypto_LUKS", readable: false, encrypted: true,
  volume_label: "Family vault", entries: [], ...extra,
});
const at = (s) => Math.floor(DEFAULT_NOW / 1000) - s;

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── Locked drives ─────────────────────────────────────────────────────────
  {
    id: "encryption/locked-card", area: A, title: "A locked drive's card (Admin)", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: ["Pill says Locked, with a lock icon", "The card says it is locked and asks for the password: no storage bar, no Open, no Eject", "Encryption is in the card's three-dot button", "The right password (correct-horse-1) opens it: one toast, card turns Ready with Open"],
  },
  {
    id: "encryption/locked-card-dark", area: A, title: "A locked drive's card, dark", url: "/files", theme: "dark",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: ["Every word on the card reads clearly", "The password field, eye button and Unlock button are all visible against the card"],
  },
  {
    id: "encryption/locked-file-page", area: A, title: "Open a locked drive straight from a link", url: "/files/d1",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: ["The page says This drive is locked and asks for the password, not Can't open", "Unlocking shows the files without leaving the page"],
  },
  {
    id: "encryption/locked-member", area: A, title: "A Member whose shared drive is locked", url: "/files",
    seed: (w) => { asMember(w); encryptDrive(w, "d1"); },
    check: ["The shared folder's card says the drive is locked and asks for the password: a Member may unlock", "No Encryption, Lock, Eject or Remove anywhere", "After unlocking, Open appears"],
  },
  {
    id: "encryption/locked-member-dashboard", area: A, title: "Dashboard for a Member: drive locked", url: "/",
    seed: (w) => { asMember(w); encryptDrive(w, "d1"); },
    check: ["The drive card says Locked and has the password prompt", "A Needs you row says the drive is locked and its button goes to the drive, where the prompt is", "Unlocking clears both"],
  },
  // ── Wrong passwords ───────────────────────────────────────────────────────
  {
    id: "encryption/wrong-password", area: A, title: "Wrong password", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: ["A wrong password shakes the field and says That password didn't work, under the field", "No toast", "Typing again clears the message", "The fifth wrong try says to wait a few minutes", "After that even the right password is refused: Too many wrong tries"],
  },
  {
    id: "encryption/too-many-tries", area: A, title: "Already locked out after wrong tries", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); addMember(w); w.unlockTries = { "u1:d1": { count: 5, until: Math.floor(Date.now() / 1000) + 300 } }; },
    check: ["Any password, even the right one, says Too many wrong tries. Wait a few minutes, with no shake", "The message gives no clock, because Luna doesn't send one", "Sign in as Sam (Member): the same drive has a fresh try count, so the right password opens it for them"],
  },
  {
    id: "encryption/unlock-busy", area: A, title: "Unlock refused: Luna is working on the drive", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); },
    faults: [{ match: "POST /api/v1/drives/d1/unlock", mode: "409", code: "drive_busy", message: "Luna is already working on this drive. Wait until it finishes." }],
    check: ["The message shows under the field with no shake and no toast", "The password stays typed so they can try again"],
  },
  // ── The Encryption sheet ─────────────────────────────────────────
  {
    id: "encryption/sheet-plain", area: A, title: "Sheet on a drive with no password", url: "/files",
    check: [SHEET, "It says Not protected and that anyone who plugs the drive into a computer can read it", "Protect with a password is the one button; the line under it says it erases the drive first", "No Lock, Change password or Remove protection"],
  },
  {
    id: "encryption/protect-plain-drive", area: A, title: "Protect a plain drive with a password", url: "/files",
    check: [SHEET, "Protect with a password asks for a password twice, with the strength chips and one plain warning that there is no way to get it back", "Too short, or two different entries: an inline message and a shake, nothing sent", "Continue opens the erase window with the drive's real contents, a 30 second countdown, and the line about the password", "Erase drive → steps (including protecting with the password) → Drive is ready → Open drive", "The card turns to Ready, and the sheet now says Protected · Unlocked", "Lock it, then unlock with the new password (not correct-horse-1)"],
  },
  {
    id: "encryption/sheet-unlocked", area: A, title: "Sheet on a protected, unlocked drive", url: "/files",
    seed: (w) => { encryptDrive(w, "d1", { locked: false }); },
    check: [SHEET, "Pill says Protected · Unlocked", "Lock, Change password and Remove protection (the caution button) are offered", "Lock closes the drive: one toast, the card turns Locked, and the sheet now shows the unlock prompt instead of Lock"],
  },
  {
    id: "encryption/sheet-locked", area: A, title: "Sheet on a locked drive", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: [SHEET, "Pill says Protected · Locked and the sheet has the password prompt", "No Lock button", "Change password and Remove protection are still there"],
  },
  {
    id: "encryption/lock-busy", area: A, title: "Lock refused: files are open", url: "/files",
    seed: (w) => { encryptDrive(w, "d1", { locked: false }); w.drives[0].lockBusy = true; },
    check: [SHEET, "Lock shows Something is still using this drive, inline in the sheet, and no toast", "The drive stays unlocked"],
  },
  {
    id: "encryption/change-password", area: A, title: "Change the password", url: "/files",
    seed: (w) => { encryptDrive(w, "d1", { locked: false }); },
    check: [SHEET, "Change password asks for the current one, then the new one twice", "A wrong current password (not correct-horse-1) shakes under its field", "A short or mismatched new password is refused in the sheet before anything is sent", "A good change (brand-new-pass-2) gives one toast and returns to the sheet", "Lock, then unlock: only the new password works"],
  },
  {
    id: "encryption/remove-protection", area: A, title: "Remove protection (erases the drive)", url: "/files",
    seed: (w) => { encryptDrive(w, "d1", { locked: false }); },
    check: [SHEET, "Remove protection says plainly that it erases everything on the drive and can't be undone", "The caution button is Remove protection and erase; Back returns to the sheet", "The erase window lists the drive's own folders and files (it is unlocked) and waits 30 seconds", "After it finishes the card is Ready, the sheet says Not protected, and there is no pill saying Locked"],
  },
  {
    id: "encryption/sheet-unplugged", area: A, title: "Sheet on an unplugged protected drive", url: "/files",
    seed: (w) => { encryptDrive(w, "d1"); w.drives[0].state = "missing"; },
    check: [SHEET, "It says to plug the drive in; every button is disabled", "No password prompt"],
  },
  // ── Adding a drive ────────────────────────────────────────────────────────
  {
    id: "encryption/add-encrypted", area: A, title: "Add a protected drive Luna hasn't added", url: "/files",
    seed: (w) => { w.detected = [vault()]; },
    check: ["The card says Protected with a password and Add drive is enabled", "Add drive asks for the password with Unlock and add, and no Add this drive button", "A wrong password shakes inline; the right one (correct-horse-1) adds it: one toast, the card is gone, the drive is Ready", "No sentence says Luna can't open encrypted drives"],
  },
  {
    id: "encryption/add-encrypted-forgotten", area: A, title: "Forgot the password: erase and start over", url: "/files",
    seed: (w) => { w.detected = [vault({ password: "something-else-9" })]; },
    check: ["Add drive shows the prompt and, under it, Don't know the password? There is no way to get it back", "Erase and start over opens the erase window (inside this task), 30 second wait, the part shown as locked", "After it finishes the drive is Ready and plain"],
  },
  {
    id: "encryption/add-blank-protect", area: A, title: "Blank drive: protect it while adding", url: "/files",
    seed: (w) => { w.detected = [{ name: "sdb", model: "Blank USB stick", size_bytes: 32 * GB, fs_type: null, readable: false, needs_setup: true, entries: [] }]; },
    check: ["Add drive offers Erase and Erase & Encrypt, each with an info hint", "Erase & Encrypt asks for the password twice, with the no-recovery warning, inside the window", "Continue closes it and opens the one erase window with the password (no wait: the drive is blank)", "Done: the drive is Ready and Encryption says Protected · Unlocked. Nothing was erased twice"],
  },
  {
    id: "encryption/add-readable-no-protect", area: A, title: "A readable drive is added as it is", url: "/files",
    seed: (w) => { w.detected = [{ name: "sdb", model: "SanDisk USB stick", size_bytes: 32 * GB, fs_type: "exfat", readable: true, entries: [{ kind: "folder", name: "Photos" }] }]; },
    check: ["Add drive offers Add this drive only: no Erase or Erase & Encrypt, because adding changes nothing on it", "Afterwards the card's Encryption offers Protect with a password"],
  },
  // ── Dashboard and backups ─────────────────────────────────────────────────
  {
    id: "encryption/dashboard-two-locked", area: A, title: "Dashboard: two drives locked, backups paused", url: "/",
    seed: (w) => {
      second(w);
      encryptDrive(w, "d1"); encryptDrive(w, "d2");
      w.backups = [backup({ source_drive: "d1", source_drive_name: "Family photos", target_drive: "d2", target_drive_name: "Backup drive", last_ok_at: at(3600) })];
    },
    check: ["A Needs you row says 2 drives are locked, so backups are paused, and names both", "Its button goes to Files, where each card asks for its password", "The backups line says 1 backup is paused, not All backed up", "See all backups: the backup says Paused until Family photos and Backup drive are unlocked", "No separate backup didn't finish row"],
  },
  {
    id: "encryption/dashboard-one-locked", area: A, title: "Dashboard: one drive locked, no backups", url: "/",
    seed: (w) => { encryptDrive(w, "d1"); },
    check: ["The row names the drive and says it is locked, without claiming backups are paused (there are none)", "The drive card has the password prompt", "Unlocking clears the row"],
  },
  {
    id: "encryption/paused-backups", area: A, title: "Backups list while a drive is locked", url: "/files",
    seed: (w) => {
      second(w);
      encryptDrive(w, "d1", { locked: false }); encryptDrive(w, "d2", { locked: false });
      w.backups = [backup({ source_drive: "d1", source_drive_name: "Family photos", target_drive: "d2", target_drive_name: "Backup drive", last_ok_at: at(3600) })];
    },
    check: ["Lock the Backup drive from its Encryption sheet", "Open Back up on Family photos: the backup says Paused, with Paused until Backup drive is unlocked", "Back up now says Paused until Backup drive is unlocked", "Unlock the drive: the backup is back to normal"],
  },
  {
    id: "encryption/backup-to-plain-refused", area: A, title: "Back up a protected drive to a plain one", url: "/files",
    seed: (w) => { second(w); encryptDrive(w, "d1", { locked: false }); },
    check: ["Open Back up on the protected drive and choose the plain Backup drive", "The sheet shows Luna's own message: back up an encrypted drive only to an encrypted drive", "No backup was created", "Protect the Backup drive first (Encryption → Protect), then the backup is accepted"],
  },
  {
    id: "encryption/backup-to-locked-refused", area: A, title: "Back up to a locked drive", url: "/files",
    seed: (w) => { second(w); encryptDrive(w, "d2"); },
    check: ["Open Back up on Family photos and choose the locked Backup drive", "The message says Unlock Backup drive first, then try again", "Unlock it and the backup is accepted"],
  },
  // ── Who may do what ───────────────────────────────────────────────────────
  {
    id: "encryption/member-cannot-manage", area: A, title: "A Member can't lock or change protection", url: "/files",
    seed: (w) => { asMember(w); encryptDrive(w, "d1", { locked: false }); },
    check: ["The Member's Files page has no Encryption, Lock or Remove", "Sign in as Admin: the card has Encryption", "Sign in as Sam, then use Break things → Send request with POST /api/v1/drives/d1/lock: the fake answers Only an Admin can lock this drive"],
  },
];
