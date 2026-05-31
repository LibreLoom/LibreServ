const STORAGE_KEY = "libreserv_expired_shown";

export function triggerSessionExpired() {
  if (typeof window !== "undefined" && sessionStorage.getItem(STORAGE_KEY)) {
    return;
  }
  if (typeof window !== "undefined") {
    sessionStorage.setItem(STORAGE_KEY, "true");
    document.dispatchEvent(new CustomEvent("libreserv:session-expired"));
  }
}

export function resetSessionExpiredShown() {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}
