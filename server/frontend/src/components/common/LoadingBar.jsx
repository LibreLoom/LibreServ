import { useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";

export default function LoadingBar() {
  const location = useLocation();
  const timeoutRef = useRef();

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    document.documentElement.classList.add("loading-bar-visible");
    timeoutRef.current = setTimeout(() => {
      document.documentElement.classList.remove("loading-bar-visible");
    }, 500);
  }, [location]);

  return (
    <div className="loading-bar fixed bottom-0 left-0 right-0 z-[9999] h-1 bg-[var(--color-primary)] overflow-hidden">
      <div className="animate-md-bar-1 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
      <div className="animate-md-bar-2 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
    </div>
  );
}