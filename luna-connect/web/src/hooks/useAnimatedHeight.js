import { useEffect, useRef } from "react";

/**
 * Smooth height transitions for cards with changing content.
 * CSS cannot animate height: auto — measure the inner node and set px height.
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
