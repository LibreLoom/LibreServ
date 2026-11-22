import { formatRecentAgo } from "./recentItems";

/**
 * One backup as the dashboard shows it. Drive rows come from /api/v1/backups,
 * cloud rows from /api/v1/cloud/backups.
 * @typedef {{
 *   id: string,
 *   kind: "drive" | "cloud",
 *   private: boolean,
 *   source_drive: string,
 *   source_path: string,
 *   source_name: string,
 *   destination: string,
 *   status: string,
 *   state: string,
 *   last_ok_at: number,
 *   last_error?: string,
 *   waiting_reason?: string | null,
 *   waiting_since?: number | null,
 *   stop_reason?: string,
 *   created_by: string,
 *   last_checked_at?: number,
 *   check_problem?: string | null,
 *   source_missing?: boolean,
 *   hard?: boolean,
 *   paused?: "locked" | null,
 *   locked_drive_names?: string[],
 *   can_resume?: boolean,
 *   notes?: string[],
 * }} BackupRow
 */

/**
 * Turns drive and cloud backup lists into one list of rows, most urgent first.
 * Private backups are kept; the caller decides how to show them.
 * @param {any[]} [driveList]
 * @param {any[]} [cloudList]
 * @returns {BackupRow[]}
 */
export function buildBackupRows(driveList = [], cloudList = []) {
  const drive = (driveList || []).map((b) => ({
    ...b,
    kind: /** @type {const} */ ("drive"),
    private: !!b.private,
    destination: b.target_drive_name || "",
  }));
  const cloud = (cloudList || []).map((b) => ({
    ...b,
    kind: /** @type {const} */ ("cloud"),
    private: !!b.private,
    destination: "Cloud",
  }));
  return sortByUrgency([...drive, ...cloud]);
}

/**
 * Why a backup rebuilt from a drive is paused (`status: "paused"`), for its InfoHint.
 * lunad holds it until its owner or an Admin resumes it.
 */
export const PAUSED_FROM_DRIVE_HINT =
  "Luna found this backup on a drive, not in its own records. Check it's one you want, then resume it.";

/**
 * Backup lists carry a waiting reason. Manual run responses still carry prose.
 * @param {{ kind?: string, last_error?: string, waiting_reason?: string | null }} backup
 */
export function backupWaitingReason({ kind, last_error: error, waiting_reason: reason }) {
  if (reason !== undefined) return reason;
  if (!error || (kind !== "drive" && kind !== "cloud")) return null;
  if (error.startsWith("Waiting: ")) return error.slice("Waiting: ".length);
  if (kind !== "cloud") return null;
  if (error === "Waiting for an Admin to set up the recovery phrase.") {
    return "An Admin needs to set up the recovery phrase.";
  }
  if (error === "This drive is locked. Enter its password to open its files.") {
    return "Unlock the original drive with its password.";
  }
  if (error === "Luna can't find this drive. Make sure it is plugged in, or unplug it and plug it in again.") {
    return "Connect the original drive.";
  }
  if (error === "Your cloud storage is full.") {
    return "Cloud storage is full. Delete a cloud backup you no longer need or ask Luna Connect support to raise the limit.";
  }
  if (error.startsWith("Cloud storage is full.")) return error;
  if (
    error === "Connect this Luna to Luna Connect in Settings → About → Advanced to use cloud backups." ||
    error.startsWith("Add a payment card at connect.luna.libreloom.org") ||
    error === "Add a payment card at Luna Connect (connect.luna.libreloom.org), then start the cloud backup."
  ) return error;
  return null;
}

/**
 * A paused backup (rebuilt from a drive) needs a look: it doesn't run until resumed.
 * Otherwise a backup needs a look when it is still running and its last copy failed
 * or went stale. A cloud backup also needs a look when its last check or
 * last run reported a problem. Stopped and deleted-source backups are finished, not broken.
 * @param {any} b
 * @param {number} [now] Current time in milliseconds.
 */
export function needsALook(b, now = Date.now()) {
  if (b.status === "paused") return true;
  if (b.status !== "active") return false;
  if (b.covered_by) return false;
  if (backupWaitingReason(b)) {
    return b.waiting_since > 0 && now - b.waiting_since * 1000 >= 24 * 60 * 60 * 1000;
  }
  if (b.paused === "locked") return false;
  if (b.state === "in_progress") return !!b.check_problem;
  if (b.state === "failing" || b.state === "stale") return true;
  return b.kind === "cloud" && (!!b.check_problem || !!b.source_missing);
}

/**
 * Status pill for one backup row. One vocabulary for every screen that shows a backup.
 * @param {any} b
 * @returns {{ label: string, variant: "success"|"warning"|"error"|"default", hint?: string }}
 */
