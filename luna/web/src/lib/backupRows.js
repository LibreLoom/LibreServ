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
 *   stop_reason?: string,
 *   created_by: string,
 *   last_checked_at?: number,
 *   check_problem?: string | null,
 *   source_missing?: boolean,
 *   hard?: boolean,
 *   paused?: "locked" | null,
 *   locked_drive_names?: string[],
 *   can_resume?: boolean,
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
 * A paused backup (rebuilt from a drive) needs a look: it doesn't run until resumed.
 * Otherwise a backup needs a look when it is still running and its last copy failed
 * or went stale. A cloud backup also needs a look when its last check or
 * last run reported a problem. Stopped and deleted-source backups are finished, not broken.
 * @param {any} b
 */
export function needsALook(b) {
  if (b.status === "paused") return true;
  if (b.status !== "active") return false;
  // Waiting for a drive's password is not a fault in the backup.
  if (b.paused === "locked") return false;
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
  if (b.kind === "cloud" && b.status === "active" && b.source_missing) {
    return { label: "Original is missing", variant: "warning" };
  }
  if (b.paused === "locked") return { label: "Paused", variant: "warning" };
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
  const count = rows.filter(needsALook).length;
  if (count === 0) {
    const paused = rows.filter((b) => b.status === "active" && b.paused === "locked").length;
    if (paused === 1) return "1 backup is paused";
    if (paused > 1) return `${paused} backups are paused`;
    // A new backup is not stale for its first day, but it has nothing backed up yet.
    const waiting = rows.filter((b) => b.status === "active" && b.paused !== "locked" && !b.last_ok_at).length;
    if (waiting === 1) return "1 backup has no copy yet";
    if (waiting > 1) return `${waiting} backups have no copy yet`;
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
