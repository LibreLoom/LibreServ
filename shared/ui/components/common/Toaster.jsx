import { CheckCircle2, XCircle, Info, X, ChevronDown } from "lucide-react";
import PropTypes from "prop-types";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useToast, useToastList } from "../../context/ToastContext";
import { useDocumentVisible } from "../../hooks/useDocumentVisible.js";
import { cn } from "../../lib/utils.js";
import { ICON_SIZE } from "../../lib/ui-tokens.js";
import { haptic } from "../../utils/haptics.js";

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, ring: "stroke-success", track: "stroke-success/25" },
  error: { icon: XCircle, ring: "stroke-error", track: "stroke-error/25" },
  info: { icon: Info, ring: "stroke-info", track: "stroke-info/25" },
};

// Circumference of the time-ring (r = 12). Drives the stroke-dash depletion.
const RING_CIRC = 2 * Math.PI * 12;
// Collapsed message clip — 2 lines of text-sm / leading-snug (14px × 1.375).
const COLLAPSED_H = "2.4rem";
// Overflow threshold in the same units as scrollHeight (px): more than 2 lines.
const TRUNCATION_THRESHOLD_PX = 40;

// Drag gesture. A press must move a few px before it counts as a drag, and a
// release dismisses past the distance threshold or on a quick flick.
const DRAG_START_PX = 6;
const DISMISS_DISTANCE_PX = 88;
const FLICK_DISTANCE_PX = 24;
const FLICK_VELOCITY_PX_PER_MS = 0.5;
const SNAP_BACK_MS = 220;

/**
 * `.animate-toast-enter` is a keyframe whose 0% frame is `opacity: 0` with
 * `animation-fill-mode: both`, so while it is applied the toast's *visible*
 * state belongs to the animation timeline. A timeline that never advances —
 * a throttled or occluded tab, a phone compositor starved mid-scroll, the
 * state gallery running the app in an iframe — then leaves the toast mounted,
 * correctly stacked, and fully transparent for its whole life: the success
 * toast nobody sees. So the class is applied for one entrance and then
 * dropped; the element's resting styles are visible on their own, and this
 * wall-clock fallback drops it even when the animation never reports finishing.
 * Keep in step with the 380ms in index.css.
 */
const ENTER_MS = 380;
const ENTER_FALLBACK_MS = ENTER_MS + 40;

