import { useState, useEffect, useRef } from "react";

/**
 * @param {number} [threshold]
 * @returns {[boolean, import('react').RefObject<null>]}
 */
export function useIsNarrow(threshold = 220) {
  const [isNarrow, setIsNarrow] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < threshold);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);

  return [isNarrow, ref];
}