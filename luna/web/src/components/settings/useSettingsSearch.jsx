import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { buildSettingsIndex, searchSettings } from "@libreloom/ui/lib/settingsSearch.js";
import { AuthProvider } from "../../context/AuthContext";
import { settingsIndexCategories } from "./categoryComponents.js";

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
  const shouldBuild = wanted || query.trim().length > 0;

  const wrap = useMemo(() => settingsIndexWrapper(queryClient), [queryClient]);

  useEffect(() => {
    if (!shouldBuild) return undefined;
    if (built?.key === key) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    buildSettingsIndex(settingsIndexCategories(categories), wrap, {
      signal,
      onError: (id, error) => console.warn(`Settings search could not read "${id}"`, error),
    }).then((index) => {
      if (!signal.aborted) setBuilt({ key, index });
    });
    return () => controller.abort();
    // `categories` is covered by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldBuild, key, wrap, built?.key]);

  const index = built?.key === key ? built.index : null;
  const resultQuery = useDeferredValue(query);
  const results = useMemo(() => (index ? searchSettings(index, resultQuery) : null), [index, resultQuery]);
  const firstResult = () => resultQuery === query ? results?.[0] : index && searchSettings(index, query, 1)[0];
  return { results, resultQuery, firstResult, prepare: () => setWanted(true) };
}
