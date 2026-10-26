import { DEFAULT_NOW } from "../fake/world.js";

const ok = (message) => ({ status: "passed", message });
const PASS = {
  healthy: true,
  checks: {
    disk_space: ok("12.4 GB free on Luna's system disk."),
    network: ok("Connected to your router or modem, with a path to the internet."),
    database: ok("Accounts, sharing, and settings are readable."),
  },
};
const WARN = {
  healthy: true,
  checks: { ...PASS.checks, video_tools: { status: "warning", message: "Videos get no preview pictures or length.", more: "Photos shows these for each video, made with video tools that are missing. Videos can still be played and downloaded." } },
};
const FAIL = {
  healthy: false,
  checks: {
    ...PASS.checks,
    disk_space: { status: "failed", message: "Luna's own storage (its system disk) is almost full. Free some space on it, or Luna may stop working.", more: "This is the disk where Luna keeps its accounts and settings; your files are on your drives." },
    network: { status: "warning", message: "Luna can't reach the internet.", more: "Updates, setting the clock, and Luna Connect (remote access and cloud backup) need the internet. Luna still works on your home network; check that your router or modem is online." },
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
  "Welcome → System check → Account → Recovery phrase → Name → Done, with a step counter",
  "Back works on every step and keeps what you typed",
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
      w.phrase = { ...w.phrase, set: true };
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
    faults: [{ match: "POST /api/v1/auth/register", mode: "500", message: "Luna couldn't do that. Try again." }],
    check: ["Message is shown next to the form", "Typed answers are kept for another try"],
  },
  {
    id: "setup/device-token-step",
    area: "Setup",
    title: "Account step asks for a Luna Connect device token",
    url: "/setup",
    seed: fresh({
      setup: { current_step: "account", step_data: { preflight_passed: true } },
      world: (w) => { w.connectActive = true; w.setupSecret = "good-token"; },
    }),
    check: ["Only appears when Connect is on and the page is on a public address", "A wrong token (anything but good-token) gives a clear error"],
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
      w.phrase = { ...w.phrase, set: true };
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
    id: "setup/phrase-step",
    area: "Setup",
    title: "Recovery phrase step",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "phrase", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    check: ["Shows a new phrase to write down, then asks you to confirm it", "Saving it moves on to naming Luna", "Copy and download both work"],
  },
  {
    id: "setup/phrase-refresh",
    area: "Setup",
    title: "Refreshed on the recovery phrase step",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "phrase", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    check: ["After a refresh a NEW phrase is shown, with the line about leaving the page", "The old phrase is never kept"],
  },
  {
    id: "setup/phrase-identity-fails",
    area: "Setup",
    title: "Recovery phrase step: Luna can't set up its backup identity",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "phrase", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    faults: [{ match: "POST /api/v1/cloud/identity", mode: "409", message: "Luna could not set up its backup identity. Try again, or contact your Admin." }],
    check: ["The message is shown on the step, in plain words", "Nothing is saved; trying again works once the rule is off"],
  },
  {
    id: "setup/phrase-save-fails",
    area: "Setup",
    title: "Recovery phrase step: saving fails",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "phrase", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    faults: [{ match: "PUT /api/v1/cloud/phrase", mode: "500", message: "Luna couldn't save that. Try again." }],
    check: ["The inline error keeps the confirm step and what you typed"],
  },
  {
    id: "setup/finish-without-phrase",
    area: "Setup",
    title: "Naming step saved, but no recovery phrase yet",
    url: "/setup",
    seed: (w) => {
      fresh({ setup: { current_step: "name", step_data: { account_completed: true, preflight_passed: true } } })(w);
      w.users = [{ id: "u1", username: "max", display_name: "Max", role: "admin", created_at: DEFAULT_NOW / 1000 }];
      w.hasAdmin = true;
      w.sessionUserId = "u1";
    },
    check: ["Luna won't finish setup without a phrase: the wizard resumes on the recovery phrase step"],
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
