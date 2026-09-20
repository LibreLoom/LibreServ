import { useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";

// Animation state machine using refs to avoid setState in effects
const PHASE = {
  HIDDEN: 'hidden',
  ENTERING: 'entering', 
  VISIBLE: 'visible',
  EXITING: 'exiting'
};

const getClassName = (phase) => {
  let className = "loading-bar fixed bottom-0 left-0 right-0 z-[9999] h-1 bg-[var(--color-primary)] overflow-hidden";
  if (phase === PHASE.ENTERING) {
    className += " loading-bar-enter";
  } else if (phase === PHASE.EXITING) {
    className += " loading-bar-exit";
  }
  return className;
};

export default function LoadingBar() {
  const location = useLocation();
  const barRef = useRef(null);
  const timeoutRef = useRef(null);
  const exitTimeoutRef = useRef(null);
  const enterTimeoutRef = useRef(null);
  const phaseRef = useRef(PHASE.HIDDEN);
  const prevLocationRef = useRef(location.key);

  const updatePhase = useCallback((newPhase) => {
    phaseRef.current = newPhase;
    const bar = barRef.current;
    if (!bar) return;

    // Update DOM classes directly based on phase
    bar.className = getClassName(newPhase);
    bar.style.display = newPhase === PHASE.HIDDEN ? 'none' : 'block';
  }, []);

  // Use a callback ref to trigger animation on mount/location change
  const setBarRef = useCallback((node) => {
    barRef.current = node;
    
    if (!node) return;
    
    // Only trigger if location actually changed
    if (prevLocationRef.current === location.key) return;
    prevLocationRef.current = location.key;
    
    // Clear any existing timeouts
    clearTimeout(timeoutRef.current);
    clearTimeout(exitTimeoutRef.current);
    clearTimeout(enterTimeoutRef.current);
    
    // Start animation sequence
    updatePhase(PHASE.ENTERING);
    
    // Transition to visible after enter animation
    enterTimeoutRef.current = setTimeout(() => {
      updatePhase(PHASE.VISIBLE);
    }, 10);
    
    // Start exit after delay
    timeoutRef.current = setTimeout(() => {
      updatePhase(PHASE.EXITING);
      exitTimeoutRef.current = setTimeout(() => {
        updatePhase(PHASE.HIDDEN);
      }, 200);
    }, 500);
  }, [location.key, updatePhase]);

  return (
    <div 
      ref={setBarRef}
      className={getClassName(PHASE.HIDDEN)}
      style={{ display: 'none' }}
    >
      <div className="animate-md-bar-1 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
      <div className="animate-md-bar-2 absolute left-0 top-0 bottom-0 h-full w-full origin-left bg-[var(--color-accent)]" />
    </div>
  );
}
