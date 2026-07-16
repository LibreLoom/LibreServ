import { useEffect, useState } from "react";

// Show a loading indicator only after `delay` ms, so fast fetches don't flash.
// ponytail: O(1) — one timer; fine for any realistic page count.
export function useDelayedLoading(isLoading, delay = 500) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      const r = requestAnimationFrame(() => setShow(false));
      return () => cancelAnimationFrame(r);
    }
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [isLoading, delay]);
  return show;
}