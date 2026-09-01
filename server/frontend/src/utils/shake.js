export const SHAKE_DURATION_MS = 500;

const SHAKE_EASING = "cubic-bezier(0.36, 0.07, 0.19, 0.97)";

const SHAKE_KEYFRAMES = [
  { transform: "translateX(0)" },
  { transform: "translateX(-12px)", offset: 0.1 },
  { transform: "translateX(12px)", offset: 0.2 },
  { transform: "translateX(-10px)", offset: 0.3 },
  { transform: "translateX(10px)", offset: 0.4 },
  { transform: "translateX(-6px)", offset: 0.55 },
  { transform: "translateX(6px)", offset: 0.7 },
  { transform: "translateX(-3px)", offset: 0.85 },
  { transform: "translateX(0)" },
];

/**
 * Apple-style horizontal shake on a DOM element.
 * @param {Element | null | undefined} el
 * @param {number} [durationMs]
 * @returns {Animation | undefined}
 */
export function shakeElement(el, durationMs = SHAKE_DURATION_MS) {
  if (!el || typeof el.animate !== "function") return undefined;

  el.getAnimations().forEach((animation) => animation.cancel());

  return el.animate(SHAKE_KEYFRAMES, {
    duration: durationMs,
    easing: SHAKE_EASING,
    fill: "none",
  });
}

/**
 * Stable serialization for error triggers (strings, numbers, plain objects).
 * @param {unknown} trigger
 * @returns {string}
 */
export function serializeShakeTrigger(trigger) {
  if (trigger == null || trigger === false || trigger === "") return "";
  if (typeof trigger === "string" || typeof trigger === "number" || typeof trigger === "boolean") {
    return String(trigger);
  }
  if (typeof trigger === "object") {
    try {
      return JSON.stringify(trigger);
    } catch {
      return "[object]";
    }
  }
  return String(trigger);
}

/**
 * Derive a shake key from Callout content without serializing React nodes.
 * @param {"success"|"warning"|"error"|"info"|"neutral"} tone
 * @param {import("react").ReactNode} title
 * @param {import("react").ReactNode} children
 * @returns {string}
 */
export function calloutShakeTrigger(tone, title, children) {
  if (tone !== "error") return "";
  if (typeof title === "string" && title) return title;
  if (typeof children === "string" && children) return children;
  if (title != null || children != null) return "__callout_error__";
  return "";
}
