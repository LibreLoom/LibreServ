import { memo } from "react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { useAnimatedHeight } from "../../hooks/useAnimatedHeight";

/**
 * @typedef {object} CardProps
 * @property {import('react').ReactNode} [children]
 * @property {string} [className]
 * @property {boolean} [noPopIn]
 * @property {boolean} [noHeightAnim]
 * @property {import('react').ElementType} [icon]
 * @property {string} [title]
 * @property {import('react').ReactNode} [headerActions]
 * @property {boolean} [padding]
 * @property {"primary"|"secondary"} [surface] Surface this card establishes. "secondary" (default) is the normal card surface (bg-secondary text-primary); "primary" inverts it (bg-primary text-secondary) for panels that should blend with the page.
 * @property {import('react').ElementType} [as] Render as a different element or component (e.g. Link, "button", "a"). Interactive props like `to`, `href`, `onClick`, `type` pass through via rest.
 * @property {(event: React.AnimationEvent) => void} [onAnimationEnd]
 * @property {Record<string, any>} [rest] Additional props spread onto the rendered element (for `as` consumers).
 */

/** @param {CardProps} props */
function Card({
  children,
  className = "",
  noPopIn = false,
  noHeightAnim = false,
  icon: Icon,
  title,
  headerActions,
  padding = true,
  surface = "secondary",
  as: As = "div",
  onAnimationEnd,
  ...rest
}) {
  const { outerRef, innerRef } = useAnimatedHeight();

  const animationClass = noPopIn ? "" : "pop-in";

  const surfaceClasses =
    surface === "primary"
      ? "bg-primary text-secondary border-2 border-secondary/30"
      : "bg-secondary text-primary";

  const hasHeader = title || Icon;

  if (noHeightAnim) {
    return (
      <As
        data-slot="card"
        data-surface={surface}
        className={cn(
          "rounded-large-element",
          surfaceClasses,
          padding && "p-5",
          animationClass,
          className
        )}
        onAnimationEnd={onAnimationEnd}
        {...rest}
      >
        {hasHeader && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              {title && <h2 className="font-mono font-normal text-primary">{title}</h2>}
            </div>
            {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
          </div>
        )}
        {children}
      </As>
    );
  }

  return (
    <div
      ref={outerRef}
      className="overflow-hidden rounded-large-element transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <As
        ref={innerRef}
        data-slot="card"
        data-surface={surface}
        className={cn(
          "rounded-large-element",
          surfaceClasses,
          animationClass,
          className
        )}
        onAnimationEnd={onAnimationEnd}
        {...rest}
      >
        {hasHeader && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              {title && <h2 className="font-mono font-normal text-primary">{title}</h2>}
            </div>
            {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
          </div>
        )}
        {padding ? <div className="p-5">{children}</div> : children}
      </As>
    </div>
  );
}

Card.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  noPopIn: PropTypes.bool,
  noHeightAnim: PropTypes.bool,
  icon: PropTypes.elementType,
  title: PropTypes.string,
  headerActions: PropTypes.node,
  padding: PropTypes.bool,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  as: PropTypes.elementType,
  onAnimationEnd: PropTypes.func,
};

export default memo(Card);
