import { cloudBackup, DAY, DEFAULT_NOW, drive, HOUR, summary, user } from "../fake/world.js";

const at = (s) => Math.floor(DEFAULT_NOW / 1000) - s;

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
      "Add a good one and it appears in the list",
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
      w.orphans = {
        offline_drives: ["Old USB"],
        owners: [
          { user_id: "gone1", username: "alex", display_name: "Alex", total: 4, drives: [{ drive_label: "Family photos", count: 3, trash_count: 1, readonly: false }] },
          { user_id: "gone2", username: "kit", display_name: "", total: 1, drives: [{ drive_label: "Backup drive", count: 1, trash_count: 0, readonly: true }] },
        ],
      };
      w.ownerless = 2;
      withPeople(w);
    },
    check: ["Two removed people listed with where their folders are", "Delete is disabled for the read-only one", "A line says Old USB isn't connected", "'Give to' flow hands the 2 ownerless folders to someone"],
  },
  {
    id: "settings/users-last-admin",
    area: "Settings: Users",
    title: "Last Admin tries to leave",
    url: "/settings/users/u1",
    check: ["Removing yourself is blocked with a plain message", "Changing your own role to Member is refused, with a reason"],
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
    faults: [{ match: "DELETE /api/v1/users", mode: "409", message: "Sam is still signed in on another device." }],
    check: ["The dialog shows the reason and stays open"],
  },
  // ── Edit user ─────────────────────────────────────────────────────────────
  {
    id: "settings/edit-user-other",
    area: "Edit user",
    title: "Editing another person",
    url: "/settings/users/u2",
    seed: withPeople,
    check: ["Name, role and password can change", "Weak password is refused with the rule", "Saving returns to Users with a toast", "Remove asks first"],
  },
  {
    id: "settings/edit-user-self",
    area: "Edit user",
    title: "Editing yourself",
    url: "/settings/users/u1",
    check: ["Removing yourself isn't offered or is explained", "Page still loads"],
  },
  {
    id: "settings/edit-user-missing",
    area: "Edit user",
    title: "Person doesn't exist",
    url: "/settings/users/nobody",
    check: ["Friendly 'not found' with a way back to Users"],
  },
  {
    id: "settings/edit-user-member-blocked",
    area: "Edit user",
    title: "Member opens the edit page",
    url: "/settings/users/u1",
    seed: asMember,
    check: ["Blocked with an explanation, not a blank page"],
  },
  {
    id: "settings/edit-user-save-fails",
    area: "Edit user",
    title: "Saving fails",
    url: "/settings/users/u2",
    seed: withPeople,
    faults: [{ match: "PATCH /api/v1/users", mode: "500" }],
    check: ["Error shows on the page and typed changes stay"],
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
    check: ["Changing theme and colors applies at once", "Everything stays readable in both modes", "Choice survives Reload only if it is meant to"],
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
    title: "Creating a token fails; duplicate name",
    url: "/settings#security",
    seed: (w) => { w.tokens = [{ id: "t1", name: "Phone app", created_at: at(DAY), last_used_at: null, expires_at: null }]; },
    check: ["Name 'Phone app' → 'already have a token' error inside the dialog", "An empty name is refused"],
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
    area: "Settings: Cloud backup",
    title: "Luna Connect is off",
    url: "/settings",
    check: [
      "Neither Cloud backup nor Luna Connect is in the sidebar",
      "No Cloud backup or Luna Connect card appears anywhere on the page",
      "Settings opens on Appearance",
    ],
  },
  {
    id: "settings/cloud-backups",
    area: "Settings: Cloud backup",
    title: "Cloud backups: ok, source missing, check problem",
    url: "/settings#cloud_backup",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.cloudBackups = [
        cloudBackup({ source_name: "Documents" }),
        cloudBackup({ source_name: "Old photos", source_missing: true }),
        cloudBackup({ source_name: "Taxes", check_problem: "The cloud copy could not be read." }),
      ];
    },
    check: ["Run now works on the first", "'Run anyway' appears only for the missing folder and then succeeds", "Check works and clears the problem", "Delete asks first"],
  },
  {
    id: "settings/cloud-no-card",
    area: "Settings: Cloud backup",
    title: "Connect on but no payment card",
    url: "/settings#cloud_backup",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: false }; w.connectActive = true; w.cloudBackups = [cloudBackup()]; },
    check: ["Says a card is needed before backing up, and where to add it"],
  },
  {
    id: "settings/cloud-run-fails",
    area: "Settings: Cloud backup",
    title: "Running a cloud backup fails",
    url: "/settings#cloud_backup",
    seed: (w) => { w.connect = { enabled: true, connect_active: true, card_on_file: true }; w.connectActive = true; w.cloudBackups = [cloudBackup()]; },
    faults: [{ match: "POST /api/v1/cloud/backups", mode: "500", message: "Couldn't reach the cloud." }],
    check: ["Problem stays on the backup card, not a toast"],
  },
  {
    id: "settings/phrase-check-wrong",
    area: "Settings: Cloud backup",
    title: "Recovery phrase check with the wrong words",
    url: "/settings#cloud_backup",
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
    id: "settings/phrase-not-set",
    area: "Settings: Cloud backup",
    title: "Setting up a recovery phrase for the first time",
    url: "/settings#cloud_backup",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.phrase = { set: false, set_at: 0, luna_id: "", signing_public: "", check_due: false };
    },
    check: ["Creating the phrase shows 12 words (or 24 if chosen) once", "Confirming them marks the phrase as set"],
  },
  {
    id: "settings/restore-needed",
    area: "Settings: Cloud backup",
    title: "Restore: Luna lost its list of cloud backups",
    url: "/settings#cloud_backup",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.restore = { needed: true, luna_id: "luna-1", signing_public: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", cloud_snapshots: 14, indexed_snapshots: 0 };
    },
    check: ["Restore card explains 14 versions were found", "Any 12 or 24 words are refused with 'doesn't open any backups' (the fake has none)", "Words with a typo are refused before anything is sent"],
  },
  {
    id: "settings/restore-private-needed",
    area: "Settings: Cloud backup",
    title: "Restore: private backups list lost",
    url: "/settings#cloud_backup",
    seed: (w) => {
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.restorePrivate = { needed: true, luna_id: "luna-1", signing_public: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", scopes: 3 };
    },
    check: ["Private restore card appears with the number of private areas", "Wrong words give the 'check each word' message"],
  },
  {
    id: "settings/phrase-member-not-set",
    area: "Settings: Cloud backup",
    title: "Member, Connect on, no recovery phrase",
    url: "/settings#cloud_backup",
    seed: (w) => {
      asMember(w);
      w.connect = { enabled: true, connect_active: true, card_on_file: true };
      w.connectActive = true;
      w.phrase = { set: false, set_at: 0, luna_id: "", signing_public: "", check_due: false, admin_has_phrase: false };
    },
    check: [
      "Sam sees Cloud backup in the sidebar and no Luna Connect or Users",
      "The recovery phrase card shows, with a button to set up a phrase",
      "With no Admin phrase, a line says shared backups wait until an Admin sets one",
    ],
  },
  {
    id: "settings/phrase-set-check-due",
    area: "Settings: Cloud backup",
    title: "Recovery phrase check is due",
    url: "/settings#cloud_backup",
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
  // ── Remote / Connect / About ──────────────────────────────────────────────
  {
    id: "settings/remote-off",
    area: "Settings: Luna Connect",
    title: "Remote access off",
    url: "/settings#luna_connect",
    check: ["Explains what turning it on does", "Entering a device token ('bad' is refused) turns it on"],
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
    seed: (w) => { w.connect = { enabled: true, connect_active: true, device_token_error: "Luna Connect no longer accepts this device token." }; w.connectActive = true; },
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
          disk_space: { status: "failed", message: "Storage space is nearly gone.", category: "storage" },
          clock: { status: "warning", message: "The clock may be wrong.", category: "system" },
          database: { status: "passed", message: "Working", category: "system" },
        },
      };
    },
    check: ["Checks are grouped, failures first", "Update now starts the update", "Open source licenses open and close"],
  },
  {
    id: "settings/update-source",
    area: "Settings: About",
    title: "Update source",
    url: "/settings#about",
    check: ["Switching the source saves and says so", "A bad address is refused clearly"],
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
    check: ["Luna Connect category shows for an Admin, with the remote access card", "Cloud backup is also in the sidebar, above Luna Connect"],
  },
  // ── Whole-page ────────────────────────────────────────────────────────────
  {
    id: "settings/member-categories",
    area: "Settings",
    title: "Member sees fewer categories",
    url: "/settings",
    seed: asMember,
    check: ["No Users or About, and no Cloud backup or Luna Connect while Connect is off", "/settings#users falls back to an allowed page"],
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
