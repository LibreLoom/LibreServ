import PropTypes from "prop-types";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const pillVariants = cva(
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs border",
  {
    variants: {
      variant: {
        default: "bg-accent/15 border-accent/25 text-accent",
        muted: "bg-primary/20 border-primary/30 text-accent",
        accent: "bg-accent/20 border-accent/30 text-accent",
        success: "bg-success/20 border-success/30 text-success",
        warning: "bg-warning/20 border-warning/30 text-warning",
        error: "bg-error/20 border-error/30 text-error",
        info: "bg-info/20 border-info/30 text-info",
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
