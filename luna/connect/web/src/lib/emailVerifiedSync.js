/** Cross-tab signal when email verification completes (e.g. link opened in another tab). */
export const EMAIL_VERIFIED_CHANNEL = "luna-connect-email-verified";
export const EMAIL_VERIFIED_STORAGE_KEY = "luna-connect-email-verified";

/** Tell other Luna Connect tabs that this account's email is verified. */
export function notifyEmailVerifiedCrossTab() {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(EMAIL_VERIFIED_CHANNEL);
      channel.postMessage({ verified: true });
      channel.close();
    }
    // storage events fire in other tabs only; set then remove to trigger listeners.
    localStorage.setItem(EMAIL_VERIFIED_STORAGE_KEY, String(Date.now()));
    localStorage.removeItem(EMAIL_VERIFIED_STORAGE_KEY);
  } catch {
    /* private mode / blocked storage */
  }
}

/**
 * @param {() => void} onVerified
 * @returns {() => void} cleanup
 */
export function listenForEmailVerifiedCrossTab(onVerified) {
  /** @type {BroadcastChannel | null} */
  let channel = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(EMAIL_VERIFIED_CHANNEL);
    channel.onmessage = () => onVerified();
  }

  /** @param {StorageEvent} event */
  const onStorage = (event) => {
    if (event.key === EMAIL_VERIFIED_STORAGE_KEY) onVerified();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener("storage", onStorage);
    if (channel) {
      channel.onmessage = null;
      channel.close();
    }
  };
}
