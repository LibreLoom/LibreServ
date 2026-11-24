// Plain-language helpers for password-protected drives: who may do what, what
// to say about a refused password, and the line the dashboard and backups use
// when drives are locked. Backend: crates/lunad/src/api/drive_crypt.rs.

/**
 * @template {{ encrypted?: boolean, locked?: boolean }} T
 * @param {T[] | null | undefined} drives
 * @returns {T[]}
 */
export function lockedDrives(drives) {
  return (drives || []).filter((d) => d.encrypted && d.locked);
}

/**
 * Why a new password can't be used yet, in one sentence, or "" when it can.
 * Drive passwords have no length or letter/number rule: lunad refuses only an
 * empty password for a drive, so a short one is sent and accepted. The strength
 * chips beside the field are a suggestion, not a requirement.
 * @param {string} password
 * @param {string} again
 */
export function newPasswordProblem(password, again) {
  if (!password) return "Enter a password.";
  if (password !== again) return "The two passwords don't match.";
  return "";
}

/**
 * A plain count of locked drives for the dashboard: one drive by name, several
 * as a number. `paused` says whether any backup is waiting on them.
 * @param {{ label: string }[]} drives
 * @param {boolean} paused
 * @returns {Array<string | { name: string }>}
 */
export function lockedDrivesTitle(drives, paused) {
  const tail = paused ? ", so backups are paused." : ".";
  if (drives.length === 1) return [{ name: drives[0].label }, ` is locked${tail}`];
  return [`${drives.length} drives are locked${tail}`];
}

/** Does this backup row wait on a locked drive? (single definition, shared with the backup UI) */
export { isPausedByLock } from "./backupRows.js";
