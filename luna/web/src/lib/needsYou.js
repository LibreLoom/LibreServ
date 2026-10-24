import { describeDriveHealth } from "./driveHealth.js";
import { formatBytes } from "./formatBytes.js";
import { buildBackupItems, buildPhraseItem } from "./needsYouBackups.js";
import { buildSystemCheckItems } from "./needsYouChecks.js";

/**
 * @typedef {{
 *   id: string,
 *   rank: number,
 *   tone: "problem" | "info",
 *   title: Array<string | { name: string }>,
 *   detail?: string | Array<string | { name: string }>,
 *   hint?: string,
 *   action?: { label: string, ariaLabel?: string, href?: string, intent?: "open-backup" | "check-phrase", payload?: any },
 * }} NeedsYouItem
 */

/**
 * @typedef {{
 *   isAdmin: boolean,
 *   userId: string,
 *   drives: Array<{ id: string, label: string, state: string }>,
 *   drivesLoading: boolean,
 *   driveSummaries: Record<string, { mounted?: boolean, total_bytes?: number | null, free_bytes?: number | null } | undefined>,
 *   driveHealth: Record<string, object | null | undefined>,
 *   systemChecks: { checks?: Record<string, any> } | null,
 *   backupRows: import("./backupRows.js").BackupRow[],
 *   phrase: { check_due?: boolean } | null,
 *   connect: { device_token_error?: string } | null,
 *   network: { has_default_route?: boolean } | null,
 *   detected: any[],
 *   now?: number,
 * }} NeedsYouInput
 */

/** A drive below this share of free space is flagged as almost full. */
const ALMOST_FULL_RATIO = 0.1;

/**
 * Every "Needs you" row for this viewer, most urgent first (lower rank first, ties by id).
 * Admins see drive, system, network, token and storage rows. Everyone sees
 * the backup rows they may open and the recovery phrase reminder.
 *
 * Pure: it reads only its input and never fetches. It reads the clock only when `now` is not given.
 *
 * @param {NeedsYouInput} input
 * @returns {NeedsYouItem[]}
 */
export function buildNeedsYouItems(input) {
  const isAdmin = !!input?.isAdmin;
  const userId = input?.userId ?? "";
  const backupRows = input?.backupRows ?? [];

  /** @type {NeedsYouItem[]} */
  const items = [];
  if (isAdmin) items.push(...buildAdminItems(input));

  items.push(...buildBackupItems({ backupRows, isAdmin, userId, now: input?.now }));
  const phraseItem = buildPhraseItem({ backupRows, phrase: input?.phrase ?? null, isAdmin, userId });
  if (phraseItem) items.push(phraseItem);

  return items.sort(byRankThenId);
}

/**
 * Rows only an Admin sees. Coverage flags are set only when the row they describe is made,
 * so a row that is not shown never hides another check.
 * @param {NeedsYouInput} input
 * @returns {NeedsYouItem[]}
 */
function buildAdminItems(input) {
  const drives = Array.isArray(input.drives) ? input.drives : [];
  const driveSummaries = input.driveSummaries ?? {};
  const driveHealth = input.driveHealth ?? {};

  /** @type {NeedsYouItem[]} */
  const items = [];
  /** @type {string[]} */
  const coveredDriveLabels = [];

  for (const drive of drives) {
    if (!drive) continue;

    if (drive.state === "failed") {
      items.push(driveFailedItem(drive));
      coveredDriveLabels.push(drive.label);
    }

    const health = driveHealth[drive.id];
    if (health != null) {
      const copy = describeDriveHealth(/** @type {any} */ (health));
      if (copy && (copy.pill === "warning" || copy.pill === "error")) {
        items.push(driveHealthItem(drive, copy));
        coveredDriveLabels.push(drive.label);
      }
    }

    const summary = driveSummaries[drive.id];
    if (isAlmostFull(drive, summary)) items.push(driveFullItem(drive, summary));
  }

  const tokenError = input.connect?.device_token_error;
  const tokenShown = typeof tokenError === "string" && tokenError.trim() !== "";
  if (tokenShown) items.push(deviceTokenItem(tokenError));

  const noRouteShown = input.network?.has_default_route === false;
  if (noRouteShown) items.push(noRouteItem());

  items.push(
    ...buildSystemCheckItems({
      systemChecks: input.systemChecks ?? null,
      coveredDriveLabels,
      noRouteShown,
      tokenShown,
    }),
  );

  // A drive Luna just found gets its own card on the dashboard, so "No drives yet" would contradict it.
  const driveWaiting = Array.isArray(input.detected) && input.detected.length > 0;
  if (!input.drivesLoading && drives.length === 0 && !driveWaiting) items.push(noDrivesItem());

  return items;
}