function Toast({ toast, onDismiss, onPause, onResume }) {
  const config = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;
  const Icon = config.icon;
  const hasTimer = (toast.duration ?? 0) > 0;
  const visible = useDocumentVisible();

  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const snapTimerRef = useRef(null);
  const suppressClickRef = useRef(false);

  const [entering, setEntering] = useState(!toast.exiting);
  const [mouseHovering, setMouseHovering] = useState(false);
  const [touchHeld, setTouchHeld] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [clickedOpen, setClickedOpen] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  // `drag` is null at rest. While set it holds the live pointer offset; on
  // release it becomes either {x:0,y:0} (snap back) or a flung-out offset.
  const [drag, setDrag] = useState(null);
  const [snapping, setSnapping] = useState(false);
  const [swipedOut, setSwipedOut] = useState(false);
  const msgRef = useRef(null);

  useEffect(() => {
    if (!entering) return undefined;
    const timer = setTimeout(() => setEntering(false), ENTER_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [entering]);

  useEffect(
    () => () => {
      clearTimeout(snapTimerRef.current);
    },
    []
  );

  // Compact by default; springs open on hover/click when the message overflows.
  const expanded = clickedOpen || (mouseHovering && isTruncated);
  // Hover is a desktop affordance; touch users pause by holding the toast, and
  // keyboard users by focusing anything inside it. A hidden tab pauses too.
  const paused =
    !!toast.exiting ||
    !visible ||
    mouseHovering ||
    touchHeld ||
    focusWithin ||
    clickedOpen;

  useEffect(() => {
    if (!hasTimer) return;
    if (paused) onPause(toast.id);
    else onResume(toast.id);
  }, [paused, hasTimer, toast.id, onPause, onResume]);

  // Touching or clicking anything outside this toast ends its pause sources.
  // Without this, a tap's synthetic mouse events (or an expanded message)
  // could leave a toast paused indefinitely after the person moved on.
  useEffect(() => {
    if (!touchHeld && !clickedOpen) return undefined;
    const onOutsideDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setTouchHeld(false);
        setClickedOpen(false);
      }
    };
    document.addEventListener("pointerdown", onOutsideDown, true);
    return () => document.removeEventListener("pointerdown", onOutsideDown, true);
  }, [touchHeld, clickedOpen]);

  // A finger can be released outside the toast; that must still unpause it.
  useEffect(() => {
    if (!touchHeld) return undefined;
    const end = () => setTouchHeld(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [touchHeld]);

  // Measure the full (unclipped) message height so max-height animates between
  // two real values — no dead zone, smooth in both directions.
  // Re-runs when truncation flips (chevron appears, shifting text width).
  useLayoutEffect(() => {
    const el = msgRef.current;
    if (!el) return;
    const full = el.scrollHeight;
    setFullHeight(full);
    setIsTruncated(full > TRUNCATION_THRESHOLD_PX);
  }, [toast.message, isTruncated]);

  const onPointerDown = (event) => {
    // Buttons own their own taps; don't turn them into a drag.
    if (event.target instanceof Element && event.target.closest("button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    if (event.pointerType !== "mouse") setTouchHeld(true);
    // Hand transform back from the entrance keyframes to the drag style.
    setEntering(false);
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      started: false,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is a nicety; pointer-up on window covers the rest */
    }
  };

  const onPointerMove = (event) => {
    const start = dragRef.current;
    if (!start || start.id !== event.pointerId) return;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.started && Math.hypot(dx, dy) < DRAG_START_PX) return;
    if (!start.started) {
      start.started = true;
      haptic("rigid");
    }

    // `touch-none` on the root already stops the page scrolling under a
    // drag; calling preventDefault here could suppress the matching click.
    setSnapping(false);
    setDrag({ x: dx, y: dy });
  };

  const finishDrag = (event) => {
    const start = dragRef.current;
    if (!start || start.id !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* see setPointerCapture above */
    }
    if (!start.started) return;

    // A real drag must not also count as a tap-to-expand on the same gesture.
    suppressClickRef.current = true;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const distance = Math.hypot(dx, dy);
    const velocity = distance / Math.max(1, performance.now() - start.time);
    const shouldDismiss =
      distance > DISMISS_DISTANCE_PX ||
      (distance > FLICK_DISTANCE_PX && velocity > FLICK_VELOCITY_PX_PER_MS);

    setSnapping(true);
    if (shouldDismiss) {
      haptic("light");
      setSwipedOut(true);
      setDrag({ x: dx * 1.35, y: dy * 1.35 });
      onDismiss(toast.id);
    } else {
      setDrag({ x: 0, y: 0 });
      clearTimeout(snapTimerRef.current);
      snapTimerRef.current = setTimeout(() => {
        setDrag(null);
        setSnapping(false);
      }, SNAP_BACK_MS);
    }
  };

  const toggleExpanded = (event) => {
    event?.stopPropagation();
    haptic("light");
    setClickedOpen((value) => !value);
  };

  const dragDistance = drag ? Math.hypot(drag.x, drag.y) : 0;
  const dragStyle = {
    transform: `translate3d(${drag?.x ?? 0}px, ${drag?.y ?? 0}px, 0)`,
    ...(drag
      ? { opacity: swipedOut ? 0 : Math.max(0.35, 1 - dragDistance / 260) }
      : {}),
    transition: snapping
      ? `transform ${SNAP_BACK_MS}ms cubic-bezier(0.2,0,0,1), opacity ${SNAP_BACK_MS}ms ease-out`
      : "none",
  };

  return (
    <div
      ref={rootRef}
      role={toast.type === "error" ? "alert" : "status"}
      data-slot="toast"
      data-tone={toast.type}
      data-dragging={drag && !snapping ? "true" : undefined}
      style={dragStyle}
      className={cn(
        "pointer-events-auto relative flex items-center gap-3 overflow-hidden touch-none",
        "min-w-[220px] max-w-[380px]",
        "surface-secondary",
        "rounded-large-element border border-primary/10 shadow-lg",
        "py-2.5 pl-3 pr-2.5 origin-top-right",
        toast.exiting ? !swipedOut && "animate-toast-exit" : entering && "animate-toast-enter",
        isTruncated && "cursor-pointer",
      )}
      // The entrance ends here too, so a stalled timeline still drops the class.
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && entering) setEntering(false);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (isTruncated) toggleExpanded(event);
      }}
      // Only a real mouse hovers. Touch fires synthetic mouseenter/mouseleave
      // that would otherwise pause the toast until the next unrelated tap.
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setMouseHovering(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setMouseHovering(false);
      }}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          haptic("light");
          onDismiss(toast.id);
        }
      }}
    >
      {/* Status icon wrapped in a depleting time-ring */}
      <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7">
        <svg
          className="absolute inset-0 -rotate-90 pointer-events-none"
          viewBox="0 0 28 28"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="14" cy="14" r="12" strokeWidth="2" className={config.track} />
          <circle
            cx="14"
            cy="14"
            r="12"
            strokeWidth="2"
            strokeLinecap="round"
            className={cn(hasTimer && "toast-ring", config.ring)}
            strokeDasharray={RING_CIRC}
            style={
              hasTimer
                ? { animationDuration: `${toast.duration}ms`, animationPlayState: paused ? "paused" : "running" }
                : undefined
            }
          />
        </svg>
        <Icon size={ICON_SIZE.sm} className="text-primary" strokeWidth={2.5} aria-hidden="true" />
      </div>

      <div className="flex-1 min-w-0">
        <div
          className="min-w-0 overflow-hidden motion-safe:transition-[max-height] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]"
          style={{ maxHeight: expanded ? (fullHeight ? `${fullHeight}px` : "none") : COLLAPSED_H }}
        >
          <p ref={msgRef} className="font-mono text-sm text-primary leading-snug">
            {toast.message}
          </p>
        </div>
        {toast.description && (
          <p className="text-xs mt-1 leading-snug">{toast.description}</p>
        )}
      </div>

      {toast.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            haptic("light");
            toast.action.onClick();
            onDismiss(toast.id);
          }}
          className={cn(
            "flex-shrink-0 h-8 rounded-pill surface-primary px-3 text-xs font-mono",
            "hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary",
            "motion-safe:transition-all active:motion-safe:scale-95",
            "focus-visible:ring-2 focus-visible:ring-accent no-focus-outline",
          )}
        >
          {toast.action.label}
        </button>
      )}

      <div className="flex flex-shrink-0 items-center">
        {isTruncated && (
          <button
            type="button"
            aria-label={expanded ? "Show less" : "Show more"}
            aria-expanded={expanded}
            onClick={toggleExpanded}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-pill",
              "hover:bg-primary/10 motion-safe:transition-colors",
              "focus-visible:ring-2 focus-visible:ring-accent no-focus-outline",
            )}
          >
            <ChevronDown
              size={ICON_SIZE.sm}
              className={cn(
                "motion-safe:transition-transform motion-safe:duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            haptic("light");
            onDismiss(toast.id);
          }}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-pill",
            "hover:text-primary hover:bg-primary/10",
            "motion-safe:transition-colors",
            "focus-visible:ring-2 focus-visible:ring-accent no-focus-outline",
          )}
          aria-label="Dismiss notification"
        >
          <X size={ICON_SIZE.sm} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

