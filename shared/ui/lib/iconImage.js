import { useSyncExternalStore } from "react";

// Lucide icons painted as CSS background images instead of inline <svg>.
//
// An inline SVG is a small document of its own: a transform for its viewBox,
// a clip, and a paint chunk per icon. Long lists carry eight or so per row,
// and scrolling a big folder spent half of every frame painting and
// layerizing them (W6). A background image of the same icon is one image
// draw, decoded once per icon and color. Images can't use currentColor, so
// the stroke color is the theme's own token value, read from the root.

/** @typedef {"primary" | "secondary"} Tone */

/** Only colors the theme writes (hex, rgb[a], hsl[a]) ever reach a URL. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9.,%\s/]+\))$/i;

/** @type {WeakMap<object, { size: number, node: Array<[string, Record<string, any>]> } | null>} */
const nodeCache = new WeakMap();

/**
 * The shapes inside a lucide icon component, or null when this lucide
 * version hides them (callers then draw the normal <svg>).
 * @param {any} Icon
 */
function iconShapes(Icon) {
  if (!Icon || (typeof Icon !== "object" && typeof Icon !== "function")) return null;
  if (nodeCache.has(Icon)) return nodeCache.get(Icon);
  let shapes = null;
  try {
    // A lucide icon is forwardRef(() => <Icon icon|iconNode=… />).
    const props = typeof Icon.render === "function" ? Icon.render({}, null)?.props : null;
    const node = props?.icon?.node ?? props?.iconNode;
    if (Array.isArray(node) && node.length && node.every((n) => Array.isArray(n) && typeof n[0] === "string")) {
      shapes = { size: Number(props?.icon?.size) || 24, node };
    }
  } catch {
    shapes = null;
  }
  nodeCache.set(Icon, shapes);
  return shapes;
}

/** @param {unknown} value */
const attr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** @type {WeakMap<object, Map<string, string | null>>} */
const urlCache = new WeakMap();

/**
 * `url("data:image/svg+xml,…")` for a lucide icon stroked in `color`, or
 * null when the icon's shapes or the color can't be used.
 * @param {any} Icon
 * @param {string | null | undefined} color
 */
export function iconImageUrl(Icon, color) {
  if (!color || !SAFE_COLOR.test(color)) return null;
  const shapes = iconShapes(Icon);
  if (!shapes) return null;
  let byColor = urlCache.get(Icon);
  if (!byColor) {
    byColor = new Map();
    urlCache.set(Icon, byColor);
  }
  let url = byColor.get(color);
  if (url === undefined) {
    const body = shapes.node
      .map(([tag, attrs]) => {
        const parts = Object.entries(attrs || {})
          .filter(([name]) => name !== "key" && /^[a-zA-Z-:]+$/.test(name))
          // An image has no currentColor of its own: a shape filled with it
          // takes the stroke color.
          .map(([name, value]) => `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${attr(value === "currentColor" ? color : value)}"`);
        return /^[a-z]+$/i.test(tag) ? `<${tag} ${parts.join(" ")}/>` : "";
      })
      .join("");
    const s = shapes.size;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" fill="none" stroke="${attr(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    byColor.set(color, url);
  }
  return url;
}

// One observer for the whole app: the theme writes --primary/--secondary on
// <html> (ThemeContext), and forced colors (high contrast) must keep real
// SVGs, which follow the system's colors. The colors are read once per
// change, not once per icon render.
/** @type {Set<() => void>} */
const listeners = new Set();
/** @type {MutationObserver | null} */
let observer = null;
/** @type {MediaQueryList | null} */
let forced = null;
/** @type {Record<Tone, string | null> | null} */
let tones = null;
const notify = () => {
  tones = null;
  for (const listener of listeners) listener();
};

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    if (typeof window !== "undefined" && window.matchMedia) {
      forced = window.matchMedia("(forced-colors: active)");
      forced.addEventListener?.("change", notify);
    }
    tones = null;
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && observer) {
      observer.disconnect();
      observer = null;
      forced?.removeEventListener?.("change", notify);
      forced = null;
      tones = null;
    }
  };
}

/** @param {Tone} tone */
function readTone(tone) {
  if (typeof document === "undefined") return null;
  // Without the observer nothing would clear the cache, so read afresh.
  if (tones && observer) return tones[tone];
  const media = forced ?? (typeof window !== "undefined" ? window.matchMedia?.("(forced-colors: active)") : null);
  const style = document.documentElement.style;
  const read = (/** @type {Tone} */ name) => (media?.matches ? null : style.getPropertyValue(`--${name}`).trim() || null);
  tones = { primary: read("primary"), secondary: read("secondary") };
  return tones[tone];
}

const serverSnapshot = () => null;

/**
 * The color text in `tone` (text-primary / text-secondary) has right now, for
 * `iconImageUrl`. Null until the theme has set it, or in forced colors.
 * @param {Tone} tone
 */
export function useToneColor(tone) {
  return useSyncExternalStore(subscribe, () => readTone(tone), serverSnapshot);
}
