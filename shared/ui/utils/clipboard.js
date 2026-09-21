/**
 * Shared clipboard helper — gives every copy action a consistent haptic and a
 * consistent copied-state reset window, so the ~10 copy sites across the apps
 * can't drift apart. Prefer this over calling navigator.clipboard directly.
 *
 * The Clipboard API requires a secure context (HTTPS / localhost). On plain
 * HTTP (LAN IP) it is unavailable — use {@link canUseClipboard} and prefer
 * {@link CopyableValue} so the UI shows selectable text instead of a broken
 * Copy button that pretends to succeed.
 *
 * Fires a `success` haptic on copy (the ascending double-tap). When a toast
 * follows, pass `suppressHaptic: true` — the toast itself fires the outcome
 * haptic via ToastContext, so we avoid a double-buzz.
 */

import { haptic } from "./haptics.js";

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
 * Write text to the clipboard with haptic feedback.
 * Returns false when the page is not secure or the write fails.
 *
 * @param {string} text
 * @param {{ onSuccess?: () => void, onError?: () => void, suppressHaptic?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text, { onSuccess, onError, suppressHaptic = false } = {}) {
  if (!canUseClipboard() || text == null) {
    if (!suppressHaptic) haptic("error");
    onError?.();
    return false;
  }
  try {
    await navigator.clipboard.writeText(String(text));
    if (!suppressHaptic) haptic("success");
    onSuccess?.();
    return true;
  } catch {
    if (!suppressHaptic) haptic("error");
    onError?.();
    return false;
  }
}

/**
 * Copy text and briefly flip a "copied" boolean with haptic feedback.
 * No-ops (returns false) when clipboard is unavailable.
 *
 * @param {string} text
 * @param {(copied: boolean) => void} setCopied
 * @param {{ onSuccess?: () => void, onError?: () => void, suppressHaptic?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function copyWithFeedback(text, setCopied, options = {}) {
  const ok = await copyToClipboard(text, options);
  if (ok) {
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }
  return ok;
}

export { COPIED_RESET_MS };
