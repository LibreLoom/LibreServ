import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Card from "../cards/Card";

/**
 * EmptyState — centered empty copy inside a Card (never on bare page bg).
 * @param {{
 *   icon?: import('react').ElementType,
 *   title?: string,
 *   description?: string,
 *   action?: import('react').ReactNode,
 *   className?: string,
 *   surface?: "primary" | "secondary",
 * }} props
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
  surface = "secondary",
}) {
  const textClass = surface === "primary" ? "text-secondary" : "text-primary";
  return (
    <Card surface={surface} className={cn("text-center", className)} data-slot="empty-state">
      <div className="flex flex-col items-center justify-center py-4 px-2">
        {Icon && (
          <div className="mb-3">
            <Icon size={32} className="text-accent" aria-hidden="true" />
          </div>
        )}
        {title && (
          <p className={cn("font-mono mb-1", textClass)}>{title}</p>
        )}
        {description && (
          <p className={cn("text-sm max-w-xs", textClass)}>{description}</p>
        )}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </Card>
  );
}

EmptyState.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string,
  description: PropTypes.string,
  action: PropTypes.node,
  className: PropTypes.string,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};
