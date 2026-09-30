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
 */
export default function useSettingsSearch(categories, query) {
  const queryClient = useQueryClient();
  const [wanted, setWanted] = useState(false);
  const [built, setBuilt] = useState(/** @type {{ key: string, index: import("@libreloom/ui/lib/settingsSearch.js").SettingsHit[] } | null} */ (null));
  const key = categories.map((c) => c.id).join("|");

  const wrap = useMemo(() => settingsIndexWrapper(queryClient), [queryClient]);

  useEffect(() => {
    if (!wanted && !query.trim()) return undefined;
    if (built?.key === key) return undefined;
    let cancelled = false;
    const list = categories
      .filter((c) => CATEGORY_COMPONENTS[c.id])
      .map((c) => ({ id: c.id, label: c.label, Component: CATEGORY_COMPONENTS[c.id] }));
    buildSettingsIndex(list, wrap, {
      onError: (id, error) => console.warn(`Settings search could not read "${id}"`, error),
    }).then((index) => {
      if (!cancelled) setBuilt({ key, index });
    });
    return () => {
      cancelled = true;
    };
    // `categories` is covered by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, query, key, wrap, built?.key]);

  const index = built?.key === key ? built.index : null;
  const results = useMemo(() => (index ? searchSettings(index, query) : null), [index, query]);
  return { results, prepare: () => setWanted(true) };
}
