/**
 * Shared clipboard helpers for Luna web.
 *
 * The Clipboard API only works in a secure context (HTTPS, localhost).
 * On plain HTTP (common on a home LAN IP), navigator.clipboard is missing
 * or writeText throws — so callers must not show a fake "Copied" state.
 * Prefer {@link CopyableValue} so insecure pages get selectable text instead.
 */

const COPIED_RESET_MS = 2000;

/**
 * True when one-click clipboard write is available.
 * @returns {boolean}
 */
export function canUseClipboard() {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

/**
 * Write text to the clipboard. Returns false when the page is not secure
 * or the write fails — never pretends success.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  if (!canUseClipboard() || text == null) return false;
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text and briefly flip a "copied" boolean. No-ops (returns false) when
 * clipboard is unavailable — callers should use CopyableValue for UI.
 *
 * @param {string} text
 * @param {(copied: boolean) => void} setCopied
 * @returns {Promise<boolean>}
 */
export async function copyWithFeedback(text, setCopied) {
  const ok = await copyToClipboard(text);
  if (ok) {
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }
  return ok;
}

export { COPIED_RESET_MS };
