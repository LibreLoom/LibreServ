/** Shortest wait between timeline refreshes while photos are indexing. */
export const INDEXING_REFRESH_MS = 4000;
/** Longest wait, so new photos still turn up while someone is scrolled deep. */
export const INDEXING_REFRESH_MAX_MS = 30_000;

/**
 * How long to wait between timeline refreshes while indexing. A refresh
 * refetches every page already loaded (the list is paged by offset, so pages
 * must be reloaded together), so its cost grows with how far the person has
 * scrolled; the wait grows with it to keep lunad's load flat during a scan.
 *
 * @param {number | undefined} pagesLoaded
 */
export function indexingRefreshDelay(pagesLoaded) {
  const pages = Math.max(1, Math.floor(Number(pagesLoaded) || 1));
  return Math.min(INDEXING_REFRESH_MAX_MS, INDEXING_REFRESH_MS * pages);
}
