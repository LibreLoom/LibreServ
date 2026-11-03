import { displayLabel } from "./healthChecks.js";

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

const DRIVE_SMART = /^drive_.+_smart$/;
/** Checks about Luna's own built-in disk, not the person's drives. */
export const SYSTEM_DISK_CHECKS = new Set(["disk_space", "data_path_writable", "logs_path_writable"]);
export const SYSTEM_DISK_HINT = "Luna keeps its own software and settings on a small built-in disk, separate from your drives.";

/**
 * Failed checks with no fix a person can carry out. They are not "Needs you"
 * rows, because a row promises an action and these have none — the only thing
 * anyone can do is read them, and that belongs on the System checks card. They
 * still show in the dashboard's header pill so a failing Luna isn't silent.
 *
 * `disk_space` is here even though Settings → About → System checks can now
 * clear temporary files: the fix lives there, not on the row.
 */
export const NO_ACTION_CHECKS = new Set(["disk_space", "data_path_writable", "database"]);

const DRIVE_READ_WRITE = /^drive_.+_read_write$/;

/**
 * What the dashboard's header pill lists: every warning (a feature that won't
 * work) plus the failed checks that have no Needs you row. The page also asks
 * this to know whether the pill will draw anything, so the header never
 * reserves room for an empty one.
 *
 * @param {{ checks?: Record<string, { status: string, message?: string, category?: string }> } | null | undefined} systemChecks
 * @returns {Array<{ name: string, label: string, message?: string, status: string }>}
 */
export function pillChecks(systemChecks) {
  const checks = systemChecks?.checks;
  if (!checks || typeof checks !== "object") return [];
  return Object.entries(checks)
    .filter(([name, result]) => {
      if (result?.status === "warning") return true;
      return result?.status === "failed" && NO_ACTION_CHECKS.has(name);
    })
    .map(([name, result]) => ({
      name,
      label: displayLabel(name, result),
      message: result?.message,
      status: result?.status === "failed" ? "failed" : "warning",
    }));
}

/**
 * One "Needs you" row per failed system health check that the person can
 * actually do something about. Warnings, and failures with no action, stay in
 * the header pill. Each exclusion names the row that already covers the check.
 *
 * Only a few checks can fail at all: Luna's clock and a drive's save test.
 * Everything else lunad reports is a warning at worst.
 *
 * @param {{
 *   systemChecks: { checks?: Record<string, { status: string, message?: string, category?: string, details?: { drive_label?: string, [k: string]: any } }> } | null | undefined,
 *   coveredDriveLabels?: string[],
 *   noRouteShown?: boolean,
 * }} input
 * @returns {NeedsYouItem[]}
 */
export function buildSystemCheckItems({
  systemChecks,
  coveredDriveLabels = [],
  noRouteShown = false,
}) {
  const checks = systemChecks?.checks;
  if (!checks || typeof checks !== "object") return [];

  /** @type {NeedsYouItem[]} */
  const items = [];
  for (const [name, check] of Object.entries(checks)) {
    if (check?.status !== "failed") continue;
    // Nothing the person can do about it: the pill carries it instead.
    if (NO_ACTION_CHECKS.has(name)) continue;
    // Backup rows already cover backup checks.
    if (check.category === "backups") continue;
    // The drive health row covers hard drive wear checks.
    if (DRIVE_SMART.test(name)) continue;
    // A wrong clock is almost always "no internet", which the no-route row
    // already says, with the same fix. Two rows with one fix is noise.
    if (name === "clock" && noRouteShown) continue;

    /** @type {NeedsYouItem} */
    const item = {
      id: `check:${name}`,
      rank: 20,
      tone: "problem",
      title: [displayLabel(name, check)],
      action: { label: "Open system checks", href: "/settings#about" },
    };

    if (DRIVE_READ_WRITE.test(name)) {
      // The drive's own row already says what is wrong with it.
      const label = check.details?.drive_label;
      if (typeof label === "string" && coveredDriveLabels.includes(label)) continue;
      item.action = { label: "Open Files", href: "/files" };
    }

    if (typeof check.message === "string" && check.message.trim() !== "") {
      item.detail = check.message;
    }
    items.push(item);
  }
  return items.sort(byId);
}

/** @param {NeedsYouItem} a @param {NeedsYouItem} b */
function byId(a, b) {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
