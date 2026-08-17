/**
 * Shared clipboard helper — gives every copy action a consistent haptic and a
 * consistent copied-state reset window, so the ~10 copy sites across the app
 * can't drift apart. Prefer this over calling navigator.clipboard directly.
 *
 * Fires a `success` haptic on copy (the ascending double-tap). When a toast
 * follows, pass `suppressHaptic: true` — the toast itself fires the outcome
 * haptic via ToastContext, so we avoid a double-buzz.
 */
import { haptic } from "./haptics";

const COPIED_RESET_MS = 2000;

/**
 * Legacy fallback for insecure contexts (plain HTTP on a LAN IP), where the
 * Clipboard API isn't exposed. Uses a hidden textarea + execCommand("copy").
 * @param {string} text
 * @returns {Promise<void>} resolves on success, rejects on failure
 */
function legacyWriteText(text) {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand("copy")) {
        resolve();
      } else {
        reject(new Error("execCommand('copy') returned false"));
      }
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

/**
 * Write text to the clipboard with haptic feedback.
 * @param {string} text
 * @param {{ onSuccess?: () => void, onError?: () => void, suppressHaptic?: boolean }} [options]
 * @returns {Promise<boolean>} true if copied successfully
 */
export async function copyToClipboard(text, { onSuccess, onError, suppressHaptic = false } = {}) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      await legacyWriteText(text);
    }
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
 * @param {{ suppressHaptic?: boolean }} [options]
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
