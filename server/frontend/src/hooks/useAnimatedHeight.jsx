import { useEffect, useRef } from "react";

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
 *
 *   <div ref={outerRef} className="overflow-hidden transition-[height] ease-[...]"
 *        style={{ transitionDuration: "var(--motion-duration-medium2)" }}>
 *     <div ref={innerRef}>
 *       {content that changes height}
 *     </div>
 *   </div>
 *
 * Notes:
 * - `innerRef` must wrap ALL content inside the outer div.
 * - The initial height is set without animation (auto → px is not transitionable
 *   by the browser, so it snaps instantly — correct behaviour).
 * - All subsequent height changes (px → px) animate via the CSS transition.
 */
export function useAnimatedHeight() {
  const outerRef = useRef(null);
  const innerRef = useRef(null);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const applyHeight = () => {
      outer.style.height = inner.offsetHeight + "px";
    };

    const ro = new ResizeObserver(applyHeight);
    ro.observe(inner);

    return () => ro.disconnect();
  }, []);

  return { outerRef, innerRef };
}
