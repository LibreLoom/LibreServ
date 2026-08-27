/**
 * Shared clipboard helper — gives every copy action a consistent haptic and a
 * consistent copied-state reset window, so the ~10 copy sites across the app
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
import { haptic } from "./haptics";

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
 * Returns false (and calls onError) when the page is not secure or the write fails.
 * Does not use silent execCommand fallbacks — insecure pages should show
 * selectable text via CopyableValue instead of pretending Copy worked.
 *
 * @param {string} text
 * @param {{ onSuccess?: () => void, onError?: () => void, suppressHaptic?: boolean }} [options]
 * @returns {Promise<boolean>} true if copied successfully
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
 * Copy text and manage a "copied" boolean state with auto-reset.
 * For call sites that show a checkmark / "Copied" label for 2 seconds.
 *
 * @param {string} text
 * @param {(copied: boolean) => void} setCopied - state setter
 * @param {{ suppressHaptic?: boolean, onError?: () => void }} [options]
 * @returns {Promise<boolean>}
 */
export async function copyWithFeedback(text, setCopied, options = {}) {
  return copyToClipboard(text, {
    ...options,
    onSuccess: () => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    },
  });
}

export { COPIED_RESET_MS };
