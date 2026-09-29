import PropTypes from "prop-types";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const pillVariants = cva(
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs border",
  {
    variants: {
      variant: {
        default: "bg-current/10 border-current/25",
        muted: "bg-primary/20 border-primary/30",
        // Accent is an outline only — the fill stays the surface's own.
        accent: "bg-transparent border-accent",
        // Status reads from the tint and border; the text keeps the
        // surface's own color. Status-colored text (yellow, green) on a
        // light surface is unreadable.
        success: "bg-success/20 border-success/30",
        warning: "bg-warning/20 border-warning/30",
        error: "bg-error/20 border-error/30",
        info: "bg-info/20 border-info/30",
        custom: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export default function Pill({ children, variant = "default", className = "" }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(pillVariants({ variant: /** @type {any} */ (variant) }), className)}
    >
      {children}
    </span>
  );
}

Pill.propTypes = {
  children: PropTypes.node.isRequired,
  variant: PropTypes.oneOf(["default", "muted", "accent", "success", "warning", "error", "info", "custom"]),
  className: PropTypes.string,
};
