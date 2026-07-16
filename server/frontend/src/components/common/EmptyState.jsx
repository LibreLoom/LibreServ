import { cn } from "@/lib/utils";
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
      className={cn("flex flex-col items-center justify-center py-8 px-4 text-center", className)}
      data-slot="empty-state"
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
        <p className="text-sm text-primary/70 max-w-xs">{description}</p>
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
