import PropTypes from "prop-types";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { cn } from "@libreloom/ui/lib/utils.js";

// The status hue lives in the disc (tint + solid ring); the glyph uses the
// surface's own text token so it stays readable on any card, in both themes.
const DISCS = {
  passed: { Icon: Check, tone: "bg-success/20 border-success" },
  warning: { Icon: AlertTriangle, tone: "bg-warning/20 border-warning" },
  failed: { Icon: X, tone: "bg-error/20 border-error" },
  pending: { Icon: Loader2, tone: "bg-primary/10 border-transparent" },
};

const SIZES = {
  sm: { disc: "w-5 h-5", icon: "w-3 h-3" },
  md: { disc: "w-7 h-7", icon: "w-3.5 h-3.5" },
  lg: { disc: "w-12 h-12 border-2", icon: "w-5 h-5" },
};

/** Status disc for a health-check row. */
export default function CheckStatusIcon({ status, size = "md", className = "" }) {
  const { Icon, tone } = DISCS[status] ?? DISCS.failed;
  const s = SIZES[size] ?? SIZES.md;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded-full border text-primary motion-safe:transition-colors motion-safe:duration-300",
        s.disc,
        tone,
        className,
      )}
      aria-hidden="true"
    >
      <Icon className={cn(s.icon, status === "pending" && "animate-spin")} strokeWidth={2.5} />
    </span>
  );
}

CheckStatusIcon.propTypes = {
  status: PropTypes.string,
  size: PropTypes.oneOf(["sm", "md", "lg"]),
  className: PropTypes.string,
};
