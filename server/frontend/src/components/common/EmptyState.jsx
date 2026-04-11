import PropTypes from "prop-types";

export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-8 px-4 text-center ${className}`}
    >
      {Icon && (
        <div className="mb-3">
          <Icon size={32} className="text-accent" />
        </div>
      )}
      {title && (
        <p className="font-mono text-primary mb-1">{title}</p>
      )}
      {description && (
        <p className="text-sm text-accent max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

EmptyState.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string,
  description: PropTypes.string,
  action: PropTypes.node,
  className: PropTypes.string,
};
