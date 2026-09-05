import PropTypes from "prop-types";
import { useRef } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import useShakeOnError from "../../hooks/useShakeOnError";
import { calloutShakeTrigger } from "../../utils/shake";

const calloutTones = cva(
  "border p-3 motion-safe:transition-colors animate-alert-enter",
  {
    variants: {
      tone: {
        success: "bg-success/20 border-success/30",
        warning: "bg-warning/20 border-warning/30",
        error: "bg-error/20 border-error/30",
        info: "bg-info/20 border-info/30",
        neutral: "bg-primary/10 border-primary/20",
      },
      rounded: {
        "large-element": "rounded-large-element",
        pill: "rounded-pill",
        card: "rounded-card",
      },
    },
    defaultVariants: {
      tone: "info",
      rounded: "large-element",
    },
  }
);

const TONE_ICONS = {
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
  info: Info,
  neutral: Info,
};

const TONE_TEXT = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-info",
  neutral: "text-accent",
};

/**
 * @typedef {object} CalloutProps
 * @property {"success"|"warning"|"error"|"info"|"neutral"} [tone]
 * @property {import("react").ElementType|null} [icon] Auto from tone; pass null to suppress.
 * @property {import("react").ReactNode} [title] Colored mono heading.
 * @property {import("react").ReactNode} [children] Body (text-primary, readable on tint).
 * @property {import("react").ReactNode} [action] Right-aligned action node.
 * @property {() => void} [onDismiss] Renders a dismiss button.
 * @property {"large-element"|"pill"|"card"} [rounded]
 * @property {string} [className]
 */

/** @param {CalloutProps} props */
export default function Callout({
  tone = "info",
  icon,
  title,
  children,
  action,
  onDismiss,
  rounded = "large-element",
  className = "",
}) {
  const Icon = icon !== undefined ? icon : TONE_ICONS[tone] || TONE_ICONS.info;
  const textClass = TONE_TEXT[tone] || TONE_TEXT.info;
  const calloutRef = useRef(null);
  const shakeTrigger = calloutShakeTrigger(tone, title, children);

  useShakeOnError(shakeTrigger, calloutRef);

  return (
    <div
      ref={calloutRef}
      data-slot="alert"
      data-tone={tone}
      className={cn(calloutTones({ tone, rounded }), className)}
      role={tone === "error" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        {Icon && <Icon size={20} className={cn(textClass, "shrink-0 mt-0.5")} aria-hidden="true" />}
        <div className="flex-1 min-w-0">
          {title && <p className={cn("font-mono font-medium text-sm mb-1", textClass)}>{title}</p>}
          {children && <div className="text-sm text-primary">{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "shrink-0 cursor-pointer hover:bg-primary/20 rounded-pill p-1.5 motion-safe:transition-colors",
              "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 no-focus-outline",
              textClass
            )}
            aria-label="Dismiss"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

Callout.propTypes = {
  tone: PropTypes.oneOf(["success", "warning", "error", "info", "neutral"]),
  icon: PropTypes.elementType,
  title: PropTypes.node,
  children: PropTypes.node,
  action: PropTypes.node,
  onDismiss: PropTypes.func,
  rounded: PropTypes.oneOf(["large-element", "pill", "card"]),
  className: PropTypes.string,
};
