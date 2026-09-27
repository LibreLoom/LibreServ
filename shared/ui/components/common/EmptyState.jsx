import { cn } from "../../lib/utils.js";
import PropTypes from "prop-types";
import Card from "../../components/cards/Card.jsx";

/**
 * EmptyState — centered empty copy inside a Card (never on bare page bg).
 * `bare` drops the Card frame for surfaces that already sit inside a card
 * (e.g. the file explorer, where the empty state is the card's own body).
 * @param {{
 *   icon?: import('react').ElementType,
 *   title?: string,
 *   description?: string,
 *   action?: import('react').ReactNode,
 *   className?: string,
 *   surface?: "primary" | "secondary",
 *   bare?: boolean,
 * }} props
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
  surface = "secondary",
  bare = false,
}) {
  const textClass = surface === "primary" ? "text-secondary" : "text-primary";
  const content = (
    <div className="flex flex-col items-center justify-center py-4 px-2">
      {Icon && (
        <div className="mb-3">
          <Icon size={32} aria-hidden="true" />
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
  );

  if (bare) {
    return (
      <div data-slot="empty-state" className={cn("text-center", className)}>
        {content}
      </div>
    );
  }

  return (
    <Card surface={surface} className={cn("text-center", className)} data-slot="empty-state">
      {content}
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
  bare: PropTypes.bool,
};
