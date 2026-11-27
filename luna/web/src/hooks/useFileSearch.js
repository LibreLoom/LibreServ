import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";
import { MIN_SEARCH_LENGTH, parseSearchResponse, searchUrl } from "../lib/fileSearch.js";

/* Names and text are cheap (a quick name answer takes lunad well under
 * 100 ms), so the quick search asks on every key, with no debounce: a key
 * waiting even 30 ms showed in W10. A newer request cancels the one still on
 * its way (see `signal` below); lunad still finishes a cancelled one. */
/** Photos and passages by meaning embed the query with a model (about a
 * second on Luna), so ask for them only once typing pauses. */
const FULL_DEBOUNCE_MS = 700;
/** How often to ask again while Luna is still reading drives. */
const SCAN_POLL_MS = 1200;
/** Reading inside files takes much longer; ask less often meanwhile. */
const CONTENT_POLL_MS = 5000;
const EMPTY_HITS = [];

/**
 * Debounced file search that keeps working while Luna is still reading
 * drives: it asks again every moment until the scan finishes, and the
 * previous answer stays on screen until the next one lands, so rows slide in
 * instead of the list blinking away.
 *
 * @param {string} typed what's in the search box
 * @param {{ enabled?: boolean, kind?: "all" | "dir" | "file" }} [options]
 */
export default function useFileSearch(typed, { enabled = true, kind = "all" } = {}) {
  const [fullQ, setFullQ] = useState("");
  const trimmed = typed.trim();
  const q = trimmed;

  useEffect(() => {
    if (!enabled || trimmed.length < MIN_SEARCH_LENGTH) return undefined;
    const full = setTimeout(() => setFullQ(trimmed), FULL_DEBOUNCE_MS);
    return () => clearTimeout(full);
  }, [enabled, trimmed]);

  const active = enabled && q.length >= MIN_SEARCH_LENGTH;

  const quickQuery = useQuery({
    queryKey: ["search", q, kind, "quick"],
    // The signal aborts this request once newer text replaces it, so fast
    // typing doesn't leave a queue of stale answers on the connection.
    // Carry the answer's text through placeholderData so its existing rows
    // keep the same highlights while the next answer is on its way.
    queryFn: async ({ signal }) => ({
      q,
      data: await getJson(searchUrl(q, kind, { quick: true }), { signal }),
    }),
    enabled: active,
    placeholderData: keepPreviousData,
  });
  // The full answer (with photos and meaning) for the same text replaces the
  // quick one once it lands; it alone keeps polling while drives are read.
  const fullActive = active && fullQ === q;
  const fullQuery = useQuery({
    queryKey: ["search", fullQ, kind],
    queryFn: ({ signal }) => getJson(searchUrl(fullQ, kind), { signal }),
    enabled: fullActive,
    refetchInterval: (state) => {
      const scan = state.state.data?.scan;
      if (scan?.scanning) return SCAN_POLL_MS;
      return scan?.contents_reading ? CONTENT_POLL_MS : false;
    },
  });
  const useFull = fullActive && fullQuery.data !== undefined;
  const query = useFull ? fullQuery : quickQuery;

  const data = useFull ? fullQuery.data : quickQuery.data?.data;
  const { hits, closeOnly, truncated, incomplete, scan } = useMemo(() => parseSearchResponse(data), [data]);
  return {
    /** The text being searched (the box, trimmed). */
    q,
    resultQ: useFull ? fullQ : quickQuery.data?.q ?? q,
    active,
    hits: active ? hits : EMPTY_HITS,
    closeOnly: active && closeOnly,
    truncated: active && truncated,
    incomplete: active && incomplete,
    // Scan progress is useful even before anything is typed.
    scan,
    /** First answer for this search is on its way. */
    isLoading: active && query.isLoading,
    /** Showing the previous answer while a newer one loads. */
    isUpdating: active && query.isPlaceholderData,
    isError: active && query.isError,
    error: query.error,
    retry: query.refetch,
  };
}
