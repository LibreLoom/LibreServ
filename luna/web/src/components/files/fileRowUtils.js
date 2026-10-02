import { canViewerOpen } from "../../lib/officeConvert.js";
import { viewerNeedsSession } from "../../lib/fileKinds.js";

/** What the user sees for this row — trash entries carry `original_name`. */
export function displayNameOf(entry) {
  return entry?.original_name || entry?.name || "";
}

/** Can this row open in the viewer? Trash keeps session kinds closed. */
export function canOpenRow(entry, displayName, trashView) {
  if (entry.kind !== "file" || !canViewerOpen(displayName)) return false;
  // A failed new file is only a placeholder row — nothing is on the drive.
  if (entry.save_failed && entry.size === 0) return false;
  if (trashView && viewerNeedsSession(displayName)) return false;
  return true;
}
