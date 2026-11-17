import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";
import { MIN_SEARCH_LENGTH, parseSearchResponse, searchUrl } from "../lib/fileSearch.js";

/** Names and text: cheap (a quick name answer takes lunad well under 100 ms),
 * so ask as soon as a key lands. Keys inside this window share one request,
 * and a newer request cancels the one still on its way (see `signal` below);
 * lunad still finishes a cancelled one. */
const QUICK_DEBOUNCE_MS = 30;
/** Photos and passages by meaning embed the query with a model (about a
 * second on Luna), so ask for them only once typing pauses. */
const FULL_DEBOUNCE_MS = 700;
/** How often to ask again while Luna is still reading drives. */
const SCAN_POLL_MS = 1200;
/** Reading inside files takes much longer; ask less often meanwhile. */
const CONTENT_POLL_MS = 5000;

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
  const [q, setQ] = useState("");
  const [fullQ, setFullQ] = useState("");
  const trimmed = typed.trim();

  useEffect(() => {
    const t = setTimeout(() => setQ(trimmed), QUICK_DEBOUNCE_MS);
    const full = setTimeout(() => setFullQ(trimmed), FULL_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      clearTimeout(full);
    };
  }, [trimmed]);

  // `q` trails the box by the debounce, so also require the live text to be
  // long enough — otherwise old results linger once the text gets too short.
  const active = enabled && q.length >= MIN_SEARCH_LENGTH && trimmed.length >= MIN_SEARCH_LENGTH;

  const quickQuery = useQuery({
    queryKey: ["search", q, kind, "quick"],
    // The signal aborts this request once newer text replaces it, so fast
    // typing doesn't leave a queue of stale answers on the connection.
    queryFn: ({ signal }) => getJson(searchUrl(q, kind, { quick: true }), { signal }),
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

  const { hits, closeOnly, truncated, incomplete, scan } = parseSearchResponse(query.data);
  return {
    /** The text actually being searched (trails the box by the debounce). */
    q,
    active,
    hits: active ? hits : [],
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
