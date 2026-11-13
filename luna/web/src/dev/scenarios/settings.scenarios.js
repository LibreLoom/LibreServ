import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { cloudBackup, DAY, DEFAULT_NOW, drive, HOUR, summary, user } from "../fake/world.js";
import { addDir } from "../fake/handlers/files.js";

const at = (s) => Math.floor(DEFAULT_NOW / 1000) - s;

/** Luna's signing public key, base64, the right length for the replace flow to build keys. */
const SIGNING_PUBLIC = btoa(String.fromCharCode(...new Uint8Array(SIG_PUBLIC_LEN).fill(7)));

/** A phrase that is set and checked, with Luna's signing key present so a replacement can be built. */
const setPhrase = (w, extra = {}) => {
  w.connect = { enabled: true, connect_active: true, card_on_file: true };
  w.connectActive = true;
  w.cloudBackups = [cloudBackup()];
  w.phrase = { set: true, set_at: at(90 * DAY), luna_id: "luna-1", signing_public: SIGNING_PUBLIC, check_due: false, last_checked_at: at(DAY), ...extra };
};

const asMember = (w) => {
  w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
  w.sessionUserId = "u2";
};
const withPeople = (w) => {
  w.users.push(
    user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }),
    user({ id: "u3", username: "robin", display_name: "Robin", role: "user" }),
  );
};

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── Users ─────────────────────────────────────────────────────────────────
  {
    id: "settings/users-many",
    area: "Settings: Users",
    title: "Several people, add and remove",
    url: "/settings#users",
    seed: withPeople,
    check: [
      "Add a user with a short password (under 12) and see the rule explained",
      "Add one named 'max' and see 'username is taken'",
      "Add a good one and it appears in the list", "The Role row has breathing room above it, not jammed under Password",
      "Removing someone asks first and then removes them",
    ],
  },
  {
    id: "settings/users-private-folders",
    area: "Settings: Users",
    title: "Removing someone who has private folders",
    url: "/settings#users",
    seed: (w) => { withPeople(w); w.privateCounts = { u2: 3 }; },
    check: ["Confirm dialog says 3 private folders stay hidden on the drives", "After removing, the left-behind folders show in the cleanup list only if listed"],
  },
  {
    id: "settings/users-orphans",
    area: "Settings: Users",
    title: "Private folders left by removed people",
    url: "/settings#users",
    seed: (w) => {
      withPeople(w);
      w.deletedUsers.push(
        { id: "gone1", username: "alex", display_name: "Alex", deleted_at: at(9 * DAY) },
        { id: "gone2", username: "kit", display_name: "", deleted_at: at(30 * DAY) },
      );
      // Alex left three private folders on Family photos and one in its Trash.
      for (let n = 1; n <= 3; n += 1) addDir(w, "d1", `Alex private ${n}`, { private: true, owner: "gone1" });
      w.fs.d1.trash.push({ key: "1790000000-Alex old", original_path: "Alex old", trashed_at: at(5 * DAY), nodes: { "": { kind: "dir", modified: at(9 * DAY) } }, private_boundary: { path: "Alex old", owner: "gone1" } });
      // Kit's is on a read-only drive, and Old USB is unplugged.
      w.drives.push(drive({ id: "d2", label: "Backup drive", state: "readonly" }), drive({ id: "d3", label: "Old USB", state: "missing" }));
      w.summaries.d2 = summary("d2");
      w.summaries.d3 = { id: "d3", mounted: false, total_bytes: null, free_bytes: null, used_bytes: null, shortcuts: [] };
      addDir(w, "d2", "Kit private", { private: true, owner: "gone2" });
      // Two private folders nobody owns (they came with a drive from another Luna).
      addDir(w, "d1", "Imported A", { private: true });
      addDir(w, "d1", "Imported B", { private: true });
    },
    check: [
      "Two removed people listed with where their folders are (Alex: 3 folders and 1 item in Trash)",
      "Each has a Manage button; Kit's delete is disabled because the drive is read-only",
      "A line says Old USB isn't connected",
      "The ownerless card lists Imported A and Imported B, each with its own Give control; giving one leaves the other",
    ],
  },
  {
    id: "settings/users-last-admin",
    area: "Settings: Users",
    title: "Your own row is not editable",
    url: "/settings#users",
    check: [
      "Your own row has no Remove action",
      "Clicking your own row goes to Settings → Security, not an edit modal",
      "Members cannot open the Users category at all",
    ],
  },
  {
    id: "settings/users-load-fails",
    area: "Settings: Users",
    title: "User list can't load",
    url: "/settings#users",
    faults: [{ match: "GET /api/v1/users", mode: "500" }],
    check: ["A clear error with a way to retry"],
  },
  {
    id: "settings/users-delete-fails",
    area: "Settings: Users",
    title: "Removing a person fails",
    url: "/settings#users",
    seed: withPeople,
    faults: [{ match: "DELETE /api/v1/users/*", mode: "500", message: "Luna could not remove this user. Try again." }],
    check: ["The dialog shows the reason and stays open"],
  },
  // ── Edit user ─────────────────────────────────────────────────────────────
  {
    id: "settings/edit-user",
    area: "Edit user",
    title: "Editing another person",
    url: "/settings#users",
    seed: withPeople,
    check: [
      "Open the pencil (or click the row) for Sam: an Edit Sam modal opens over Settings, shaped like Add a user",
      "Name, role and password can change; a weak password is refused with the rule",
      "Saving closes the modal, returns to the list and shows a toast",
      "Remove asks first inside the same modal",
    ],
  },
  {
    id: "settings/edit-user-self",
    area: "Edit user",
    title: "Editing yourself",
    url: "/settings#users",
    seed: withPeople,
    check: [
      "Clicking your own row opens Settings → Security, not an edit modal",
      "No remove action is offered for yourself",
    ],
  },
  {
    id: "settings/edit-user-save-fails",
    area: "Edit user",
    title: "Saving a person fails",
    url: "/settings#users",
    seed: withPeople,
    faults: [{ match: "PATCH /api/v1/users/*", mode: "500", message: "Luna could not update users. Try again." }],
    check: [
      "Error shows inside the modal and typed changes stay",
      "Cancel closes the modal without changing the row",
    ],
  },
  {
    id: "settings/edit-user-phone",
    area: "Edit user",
    title: "Editing a person on a phone",
    url: "/settings#users",
    seed: withPeople,
    viewport: "phone",
    check: ["The modal fits the screen and scrolls", "Save and Cancel stay reachable", "Nothing scrolls sideways"],
  },
  // ── Security (access) ─────────────────────────────────────────────────────
  {
    id: "settings/security-account",
    area: "Settings: Security",
    title: "Change name and password",
    url: "/settings#security",
    check: ["Wrong current password (type: wrong) is explained", "Weak new password is refused with the rule", "A good change signs you out with a toast", "Display name saves"],
  },
  {
    id: "settings/security-sessions",
    area: "Settings: Security",
    title: "Sign out of every browser / app",
    url: "/settings#security",
    seed: (w) => { w.tokens = [{ id: "t1", name: "Phone app", created_at: at(5 * DAY), last_used_at: at(HOUR), expires_at: null }]; },
    check: ["Signing out of browsers ends this session too", "Signing out of apps empties the token list"],
  },
  {
    id: "settings/security-member",
    area: "Settings: Security",
    title: "Member in Security",
    url: "/settings#security",
    seed: asMember,
    check: ["Only things a Member may do are shown"],
  },
  // ── Appearance ────────────────────────────────────────────────────────────
  {
    id: "settings/appearance",
    area: "Settings: Appearance",
    title: "Appearance, light and dark",
    url: "/settings#appearance",
    check: ["Changing theme and colors applies at once", "Custom colors shows presets and three compact colour rows; Reset to default sits at the bottom", "Everything stays readable in both modes", "Choice survives Reload only if it is meant to"],
  },
  {
    id: "settings/appearance-phone",
    area: "Settings: Appearance",
    title: "Appearance on a phone",
    url: "/settings#appearance",
    viewport: "phone",
    check: ["Category list first, then the page", "Back returns to the list"],
  },
  // ── Devices & tokens ──────────────────────────────────────────────────────
  {
    id: "settings/tokens-none",
    area: "Settings: Security",
    title: "No access tokens yet",
    url: "/settings#security",
    check: ["Friendly empty state", "Create a token: shown once with a copy button and QR"],
  },
  {
    id: "settings/tokens-many",
    area: "Settings: Security",
    title: "Tokens: fresh, old, expired, long name",
    url: "/settings#security",
    seed: (w) => {
      w.tokens = [
        { id: "t1", name: "Phone app", created_at: at(30 * DAY), last_used_at: at(HOUR), expires_at: null },
        { id: "t2", name: "Old laptop script", created_at: at(400 * DAY), last_used_at: null, expires_at: at(DAY) },
        { id: "t3", name: "A token with a very long name that someone typed without thinking about the layout", created_at: at(DAY), last_used_at: at(2 * DAY), expires_at: DEFAULT_NOW / 1000 + 30 * DAY },
      ];
      w.tokenUsage = {
        t1: [{ action: "auth", detail: "api", used_at: at(HOUR), client: "Luna app 2.1", origin: "192.168.1.20" }, { action: "download", detail: "Photos", used_at: at(DAY) }],
        t3: [],
      };
    },
    check: ["Expired token is marked", "Activity opens for t1 and shows 'older activity' for the row without a client", "Revoke asks first, then the token disappears"],
  },
  {
    id: "settings/tokens-create-fails",
    area: "Settings: Security",
    title: "Creating a token with a blank name",
    url: "/settings#security",
    seed: (w) => { w.tokens = [{ id: "t1", name: "Phone app", created_at: at(DAY), last_used_at: null, expires_at: null }]; },
    check: ["An empty name is refused with \"Give this device a name between 1 and 80 characters.\" inside the dialog", "Luna allows two tokens with the same name: 'Phone app' again simply adds a second one"],
  },
  {
    id: "settings/tokens-load-fails",
    area: "Settings: Security",
    title: "Tokens can't load",
    url: "/settings#security",
    faults: [{ match: "GET /api/v1/device-tokens", mode: "500" }],
    check: ["Error is shown in place, the rest of the page works"],
  },
  // ── Cloud backup & restore ────────────────────────────────────────────────
  {
    id: "settings/connect-off",
    area: "Settings: Luna Connect",
    title: "Luna Connect is off",
    url: "/settings",
    check: [
      "Luna Connect is in the sidebar and cloud backup lives there with it, recovery phrase card included",
      "The page says Luna Connect is off and shows the recovery phrase card",
      "Settings opens on Appearance",
    ],
  },
  {
    id: "settings/cloud-backups",
    area: "Settings: Luna Connect",
    title: "Cloud backups: ok, source missing, check problem",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.cloudBackups = [
        cloudBackup({ source_name: "Documents" }),
        cloudBackup({ source_name: "Old photos", source_missing: true }),
        cloudBackup({ source_name: "Taxes", check_problem: "The cloud copy could not be read." }),
      ];
    },
    check: ["The page holds both the Luna Connect address and cloud backup", "Run now works on the first", "'Run anyway' appears only for the missing folder and then succeeds", "Check works and clears the problem", "Delete asks first", "While one backup runs, only that row's buttons show it working"],
  },
  {
    id: "settings/cloud-no-card",
    area: "Settings: Luna Connect",
    title: "Connect on but no payment card",
    url: "/settings#luna_connect",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: false }; w.connectActive = true; w.cloudBackups = [cloudBackup()]; },
    check: ["Says a card is needed before backing up, and where to add it"],
  },
  {
    id: "settings/cloud-run-fails",
    area: "Settings: Luna Connect",
    title: "Running a cloud backup fails",
    url: "/settings#luna_connect",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: true }; w.connectActive = true; w.cloudBackups = [cloudBackup()]; },
    faults: [{ match: "POST /api/v1/cloud/backups/*/run", mode: "502", message: "Luna Connect couldn't be reached. Check your internet connection and try again." }],
    check: ["Problem stays on the backup card, not a toast"],
  },
  {
    id: "settings/phrase-not-set",
    area: "Settings: Luna Connect",
    title: "No recovery phrase yet",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.phrase = { ...w.phrase, set: false };
    },
    check: [
      "Recovery phrase shows a 'Not set up' pill and a Set up button",
      "Set up opens the phrase dialog with the 12/24 switch",
      "The dialog says why someone would choose 24 words before you pick",
      "Saving closes the dialog and the card says Ready",
    ],
  },
  {
    id: "settings/phrase-check-wrong",
    area: "Settings: Luna Connect",
    title: "Recovery phrase check with the wrong words",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.cloudBackups = [cloudBackup()];
      w.phrase = { ...w.phrase, check_due: true };
      w.phraseWrong = true;
    },
    check: ["Any valid-looking 12 or 24 words are refused with a plain message", "The reminder stays until a check succeeds"],
  },
  {
    id: "settings/restore-needed",
    area: "Settings: Luna Connect",
    title: "Restore: Luna lost its list of cloud backups",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.restore = { needed: true, luna_id: "luna-1", signing_public: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", cloud_snapshots: 14, indexed_snapshots: 0 };
    },
    check: ["Restore card explains 14 versions were found", "Any 12 or 24 words are refused with 'doesn't open any backups' (the fake has none)", "Words with a typo are refused before anything is sent"],
  },
  {
    id: "settings/restore-private-needed",
    area: "Settings: Luna Connect",
    title: "Restore: private backups list lost",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.restorePrivate = { needed: true, luna_id: "luna-1", signing_public: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", scopes: 3 };
    },
    check: ["Private restore card appears with the number of private areas", "Wrong words give the 'check each word' message"],
  },
  {
    id: "settings/phrase-24-words",
    area: "Settings: Luna Connect",
    title: "Recovery phrase check for a 24-word phrase",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.cloudBackups = [cloudBackup()];
      w.phrase = { ...w.phrase, phrase_words: 24, check_due: true };
    },
    check: ["The check shows 24 boxes and no switch between 12 and 24", "Any valid 24 words pass"],
  },
  {
    id: "settings/phrase-set-check-due",
    area: "Settings: Luna Connect",
    title: "Recovery phrase check is due",
    url: "/settings#luna_connect",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.cloudBackups = [cloudBackup()];
      w.phrase = { ...w.phrase, check_due: true };
    },
    check: [
      "The recovery phrase card shows a 'Check due' pill",
      "Check is the main button on the card",
      "Check opens the check and accepts any 12 or 24 words",
    ],
  },
  {
    id: "settings/phrase-change",
    area: "Settings: Luna Connect",
    title: "Changing the phrase with the wrong old phrase",
    url: "/settings#luna_connect",
    seed: (w) => { setPhrase(w); w.phraseWrong = true; },
    check: [
      "Change phrase asks for the current phrase first",
      "Any 12 or 24 words are refused inline (That is not the recovery phrase set up on this Luna), and the dialog stays on the check",
      "Nothing is saved and no toast appears",
    ],
  },
  {
    id: "settings/phrase-change-exposed",
    area: "Settings: Luna Connect",
    title: "Changing the phrase because someone may have it",
    url: "/settings#luna_connect",
    seed: (w) => setPhrase(w),
    check: [
      "Current phrase is accepted, then 'Could someone else have your phrase?' appears",
      "'Someone may have it' says the old phrase stops working right away, that Luna moves cloud backups to the new phrase over days, and what stays open until then",
      "The Connect note appears under it, with no older-private-items line under either answer",
      "After confirming the new phrase, the toast says 'Recovery phrase changed.' and the card shows 'Updating your cloud backups to the new phrase…'",
      "A last step 'Delete older private versions?' names earlier versions and files deleted from the drive that exist only in the cloud, and says Cancel keeps them and the old phrase may still open them",
      "'Delete older versions' shows the toast 'Older private versions deleted.'; Cancel closes with nothing deleted",
    ],
  },
  {
    id: "settings/phrase-lost-exposed",
    area: "Settings: Luna Connect",
    title: "Lost phrase that may have been found",
    url: "/settings#luna_connect",
    seed: (w) => setPhrase(w),
    check: [
      "'Get a new phrase' confirm names the private items that can't be opened",
      "After 'Someone may have it', the private line says Luna removes your older private items now",
      "Asks for the Luna password, then the new phrase, then the toast 'New recovery phrase saved.'",
    ],
  },
  {
    id: "settings/phrase-lost",
    area: "Settings: Luna Connect",
    title: "Lost phrase, nobody else has it",
    url: "/settings#luna_connect",
    seed: (w) => {
      setPhrase(w, { old_phrase_copies: { count: 2, removed_at: at(-30 * DAY) } });
      w.passwordWrong = true;
    },
    check: [
      "Under 'Lost your recovery phrase?', 'Get a new phrase' confirm says private items backed up with the old phrase can't be opened, and shared backups stay open",
      "'No, it's just lost' says the private line: Luna keeps them for 30 days",
      "Asks for the Luna password; the first save is refused inline (That is not your Luna password), not with a toast, and the dialog returns to the password step with a new phrase to write down",
      "After saving, the 'Old phrase backups' row shows with its removal date and Delete now",
    ],
  },
  {
    id: "settings/phrase-resealing",
    area: "Settings: Luna Connect",
    title: "Cloud backups still moving to the new phrase",
    url: "/settings#luna_connect",
    seed: (w) => setPhrase(w, { resealing: true }),
    check: [
      "The card says 'Updating your cloud backups to the new phrase…' under the phrase row",
      "No problem pill or toast appears while it runs",
      "Status is re-read every few seconds and the line goes away when it finishes",
    ],
  },
  {
    id: "settings/phrase-moving",
    area: "Settings: Luna Connect",
    title: "Cloud backups moving to the new phrase in the background",
    url: "/settings#luna_connect",
    seed: (w) => {
      setPhrase(w);
      w.phrase.moving = { percent: 40.9, paused_full: false };
      w.cloudBackups = [cloudBackup({ moving: { percent: 40.9, paused_full: false } })];
    },
    check: [
      "The card says 'Updating your cloud backups to the new phrase · 40%' under the phrase row",
      "The cloud backup row in All backups says the same",
      "Nothing shows a problem: no warning pill, no toast, no Needs you entry",
    ],
  },
  {
    id: "settings/phrase-moving-full",
    area: "Settings: Luna Connect",
    title: "Move paused because Connect storage is full",
    url: "/settings#luna_connect",
    seed: (w) => {
      setPhrase(w);
      w.phrase.moving = { percent: 40, paused_full: true };
      w.cloudBackups = [cloudBackup({ moving: { percent: 40, paused_full: true } })];
    },
    check: [
      "The card and the backup row say Connect storage is full and the move is paused",
      "They say nothing old was deleted and to free up space or add storage",
      "The message stays inline: no toast and no error pill",
    ],
  },
  // ── Remote / Connect / About ──────────────────────────────────────────────
  {
    id: "settings/remote-off",
    area: "Settings: Luna Connect",
    title: "Remote access off",
    url: "/settings#luna_connect",
    check: ["Shows Luna Connect as Off, with what it is for (a public address, cloud backup) and an Open Luna Connect link", "The device token lives in Settings → About → Advanced; entering a bad one there is refused"],
  },
  {
    id: "settings/remote-on",
    area: "Settings: Luna Connect",
    title: "Remote access on",
    url: "/settings#luna_connect",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: true }; w.connectActive = true; },
    check: ["Shows it is connected", "Removing the device token turns it off after confirming"],
  },
  {
    id: "settings/remote-token-rejected",
    area: "Settings: About",
    title: "Connect rejected the device token",
    url: "/settings#about",
    seed: (w) => { w.connect = { enabled: false, connect_active: false, device_token_error: "Luna Connect did not accept this device token. It may be mistyped, revoked, or meant for a different Luna. Open Luna on a phone or computer, then go to Settings → About → Advanced and paste a new device token." }; w.connectActive = false; },
    check: ["Error is shown in plain words", "Replacing the token clears it"],
  },
  {
    id: "settings/about-versions",
    area: "Settings: About",
    title: "About, system checks and updates",
    url: "/settings#about",
    seed: (w) => {
      w.updates = { update_available: true, current_version: "1.4.2", latest_version: "1.5.0" };
      w.systemChecks = {
        overall_pass: false,
        checks: {
          drive_d1_smart: { status: "failed", message: "Drive 1 is failing. Copy your files to another drive now.", category: "drives" },
          disk_space: { status: "failed", message: "Luna's own storage (its system disk) is almost full. Free some space on it, or Luna may stop working.", more: "This is the disk where Luna keeps its accounts and settings; your files are on your drives.", category: "system" },
          clock: { status: "warning", message: "The clock may be off.", more: "Luna sets its clock over the internet and hasn't managed to yet, so new and changed files may get wrong dates. Check that your router or modem is online, then check again in a minute.", category: "system" },
          database: { status: "passed", message: "Luna's database is working.", category: "system" },
        },
      };
    },
    check: ["Checks are grouped, failures first", "Luna's own storage shows what is using the disk, biggest first", "Free up space clears the temporary files and says how much", "Update now starts the update", "Open source licenses open and close"],
  },
  {
    id: "settings/update-source",
    area: "Settings: About",
    title: "Update source",
    url: "/settings#about",
    check: [
      "Changing Stable ↔ Beta keeps the feed address and says it saved",
      "The card says Default source or Custom source and shows the address",
      "Edit update source opens with the warning and prefilled fields",
      "A bad address or key is refused inline and the old value stays",
    ],
  },
  {
    id: "settings/update-source-lan-feed",
    area: "Settings: About",
    title: "Update source on a network address",
    url: "/settings#about",
    seed: (w) => {
      w.updateSource = {
        ...w.updateSource,
        feed_url: "https://192.168.1.10/feeds",
        default_keys: false,
        effective_keys: ["RWCUSTOM"],
      };
    },
    check: [
      "The card says Custom source and shows the network address",
      "Switching Stable ↔ Beta saves without the private-network error",
      "The feed address stays 192.168.1.10",
    ],
  },
  {
    id: "settings/update-source-fails",
    area: "Settings: About",
    title: "Saving the update source fails",
    url: "/settings#about",
    faults: [{ match: "PUT /api/v1/system/updates/source", mode: "500" }],
    check: ["Error appears next to the field and the old value stays"],
  },
  {
    id: "settings/factory-reset",
    area: "Settings: About",
    title: "Erase and start over",
    url: "/settings#about",
    check: ["Asks for clear confirmation naming what is erased", "Confirming sends you to setup"],
  },
  {
    id: "settings/factory-reset-fails",
    area: "Settings: About",
    title: "Reset fails",
    url: "/settings#about",
    faults: [{ match: "POST /api/v1/system/factory-reset", mode: "500" }],
    check: ["Says it didn't work and nothing was erased"],
  },
  // ── Luna Connect (Admin) ──────────────────────────────────────────────────
  {
    id: "settings/luna-connect-admin",
    area: "Settings: Luna Connect",
    title: "Luna Connect for an Admin",
    url: "/settings#luna_connect",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: true }; w.connectActive = true; },
    check: ["Luna Connect category shows for an Admin, with the remote access card and cloud backup in the same entry"],
  },
  // ── Whole-page ────────────────────────────────────────────────────────────
  {
    id: "settings/member-categories",
    area: "Settings",
    title: "Member sees fewer categories",
    url: "/settings",
    seed: asMember,
    check: ["No Users or About; the Luna Connect entry stays visible (Off) with cloud backup in it, like for an Admin", "/settings#users falls back to an allowed page"],
  },
  {
    id: "settings/search",
    area: "Settings",
    title: "Settings search",
    url: "/settings",
    check: ["Press / and search 'password', 'theme', 'token'", "Picking a hit opens the card and highlights the row"],
  },
  {
    id: "settings/session-dies",
    area: "Settings",
    title: "Session ends while editing settings",
    url: "/settings#security",
    check: ["Fault panel: Expire session, then press Save somewhere", "Sign-in form appears in place; typed text isn't silently lost"],
  },
  {
    id: "settings/all-slow-phone-dark",
    area: "Settings",
    title: "Slow network, phone, dark",
    url: "/settings#security",
    viewport: "phone",
    theme: "dark",
    latency: 2500,
    seed: (w) => { w.drives.push(drive({ id: "d2", label: "Backup drive" })); w.summaries.d2 = summary("d2"); },
    check: ["Loading states, no empty flash", "Every card is readable in dark"],
  },
  // ── 404 ───────────────────────────────────────────────────────────────────
  {
    id: "notfound/signed-in",
    area: "404",
    title: "Page that doesn't exist",
    url: "/no/such/page",
    check: ["Friendly message and a button back to the dashboard", "Navbar not broken"],
  },
  {
    id: "notfound/signed-out",
    area: "404",
    title: "Unknown address while signed out",
    url: "/no/such/page",
    seed: (w) => { w.sessionUserId = null; },
    check: ["Either the 404 or sign-in, but never a blank page"],
  },
  {
    id: "notfound/phone",
    area: "404",
    title: "404 on a phone, dark",
    url: "/nope",
    viewport: "phone",
    theme: "dark",
    check: ["Readable, button reachable"],
  },
];
