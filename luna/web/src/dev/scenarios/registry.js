// Scenarios live in *.scenarios.js files next to each other, one per product area,
// so areas can be filled in independently. Each file default-exports an array of
// scenario objects. See README.md for the shape and the axes to cover.
/** @type {Record<string, { default?: Scenario[] }>} */
const modules = /** @type {any} */ (import.meta.glob("./*.scenarios.js", { eager: true }));

/** @typedef {{
 *   id: string, area: string, title: string,
 *   how?: string[],              // step-by-step instructions the gallery shows
 *   reviewOrder?: number,        // temporary ordering inside the review category
 *   check?: string[],            // what the tester should look for
 *   url?: string,                // start route, default "/"
 *   seed?: (world: any) => void, // edits the base world
 *   faults?: Array<{ match: string, mode: string, message?: string, code?: string, once?: boolean, on?: boolean }>,
 *   now?: number,                // frozen start time (ms)
 *   offline?: boolean, latency?: number,
 *   restart?: number,           // lunad is down for this many ms from the start (as after an update)
 *   viewport?: "phone" | "tablet" | "desktop",
 *   theme?: "light" | "dark",
 *   realLunadOnly?: string,      // set when a fake can't stand in (office editors, ...)
 * }} Scenario */

// TEMPORARY review grouping for the 2026-11-06 issue sweep. Delete this block
// and the map in `scenarios` below once the review pass is done — the
// scenarios go back to their real areas.
const REVIEW_AREA = "Review: 2026-11-06";
const REVIEW_ORDER = [
  // Drive encryption
  "files/encryption",
  "files/encryption-locked",
  // Health, shared page, folder upload and speed
  "files/health-unknown",
  "shared/loading",
  "shared/many",
  "files/upload-folder",
  "files/open-close-speed",
  "dashboard/member-calm",
  // Recovery phrase, Connect and the recovery file
  "settings/phrase-not-set",
  "settings/phrase-24-words",
  "settings/phrase-check-wrong",
  "settings/phrase-set-check-due",
  "settings/phrase-change",
  "settings/phrase-change-exposed",
  "settings/phrase-lost-exposed",
  "settings/phrase-lost",
  "settings/phrase-resealing",
  "settings/phrase-moving",
  "settings/phrase-moving-full",
  "auth/member-needs-phrase",
  "recovery/create",
  "recovery/phone-dark",
  // Updates, users and private folders
  "settings/update-source",
  "settings/update-source-lan-feed",
  "settings/users-many",
  "settings/users-orphans",
  "files/private-ownerless",
  "settings/edit-user",
  "settings/edit-user-self",
  "settings/edit-user-save-fails",
  "settings/edit-user-phone",
  "auth/member",
  // Sharing
  "share/many-people",
  "share/links-all-states",
  // Editors
  "files/edit-markdown",
  "files/edit-form",
  "files/edit-form-collab",
  "public/file-edit",
  // Luna Connect and backup
  "settings/cloud-backups",
  "settings/cloud-no-card",
  "settings/cloud-run-fails",
  "settings/restore-needed",
  "settings/restore-private-needed",
  // Appearance and photos
  "settings/appearance",
  "gallery/segment-motion",
];
const REVIEW_IDS = new Set(REVIEW_ORDER);

