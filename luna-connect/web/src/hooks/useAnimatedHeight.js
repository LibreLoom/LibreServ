import { useEffect, useRef } from "react";

/**
 * Smooth height transitions for cards with changing content.
 * Measures inner content with ResizeObserver and sets an explicit pixel height
 * on the outer container so height can animate between known values.
 *
 * @returns {{ outerRef: import("react").RefObject<HTMLElement|null>, innerRef: import("react").RefObject<HTMLElement|null> }}
 */
export function useAnimatedHeight() {
  const outerRef = useRef(null);
  const innerRef = useRef(null);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const applyHeight = () => {
      outer.style.height = `${inner.offsetHeight}px`;
    };

    if (typeof ResizeObserver === "undefined") {
      applyHeight();
      return undefined;
    }

    const ro = new ResizeObserver(applyHeight);
    ro.observe(inner);

    return () => ro.disconnect();
  }, []);

  return { outerRef, innerRef };
}
