import { memo } from "react";
import PropTypes from "prop-types";
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
 * @property {(event: React.AnimationEvent) => void} [onAnimationEnd]
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
  onAnimationEnd,
}) {
  const { outerRef, innerRef } = useAnimatedHeight();

  const animationClass = noPopIn
    ? ""
    : "pop-in";

  const hasHeader = title || Icon;

  if (noHeightAnim) {
    return (
      <div
        className={`bg-secondary text-primary rounded-large-element ${padding ? "p-5" : ""} ${animationClass} ${className}`}
        onAnimationEnd={onAnimationEnd}
      >
        {hasHeader && (
          <div className={`flex items-center justify-between px-4 py-3 border-b border-primary/10 ${padding ? "-mx-5 -mt-5 mb-0" : ""}`}>
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              {title && <h2 className="font-mono font-normal text-primary">{title}</h2>}
            </div>
            {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
          </div>
        )}
        {children}
      </div>
    );
  }

  return (
    <div
      ref={outerRef}
      className="overflow-hidden rounded-large-element transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div
        ref={innerRef}
        className={`bg-secondary text-primary rounded-large-element ${animationClass} ${className}`}
        onAnimationEnd={onAnimationEnd}
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
      </div>
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
  onAnimationEnd: PropTypes.func,
};

export default memo(Card);
