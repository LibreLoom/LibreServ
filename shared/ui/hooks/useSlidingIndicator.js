import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Keeps an indicator (a "puck") under the active item of a row whose items
 * have different widths. `SegmentedControl` covers equal-width columns; this
 * measures each item instead.
 *
 * The indicator is moved on the DOM directly — it is layout work, not React
 * state, and must not re-render its parent. It jumps into place when it first
 * appears or while `animate` is false (e.g. the row is folded away), and
 * transitions otherwise, so give it a transform/width transition in CSS.
 * It re-measures whenever the row resizes.
 *
 * @param {string | null} activeKey Key of the active item, or null for none.
 * @param {{ animate?: boolean }} [options]
 */
export function useSlidingIndicator(activeKey, { animate = true } = {}) {
  // Typed loosely so the refs fit whatever elements the caller renders.
  const trackRef = useRef(/** @type {any} */ (null));
  const indicatorRef = useRef(/** @type {any} */ (null));
  const items = useRef(/** @type {Record<string, HTMLElement | null>} */ ({}));
  const hadActiveRef = useRef(false);

  /** Ref callback for one item: `ref={registerItem(key)}`. */
  const registerItem = useCallback(
    (/** @type {string} */ key) => (/** @type {HTMLElement | null} */ el) => {
      items.current[key] = el;
    },
    [],
  );

  useLayoutEffect(() => {
    const indicator = indicatorRef.current;
    const track = trackRef.current;
    if (!indicator || !track) return undefined;

    const place = (/** @type {boolean} */ instant) => {
      const item = activeKey ? items.current[activeKey] : null;
      if (!item) {
        indicator.style.opacity = "0";
        return;
      }
      if (instant) indicator.style.transition = "none";
      indicator.style.width = `${item.offsetWidth}px`;
      indicator.style.transform = `translateX(${item.offsetLeft}px)`;
      indicator.style.opacity = "1";
      if (instant) {
        // Commit the jump before handing motion back to CSS.
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
    };

    place(!hadActiveRef.current || !animate);
    hadActiveRef.current = Boolean(activeKey);

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => place(true));
    observer.observe(track);
    return () => observer.disconnect();
  }, [activeKey, animate]);

  return { trackRef, indicatorRef, registerItem };
}
