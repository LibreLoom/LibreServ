// The timeline's next listing page, fetched before anyone scrolls to it.
//
// A jump to the end of the loaded timeline used to wait for the next page's
// listing (one round trip) before the cells at the bottom existed, then for
// their thumbnails (a second one); over a remote link that was most of W8 in
// luna/perf. Each listing page is small (~7 KB for 80 photos), so the page
// after the last one shown is fetched as soon as that one lands. It is kept
// here, not in the query's pages, so nothing renders until the timeline
// actually asks for it.
//
// - A kept page is used once: a later refetch of the same offset asks Luna again.
// - Fetching the first page (a new list, or a refetch after a change or while
//   indexing) drops every kept page, so an offset never returns photos from
//   before the change.
// - A kept page older than AHEAD_MAX_AGE_MS is not used.

/** How long a fetched-ahead page stays usable (ms). */
export const AHEAD_MAX_AGE_MS = 60_000;
/** Most pages kept at once (one per list the person recently looked at). */
const AHEAD_MAX_PAGES = 4;

/** @type {Map<string, { at: number, page: Promise<any> }>} */
const kept = new Map();

/**
 * Fetch `url` now and keep the answer for takeListingPage().
 * @param {string} url
 * @param {(url: string) => Promise<any>} fetcher
 */
export function fetchListingAhead(url, fetcher) {
  if (kept.has(url)) return;
  const page = fetcher(url);
  // A failed look-ahead is forgotten; the real fetch asks again.
  page.catch(() => {
    if (kept.get(url)?.page === page) kept.delete(url);
  });
  kept.set(url, { at: Date.now(), page });
  while (kept.size > AHEAD_MAX_PAGES) kept.delete(kept.keys().next().value);
}

/**
 * A listing page: the one fetched ahead for `url` if there is one (even
 * still on its way), otherwise a fresh fetch.
 * @param {string} url
 * @param {(url: string) => Promise<any>} fetcher
 * @param {{ first?: boolean }} [opts] `first`: this is the list's first page
 */
export function takeListingPage(url, fetcher, { first = false } = {}) {
  if (first) kept.clear();
  const hit = kept.get(url);
  kept.delete(url);
  if (!hit || Date.now() - hit.at > AHEAD_MAX_AGE_MS) return fetcher(url);
  return hit.page.catch(() => fetcher(url));
}

/** Forget every kept page (tests). */
export function clearListingAhead() {
  kept.clear();
}
