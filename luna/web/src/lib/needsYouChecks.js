import { displayLabel } from "./healthChecks.js";

/**
 * @typedef {{
 *   id: string,
 *   rank: number,
 *   tone: "problem" | "info",
 *   title: Array<string | { name: string }>,
 *   detail?: string,
 *   action?: { label: string, ariaLabel?: string, href?: string, intent?: "open-backup" | "check-phrase", payload?: any },
 * }} NeedsYouItem
 */

const DRIVE_SMART = /^drive_.+_smart$/;
const DRIVE_READ_WRITE = /^drive_.+_read_write$/;

/**
 * The checks that warn (a feature that won't work). They show in the header
 * pill, never as Needs you rows. The page also asks this to know whether the
 * pill will draw anything, so the header never reserves room for an empty one.
 *
 * @param {{ checks?: Record<string, { status: string, message?: string, category?: string }> } | null | undefined} systemChecks
 * @returns {Array<{ name: string, label: string, message?: string }>}
 */
export function warningChecks(systemChecks) {
  const checks = systemChecks?.checks;
  if (!checks || typeof checks !== "object") return [];
  return Object.entries(checks)
    .filter(([, result]) => result?.status === "warning")
    .map(([name, result]) => ({
      name,
      label: displayLabel(name, result),
      message: result?.message,
    }));
}

/**
 * One "Needs you" row per failed system health check. Warnings stay in the
 * header pill. Each exclusion names the row that already covers the check.
 *
 * @param {{
 *   systemChecks: { checks?: Record<string, { status: string, message?: string, category?: string, details?: { drive_label?: string, [k: string]: any } }> } | null | undefined,
 *   coveredDriveLabels?: string[],
 *   noRouteShown?: boolean,
 *   tokenShown?: boolean,
 * }} input
 * @returns {NeedsYouItem[]}
 */
export function buildSystemCheckItems({
  systemChecks,
  coveredDriveLabels = [],
  noRouteShown = false,
  tokenShown = false,
}) {
  const checks = systemChecks?.checks;
  if (!checks || typeof checks !== "object") return [];

  /** @type {NeedsYouItem[]} */
  const items = [];
  for (const [name, check] of Object.entries(checks)) {
    if (check?.status !== "failed") continue;
    // Backup rows already cover backup checks.
    if (check.category === "backups") continue;
    // The drive health row covers hard drive wear checks.
    if (DRIVE_SMART.test(name)) continue;
    // The no-route row covers the network check.
    if (name === "network" && noRouteShown) continue;
    // The device token row covers Connect and remote access.
    if ((name === "connect" || name === "remote_access") && tokenShown) continue;

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