export function backupStatus(b, now = Date.now()) {
  if (b.status === "stopped") return { label: "Stopped", variant: "default" };
  if (b.status === "source_gone") return { label: "Original is gone", variant: "default" };
  if (b.status === "paused") return { label: "Paused", variant: "warning", hint: PAUSED_FROM_DRIVE_HINT };
  if (b.covered_by) return { label: "Included in a bigger backup", variant: "default" };
  if (backupWaitingReason(b)) return { label: "Waiting", variant: "warning" };
  if (b.paused === "locked") return { label: "Paused", variant: "warning" };
  if (b.state === "in_progress") {
    return b.check_problem
      ? { label: "Check failed", variant: "warning" }
      : { label: "First backup in progress", variant: "default" };
  }
  if (b.status === "active" && b.source_missing) {
    return { label: "Backup paused", variant: "warning" };
  }
  if (b.state === "failing") return { label: "Last copy failed", variant: "error" };
  if (b.state === "stale") return { label: lastBackedUpLine(b.last_ok_at, now), variant: "warning" };
  if (b.kind === "cloud" && b.check_problem) return { label: "Check failed", variant: "warning" };
  if (!b.last_ok_at) return { label: "No copy yet", variant: "default" };
  return { label: "Backup successful", variant: "success" };
}

/** What a backup copies, in words: "Folder backup", "Drive backup" or "Cloud backup". */
export function backupKindLabel(b) {
  if (b.kind === "cloud") return "Cloud backup";
  return b.source_path ? "Folder backup" : "Drive backup";
}

/** Most urgent first: hard errors, then the oldest good copy (0 = never). */
export function sortByUrgency(list) {
  return [...list].sort(
    (a, b) => Number(!!b.hard) - Number(!!a.hard) || (a.last_ok_at || 0) - (b.last_ok_at || 0),
  );
}

/**
 * The one wording for when a backup last finished: "Last backed up 2 days ago."
 * Used wherever a backup's age is shown, stale or not. Anything a week or older
 * reads as a date ("Last backed up on Mar 4.").
 * @param {number | null | undefined} lastOkAt Unix seconds, 0 or missing when it never finished.
 * @param {number} [now]
 */
export function lastBackedUpLine(lastOkAt, now = Date.now()) {
  if (!lastOkAt) return "Not backed up yet.";
  const ago = formatRecentAgo(lastOkAt * 1000, now);
  if (ago === "Just now") return "Last backed up just now.";
  return /ago$/.test(ago) ? `Last backed up ${ago}.` : `Last backed up on ${ago}.`;
}

/** @param {any} b @param {number} [now] */
export function lastCopyLine(b, now = Date.now()) {
  return lastBackedUpLine(b.last_ok_at, now);
}

/** Name shown for a backup's creator, or "Someone" when unknown. */
export function creatorName(userId, users) {
  const u = (users || []).find((x) => x.id === userId);
  return u ? u.display_name || u.username : "Someone";
}

/** Groups backups by creator, keeping the order of `list`. */
export function groupByCreator(list, users) {
  const groups = new Map();
  for (const b of list) {
    const name = creatorName(b.created_by, users);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(b);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === "Someone") - Number(b === "Someone") || a.localeCompare(b))
    .map(([name, items]) => ({ name, items: sortByUrgency(items) }));
}

/** Headline for the card's first line. */
export function backupHeadline(rows) {
  if (rows.length === 0) return "No backups yet";
  const count = rows.filter((b) => needsALook(b)).length;
  if (count === 0) {
    const paused = rows.filter((b) => b.status === "active" && !b.covered_by && b.paused === "locked" && !backupWaitingReason(b)).length;
    if (paused === 1) return "1 backup is paused";
    if (paused > 1) return `${paused} backups are paused`;
    const waiting = rows.filter((b) => b.status === "active" && !b.covered_by && backupWaitingReason(b)).length;
    if (waiting === 1) return "1 backup is waiting";
    if (waiting > 1) return `${waiting} backups are waiting`;
    const uploading = rows.filter((b) => b.status === "active" && !b.covered_by && b.state === "in_progress").length;
    if (uploading === 1) return "First backup in progress";
    if (uploading > 1) return `${uploading} first backups in progress`;
    const noCopy = rows.filter((b) => b.status === "active" && !b.covered_by && !b.last_ok_at).length;
    if (noCopy === 1) return "1 backup has no copy yet";
    if (noCopy > 1) return `${noCopy} backups have no copy yet`;
    return "All backed up";
  }
  if (count === 1) return "1 backup needs a look";
  return `${count} backups need a look`;
}

/**
 * Second line of the card: when the newest cloud copy was tested. Null when none was,
 * since the headline already says how many backups there are.
 * @param {BackupRow[]} rows
 * @param {number} [now]
 * @returns {string | null}
 */
export function lastTestedLine(rows, now = Date.now()) {
  const checks = rows
    .filter((r) => r.kind === "cloud" && r.last_checked_at)
    .map((r) => Number(r.last_checked_at));
  if (checks.length === 0) return null;
  const ago = formatRecentAgo(Math.max(...checks) * 1000, now);
  // "2 days ago", or "on Mar 4" once it is a date.
  const when = ago === "Just now" ? "just now" : /ago$/.test(ago) ? ago : `on ${ago}`;
  return `Copies last tested ${when}`;
}

/**
 * Private backups grouped by owner, from /api/v1/private-backups/summary.
 * @param {{ owners?: any[] } | null | undefined} summary
 * @param {any[]} [users]
 */
export function privateGroups(summary, users) {
  return (summary?.owners || []).map((o) => ({
    ownerId: o.owner_id,
    name: o.deleted ? "Deleted user" : o.name || creatorName(o.owner_id, users),
    deleted: !!o.deleted,
    backups: o.backups ?? 0,
    needsLook: o.needs_look ? 1 : 0,
  }));
}
