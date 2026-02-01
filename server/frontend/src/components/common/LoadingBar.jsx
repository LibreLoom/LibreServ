import { useRef, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

export default function LoadingBar() {
  const location = useLocation();
  const timeoutRef = useRef();
  const exitTimeoutRef = useRef();
  const enterTimeoutRef = useRef();
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isEntering, setIsEntering] = useState(true);

  useEffect(() => {
    setIsVisible(true);
    setIsExiting(false);
    setIsEntering(true);
    
    clearTimeout(timeoutRef.current);
    clearTimeout(exitTimeoutRef.current);
    clearTimeout(enterTimeoutRef.current);
    
    // Trigger enter animation on next frame
    enterTimeoutRef.current = setTimeout(() => {
      setIsEntering(false);
    }, 10);
    
    timeoutRef.current = setTimeout(() => {
      setIsExiting(true);
      exitTimeoutRef.current = setTimeout(() => {
        setIsVisible(false);
      }, 200);
    }, 500);

    return () => {
      clearTimeout(timeoutRef.current);
      clearTimeout(exitTimeoutRef.current);
      clearTimeout(enterTimeoutRef.current);
    };
  }, [location]);

  if (!isVisible) return null;

  let className = "loading-bar fixed bottom-0 left-0 right-0 z-[9999] h-1 bg-[var(--color-primary)] overflow-hidden";
  if (isEntering) {
    className += " loading-bar-enter";
  } else if (isExiting) {
    className += " loading-bar-exit";
  }

  return (
    <div 
      className={className}
    >
      <div className="animate-md-bar-1 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
      <div className="animate-md-bar-2 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
    </div>
  );
}
