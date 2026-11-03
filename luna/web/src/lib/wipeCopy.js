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
 * Turn an Add-drive inspection into the shape the wipe dialog expects.
 *
 * A drive Luna has not added yet has a device name (`sdb`), not an id, so it
 * cannot fetch `/wipe-preview`. It does not need to: `inspect` already
 * measured the same thing and decided `meaningful` with the same rule, so the
 * values are mapped straight across and both flows show one dialog.
 *
 * @param {any} result the `/inspect` response
 * @param {string} label the name the person is giving the drive
 * @returns {import("./encryption.js").WipePreview | undefined}
 */
export function previewFromInspection(result, label) {
  if (!result) return undefined;
  return {
    drive_id: result.device,
    label,
    used_bytes: result.used_bytes ?? null,
    meaningful: Boolean(result.meaningful),
    // Adding a drive always leaves it plain and readable anywhere.
    target_fs: "exfat",
    target_encrypted: false,
    entries: Array.isArray(result.entries) ? result.entries : [],
    folders: Number(result.folders) || 0,
    files: Number(result.files) || 0,
    readable: Boolean(result.readable),
  };
}

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
