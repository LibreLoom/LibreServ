import { CheckCircle2, XCircle, Info, X, ChevronDown } from "lucide-react";
import PropTypes from "prop-types";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useToast } from "../../context/ToastContext";
import { cn } from "@/lib/utils";
import { ICON_SIZE } from "@/lib/ui-tokens";

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, ring: "stroke-success", track: "stroke-success/25" },
  error: { icon: XCircle, ring: "stroke-error", track: "stroke-error/25" },
  info: { icon: Info, ring: "stroke-info", track: "stroke-info/25" },
};

// Circumference of the time-ring (r = 12). Drives the stroke-dash depletion.
const RING_CIRC = 2 * Math.PI * 12;
// Collapsed message clip — ~1 line of text-sm / leading-snug.
const COLLAPSED_H = "1.3rem";

function Toast({ toast, onDismiss, onPause, onResume }) {
  const config = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;
  const Icon = config.icon;
  const hasTimer = (toast.duration ?? 0) > 0;

  const [hovering, setHovering] = useState(false);
  const [clickedOpen, setClickedOpen] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  const msgRef = useRef(null);

  // Compact by default; springs open on hover/click when the message overflows.
  const expanded = clickedOpen || (hovering && isTruncated);
  // Hovering or expanded freezes both the dismiss timer and the time-ring.
  const paused = hovering || clickedOpen || !!toast.exiting;

  useEffect(() => {
    if (!hasTimer) return;
    if (paused) onPause(toast.id);
    else onResume(toast.id);
  }, [paused, hasTimer, toast.id, onPause, onResume]);

  // Measure the full (unclipped) message height so max-height animates between
  // two real values — no dead zone, smooth in both directions.
  // Re-runs when truncation flips (chevron appears, shifting text width).
  useLayoutEffect(() => {
    const el = msgRef.current;
    if (!el) return;
    const full = el.scrollHeight;
    setFullHeight(full);
    setIsTruncated(full > 30);
  }, [toast.message, isTruncated]);

  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      data-slot="toast"
      data-tone={toast.type}
      className={cn(
        "pointer-events-auto relative flex items-start gap-3 overflow-hidden",
        "min-w-[220px] max-w-[380px]",
        "bg-secondary text-primary",
        "rounded-large-element border border-primary/10 shadow-lg",
        "pl-3 pr-2 py-2.5 origin-top-right",
        toast.exiting ? "animate-toast-exit" : "animate-toast-enter",
        isTruncated && "cursor-pointer",
      )}
      onClick={() => isTruncated && setClickedOpen((v) => !v)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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

      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-start gap-1">
          <div
            className="min-w-0 overflow-hidden motion-safe:transition-[max-height] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]"
            style={{ maxHeight: expanded ? (fullHeight ? `${fullHeight}px` : "none") : COLLAPSED_H }}
          >
            <p ref={msgRef} className="font-mono text-sm font-medium text-primary leading-snug">
              {toast.message}
            </p>
          </div>
          {isTruncated && (
            <ChevronDown
              size={ICON_SIZE.sm}
              className={cn(
                "flex-shrink-0 mt-0.5 text-accent motion-safe:transition-transform motion-safe:duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          )}
        </div>
        {toast.description && (
          <p className="text-xs text-accent mt-0.5 leading-relaxed">{toast.description}</p>
        )}
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.id);
        }}
        className={cn(
          "flex-shrink-0 p-1 rounded-pill text-accent",
          "hover:text-primary hover:bg-primary/10",
          "motion-safe:transition-colors",
          "focus-visible:ring-2 focus-visible:ring-accent no-focus-outline",
        )}
        aria-label="Dismiss notification"
      >
        <X size={ICON_SIZE.sm} aria-hidden="true" />
      </button>
    </div>
  );
}

Toast.propTypes = {
  toast: PropTypes.shape({
    id: PropTypes.number.isRequired,
    type: PropTypes.oneOf(["success", "error", "info"]).isRequired,
    message: PropTypes.string.isRequired,
    description: PropTypes.string,
    duration: PropTypes.number,
    exiting: PropTypes.bool,
  }).isRequired,
  onDismiss: PropTypes.func.isRequired,
  onPause: PropTypes.func.isRequired,
  onResume: PropTypes.func.isRequired,
};

export default function Toaster() {
  const { toasts, dismissToast, pauseToast, resumeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-6 z-[9999] flex flex-col items-end pointer-events-none"
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