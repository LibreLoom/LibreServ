// The all-files search lives in one place (AppShell). Anything can open it —
// the header button, a keyboard shortcut — by sending this event.
export const OPEN_FILE_SEARCH_EVENT = "luna:open-file-search";

export function openFileSearch() {
  window.dispatchEvent(new Event(OPEN_FILE_SEARCH_EVENT));
}
