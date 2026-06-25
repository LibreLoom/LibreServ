import { Link } from "react-router-dom";

/**
 * A standardized clickable card that wraps arbitrary content rather than the
 * fixed icon + label of CardButton. Renders as a route Link, an external
 * anchor, or a <button> (when `onClick` is given instead of `action`).
 *
 * Use this when a whole block of content should be a single clickable surface
 * (e.g. wrapping custom markup or art) but should still read as a card.
 *
 * @param {{
 *   action?: string,
 *   onClick?: (event: React.MouseEvent) => void,
 *   type?: "button" | "submit" | "reset",
 *   external?: boolean,
 *   ariaLabel?: string,
 *   title?: string,
 *   className?: string,
 *   children?: import('react').ReactNode,
 * }} props
 */
export default function ClickableCard({
  action,
  onClick,
  type = "button",
  external = false,
  ariaLabel,
  title,
  className = "",
  children,
}) {
  const classes = `pop-in block w-full text-left bg-secondary text-primary rounded-3xl p-5 cursor-pointer motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-in-out hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${className}`;

  if (external) {
    return (
      <a
        href={action}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={ariaLabel}
        title={title}
        className={classes}
      >
        {children}
      </a>
    );
  }

  if (action) {
    return (
      <Link to={action} aria-label={ariaLabel} title={title} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={classes}
    >
      {children}
    </button>
  );
}
