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
 * }} BackupRow
 */

/** Most rows the card lists before "See all backups". */
export const CARD_PROBLEM_LIMIT = 3;

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
 * A backup needs a look when it is still running and its last copy failed
 * or went stale. A cloud backup also needs a look when its last check or
 * last run reported a problem. Stopped and deleted-source backups are finished, not broken.
 * @param {any} b
 */
export function needsALook(b) {
  if (b.status !== "active") return false;
  if (b.state === "failing" || b.state === "stale") return true;
  return b.kind === "cloud" && (!!b.check_problem || !!b.source_missing);
}

/**
 * Status pill for one backup row.
 * @param {any} b
 * @returns {{ label: string, variant: "success"|"warning"|"error"|"muted" }}
 */
export function backupStatus(b) {
  if (b.status === "stopped") return { label: "Stopped", variant: "muted" };
  if (b.status === "source_gone") return { label: "Source gone", variant: "muted" };
  if (b.kind === "cloud" && b.status === "active" && b.source_missing) {
    return { label: "Waiting for you", variant: "warning" };
  }
  if (needsALook(b)) {
    return { label: "Needs a look", variant: b.state === "failing" ? "error" : "warning" };
  }
  return { label: "Backed up", variant: "success" };
}

/** Most urgent first: hard errors, then the oldest good copy (0 = never). */
export function sortByUrgency(list) {
  return [...list].sort(
    (a, b) => Number(!!b.hard) - Number(!!a.hard) || (a.last_ok_at || 0) - (b.last_ok_at || 0),
  );
}

/** @param {any} b @param {number} [now] */
export function lastGoodCopyLine(b, now = Date.now()) {
  return b.last_ok_at
    ? `Last good copy ${formatRecentAgo(b.last_ok_at * 1000, now)}`
    : "No good copy yet";
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
  if (count === 0) return "All backed up";
  if (count === 1) return "1 backup needs a look";
  return `${count} backups need a look`;
}

/**
 * Count line for the card, with the newest cloud check when there is one.
 * @param {BackupRow[]} rows
 * @param {number} [now]
 */
export function lastTestedLine(rows, now = Date.now()) {
  const count = `${rows.length} ${rows.length === 1 ? "backup" : "backups"}`;
  const checks = rows
    .filter((r) => r.kind === "cloud" && r.last_checked_at)
    .map((r) => Number(r.last_checked_at));
  if (checks.length === 0) return count;
  const ago = formatRecentAgo(Math.max(...checks) * 1000, now);
  const when = ago === "Just now" ? "just now" : ago;
  return `${count} · copies last tested ${when}`;
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
