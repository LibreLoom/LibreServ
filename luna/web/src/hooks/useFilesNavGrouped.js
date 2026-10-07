import { useCallback, useEffect, useState } from "react";

export const FILES_NAV_GROUPED_KEY = "lunaFilesNavGrouped";

/** Read the saved choice. Off by default, so the bar keeps three separate buttons. */
export function getFilesNavGrouped() {
  try {
    return window.localStorage.getItem(FILES_NAV_GROUPED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the navigation bar groups Drives, Shared and Photos under one
 * Files item (the PR 188 behavior). Off shows each as its own button.
 * @returns {[boolean, (next: boolean) => void]}
 */
export function useFilesNavGrouped() {
  const [grouped, setGroupedState] = useState(getFilesNavGrouped);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === FILES_NAV_GROUPED_KEY) setGroupedState(event.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setGrouped = useCallback((next) => {
    setGroupedState(next);
    try {
      if (next) window.localStorage.setItem(FILES_NAV_GROUPED_KEY, "1");
      else window.localStorage.removeItem(FILES_NAV_GROUPED_KEY);
    } catch {
      // Storage blocked — the choice just lasts for this visit.
    }
  }, []);

  return [grouped, setGrouped];
}
