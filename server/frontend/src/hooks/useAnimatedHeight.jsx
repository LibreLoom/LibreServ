import { useLayoutEffect, useRef } from "react";

/**
 * useAnimatedHeight - smooth height transitions for cards with changing content.
 *
 * CSS `transition` cannot animate `height: auto`. This hook measures the inner
 * content with ResizeObserver and sets an explicit pixel height on the outer
 * container so the browser can transition px → px when content grows or shrinks.
 *
 * @param {boolean} [enabled=true] When false, disconnects and clears the outer height.
 */
export function useAnimatedHeight(enabled = true) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);

  useLayoutEffect(() => {
    if (!enabled) {
      if (outerRef.current) outerRef.current.style.height = "";
      return undefined;
    }

    let cancelled = false;
    /** @type {ResizeObserver | null} */
    let ro = null;

    const applyHeight = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const { marginTop, marginBottom } = getComputedStyle(inner);
      const margins = (parseFloat(marginTop) || 0) + (parseFloat(marginBottom) || 0);
      outer.style.height = `${inner.offsetHeight + margins}px`;
    };

    const bind = () => {
      if (cancelled) return;
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) {
        requestAnimationFrame(bind);
        return;
      }
      applyHeight();
      ro = new ResizeObserver(applyHeight);
      ro.observe(inner);
    };

    bind();

    return () => {
      cancelled = true;
      ro?.disconnect();
      if (outerRef.current) outerRef.current.style.height = "";
    };
  }, [enabled]);

  return { outerRef, innerRef };
}
