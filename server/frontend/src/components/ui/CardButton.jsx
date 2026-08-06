import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";

const variants = {
  default:
    "bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-primary mt-5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
  inverted:
    "bg-secondary text-primary hover:bg-primary hover:text-secondary hover:ring-secondary mt-0 py-4 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  danger:
    "bg-accent text-primary hover:bg-primary hover:text-accent hover:ring-accent mt-0 py-4 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
  nav: "text-secondary hover:bg-secondary/10 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
};

const activeVariants = {
  nav: "bg-secondary text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
};

const alignments = {
  center: "justify-center",
  between: "justify-between",
  start: "justify-start",
};

/**
 * Standardized clickable "card" control. Renders as a route Link, an external
 * anchor, or a <button> (when `onClick` is given instead of `action`), so every
 * icon + label clickable can share one card style.
 *
 * @param {{
 *   action?: string,
 *   onClick?: (event: React.MouseEvent) => void,
 *   type?: "button" | "submit" | "reset",
 *   actionLabel?: string,
 *   variant?: "default" | "inverted" | "danger" | "nav",
 *   active?: boolean,
 *   align?: "center" | "between" | "start",
 *   className?: string,
 *   external?: boolean,
 *   icon?: import('react').ElementType,
 *   trailing?: import('react').ReactNode,
 *   ariaCurrent?: import('react').AriaAttributes["aria-current"],
 *   id?: string,
 *   children?: import('react').ReactNode,
 * }} props
 */
export default function CardButton({
  action,
  onClick,
  type = "button",
  actionLabel = "View All",
  variant = "default",
  active = false,
  align = "center",
  className = "",
  external = false,
  icon: Icon,
  trailing = null,
  ariaCurrent,
  id,
  children,
}) {
  const variantClasses =
    (active && activeVariants[variant]) || variants[variant] || variants.default;
  const alignClass = alignments[align] || alignments.center;
  const ringClass = variant === "nav" ? "" : "hover:ring-2 hover:ring-solid";
  // nav variant: no transition-all — instant hover feedback, sidebar feels snappier
  const transitionClass = variant === "nav" ? "" : "motion-safe:transition-all";

  const classes = cn("flex items-center gap-2 rounded-pill p-2 cursor-pointer", transitionClass, ringClass, alignClass, variantClasses, className, "h-full w-full");

  const label = children ?? actionLabel;
  const content = (
    <>
      {Icon && <Icon size={16} className="shrink-0" />}
      <span
        className={cn("text-sm font-medium", align !== "center" && "flex-1 text-left")}
      >
        {label}
      </span>
      {trailing}
    </>
  );

  if (external) {
    return (
      <a
        data-slot="card-button"
        href={action}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={actionLabel}
        id={id}
        className={classes}
      >
        {content}
      </a>
    );
  }

  if (action) {
    return (
      <Link
        data-slot="card-button"
        to={action}
        aria-label={actionLabel}
        aria-current={ariaCurrent}
        id={id}
        className={classes}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      data-slot="card-button"
      type={type}
      onClick={onClick}
      aria-label={actionLabel}
      aria-current={ariaCurrent}
      id={id}
      className={classes}
    >
      {content}
    </button>
  );
}