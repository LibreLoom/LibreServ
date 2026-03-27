import { useRef, useEffect } from "react";
import PropTypes from "prop-types";

const PHASE = {
  TYPING: "typing",
  PAUSING: "pausing",
  CLEARING: "clearing",
};

const SIZE_CLASSES = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-xl",
};

const SIZE_MIN_HEIGHT = {
  sm: "min-h-[1.5rem]",
  md: "min-h-[2rem]",
  lg: "min-h-[2.5rem]",
};

export default function TypewriterLoader({
  message = "Loading...",
  speed = 80,
  pause = 1500,
  size = "md",
  className = "",
}) {
  const textSpanRef = useRef(null);
  const animationStateRef = useRef({
    displayText: "",
    phase: PHASE.TYPING,
    charIndex: 0,
    timeoutId: null,
  });

  useEffect(() => {
    const state = animationStateRef.current;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    if (prefersReducedMotion) {
      if (textSpanRef.current) {
        textSpanRef.current.textContent = message;
      }
      return;
    }

    const updateDisplay = () => {
      if (textSpanRef.current) {
        textSpanRef.current.textContent = state.displayText;
      }
    };

    const runAnimation = () => {
      const { phase, charIndex, displayText } = state;

      if (phase === PHASE.TYPING) {
        if (charIndex < message.length) {
          state.displayText = message.slice(0, charIndex + 1);
          state.charIndex = charIndex + 1;
          updateDisplay();
          state.timeoutId = setTimeout(runAnimation, speed);
        } else {
          state.phase = PHASE.PAUSING;
          state.timeoutId = setTimeout(runAnimation, pause);
        }
      } else if (phase === PHASE.PAUSING) {
        state.phase = PHASE.CLEARING;
        runAnimation();
      } else if (phase === PHASE.CLEARING) {
        if (displayText.length > 0) {
          state.displayText = displayText.slice(0, -1);
          updateDisplay();
          state.timeoutId = setTimeout(runAnimation, speed / 2);
        } else {
          state.charIndex = 0;
          state.phase = PHASE.TYPING;
          state.timeoutId = setTimeout(runAnimation, speed);
        }
      }
    };

    state.timeoutId = setTimeout(runAnimation, speed);

    return () => {
      clearTimeout(state.timeoutId);
    };
  }, [message, speed, pause]);

  return (
    <div
      className={`flex items-center justify-center font-mono ${SIZE_CLASSES[size] || SIZE_CLASSES.md} ${SIZE_MIN_HEIGHT[size] || SIZE_MIN_HEIGHT.md} my-3 ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span ref={textSpanRef} className="text-secondary" />
      <span
        className="ml-0.5 inline-block h-[1.1em] w-[0.6em] animate-cursor-blink bg-secondary align-middle"
        aria-hidden="true"
      />
      <span className="sr-only">{message}</span>
    </div>
  );
}

TypewriterLoader.propTypes = {
  message: PropTypes.string,
  speed: PropTypes.number,
  pause: PropTypes.number,
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  className: PropTypes.string,
};
