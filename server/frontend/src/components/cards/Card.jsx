import { memo } from "react";
import PropTypes from "prop-types";
import { useAnimatedHeight } from "../../hooks/useAnimatedHeight";

function Card({
  children,
  className = "",
  noPopIn = false,
  noHeightAnim = false,
  icon: Icon,
  title,
  headerActions,
  padding = true,
}) {
  const { outerRef, innerRef } = useAnimatedHeight();

  const animationClass = noPopIn
    ? ""
    : "pop-in transition-all duration-300 ease-in-out";

  const hasHeader = title || Icon;

  if (noHeightAnim) {
    return (
      <div
        className={`bg-secondary text-primary rounded-large-element ${padding ? "p-5" : ""} ${animationClass} ${className}`}
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
        <div className={padding ? "p-5" : ""}>{children}</div>
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
};

export default memo(Card);
