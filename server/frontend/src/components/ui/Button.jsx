import { Loader2 } from "lucide-react";
import PropTypes from "prop-types";

const variants = {
  primary: "bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary",
  secondary: "bg-secondary text-primary hover:ring-2 hover:ring-accent",
  accent: "bg-accent text-primary hover:ring-2 hover:ring-primary",
  danger: "bg-primary text-secondary border-2 border-accent hover:bg-accent hover:text-primary hover:border-primary",
  ghost: "bg-transparent text-primary hover:bg-primary/10",
};

const sizes = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  type = "button",
  className = "",
  ...props
}) {
  const variantClasses = variants[variant] || variants.primary;
  const sizeClasses = sizes[size] || sizes.md;

  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`
        rounded-pill
        font-medium
        motion-safe:transition-all
        focus-visible:ring-2
        focus-visible:ring-accent
        focus-visible:ring-offset-2
        focus-visible:ring-offset-primary
        disabled:opacity-50
        disabled:cursor-not-allowed
        inline-flex
        items-center
        justify-center
        gap-2
        ${variantClasses}
        ${sizeClasses}
        ${className}
      `}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

Button.propTypes = {
  children: PropTypes.node,
  variant: PropTypes.oneOf(['primary', 'secondary', 'accent', 'danger', 'ghost']),
  size: PropTypes.oneOf(['sm', 'md', 'lg']),
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  type: PropTypes.oneOf(['button', 'submit', 'reset']),
  className: PropTypes.string,
};
