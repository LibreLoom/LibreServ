/**
 * Haptics — the Simplex Mono design language calls for well-tuned, noticeable
 * haptics with a user-accessible toggle. On the web this uses the Vibration
 * API (`navigator.vibrate`); unsupported platforms silently no-op.
 *
 * `haptic()` is wired into the shared primitives (Button, Toggle,
 * SegmentedControl, Dropdown) and the ToastContext so every interaction and
 * outcome gets feedback from one place — do not sprinkle it through pages.
 *
 * PWM intensity modulation adapted from web-haptics (lochie/web-haptics, MIT).
 * The Vibration API has no amplitude control — only on/off durations. We fake
 * 0–1 intensity by duty-cycling a 20 ms PWM cycle: at intensity 0.5 the motor
 * is on 10 ms / off 10 ms per cycle, producing a softer perceived buzz than a
 * plain continuous vibration. This is perceptibly effective on Android LRAs.
 *
 * Preset vocabulary maps to iOS haptic generator semantics (UIImpactFeedback,
 * UINotificationFeedback, UISelectionFeedback) so the naming is familiar and
 * the feel is consistent across interaction types.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "haptics-enabled";
const CHANGE_EVENT = "libreserv:haptics-changed";

const PWM_CYCLE = 20; // ms per intensity modulation cycle

/**
 * Preset vibration patterns. Each vibration has a duration (ms), optional
 * intensity (0–1, default 0.5), and optional delay (ms before this vibration).
 *
 * Impact presets — single taps at varying intensity:
 *   selection  8 ms / 0.3  — barely-there selection change
 *   light     15 ms / 0.4  — subtle press feedback
 *   medium    25 ms / 0.7  — standard interaction
 *   heavy     35 ms / 1.0  — significant action
 *   rigid     10 ms / 1.0  — hard, crisp, precise
 *   soft      40 ms / 0.5  — cushioned, rounded
 *
 * Notification presets — multi-tap outcome patterns:
 *   success   ascending double-tap
 *   warning   two taps with hesitation
 *   error     three rapid harsh taps
 *
 * Custom:
 *   nudge     strong tap followed by a soft tap
 */
const PATTERNS = {
  selection: [{ duration: 8, intensity: 0.3 }],
  light: [{ duration: 15, intensity: 0.4 }],
  medium: [{ duration: 25, intensity: 0.7 }],
  heavy: [{ duration: 35, intensity: 1 }],
  rigid: [{ duration: 10, intensity: 1 }],
  soft: [{ duration: 40, intensity: 0.5 }],

  success: [
    { duration: 30, intensity: 0.5 },
    { delay: 60, duration: 40, intensity: 1 },
  ],
  warning: [
    { duration: 40, intensity: 0.8 },
    { delay: 100, duration: 40, intensity: 0.6 },
  ],
  error: [
    { duration: 40, intensity: 0.7 },
    { delay: 40, duration: 40, intensity: 0.7 },
    { delay: 40, duration: 40, intensity: 0.9 },
    { delay: 40, duration: 50, intensity: 0.6 },
  ],

  nudge: [
    { duration: 80, intensity: 0.8 },
    { delay: 80, duration: 50, intensity: 0.3 },
  ],
};

/**
 * Apply PWM modulation to a single vibration duration at a given intensity.
 * Returns flat on/off segments for this vibration.
 * @param {number} duration - total on-time in ms
 * @param {number} intensity - 0 to 1
 * @returns {number[]} alternating on/off durations
 */
function modulateVibration(duration, intensity) {
  if (intensity >= 1) return [duration];
  if (intensity <= 0) return [];

  const onTime = Math.max(1, Math.round(PWM_CYCLE * intensity));
  const offTime = PWM_CYCLE - onTime;
  const result = [];

  let remaining = duration;
  while (remaining >= PWM_CYCLE) {
    result.push(onTime);
    result.push(offTime);
    remaining -= PWM_CYCLE;
  }
  if (remaining > 0) {
    const remOn = Math.max(1, Math.round(remaining * intensity));
    result.push(remOn);
    const remOff = remaining - remOn;
    if (remOff > 0) result.push(remOff);
  }

  return result;
}

/**
 * Convert a Vibration array to the flat number[] pattern for navigator.vibrate(),
 * applying per-vibration PWM intensity modulation.
 * @param {{duration: number, intensity?: number, delay?: number}[]} vibrations
 * @param {number} defaultIntensity
 * @returns {number[]}
 */
function toVibratePattern(vibrations, defaultIntensity) {
  const result = [];

  for (const vib of vibrations) {
    const intensity = Math.max(0, Math.min(1, vib.intensity ?? defaultIntensity));
    const delay = vib.delay ?? 0;

    // Prepend delay: merge into trailing off-time or add new gap
    if (delay > 0) {
      if (result.length > 0 && result.length % 2 === 0) {
        result[result.length - 1] += delay;
      } else {
        if (result.length === 0) result.push(0);
        result.push(delay);
      }
    }

    const modulated = modulateVibration(vib.duration, intensity);

    if (modulated.length === 0) {
      // Zero intensity — treat vibration as silence
      if (result.length > 0 && result.length % 2 === 0) {
        result[result.length - 1] += vib.duration;
      } else if (vib.duration > 0) {
        result.push(0);
        result.push(vib.duration);
      }
      continue;
    }

    for (const seg of modulated) {
      result.push(seg);
    }
  }

  return result;
}

function isHapticsEnabled() {
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
 * Whether the Vibration API is available on this platform.
 * True on Android Chrome; false on iOS Safari and desktop Safari.
 */
const isHapticsSupported =
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/**
 * Fire a haptic pattern. No-ops when haptics are disabled or the platform
 * has no vibration support (iOS, desktop Safari).
 * @param {"selection"|"light"|"medium"|"heavy"|"rigid"|"soft"|"success"|"warning"|"error"|"nudge"} [pattern]
 */
export function haptic(pattern = "light") {
  if (!isHapticsEnabled()) return;
  if (!isHapticsSupported) return;
  const vibrations = PATTERNS[pattern];
  if (!vibrations) return;
  navigator.vibrate(toVibratePattern(vibrations, 0.5));
}
