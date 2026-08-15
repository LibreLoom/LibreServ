import { useRef, useLayoutEffect, useEffect } from "react";

/**
 * useSmoothResize — smoothly transitions an element's dimensions when its
 * content changes (e.g. "Copy" → "Copied", or a dropdown label swap).
 * Measures the natural size via `max-content` / `auto`, then transitions
 * from the previous dimensions to the new ones over 250ms.
 *
 * Fixed dimensions are handled at the call site: pass `{ x: false }` when
 * the element has a fixed width (e.g. `w-full`).
 *
 * The effect only re-measures when the element's own content actually
 * changed. Re-renders for other reasons (parent state churn, unrelated prop
 * updates) are skipped: re-probing would swap the width to `max-content`
 * and back mid-transition, which cancels any in-flight transition and snaps
 * the element to its target size instead of animating it.
 *
 * Usage:
 *   const ref = useRef(null);
 *   useSmoothResize(ref);                        // x:on, y:off (default)
 *   useSmoothResize(ref, { x: true, y: true }); // both axes
 *   useSmoothResize(ref, false);                 // disabled (backward compat)
 *
 * @param {React.RefObject<HTMLElement>} ref - the element to resize
 * @param {{ x?: boolean, y?: boolean } | boolean} [options] - x defaults true, y defaults false.
 *   Pass a boolean for backward compat (true = x only, false = disabled).
 */
export function useSmoothResize(ref, options = {}) {
  const { x: animateX = true, y: animateY = false } =
    typeof options === "boolean" ? { x: options, y: false } : options;

  const prevW = useRef(null);
  const prevH = useRef(null);
  const init = useRef(false);
  const transitionTimer = useRef(null);
  // Signature of the element's last-measured content (class + text). When a
  // re-render leaves it untouched, the element cannot have changed size, so
  // we skip the probe entirely instead of clobbering an in-flight transition.
  const lastContentSig = useRef(null);
  // True when the element's width is controlled by its layout context
  // (grid/flex stretch, e.g. a Button inside a grid-cols-2 cell) rather than
  // its content. Pinning a px width would collapse it, so x is skipped.
  const layoutControlled = useRef(false);

  useLayoutEffect(() => {
    if ((!animateX && !animateY) || !ref.current) return;

    const el = ref.current;

    const contentSig = `${el.className}\u0000${el.textContent}`;
    if (init.current && contentSig === lastContentSig.current) return;
    lastContentSig.current = contentSig;

    const renderedW = el.offsetWidth; // width as laid out right now
    const savedW = el.style.width;
    const savedH = el.style.height;

    // Measure natural dimensions
    el.style.width = "max-content";
    el.style.height = "auto";
    const nextW = el.offsetWidth;
    const nextH = el.offsetHeight;
    el.style.width = savedW;
    el.style.height = savedH;

    if (!init.current) {
      init.current = true;
      // First measurement is on a fresh element (no inline width yet), so a
      // rendered width wider than the natural max-content width means the
      // layout is stretching it — grid cells, flex-grow, etc. Leave width to
      // the layout and don't animate x on this element.
      layoutControlled.current = animateX && renderedW !== nextW;
      prevW.current = nextW;
      prevH.current = nextH;
      if (animateX && !layoutControlled.current) el.style.width = `${nextW}px`;
      if (animateY) el.style.height = `${nextH}px`;
      return;
    }

    const wChanged = animateX && !layoutControlled.current && prevW.current !== nextW;
    const hChanged = animateY && prevH.current !== nextH;

    if (!wChanged && !hChanged) return;

    // Capture the inline transition (usually empty) so we can hand transition
    // control back to the CSS classes once the size animation finishes.
    // Without this, the inline `transition: width …` permanently overrides a
    // class like `transition-all`, so hover colors/backgrounds stop animating.
    const priorInlineTransition = el.style.transition;

    // Set to previous values without transition
    el.style.transition = "none";
    if (animateX && !layoutControlled.current) el.style.width = `${prevW.current}px`;
    if (animateY) el.style.height = `${prevH.current}px`;
    // Force reflow so the browser registers the starting value
    void el.offsetWidth;

    // Transition to new values
    const props = [];
    if (wChanged) props.push("width");
    if (hChanged) props.push("height");
    el.style.transition = `${props.join(", ")} 250ms var(--motion-easing-emphasized-decelerate)`;
    if (animateX && !layoutControlled.current) el.style.width = `${nextW}px`;
    if (animateY) el.style.height = `${nextH}px`;
    prevW.current = nextW;
    prevH.current = nextH;

    // Restore the class-driven transition once the size animation has settled.
    window.clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => {
      el.style.transition = priorInlineTransition;
    }, 260);
  });

  useEffect(() => () => window.clearTimeout(transitionTimer.current), []);
}