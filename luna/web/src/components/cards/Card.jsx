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

/** @param {CardProps & Record<string, any>} props */
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
  const headerBorder = surface === "primary" ? "border-secondary/10" : "border-primary/10";
  // Custom radius (HeaderCard's rounded-pill) must replace the default card
  // curve. Tailwind does not treat rounded-pill as conflicting with
  // rounded-large-element, so skip the default when className sets one.
  const hasCustomRadius = /\brounded-/.test(className);

  if (noHeightAnim) {
    return (
      <As
        data-slot="card"
        data-surface={surface}
        className={cn(
          !hasCustomRadius && "rounded-large-element",
          surfaceClasses,
          padding && "p-5",
          animationClass,
          className,
        )}
        onAnimationEnd={onAnimationEnd}
        {...rest}
      >
        {hasHeader && (
          <div className={cn("flex items-center justify-between px-4 py-3 border-b", headerBorder)}>
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              {title && <h2 className="font-mono font-normal">{title}</h2>}
            </div>
            {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
          </div>
        )}
        {children}
      </As>
    );
  }

  // Layout (margins, extra radius like HeaderCard's rounded-pill) lives on the
  // overflow clip. The inner surface has no second radius — two matching
  // rounded-large-element curves plus overflow-hidden paint dark crescent
  // bites at the corners, worse when className margins inset the fill.
  //
  // pop-in MUST live on this clip, not the fill. The fill is a square; if it
  // scales inside a rounded overflow box, corners look 90° until the
  // animation ends and the clip radius shows through.
  return (
    <div
      ref={outerRef}
      data-slot="card-clip"
      className={cn(
        "overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]",
        !hasCustomRadius && "rounded-large-element",
        animationClass,
        className,
      )}
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      onAnimationEnd={onAnimationEnd}
    >
      <As
        ref={innerRef}
        data-slot="card"
        data-surface={surface}
        className={surfaceClasses}
        {...rest}
      >
        {hasHeader && (
          <div className={cn("flex items-center justify-between px-4 py-3 border-b", headerBorder)}>
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              {title && <h2 className="font-mono font-normal">{title}</h2>}
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
