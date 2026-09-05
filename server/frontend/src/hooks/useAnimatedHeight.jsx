import { useLayoutEffect, useRef } from "react";

/**
 * useAnimatedHeight - smooth height transitions for cards with changing content.
 *
 * CSS `transition` cannot animate `height: auto`. This hook solves that by
 * measuring the inner content with ResizeObserver and setting an explicit pixel
 * height on the outer container, so the browser always knows both start and end
 * values and can transition between them.
 *
 * Usage:
 *   const { outerRef, innerRef } = useAnimatedHeight();
 *   // ModalCard (portal mounts/unmounts with `present`):
 *   const { outerRef, innerRef } = useAnimatedHeight(present);
 *
 *   <div ref={outerRef} className="overflow-hidden transition-[height] ease-[...]"
 *        style={{ transitionDuration: "var(--motion-duration-medium2)" }}>
 *     <div ref={innerRef}>
 *       {content that changes height}
 *     </div>
 *   </div>
 *
 * Notes:
 * - `innerRef` must wrap ALL content inside the outer div, and must NOT carry a
 *   max-height that tracks the outer (that caps the measured box so growth
 *   never notifies ResizeObserver). Put viewport max-height / scrolling on a
 *   wrapper around the measure target, not on the measure target itself.
 * - The initial height is set without animation (auto → px is not transitionable
 *   by the browser, so it snaps instantly — correct behaviour).
 * - All subsequent height changes (px → px) animate via the CSS transition.
 * - Pass `enabled=false` while the measured DOM is unmounted (e.g. ModalCard
 *   after exit). Pass `enabled=true` again when it remounts so observation
 *   rebinds — a mount-only effect would miss the second open.
 *
 * @param {boolean} [enabled=true] When false, disconnects and clears the outer height.
 */
export function useAnimatedHeight(enabled = true) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);

  useLayoutEffect(() => {
    if (!enabled) return undefined;

    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return undefined;

    const applyHeight = () => {
      // offsetHeight excludes the inner element's own margins, but those
      // margins still occupy space inside the clipped outer box — so a Card
      // given a margin class (EmptyState's `mt-12`, say) puts that margin on
      // the inner element and gets exactly that many pixels shaved off its
      // bottom. Add the vertical margins back so the outer box fits content.
      const { marginTop, marginBottom } = getComputedStyle(inner);
      const margins = (parseFloat(marginTop) || 0) + (parseFloat(marginBottom) || 0);
      outer.style.height = `${inner.offsetHeight + margins}px`;
    };

    applyHeight();
    const ro = new ResizeObserver(applyHeight);
    ro.observe(inner);

    return () => {
      ro.disconnect();
      outer.style.height = "";
    };
  }, [enabled]);

  return { outerRef, innerRef };
}