const REVIEW_HOW = /** @type {Record<string, string[]>} */ ({
  "settings/update-source": [
    "Open Settings → About.",
    "Under Advanced, switch Stable → Beta and back.",
    "Press Edit update source; try a bad address and a bad signing key, then close.",
  ],
  "settings/update-source-lan-feed": [
    "Open Settings → About; the seeded feed is a network address.",
    "Under Advanced, switch Stable → Beta.",
    "Confirm no private-network error appears and the address is unchanged.",
  ],
  "settings/users-many": [
    "Open Settings → Users.",
    "Press Add user and look at the space above the Role row.",
    "Remove a person and confirm the dialog.",
  ],
  "settings/users-orphans": [
    "Open Settings → Users.",
    "Read the removed-people rows; try Delete for Alex and Kit.",
    "In the ownerless card, give Imported A to Sam, then give Imported B.",
  ],
  "settings/edit-user": [
    "Open Settings → Users.",
    "Click Sam's row or pencil.",
    "Change name, role and password; save, reopen, then remove.",
  ],
  "settings/edit-user-self": [
    "Open Settings → Users.",
    "Click your own row or pencil.",
    "Expect Settings → Security, not an edit modal; there is no Remove action.",
  ],
  "settings/edit-user-save-fails": [
    "Open Settings → Users and open Sam's edit modal.",
    "Change something and save; the fake returns 500.",
    "Check the error stays in the modal, then cancel and reopen.",
  ],
  "settings/edit-user-phone": [
    "Use the phone viewport.",
    "Open Settings → Users and Sam's modal.",
    "Scroll the modal; save and cancel.",
  ],
  "files/private-ownerless": [
    "Open Settings → Users.",
    "Give Imported A to Sam; reload and confirm Imported B remains.",
    "Give Imported B too; the card goes away.",
  ],
  "settings/appearance": [
    "Open Settings → Appearance.",
    "Enable custom colours; pick a preset; edit a colour row.",
    "Press Reset to default.",
  ],
  "settings/cloud-backups": [
    "Open Settings → Luna Connect.",
    "Run the first backup; use Run anyway for the missing folder; check Taxes; delete one.",
  ],
  "settings/cloud-no-card": [
    "Open Settings → Luna Connect with no card on file.",
    "Read the cloud backup card and the public address.",
  ],
  "settings/cloud-run-fails": [
    "Open Settings → Luna Connect and run a backup.",
    "Check the failure stays on the cloud backup card.",
  ],
  "settings/phrase-not-set": [
    "Open Settings → Luna Connect with no phrase.",
    "Press Set up; read the 12/24 explanation; save.",
    "Confirm the dialog closes and the card says Ready.",
  ],
  "settings/phrase-check-wrong": [
    "Open Settings → Luna Connect → Check.",
    "Enter wrong words; confirm the inline refusal and retry.",
  ],
  "settings/restore-needed": [
    "Open Settings → Luna Connect when restore is needed.",
    "Follow the restore card's steps.",
  ],
  "settings/restore-private-needed": [
    "Open Settings → Luna Connect when the private restore list is lost.",
    "Follow the restore card and choose the scope.",
  ],
  "settings/phrase-24-words": [
    "Open Settings → Luna Connect → Check for the 24-word phrase.",
    "Confirm 24 boxes and no 12/24 switch.",
  ],
  "settings/phrase-set-check-due": [
    "Open Settings → Luna Connect; the check is due.",
    "Press Check now and complete the words.",
  ],
  "settings/phrase-change": [
    "Open Settings → Luna Connect → Change.",
    "Enter the old phrase and a new one; save.",
  ],
  "settings/phrase-change-exposed": [
    "Open Settings → Luna Connect → Change because someone may have it.",
    "Follow the warning and the optional delete of older versions.",
  ],
  "settings/phrase-lost-exposed": [
    "Open Settings → Luna Connect → Lost phrase.",
    "Choose that someone may have it, then follow the replacement.",
  ],
  "settings/phrase-lost": [
    "Open Settings → Luna Connect → Lost phrase.",
    "Choose that nobody else has it and set a new phrase.",
  ],
  "settings/phrase-resealing": [
    "Open Settings → Luna Connect after a phrase change.",
    "Watch the moving note and progress on the phrase card.",
  ],
  "settings/phrase-moving": [
    "Open Settings → Luna Connect while backups move.",
    "Watch the progress, leave, and come back.",
  ],
  "settings/phrase-moving-full": [
    "Open Settings → Luna Connect with Connect storage full.",
    "Read the paused note and what to do.",
  ],
  "auth/member-needs-phrase": [
    "Sign in as the Member who has no phrase.",
    "Open Home and Settings → Luna Connect.",
    "Confirm there is no phrase gate; the card says Not set up.",
  ],
  "dashboard/member-calm": [
    "Sign in as a Member.",
    "Open Home; check the drive column heading and the Needs you area.",
  ],
  "auth/member": [
    "Sign in as a Member.",
    "Open Home and Settings; check admin cards and categories are hidden.",
  ],
  "files/health-unknown": [
    "Open the seeded drive's Files page.",
    "Look for any drive-health section, pill or notice.",
  ],
  "files/upload-folder": [
    "Open Files → Documents → Upload.",
    "Pick a folder, then pick an empty folder.",
    "Drag a folder with subfolders in; watch the file card.",
  ],
  "files/edit-markdown": [
    "Open readme.md from Viewers.",
    "Edit text and the table; use Share in the sidebar.",
  ],
  "files/edit-form": [
    "Open rsvp.lunaform from Viewers.",
    "Edit the title and a question; save; open Responses.",
  ],
  "files/edit-form-collab": [
    "Needs real Luna. Open rsvp.lunaform as two people.",
    "Click into question 1 in one window, then question 2 in the other.",
  ],
  "files/open-close-speed": [
    "Open the Big folder (5,000 files).",
    "Open notes.txt and close it five times.",
    "Watch scroll position and selection after each close.",
  ],
  "files/encryption": [
    "Open Files and press Encryption on Family photos.",
    "Encrypt; enter the password twice; confirm the wipe; wait for the finish.",
  ],
  "files/encryption-locked": [
    "Open Files and Encryption on the locked drive.",
    "Try a wrong password, then the right one.",
  ],
  "shared/many": [
    "Open Shared with lots of rows.",
    "Hover rows; press /; search; switch tabs.",
  ],
  "shared/loading": [
    "Open Shared while the access request is slow.",
    "Watch the loader, then the content arrive.",
  ],
  "public/file-edit": [
    "Needs real Luna. Open a full text-file link.",
    "Edit, save, close and reopen; open a second window for presence.",
  ],
  "recovery/create": [
    "Open /recover.",
    "Choose an account; toggle the device token; set the passwords; download.",
    "Open How to use the recovery file.",
  ],
  "recovery/phone-dark": [
    "Open /recover on a phone in dark mode.",
    "Scroll the card; check every field and the download button.",
  ],
  "share/many-people": [
    "Open Shared → Manage sharing, then open a sharing sheet with people and links.",
    "Check the People names use the mono font; check each link's copy button says Copy link.",
  ],
  "share/links-all-states": [
    "Open a sharing sheet with links in different states (open, password, expired).",
    "Check every link row's copy button says Copy link.",
  ],
  "gallery/segment-motion": [
    "Open Photos.",
    "Switch Library → Albums → Places → Favorites and back.",
    "Open an album; try Reduce Motion.",
  ],
});

/** @type {Scenario[]} */
export const scenarios = Object.values(modules)
  .flatMap((m) => m.default || [])
  .map((s) => (REVIEW_IDS.has(s.id)
    ? { ...s, area: REVIEW_AREA, reviewOrder: REVIEW_ORDER.indexOf(s.id), ...(REVIEW_HOW[s.id] ? { how: REVIEW_HOW[s.id] } : {}) }
    : s))
  // Temporary: the review category leads, in the order its instructions are
  // written. Everything else keeps its original order.
  .sort((a, b) => (a.reviewOrder ?? Number.MAX_SAFE_INTEGER) - (b.reviewOrder ?? Number.MAX_SAFE_INTEGER))
  .map((s) => ({ url: "/", check: [], ...s }));

const seen = new Set();
for (const s of scenarios) {
  if (seen.has(s.id)) throw new Error(`Duplicate scenario id: ${s.id}`);
  seen.add(s.id);
}

export const scenarioById = (id) => scenarios.find((s) => s.id === id);