/** @param {{ id: string, label: string }} drive
 * @returns {NeedsYouItem}
 */
function driveFailedItem(drive) {
  return {
    id: `drive-failed:${drive.id}`,
    rank: 10,
    tone: "problem",
    title: [{ name: drive.label }, " ran into a problem"],
    detail: "Open Files to see what Luna found.",
    action: { label: "Open Files", href: "/files" },
  };
}

/**
 * @param {{ id: string, label: string }} drive
 * @param {{ pill: string, detail: string }} copy
 * @returns {NeedsYouItem}
 */
function driveHealthItem(drive, copy) {
  return {
    id: `drive-health:${drive.id}`,
    rank: 30,
    tone: "problem",
    title: [{ name: drive.label }, copy.pill === "error" ? " needs attention" : " is working, with a warning"],
    detail: copy.detail,
    action: { label: "Open Files", href: "/files" },
  };
}

/**
 * Only drives Luna can browse (as is or read-only) with a known, mounted size.
 * @param {{ state: string }} drive
 * @param {{ mounted?: boolean, total_bytes?: number | null, free_bytes?: number | null } | undefined} summary
 */
function isAlmostFull(drive, summary) {
  if (drive.state !== "as_is" && drive.state !== "readonly") return false;
  if (!summary?.mounted) return false;
  if (!(Number(summary.total_bytes) > 0)) return false;
  if (summary.free_bytes == null) return false;
  return Number(summary.free_bytes) / Number(summary.total_bytes) < ALMOST_FULL_RATIO;
}

/**
 * @param {{ id: string, label: string }} drive
 * @param {{ total_bytes?: number | null, free_bytes?: number | null }} summary
 * @returns {NeedsYouItem}
 */
function driveFullItem(drive, summary) {
  return {
    id: `drive-full:${drive.id}`,
    rank: 80,
    tone: "problem",
    title: [{ name: drive.label }, " is almost full"],
    detail: `${formatBytes(Number(summary.free_bytes))} free of ${formatBytes(Number(summary.total_bytes))}`,
    action: { label: "Browse files", href: `/files/${drive.id}` },
  };
}

/** @param {string} error
 * @returns {NeedsYouItem}
 */
function deviceTokenItem(error) {
  return {
    id: "device-token",
    rank: 50,
    tone: "problem",
    title: ["Luna Connect needs a new device token"],
    detail: error,
    action: { label: "Change the device token", href: "/settings#about" },
  };
}

/** @returns {NeedsYouItem} */
function noRouteItem() {
  return {
    id: "no-route",
    rank: 60,
    tone: "problem",
    title: ["Luna can't reach the internet"],
    detail: "Check that your router or modem is online.",
    action: { label: "Open system checks", href: "/settings#about" },
  };
}

/** @returns {NeedsYouItem} */
function noDrivesItem() {
  return {
    id: "no-drives",
    rank: 100,
    tone: "info",
    title: ["No drives yet"],
    detail: "Plug a USB drive into Luna to get started.",
  };
}

/**
 * Lower rank first; equal ranks by id, compared by code unit so the order does not depend on locale.
 * @param {NeedsYouItem} a
 * @param {NeedsYouItem} b
 */
function byRankThenId(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
