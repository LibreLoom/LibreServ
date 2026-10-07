import { useSyncExternalStore } from "react";

export const FILES_NAV_GROUPED_KEY = "lunaFilesNavGrouped";

const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

/** Read the saved choice. Off by default, so the bar keeps three separate buttons. */
export function getFilesNavGrouped() {
  try {
    return window.localStorage.getItem(FILES_NAV_GROUPED_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Cross-tab changes arrive as `storage` events (which never fire in the
// tab that made the change — same-page updates go through notify() in
// setFilesNavGrouped below), so fan those out to subscribers too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === FILES_NAV_GROUPED_KEY) notify();
  });
}

/** Persist the choice and wake every mounted hook in this page. */
export function setFilesNavGrouped(next) {
  try {
    if (next) window.localStorage.setItem(FILES_NAV_GROUPED_KEY, "1");
    else window.localStorage.removeItem(FILES_NAV_GROUPED_KEY);
  } catch {
    // Storage blocked — the choice just lasts for this visit.
  }
  notify();
}

/**
 * Whether the navigation bar groups Drives, Shared and Photos under one
 * Files item (the PR 188 behavior). Off shows each as its own button.
 *
 * One shared store, so the Settings switch and the nav bar always agree —
 * flipping the switch re-renders every mounted reader in this page.
 * @returns {[boolean, (next: boolean) => void]}
 */
export function useFilesNavGrouped() {
  const grouped = useSyncExternalStore(subscribe, getFilesNavGrouped, () => false);
  return [grouped, setFilesNavGrouped];
}
