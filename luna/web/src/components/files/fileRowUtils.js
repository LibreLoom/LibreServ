import { useSyncExternalStore } from "react";
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

const SM_UP_QUERY = "(min-width: 640px)";

/** @type {MediaQueryList | null} */
let smUpQuery = null;
/** @type {unknown} */
let smUpSource = null;
function smUpList() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  // Re-query when matchMedia itself was swapped (tests stub it per case).
  if (smUpSource !== window.matchMedia) {
    smUpSource = window.matchMedia;
    smUpQuery = window.matchMedia(SM_UP_QUERY);
  }
  return smUpQuery;
}
/** @param {() => void} onChange */
function subscribeSmUp(onChange) {
  const mq = smUpList();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const readSmUp = () => smUpList()?.matches ?? true;

/**
 * Phones get one action button; a missing matchMedia (tests) counts as desktop.
 * One shared media query for every row, instead of a listener and state each.
 */
export function useIsSmUp() {
  return useSyncExternalStore(subscribeSmUp, readSmUp, () => true);
}
