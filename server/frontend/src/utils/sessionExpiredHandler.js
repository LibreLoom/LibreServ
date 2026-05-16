export function triggerSessionExpired() {
  if (typeof window !== "undefined" && window.__triggerSessionExpired) {
    window.__triggerSessionExpired();
  }
}