Toast.propTypes = {
  toast: PropTypes.shape({
    id: PropTypes.number.isRequired,
    type: PropTypes.oneOf(["success", "error", "info"]).isRequired,
    message: PropTypes.string.isRequired,
    description: PropTypes.node,
    duration: PropTypes.number,
    exiting: PropTypes.bool,
    action: PropTypes.shape({
      label: PropTypes.string.isRequired,
      onClick: PropTypes.func.isRequired,
    }),
  }).isRequired,
  onDismiss: PropTypes.func.isRequired,
  onPause: PropTypes.func.isRequired,
  onResume: PropTypes.func.isRequired,
};

export default function Toaster() {
  const { dismissToast, pauseToast, resumeToast } = useToast();
  const toasts = useToastList();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-[max(1rem,env(safe-area-inset-top,0px))] right-[max(1.5rem,env(safe-area-inset-right,0px))] z-[9999] flex flex-col items-end pointer-events-none"
      data-slot="toaster"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        // Grid row collapses 1fr→0fr on exit so siblings glide up smoothly.
        <div
          key={toast.id}
          className={cn(
            "grid motion-safe:transition-[grid-template-rows,margin] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.3,0,0,1)]",
            toast.exiting ? "grid-rows-[0fr] mb-0" : "grid-rows-[1fr] mb-2.5",
          )}
        >
          <div className={cn("min-h-0", toast.exiting && "overflow-hidden")}>
            <Toast
              toast={toast}
              onDismiss={dismissToast}
              onPause={pauseToast}
              onResume={resumeToast}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
