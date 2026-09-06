import { useLayoutEffect, useRef } from "react";

/**
 * useAnimatedHeight - smooth height transitions for cards and modals with changing content.
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
    /** @type {number | null} */
    let resizeRaf = null;

    /** @type {HTMLElement | null} */
    let outerAtBind = null;

    const applyHeight = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      const { marginTop, marginBottom } = getComputedStyle(inner);
      const margins = (parseFloat(marginTop) || 0) + (parseFloat(marginBottom) || 0);
      const contentHeight = Math.ceil(
        Math.max(inner.offsetHeight || 0, inner.getBoundingClientRect?.().height || 0)
      );
      let targetHeight = contentHeight + margins;

      // When outer has a CSS max-height (e.g. modal calc(95vh - 4rem)), cap the inline
      // height to avoid dead-zone delay when animating down from large content.
      const computedMax = parseFloat(getComputedStyle(outer).maxHeight);
      if (!isNaN(computedMax) && computedMax > 0) {
        targetHeight = Math.min(targetHeight, Math.ceil(computedMax));
      }

      outer.style.height = `${targetHeight}px`;
    };

    const onWindowResize = () => {
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(applyHeight);
    };

    const bind = () => {
      if (cancelled) return;
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) {
        requestAnimationFrame(bind);
        return;
      }
      outerAtBind = outer;
      applyHeight();
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(applyHeight);
        ro.observe(inner);
      }
      window.addEventListener("resize", onWindowResize);
    };

    bind();

    return () => {
      cancelled = true;
      ro?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf);
      if (outerAtBind) outerAtBind.style.height = "";
    };
  }, [enabled]);

  return { outerRef, innerRef };
}

