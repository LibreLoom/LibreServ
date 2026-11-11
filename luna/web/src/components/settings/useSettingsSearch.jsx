import { useEffect, useMemo, useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { buildSettingsIndex, searchSettings } from "@libreloom/ui/lib/settingsSearch.js";
import { AuthProvider } from "../../context/AuthContext";
import { CATEGORY_COMPONENTS } from "./categoryComponents.js";

/** The providers the categories need to draw once, outside the live page. */
export function settingsIndexWrapper(queryClient) {
  return (/** @type {import("react").ReactNode} */ node) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <ThemeProvider>
            <AuthProvider>{node}</AuthProvider>
          </ThemeProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * Search over the settings categories this person can see. The index is built by
 * rendering the categories once (see `buildSettingsIndex`), the first time the
 * search is used, so nothing here lists individual settings.
 *
 * @param {{ id: string, label: string }[]} categories
 * @param {string} query
 * @param {boolean} [preload]
 */
export default function useSettingsSearch(categories, query, preload = false) {
  const queryClient = useQueryClient();
  const [wanted, setWanted] = useState(false);
  const [built, setBuilt] = useState(/** @type {{ key: string, index: import("@libreloom/ui/lib/settingsSearch.js").SettingsHit[] } | null} */ (null));
  const key = categories.map((c) => c.id).join("|");

  const wrap = useMemo(() => settingsIndexWrapper(queryClient), [queryClient]);
  // Who can see which categories can change long after the first build, so the
  // index follows the list rather than the first one it saw.
  const list = useMemo(
    () => categories
      .filter((c) => CATEGORY_COMPONENTS[c.id])
      .map((c) => ({ id: c.id, label: c.label, Component: CATEGORY_COMPONENTS[c.id] })),
    [categories],
  );

  useEffect(() => {
    // Latch the first request so query and visibility changes cannot restart an in-flight index build.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!wanted && (preload || query.trim())) setWanted(true);
  }, [wanted, preload, query]);

  useEffect(() => {
    if (!wanted) return undefined;
    if (built?.key === key) return undefined;
    let cancelled = false;
    buildSettingsIndex(list, wrap, {
      onError: (id, error) => console.warn(`Settings search could not read "${id}"`, error),
    }).then((index) => {
      if (!cancelled) setBuilt({ key, index });
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, key, list, wrap, built?.key]);

  const index = built?.key === key ? built.index : null;
  const results = useMemo(() => (index ? searchSettings(index, query) : null), [index, query]);
  return { results, prepare: () => setWanted(true) };
}
