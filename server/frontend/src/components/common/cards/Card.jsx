import { memo } from "react";
import PropTypes from "prop-types";

function Card({ children, className = "", noPopIn = false }) {
  const animationClass = noPopIn
    ? ""
    : "pop-in transition-all duration-300 ease-in-out";

  return (
    <div
      className={`bg-secondary text-primary rounded-large-element p-5 ${animationClass} ${className}`}
    >
      {children}
    </div>
  );
}

Card.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  noPopIn: PropTypes.bool,
};

export default memo(Card);
