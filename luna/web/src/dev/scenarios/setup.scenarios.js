import { DEFAULT_NOW, healthyPreflight } from "../fake/world.js";

// lunad reports every probe on every run, so each sample carries the full set;
// the scenarios override one or two rows on top of the healthy answer.
const PASS = healthyPreflight();
const WARN = {
  ...PASS,
  checks: {
    ...PASS.checks,
    video_tools: {
      ...PASS.checks.video_tools,
      status: "warning",
      message: "Videos get no preview pictures or length.",
      more: "Photos shows these for each video, made with video tools that are missing. Videos can still be played and downloaded.",
    },
  },
};
const FAIL = {
  ...PASS,
  healthy: false,
  checks: {
    ...PASS.checks,
    disk_space: {
      ...PASS.checks.disk_space,
      status: "failed",
      message: "Luna's system disk is almost full, so Luna may stop working.",
      more: "This disk holds Luna's accounts and settings, not your files. To clear temporary files, select Free up space in Settings → About → System checks.",
      details: { free_bytes: 900_000_000, free_human: "0.9 GB" },
    },
    network: {
      ...PASS.checks.network,
      status: "warning",
      message: "Luna can't reach the internet.",
      more: "Updates, setting the clock, and Luna Connect (remote access and cloud backup) need the internet. Luna still works on your home network; check that your router or modem is online.",
    },
  },
};

/** A Luna that has never been set up. */
const fresh = (over = {}) => (w) => {
  w.users = [];
  w.sessionUserId = null;
  w.hasAdmin = false;
  w.phrase = { ...w.phrase, set: false }; // a new account has no recovery phrase yet
  w.setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} };
  over.setup && Object.assign(w.setup, over.setup);
  if (over.preflight) w.preflight = over.preflight;
  if (over.world) over.world(w);
};

const STEPS_CHECK = [
  "Welcome → System check → Account → Name → Done, with a step counter",
  "Back works on every step and keeps what you typed",
  "No recovery phrase step: a phrase is only asked for when someone turns on cloud backup",
];

