// Custom event approach — avoids fragile window global state.
// Any component can listen for 'libreserv:session-expired' on document,
// which is more robust than a mutable global function reference that
// can become stale or be overwritten.

let _fired = false;

export function triggerSessionExpired() {
  if (_fired) return; // fire once per expiry cycle
  _fired = true;

  if (typeof window !== "undefined") {
    document.dispatchEvent(new CustomEvent("libreserv:session-expired"));
  }

  // Reset after a short cooldown so a new session can expire later
  // (e.g. user re-logs in and session expires again).
  setTimeout(() => {
    _fired = false;
  }, 5000);
}
