import { memo } from "react";

export default memo(function Card({ children, className = "" }) {
  return (
    <div
      className={`bg-secondary text-primary rounded-large-element p-5 pop-in transition-all duration-300 ease-in-out ${className}`}
    >
      {children}
    </div>
  );
});
