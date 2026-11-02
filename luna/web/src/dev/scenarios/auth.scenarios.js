import { backup, cloudBackup, DAY, drive, summary, user } from "../fake/world.js";

const ago = (s) => Math.floor(Date.now() / 1000) - s;
void ago; void backup; void cloudBackup; void DAY; void drive; void summary; void user;

/** @type {import("./registry.js").Scenario[]} */
export default [
  {
    id: "auth/signed-in-admin",
    area: "Sign-in",
    title: "Admin, everything normal",
    check: ["Dashboard loads with one drive", "Navbar shows every page", "Sign out returns to the sign-in form"],
  },
  {
    id: "auth/signed-out",
    area: "Sign-in",
    title: "Signed out (an account exists)",
    seed: (w) => { w.sessionUserId = null; },
    check: ["Sign-in form shows in place at /", "Wrong password shows a clear message (type: wrong)", "Right password returns to the page you were on"],
  },
  {
    id: "auth/signed-out-deep-link",
    area: "Sign-in",
    title: "Signed out, opened a deep link",
    url: "/files",
    seed: (w) => { w.sessionUserId = null; },
    check: ["URL stays /files while the form shows", "After signing in you land on /files"],
  },
  {
    id: "auth/member",
    area: "Sign-in",
    title: "Member (not Admin)",
    seed: (w) => {
      const m = user({ id: "u2", username: "sam", display_name: "Sam", role: "user" });
      w.users.push(m);
      w.sessionUserId = "u2";
    },
    check: ["No admin-only cards on the dashboard", "/settings/users/u1 is blocked, not blank", "Settings hides admin categories"],
  },
  {
    id: "auth/member-needs-phrase",
    area: "Sign-in",
    title: "Member signed in without a recovery phrase",
    seed: (w) => {
      w.users.push(user({ id: "u2", username: "sam", display_name: "Sam", role: "user" }));
      w.sessionUserId = "u2";
      w.phrase = { ...w.phrase, set: false };
    },
    check: ["The recovery phrase gate shows before the app", "Sign out works from the gate", "Saving a phrase opens the dashboard"],
  },
  {
    id: "auth/session-dies-mid-use",
    area: "Sign-in",
    title: "Session dies while using the app",
    check: ["Use the fault panel: Expire session, then click around", "Form appears in place, URL does not move", "Message says why you were signed out"],
  },
  {
    id: "auth/fresh-box",
    area: "Sign-in",
    title: "Brand new Luna, no accounts",
    seed: (w) => {
      w.users = [];
      w.sessionUserId = null;
      w.hasAdmin = false;
      w.setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} };
    },
    check: ["Any URL bounces to /setup", "/login also redirects to /setup"],
    url: "/files",
  },
];
