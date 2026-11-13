import { useRef, useLayoutEffect, useEffect } from "react";

// A page that mounts hundreds of buttons at once (a long form, a big table of
// actions) used to measure each one on its own: write, read, write — and every
// read forces a layout of the whole page, so the cost grew with the square of
// the count (a 300-question form spent tens of seconds in layout). The first
// few measurements of a burst still run on the spot; the rest are queued and
// measured together in four passes, which costs two layouts however many
// there are. A first measurement only pins the width the element already has,
// so deferring it by a microtask is invisible.
const INLINE_FIRST_PROBES = 8;
let probeBurst = 0;
/** @type {Array<{ read: () => void, hide: () => void, measure: () => void, apply: () => void }>} */
let deferredProbes = [];

function flushDeferredProbes() {
  const batch = deferredProbes;
  deferredProbes = [];
  batch.forEach((p) => p.read());
  batch.forEach((p) => p.hide());
  batch.forEach((p) => p.measure());
  batch.forEach((p) => p.apply());
}

function deferFirstProbe(probe) {
  if (probeBurst === 0) queueMicrotask(() => { probeBurst = 0; });
  probeBurst += 1;
  if (probeBurst <= INLINE_FIRST_PROBES) return false;
  if (deferredProbes.length === 0) queueMicrotask(flushDeferredProbes);
  deferredProbes.push(probe);
  return true;
}

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
  // The element's inline transition as it was before this hook ever touched
  // it (captured on first probe, usually ""). The restore timer always
  // rewinds to THIS baseline — never to a value we set ourselves — so rapid
  // successive content changes can't leave the element permanently stuck on
  // the inline width-transition (which overrides class transitions like
  // `transition-all`, killing hover/active animations).
  const baselineTransition = useRef(null);
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

    if (!init.current) {
      let renderedW = 0;
      let savedW0 = "";
      let savedH0 = "";
      let nextW0 = 0;
      let nextH0 = 0;
      const deferred = deferFirstProbe({
        read: () => {
          renderedW = el.offsetWidth;
          savedW0 = el.style.width;
          savedH0 = el.style.height;
        },
        hide: () => {
          el.style.width = "max-content";
          el.style.height = "auto";
        },
        measure: () => {
          nextW0 = el.offsetWidth;
          nextH0 = el.offsetHeight;
        },
        apply: () => {
          el.style.width = savedW0;
          el.style.height = savedH0;
          if (nextW0 === 0 && nextH0 === 0) {
            // Hidden: retry on a later render, like the inline path.
            init.current = false;
            lastContentSig.current = null;
            return;
          }
          baselineTransition.current = el.style.transition;
          layoutControlled.current = animateX && renderedW !== nextW0;
          prevW.current = nextW0;
          prevH.current = nextH0;
          if (animateX && !layoutControlled.current) el.style.width = `${nextW0}px`;
          if (animateY) el.style.height = `${nextH0}px`;
        },
      });
      if (deferred) {
        init.current = true;
        return;
      }
    }

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

    // Element is hidden (e.g. `hidden sm:inline-flex` mounted at the wrong
    // breakpoint): there is no natural width to capture, and pinning 0px
    // would collapse it permanently when it later becomes visible.
    if (nextW === 0 && nextH === 0) return;

    if (!init.current) {
      init.current = true;
      // First measurement is on a fresh element (no inline width yet), so a
      // rendered width wider than the natural max-content width means the
      // layout is stretching it — grid cells, flex-grow, etc. Leave width to
      // the layout and don't animate x on this element.
      baselineTransition.current = el.style.transition;
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

    // Hand transition control back to the CSS classes once the size animation
    // finishes by restoring the element's ORIGINAL inline transition (captured
    // on first probe, before we touched it). Without this, the inline
    // `transition: width …` permanently overrides a class like
    // `transition-all`, so hover colors/backgrounds stop animating.
    // Restoring the baseline (not the transition captured on this probe)
    // matters: when two content changes happen within 260ms of each other,
    // the second probe would otherwise capture the FIRST probe's inline
    // transition as the value to "restore", sticking the width-only
    // transition on the element forever.

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
      el.style.transition = baselineTransition.current;
    }, 260);
  });

  useEffect(() => () => window.clearTimeout(transitionTimer.current), []);
}