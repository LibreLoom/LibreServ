// Encrypted drives: state, unlock, lock, change password, and unlock-and-add. Copies
// crates/lunad/src/api/drive_crypt.rs (and drives/crypt/vault.rs): who may do what, the
// status codes and codes, the messages, and the rate limit on wrong passwords.
//
// A drive row carries `encrypted` and `locked` (a locked drive is also not `mounted`, so
// the file routes refuse it with 423 `drive_locked`, like files::drive_root).
//
// What a scenario can set on a drive row (all optional):
//   password   the password that opens it (default PASSWORD below)
//   lockBusy   something has files open from it, so locking is refused
// and on a detected drive (an encrypted one Luna hasn't registered):
//   encrypted: true, password, volume_label (the name it is added under)
import { fail, get, post } from "../engine.js";
import { hasDriveAccess, isAdmin, requireAdmin } from "../policy.js";
import { nextId, summary } from "../world.js";
import { nowS } from "../fsmodel.js";
import { activeRun } from "./format.js";

export const PASSWORD = "correct-horse-1";
const ADMIN_ONLY = "Only an Admin can manage drives.";
const BUSY = "Luna is already working on this drive. Wait until it finishes.";
const WRONG = "That password didn't work.";
const WRONG_LOCKED_OUT = "That password didn't work. Too many wrong tries, so wait a few minutes before trying again.";
const TOO_MANY = "Too many wrong tries. Wait a few minutes, then try again.";
const MAX_FAILURES = 5;

const driveOf = (world, id) => {
  const d = world.drives.find((x) => x.id === id);
  if (!d) throw fail(404, "Luna doesn't know this drive.", "unknown_drive");
  return d;
};
const passwordOf = (d) => d.password ?? PASSWORD;
const present = (d) => d.state !== "missing" && d.state !== "ejected";

function authorize(world, user, id) {
  if (!hasDriveAccess(world, user, id)) throw fail(403, "You don't have access to this drive.");
}

/** UnlockGuard: five wrong tries lock one person out of one drive, doubling from a minute. */
const guard = (world) => (world.unlockTries ??= {});
function checkNotLockedOut(world, user, key) {
  if ((guard(world)[`${user.id}:${key}`]?.until ?? 0) > nowS()) throw fail(429, TOO_MANY, "too_many_tries");
}
function wrongPassword(world, user, key) {
  const slot = (guard(world)[`${user.id}:${key}`] ??= { count: 0, until: 0 });
  slot.count += 1;
  const lockedOut = slot.count >= MAX_FAILURES;
  if (lockedOut) slot.until = nowS() + 60 * 2 ** Math.min(slot.count - MAX_FAILURES, 10);
  return fail(401, lockedOut ? WRONG_LOCKED_OUT : WRONG, "wrong_password", { locked_out: lockedOut });
}
const clearTries = (world, user, key) => { delete guard(world)[`${user.id}:${key}`]; };

/** drive_crypt::ready: plugged in, encrypted, not being erased. */
function ready(world, d) {
  if (!present(d)) throw fail(400, "This drive is unplugged. Plug it in and try again.");
  if (!d.encrypted) throw fail(400, "This drive isn't encrypted.");
  if (activeRun(world, d.device)) throw fail(409, "Luna is erasing this drive right now. Try again when it finishes.", "drive_busy");
}

get("/api/v1/drives/:id/encryption", ({ world, user, params }) => {
  authorize(world, user, params.id);
  const d = driveOf(world, params.id);
  const formatting = Boolean(activeRun(world, d.device));
  const status = !d.encrypted ? "not_encrypted" : !present(d) ? "unplugged" : formatting ? "formatting" : d.locked ? "locked" : "unlocked";
  return {
    drive_id: d.id, label: d.label, encrypted: Boolean(d.encrypted), unlocked: status === "unlocked",
    locked: Boolean(d.encrypted && d.locked), present: present(d), status,
  };
});

post("/api/v1/drives/:id/unlock", ({ world, user, params, body }) => {
  authorize(world, user, params.id);
  const d = driveOf(world, params.id);
  ready(world, d);
  if (!d.locked) return { ok: true, already_unlocked: true };
  if (!String(body.password ?? "")) throw fail(400, "Enter this drive's password.");
  checkNotLockedOut(world, user, d.id);
  if (body.password !== passwordOf(d)) throw wrongPassword(world, user, d.id);
  clearTries(world, user, d.id);
  d.locked = false;
  d.mounted = true;
  d.state = "as_is";
  return { ok: true };
});

post("/api/v1/drives/:id/lock", ({ world, user, params }) => {
  if (!isAdmin(user)) throw fail(403, "Only an Admin can lock this drive.");
  authorize(world, user, params.id);
  const d = driveOf(world, params.id);
  ready(world, d);
  if (d.locked) return { ok: true, already_locked: true };
  if (d.lockBusy) throw fail(409, "Something is still using this drive. Close any files open from it, then try again.", "drive_busy");
  d.locked = true;
  d.mounted = false;
  return { ok: true };
});

post("/api/v1/drives/:id/password", ({ world, user, params, body }) => {
  if (!isAdmin(user)) throw fail(403, "Only an Admin can change this drive's password.");
  if (!String(body.current_password ?? "") || !String(body.new_password ?? "")) throw fail(400, "Enter the current and the new password.");
  const text = String(body.new_password);
  if (text.length < 12) throw fail(400, "Passwords need at least 12 characters.", "weak_password");
  if (!/[a-zA-Z]/.test(text) || !/[0-9]/.test(text)) throw fail(400, "Passwords need at least one letter and one number.", "weak_password");
  const d = driveOf(world, params.id);
  ready(world, d);
  checkNotLockedOut(world, user, d.id);
  if (body.current_password !== passwordOf(d)) throw wrongPassword(world, user, d.id);
  clearTries(world, user, d.id);
  d.password = text;
  return { ok: true };
});

post("/api/v1/drives/:name/unlock-and-add", ({ world, user, params, body }) => {
  requireAdmin(user, "Only an Admin can manage drives.");
  if (!String(body.password ?? "")) throw fail(400, "Enter this drive's password.");
  const found = world.detected.find((x) => x.name === params.name);
  if (!found) throw fail(404, "Luna can't see this drive. Plug it in and try again.");
  if (activeRun(world, found.name)) throw fail(409, "Luna is erasing this drive right now. Try again when it finishes.", "drive_busy");
  if (!found.encrypted) throw fail(400, "Luna couldn't find the encrypted part of this drive.");
  checkNotLockedOut(world, user, found.name);
  if (body.password !== (found.password ?? PASSWORD)) throw wrongPassword(world, user, found.name);
  clearTries(world, user, found.name);
  world.detected = world.detected.filter((x) => x.name !== params.name);
  const id = nextId("d");
  world.drives.push({
    id, label: found.volume_label || "Encrypted drive", state: "as_is", device: found.name, fs_type: "ext4",
    mount_point: `/mnt/${id}`, mounted: true, encrypted: true, locked: false, password: found.password,
  });
  world.fs = { ...(world.fs || {}), [id]: { nodes: {}, trash: [] } };
  world.summaries[id] = summary(id, { shortcuts: [] });
  return { ok: true, drive_id: id };
});

/** For scenarios: make a drive an encrypted one, locked or not. */
/** @param {any} world @param {string} id @param {{ locked?: boolean, password?: string }} [opts] */
export function encryptDrive(world, id, opts = {}) {
  const { locked = true, password } = opts;
  const d = driveOf(world, id);
  d.encrypted = true;
  d.locked = locked;
  d.mounted = !locked;
  if (password !== undefined) d.password = password;
}
