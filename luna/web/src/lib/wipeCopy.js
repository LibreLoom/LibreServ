/**
 * The words a wipe confirmation uses.
 *
 * Kept apart from the dialog component so the dialog file exports only a
 * component (fast refresh needs that), and so these can be tested without
 * rendering anything.
 */

/** How long the button stays disabled when the drive holds something. */
export const WIPE_WAIT_SECONDS = 30;

/**
 * What the wipe will leave behind, in plain words.
 * @param {import("./encryption.js").WipePreview | undefined} preview
 */
export function wipeTargetCopy(preview) {
  if (!preview) return "";
  if (preview.target_encrypted) {
    return "This drive will be encrypted, so only a Luna can read it.";
  }
  if (preview.target_fs === "exfat") {
    return "This drive will be readable on any computer.";
  }
  return "";
}

/**
 * The heading over the list of what is about to be lost.
 * @param {import("./encryption.js").WipePreview} preview
 */
export function wipeContentsHeading(preview) {
  if (!preview.readable) {
    return "Luna can't see inside this drive";
  }
  const total = preview.folders + preview.files;
  if (total === 0) return "This drive is empty";
  if (total === 1) return "This drive has 1 item on it";
  return `This drive has ${total} items on it`;
}

/**
 * The sentence under the list.
 * @param {import("./encryption.js").WipePreview} preview
 */
export function wipeContentsNote(preview) {
  if (!preview.readable) {
    return "It may be locked or unreadable. Anything on it will be lost.";
  }
  if (preview.folders + preview.files === 0) {
    return "There is nothing here to lose.";
  }
  return "Everything on it will be deleted. This can't be undone.";
}
