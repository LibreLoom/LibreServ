/**
 * Haptics — the Simplex Mono design language calls for well-tuned, noticeable
 * haptics with a user-accessible toggle. On the web this uses the Vibration
 * API (`navigator.vibrate`); unsupported platforms silently no-op.
 *
 * `haptic()` is wired into the shared primitives (Button, Toggle,
 * SegmentedControl, Dropdown) so every interaction gets feedback from one
 * place — do not sprinkle it through pages.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "haptics-enabled";
const CHANGE_EVENT = "libreserv:haptics-changed";

/* Vibration patterns (ms): short and crisp for taps, grouped for outcomes. */
const PATTERNS = {
  tap: 12,
  confirm: [12, 40, 12],
  error: [50, 60, 50],
};

export function isHapticsEnabled() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : JSON.parse(stored);
  } catch {
    return true;
  }
}

export function setHapticsEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Boolean(enabled)));
  } catch {
    /* storage unavailable — the toggle still works for this session */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Reactive enabled-state, for the settings toggle. */
export function useHapticsEnabled() {
  return useSyncExternalStore(subscribe, isHapticsEnabled, () => true);
}

/**
 * Fire a haptic pattern. No-ops when haptics are disabled or the platform
 * has no vibration support.
 * @param {"tap"|"confirm"|"error"} [pattern]
 */
export function haptic(pattern = "tap") {
  if (!isHapticsEnabled()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(PATTERNS[pattern] ?? PATTERNS.tap);
}
