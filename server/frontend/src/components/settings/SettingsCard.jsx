import { memo } from "react";
import PropTypes from "prop-types";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";

function SettingsCard({
  icon: Icon,
  title,
  children,
  className = "",
  noPopIn = false,
  headerActions,
}) {
  const { outerRef, innerRef } = useAnimatedHeight();

  const animationClass = noPopIn
    ? ""
    : "pop-in transition-all duration-300 ease-in-out";

  return (
    <div
      ref={outerRef}
      className={`overflow-hidden rounded-large-element transition-[height] ease-[var(--motion-easing-emphasized-decelerate)] ${className}`}
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div
        ref={innerRef}
        className={`bg-secondary text-primary ${animationClass}`}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
            <div className="flex items-center gap-2">
              {Icon && <Icon size={18} className="text-accent" />}
              <h2 className="font-mono font-normal text-primary">{title}</h2>
            </div>
            {headerActions && (
              <div className="flex items-center gap-2">{headerActions}</div>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

SettingsCard.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string,
  children: PropTypes.node,
  className: PropTypes.string,
  noPopIn: PropTypes.bool,
  headerActions: PropTypes.node,
};

export default memo(SettingsCard);