/** @type {import("./registry.js").Scenario[]} */
export default [
  {
    id: "setup/full-walkthrough",
    area: "Setup",
    title: "Whole wizard, everything goes right",
    url: "/setup",
    seed: fresh(),
    check: [...STEPS_CHECK, "Password steps show the 12-character rule as you type", "Finishing lands on the dashboard"],
  },
  {
    id: "setup/preflight-warning",
    area: "Setup",
    title: "System check: a warning only",
    url: "/setup",
    seed: fresh({ preflight: WARN, setup: { current_step: "preflight" } }),
    check: ["Warning is explained in plain words and does not block", "Continue is enabled"],
  },
  {
    id: "setup/preflight-failed",
    area: "Setup",
    title: "System check: failed",
    url: "/setup",
    seed: fresh({ preflight: FAIL, setup: { current_step: "preflight" } }),
    check: ["Each failed check says what is wrong and what to do", "Continue stays blocked", "Run again works"],
  },
  {
    id: "setup/preflight-fails-then-passes",
    area: "Setup",
    title: "System check: fails, then passes on retry",
    url: "/setup",
    seed: fresh({ preflight: [FAIL, PASS], setup: { current_step: "preflight" } }),
    check: ["First run fails", "Run again shows a pass and unlocks Continue"],
  },
  {
    id: "setup/preflight-slow",
    area: "Setup",
    title: "System check: very slow",
    url: "/setup",
    seed: fresh({ setup: { current_step: "preflight" } }),
    faults: [{ match: "GET /api/v1/setup/preflight", mode: "slow:8000" }],
    check: ["A calm progress state shows while waiting", "Result appears when it arrives"],
  },
  {
    id: "setup/preflight-unreachable",
    area: "Setup",
    title: "System check: Luna doesn't answer",
    url: "/setup",
    seed: fresh({ setup: { current_step: "preflight" } }),
    faults: [{ match: "GET /api/v1/setup/preflight", mode: "offline" }],
    check: ["Says Luna can't be reached, not a blank screen", "Run again is offered"],
  },
  {
    id: "setup/refresh-mid-account",
    area: "Setup",
    title: "Refreshed on the account step",
    url: "/setup",
    seed: fresh({ setup: { current_step: "account", step_data: { network_connected: true, preflight_passed: true } } }),
    check: ["Resumes at the account step, not Welcome", "Back still goes to the system check"],
  },
  {
    id: "setup/refresh-mid-name",
    area: "Setup",
    title: "Refreshed on the naming step",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "name", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    check: ["Resumes at naming, signed in", "Finishing works"],
  },
  {
    id: "setup/account-exists-signed-out",
    area: "Setup",
    title: "Account made, but signed out mid-setup",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "name", step_data: { account_completed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
    },
    check: ["Lands on a sign-in form, not a second account form", "Wrong password (type: wrong) shows a clear message", "After signing in it moves on to naming"],
  },
  {
    id: "setup/username-taken",
    area: "Setup",
    title: "Account step: username already used",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "account", step_data: { preflight_passed: true } } })(w);
      w.users = [{ id: "u9", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
    },
    check: ["Use username: max", "Error points back at the username step"],
  },
  {
    id: "setup/register-fails",
    area: "Setup",
    title: "Account step: creating the account fails",
    url: "/setup",
    seed: fresh({ setup: { current_step: "account", step_data: { preflight_passed: true } } }),
    faults: [{ match: "POST /api/v1/auth/register", mode: "500", message: "Luna could not create the account. Try again." }],
    check: ["Message is shown next to the form", "Typed answers are kept for another try"],
  },
  {
    id: "setup/setup-grant-step",
    area: "Setup",
    title: "Account step offers an optional one-time setup grant",
    url: "/setup?setup_grant=query-only",
    seed: fresh({
      setup: { current_step: "account", step_data: { preflight_passed: true } },
      world: (w) => { w.connectActive = false; w.setupGrant = "good-grant"; },
    }),
    check: ["The query-string grant is stripped and never fills the field", "The optional field appears on every address", "A wrong or expired setup link gives a clear error", "A valid configured grant is consumed once and its replay is refused"],
  },
  {
    id: "setup/setup-grant-fragment",
    area: "Setup",
    title: "Setup link fills the one-time grant",
    url: "/setup#setup_grant=good-grant",
    seed: fresh({
      setup: { current_step: "account", step_data: { preflight_passed: true } },
      world: (w) => { w.connectActive = true; w.setupGrant = "good-grant"; },
    }),
    check: ["The fragment is removed from the visible URL", "The grant field is skipped because the link already filled it", "Registration submits the grant"],
  },
  {
    id: "setup/finish-fails",
    area: "Setup",
    title: "Last step: finishing fails",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "name", step_data: { account_completed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    faults: [{ match: "POST /api/v1/setup", mode: "500", message: "Luna couldn't save setup progress." }],
    check: ["The name you typed stays in the box", "An error says finishing failed and to try again"],
  },
  {
    id: "setup/progress-save-fails",
    area: "Setup",
    title: "Saving progress fails between steps",
    url: "/setup",
    seed: fresh(),
    faults: [{ match: "POST /api/v1/setup", mode: "500", message: "Luna couldn't save setup progress." }],
    check: ["Pressing Begin shows 'couldn't save your setup progress'", "You stay on the same step"],
  },
  {
    id: "setup/finish-without-phrase",
    area: "Setup",
    title: "Finishing setup with no recovery phrase",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "name", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    check: ["Setup finishes without a phrase and lands on the dashboard", "Nothing asks for a phrase on the way"],
  },
  {
    id: "setup/phone-dark",
    area: "Setup",
    title: "Wizard on a phone, dark mode",
    url: "/setup",
    viewport: "phone",
    theme: "dark",
    seed: fresh(),
    check: ["Nothing is cut off or overlapping", "Step counter and buttons stay readable"],
  },
  {
    id: "setup/already-complete",
    area: "Setup",
    title: "Opening /setup on a finished Luna",
    url: "/setup",
    check: ["Redirects to the dashboard"],
  },
];
