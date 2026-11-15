// Plain-language words and small calculations for the drive erase flow
// (FormatDriveFlow). The API is crates/lunad/src/api/drive_format.rs; every
// time in it is in unix seconds.

/** The named steps of a run, as lunad sends them, in plain words. */
export const PHASE_LABELS = {
  preparing: "Checking the drive",
  releasing: "Closing files and pausing backups",
  erasing: "Erasing the old contents",
  partitioning: "Preparing the drive",
  encrypting: "Setting up the password",
  formatting: "Setting it up for files",
  registering: "Adding it to Luna",
};

/** @param {string} phase */
export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || "Working";
}

/**
 * One sentence for each reason a start (or a preview) can be refused.
 * `weak_password` keeps lunad's own sentence: it names the exact rule.
 */
const START_ERRORS = {
  format_not_ready: "The wait isn't over yet. Try again when the countdown reaches zero.",
  preview_expired: "Luna's look at this drive is out of date. Look at the drive again.",
  preview_not_found: "Luna no longer has its look at this drive, which can happen after a restart. Look at the drive again.",
  drive_busy: "Luna is already working on this drive. Wait until it finishes, then try again.",
  drive_changed: "This isn't the drive that was shown, or it changed. Look at the drive again.",
  preview_stale: "Something on this drive changed since you looked. Look at the drive again.",
  missing_tool: "This Luna is missing a program it needs for this erase.",
  mock_encryption: "This test drive can't be protected with a password.",
  system_disk: "That's the drive Luna runs from. Luna won't erase it.",
};

/** Codes where the right next step is a fresh look at the drive. */
const STALE_CODES = new Set(["preview_expired", "preview_not_found", "drive_changed", "preview_stale"]);

/**
 * @param {{ code?: string | null, message?: string } | null | undefined} err an ApiError
 * @param {string} fallback
 */
export function startErrorMessage(err, fallback) {
  const code = err?.code || "";
  if (code === "weak_password" && err?.message) return err.message;
  if (START_ERRORS[code]) return START_ERRORS[code];
  return err?.message || fallback;
}

/** @param {{ code?: string | null } | null | undefined} err */
export function needsFreshPreview(err) {
  return STALE_CODES.has(err?.code || "");
}

/**
 * How far the server's clock is from this browser's, in seconds. Measured when
 * an answer arrives, so the wait is counted on the server's time, not ours.
 * @param {number} serverNow unix seconds from the server
 * @param {number} [clientNowMs]
 */
export function clockSkew(serverNow, clientNowMs = Date.now()) {
  return serverNow - clientNowMs / 1000;
}

/**
 * Seconds left until `readyAt`, never below zero.
 * @param {number} readyAt server unix seconds
 * @param {number} skew from {@link clockSkew}
 * @param {number} [clientNowMs]
 */
export function secondsUntil(readyAt, skew, clientNowMs = Date.now()) {
  return Math.max(0, Math.ceil(readyAt - (clientNowMs / 1000 + skew)));
}

/**
 * What one part of the drive holds, in one sentence for the states where the
 * contents can't be listed. `null` means the contents are listed instead.
 * @param {string} state a lunad PartitionState
 */
export function partitionStateLine(state) {
  switch (state) {
    case "unreadable":
      return "Luna can't read this part. It may be damaged, so its files can't be shown.";
    case "locked":
      return "This part is locked with a password, so Luna can't show what's inside.";
    case "unknown_filesystem":
      return "Luna doesn't recognise how this part is set up, so it can't show what's inside.";
    case "installer_media":
      return "This looks like an installer disk, the kind used to install an operating system.";
    default:
      return null;
  }
}

const UNREADABLE_STATES = new Set(["unreadable", "locked", "unknown_filesystem"]);

/**
 * The one line at the top of the preview. The server's `empty` verdict decides
 * whether anything is at risk; this only words what Luna found.
 * @param {{ empty?: boolean, blank?: boolean, partitions?: { state: string }[] }} preview
 * @returns {{ title: string, tone: "calm" | "careful" }}
 */
export function previewHeadline(preview) {
  const parts = preview.partitions || [];
  if (preview.empty) {
    return { title: preview.blank || parts.length === 0 ? "This drive is blank." : "This drive is empty.", tone: "calm" };
  }
  if (parts.some((p) => p.state === "installer_media")) {
    return { title: "This looks like an installer disk.", tone: "careful" };
  }
  if (parts.length === 0) return { title: "Luna can't read this drive.", tone: "careful" };
  if (parts.every((p) => UNREADABLE_STATES.has(p.state))) {
    return { title: "Luna can't read this drive.", tone: "careful" };
  }
  return { title: "This drive has files on it.", tone: "careful" };
}
