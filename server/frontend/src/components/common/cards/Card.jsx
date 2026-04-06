import { memo } from "react";
import PropTypes from "prop-types";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";

function Card({ children, className = "", noPopIn = false, noHeightAnim = false }) {
  const { outerRef, innerRef } = useAnimatedHeight();

  const animationClass = noPopIn
    ? ""
    : "pop-in transition-all duration-300 ease-in-out";

  if (noHeightAnim) {
    return (
      <div
        className={`bg-secondary text-primary rounded-large-element p-5 ${animationClass} ${className}`}
      >
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
        className={`bg-secondary text-primary p-5 ${animationClass} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

Card.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  noPopIn: PropTypes.bool,
  noHeightAnim: PropTypes.bool,
};

export default memo(Card);