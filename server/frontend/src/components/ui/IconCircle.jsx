import PropTypes from "prop-types";

const sizes = {
  sm: { container: "h-8 w-8", icon: 16 },
  md: { container: "h-12 w-12", icon: 22 },
  lg: { container: "h-14 w-14", icon: 26 },
  xl: { container: "h-16 w-16", icon: 28 },
};

const variants = {
  default: "bg-primary text-secondary",
  accent: "bg-accent text-primary",
  secondary: "bg-secondary text-primary",
};

export default function IconCircle({
  icon: Icon,
  size = "md",
  variant = "default",
  className = "",
  ...props
}) {
  const sizeConfig = sizes[size] || sizes.md;
  const variantClasses = variants[variant] || variants.default;
  const IconComponent = Icon;

  return (
    <div
      className={`rounded-pill flex items-center justify-center ${sizeConfig.container} ${variantClasses} ${className}`}
      {...props}
    >
      <IconComponent size={sizeConfig.icon} aria-hidden="true" />
    </div>
  );
}

IconCircle.propTypes = {
  icon: PropTypes.elementType.isRequired,
  size: PropTypes.oneOf(['sm', 'md', 'lg', 'xl']),
  variant: PropTypes.oneOf(['default', 'accent', 'secondary']),
  className: PropTypes.string,
};
