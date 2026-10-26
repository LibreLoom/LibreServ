import { lastBackedUpLine, needsALook } from "./backupRows.js";

/**
 * @typedef {{
 *   id: string,
 *   rank: number,
 *   tone: "problem" | "info",
 *   title: Array<string | { name: string }>,
 *   detail?: string | Array<string | { name: string }>,
 *   action?: { label: string, ariaLabel?: string, href?: string, intent?: "open-backup" | "check-phrase", payload?: any },
 * }} NeedsYouItem
 */

/** @typedef {import("./backupRows.js").BackupRow} BackupRow */

const MISSING_SOURCE_DETAIL = "The folder or drive this backs up is not available right now.";
const FALLBACK_DETAIL = "The last copy did not finish. Open it to see what went wrong.";
const PHRASE_DETAIL = "It's been a while. Make sure your recovery phrase still opens your cloud backups.";

/**
 * A viewer sees their own rows. An Admin also sees everyone's rows, except a private row
 * that someone else created: nobody else can open that one.
 * @param {BackupRow} row
 * @param {{ isAdmin?: boolean, userId?: string }} viewer
 */
function canSee(row, { isAdmin, userId }) {
  const own = !!userId && row.created_by === userId;
  if (!isAdmin) return own;
  return own || !row.private;
}

/**
 * The backup rows this viewer may see, in the order given.
 * @param {BackupRow[] | null | undefined} backupRows
 * @param {{ isAdmin?: boolean, userId?: string }} [viewer]
 * @returns {BackupRow[]}
 */
export function visibleBackupRows(backupRows, viewer = {}) {
  return (backupRows ?? []).filter((row) => canSee(row, viewer));
}

/**
 * Title segments for a backup that needs a look. The first matching case wins.
 * @param {BackupRow} row
 * @returns {NeedsYouItem["title"]}
 */
function backupTitle(row) {
  if (row.state === "failing") return [{ name: row.source_name }, " backup didn't finish"];
  if (row.state === "stale") return [{ name: row.source_name }, " backup is out of date"];
  if (row.kind === "cloud" && row.source_missing) {
    return [{ name: row.source_name }, " backup can't find its original"];
  }
  return [{ name: row.source_name }, " backup needs a look"];
}

/** lunad's short "Drive full." reads as no drive at all, so spell out which kind. */
function plainError(error) {
  return /^drive full\.?$/i.test(error.trim()) ? "Backup drive is full." : error;
}

/**
 * The row's detail. A drive backup that failed names the backup drive; a stale one says
 * when it last finished, in the one wording every screen uses.
 * @param {BackupRow} row
 * @param {number} now
 * @returns {NeedsYouItem["detail"]}
 */
function backupDetail(row, now) {
  const error = row.last_error ? plainError(row.last_error) : "";
  const driveName = row.kind === "drive" ? row.destination : "";
  if (row.state === "failing" && driveName) {
    if (error === "Backup drive is full.") return [{ name: driveName }, " (the backup drive) is full."];
    if (error) return ["Backup drive ", { name: driveName }, ": ", error];
    return ["Backing up to ", { name: driveName }, " did not finish."];
  }
  if (row.state === "stale") {
    const age = lastBackedUpLine(row.last_ok_at, now);
    return error ? `${error} ${age}` : age;
  }
  return error || row.check_problem || (row.source_missing ? MISSING_SOURCE_DETAIL : FALLBACK_DETAIL);
}

/**
 * @param {BackupRow} row
 * @param {number} now
 * @returns {NeedsYouItem}
 */
function backupItem(row, now) {
  return {
    id: `backup:${row.kind}:${row.id}`,
    rank: 40,
    tone: "problem",
    title: backupTitle(row),
    detail: backupDetail(row, now),
    action: {
      label: "Open",
      ariaLabel: `Open ${row.source_name} backup`,
      intent: "open-backup",
      payload: row,
    },
  };
}

/** Plain code-unit order, so the result does not depend on the locale. */
function byId(a, b) {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * One Needs you item per visible backup that needs a look, sorted by id.
 * @param {{ backupRows?: BackupRow[] | null, isAdmin?: boolean, userId?: string, now?: number }} [input]
 * @returns {NeedsYouItem[]}
 */
export function buildBackupItems({ backupRows, isAdmin, userId, now = Date.now() } = {}) {
  return visibleBackupRows(backupRows, { isAdmin, userId })
    .filter(needsALook)
    .map((row) => backupItem(row, now))
    .sort(byId);
}

/**
 * The recovery phrase reminder. It shows when a check is due and the viewer can see
 * at least one cloud backup, because the phrase opens those.
 * @param {{
 *   backupRows?: BackupRow[] | null,
 *   phrase?: { check_due?: boolean } | null,
 *   isAdmin?: boolean,
 *   userId?: string,
 * }} [input]
 * @returns {NeedsYouItem | null}
 */
export function buildPhraseItem({ backupRows, phrase, isAdmin, userId } = {}) {
  if (phrase?.check_due !== true) return null;
  const hasCloud = visibleBackupRows(backupRows, { isAdmin, userId }).some((row) => row.kind === "cloud");
  if (!hasCloud) return null;
  return {
    id: "phrase-check",
    rank: 90,
    tone: "info",
    title: ["Check your recovery phrase"],
    detail: PHRASE_DETAIL,
    action: { label: "Check now", intent: "check-phrase" },
  };
}
