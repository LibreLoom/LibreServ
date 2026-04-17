import PropTypes from "prop-types";

const VARIANTS = {
  default: "bg-primary/20 text-primary",
  success: "bg-success/30 text-success",
  warning: "bg-warning/30 text-warning",
  error: "bg-error/30 text-error",
  accent: "bg-accent/30 text-accent",
  info: "bg-info/30 text-info",
};

export default function StatusBadge({ children, variant = "default", className = "" }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-pill text-xs font-medium ${VARIANTS[variant] || VARIANTS.default} ${className}`}
    >
      {children}
    </span>
  );
}

StatusBadge.propTypes = {
  children: PropTypes.node.isRequired,
  variant: PropTypes.oneOf(["default", "success", "warning", "error", "accent", "info"]),
  className: PropTypes.string,
};
