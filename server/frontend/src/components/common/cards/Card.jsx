import { memo } from "react";

export default memo(function Card({ children, className = "", noPopIn = false }) {
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
});
