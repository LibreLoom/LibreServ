import { useLayoutEffect, useRef, useState } from "react";

/** Matches `--motion-duration-medium2` plus a little slack for transitionend miss. */
export const HEIGHT_SETTLE_MS = 350;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * useAnimatedHeight - smooth height transitions for cards and modals with changing content.
 *
 * CSS `transition` cannot animate `height: auto`. This hook measures the inner
 * content with ResizeObserver and sets an explicit pixel height on the outer
 * container so the browser can transition px → px when content grows or shrinks.
 *
 * `isAnimating` is true while a px→px height change is in flight — ModalCard uses
 * this to keep overflow clipped so scrollbars do not flash during the resize.
 *
 * @param {boolean} [enabled=true] When false, disconnects and clears the outer height.
 */
export function useAnimatedHeight(enabled = true) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const settleTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  useLayoutEffect(() => {
    if (!enabled) {
      if (outerRef.current) outerRef.current.style.height = "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync anim flag when disabled
      setIsAnimating(false);
      return undefined;
    }

    let cancelled = false;
    /** @type {ResizeObserver | null} */
    let ro = null;
    /** @type {number | null} */
    let resizeRaf = null;

    /** @type {HTMLElement | null} */
    let outerAtBind = null;

    const clearSettleTimer = () => {
      if (settleTimerRef.current != null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    const markSettled = () => {
      clearSettleTimer();
      if (!cancelled) setIsAnimating(false);
    };

    const markAnimating = () => {
      if (prefersReducedMotion()) {
        markSettled();
        return;
      }
      if (!cancelled) setIsAnimating(true);
      clearSettleTimer();
      settleTimerRef.current = setTimeout(markSettled, HEIGHT_SETTLE_MS);
    };

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

      const prevHeight = outer.style.height ? parseFloat(outer.style.height) : Number.NaN;
      outer.style.height = `${targetHeight}px`;

      // First paint (no prior px height) should not flag animating — pop-in / scrollReady
      // already covers open. Later px→px changes are the scrollbar-flash case.
      if (!Number.isNaN(prevHeight) && Math.abs(prevHeight - targetHeight) > 0.5) {
        markAnimating();
      }
    };

    const onTransitionEnd = (event) => {
      if (event.target !== outerRef.current) return;
      if (event.propertyName !== "height") return;
      markSettled();
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
      outer.addEventListener("transitionend", onTransitionEnd);
      outer.addEventListener("transitioncancel", onTransitionEnd);
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
      clearSettleTimer();
      ro?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeRaf != null) cancelAnimationFrame(resizeRaf);
      if (outerAtBind) {
        outerAtBind.removeEventListener("transitionend", onTransitionEnd);
        outerAtBind.removeEventListener("transitioncancel", onTransitionEnd);
        outerAtBind.style.height = "";
      }
      setIsAnimating(false);
    };
  }, [enabled]);

  return { outerRef, innerRef, isAnimating };
}
