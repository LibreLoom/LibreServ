// @ts-nocheck — polymorphic `as` forwards arbitrary element props (href/to/type) to Card; TS can't express this via JSDoc. Card itself remains type-checked.
import { Link } from "react-router-dom";

import Card from "./Card";

/**
 * A standardized clickable card that wraps arbitrary content rather than the
 * fixed icon + label of CardButton. Renders as a route Link, an external
 * anchor, or a <button> (when `onClick` is given instead of `action`).
 *
 * Composes the Card primitive via its `as` prop, so it inherits Card's
 * surface contract, pop-in animation, and rounded-large-element radius
 * rather than duplicating those classes.
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
  className = "",
  children,
}) {
  // Interactive behavior layered on top of Card's surface/animation/radius.
  const interactiveClasses = "block w-full text-left cursor-pointer motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-in-out hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

  const cardClassName = `${interactiveClasses} ${className}`;

  if (external) {
    return (
      <Card
        as="a"
        href={action}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={ariaLabel}
        data-slot="clickable-card"
        className={cardClassName}
        noHeightAnim
      >
        {children}
      </Card>
    );
  }

  if (action) {
    return (
      <Card
        as={Link}
        to={action}
        aria-label={ariaLabel}
        data-slot="clickable-card"
        className={cardClassName}
        noHeightAnim
      >
        {children}
      </Card>
    );
  }

  return (
    <Card
      as="button"
      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
      data-slot="clickable-card"
      className={cardClassName}
      noHeightAnim
    >
      {children}
    </Card>
  );
}
