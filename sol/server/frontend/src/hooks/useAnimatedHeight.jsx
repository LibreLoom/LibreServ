import { useLayoutEffect, useRef, useState } from "react";

/** Matches `--motion-duration-medium2` plus a little slack for transitionend miss. */
export const HEIGHT_SETTLE_MS = 350;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Used CSS max-height in px, or null when missing / unusable.
 * `parseFloat("100%")` is 100 — that falsely capped modals at 100px when
 * `max-h-full` did not resolve. Only trust computed values that end in `px`.
 * @param {HTMLElement} outer
 * @returns {number | null}
 */
export function resolvedMaxHeightPx(outer) {
  const raw = getComputedStyle(outer).maxHeight;
  if (!raw || raw === "none" || !raw.endsWith("px")) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n);
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
 * `needsVerticalScroll` is true only when content is taller than the outer's CSS
 * max-height (modal already at its viewport cap). ModalCard enables overflow-y
 * only then — never while the modal can still grow with the content.
 *
 * @param {boolean} [enabled=true] When false, disconnects and clears the outer height.
 */
export function useAnimatedHeight(enabled = true) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [needsVerticalScroll, setNeedsVerticalScroll] = useState(false);
  const settleTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  useLayoutEffect(() => {
    if (!enabled) {
      if (outerRef.current) outerRef.current.style.height = "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync flags when disabled
      setIsAnimating(false);
      setNeedsVerticalScroll(false);
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
      const uncapped = contentHeight + margins;
      let targetHeight = uncapped;
      let constrained = false;

      // When outer has a resolved CSS max-height in px (e.g. modal calc(95vh - 4rem)),
      // cap the inline height to avoid dead-zone delay when animating down from large
      // content. Content taller than that cap is the only case that needs a vertical
      // scrollbar. Ignore % / keywords — parseFloat("100%") === 100 is not a real cap.
      const maxH = resolvedMaxHeightPx(outer);
      if (maxH != null && uncapped > maxH) {
        constrained = true;
        targetHeight = maxH;
      }

      if (!cancelled) setNeedsVerticalScroll(constrained);

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
      setNeedsVerticalScroll(false);
    };
  }, [enabled]);

  return { outerRef, innerRef, isAnimating, needsVerticalScroll };
}
