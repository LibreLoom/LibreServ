import PropTypes from "prop-types";

const VARIANTS = {
  default: "bg-primary/20 text-primary",
  muted: "bg-primary/20 text-accent",
  accent: "bg-accent/30 text-accent",
  success: "bg-success/30 text-success",
  warning: "bg-warning/30 text-warning",
  error: "bg-error/30 text-error",
  info: "bg-info/30 text-info",
  custom: "",
};

export default function Pill({ children, variant = "default", className = "" }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs ${VARIANTS[variant] || VARIANTS.default} ${className}`}
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