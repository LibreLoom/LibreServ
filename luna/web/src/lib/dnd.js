/**
 * Shared drag-and-drop vocabulary for Luna's internal file drags.
 *
 * Rows in the file browser set both payloads on drag start; drop targets
 * (folder rows, breadcrumbs, the trash entry, the header drive menu) read
 * them on drop. The paths payload carries the dragged paths; the drive
 * payload carries the SOURCE drive so a spring-loaded cross-drive drop can
 * still post the right `from_drive` after the page switches drives.
 */

/** dataTransfer type holding a JSON array of dragged paths. */
export const LUNA_PATHS_MIME = "application/x-luna-paths";

/** dataTransfer type holding the source drive id of the drag. */
export const LUNA_DRIVE_MIME = "application/x-luna-drive";

/**
 * Hold-to-open delay before a drop target spring-loads during a drag —
 * long enough that a quick hover-through does not trigger it, short enough
 * to feel responsive. Shared by the file browser's folder rows and the
 * header drive menu's drive items.
 */
export const SPRING_LOAD_MS = 800;

/**
 * Whether a drag event carries an internal Luna file-drag payload.
 * @param {{ dataTransfer?: DataTransfer | null }} event
 */
export function hasLunaPaths(event) {
  const types = event.dataTransfer?.types;
  return Boolean(types) && Array.from(types).includes(LUNA_PATHS_MIME);
}

/**
 * Whether a drag event carries OS files (a desktop upload drag).
 * @param {{ dataTransfer?: DataTransfer | null }} event
 */
export function hasOsFiles(event) {
  const types = event.dataTransfer?.types;
  return Boolean(types) && Array.from(types).includes("Files");
}

/**
 * Read the dragged paths payload. Falls back when the payload is missing or
 * malformed — foreign drags spring-loaded in from another browser leave the
 * caller's ref empty, so the ref is the usual fallback.
 * @param {DataTransfer | null | undefined} dataTransfer
 * @param {string[]} [fallback]
 */
export function readLunaPaths(dataTransfer, fallback = []) {
  const raw = dataTransfer?.getData?.(LUNA_PATHS_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Keep fallback.
    }
  }
  return fallback;
}

/**
 * The source drive id carried by an internal drag, if present.
 * @param {DataTransfer | null | undefined} dataTransfer
 */
export function readLunaDrive(dataTransfer) {
  return dataTransfer?.getData?.(LUNA_DRIVE_MIME) || undefined;
}
