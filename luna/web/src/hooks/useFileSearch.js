import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";
import { MIN_SEARCH_LENGTH, parseSearchResponse, searchUrl } from "../lib/fileSearch.js";

const DEBOUNCE_MS = 250;
/** How often to ask again while Luna is still reading drives. */
const SCAN_POLL_MS = 1200;

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
  const trimmed = typed.trim();

  useEffect(() => {
    const t = setTimeout(() => setQ(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [trimmed]);

  // `q` trails the box by the debounce, so also require the live text to be
  // long enough — otherwise old results linger once the text gets too short.
  const active = enabled && q.length >= MIN_SEARCH_LENGTH && trimmed.length >= MIN_SEARCH_LENGTH;

  const query = useQuery({
    queryKey: ["search", q, kind],
    queryFn: () => getJson(searchUrl(q, kind)),
    enabled: active,
    placeholderData: keepPreviousData,
    refetchInterval: (state) => (state.state.data?.scan?.scanning ? SCAN_POLL_MS : false),
  });

  const { hits, closeOnly, scan } = parseSearchResponse(query.data);
  return {
    /** The text actually being searched (trails the box by the debounce). */
    q,
    active,
    hits: active ? hits : [],
    closeOnly: active && closeOnly,
    // Scan progress is useful even before anything is typed.
    scan,
    /** First answer for this search is on its way. */
    isLoading: active && query.isLoading,
    /** Showing the previous answer while a newer one loads. */
    isUpdating: active && query.isPlaceholderData,
    isError: active && query.isError,
    error: query.error,
  };
}
