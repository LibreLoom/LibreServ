import PropTypes from "prop-types";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import useShakeOnError from "../../hooks/useShakeOnError";

/**
 * Shakes its root element when `shake` becomes a new non-empty failure signal.
 * Wrap forms or field groups to draw attention on validation / submit errors.
 */
const ShakeTarget = forwardRef(function ShakeTarget(
  { shake, as: Component = "div", className, children, ...props },
  forwardedRef,
) {
  const localRef = /** @type {import("react").RefObject<HTMLElement | null>} */ ({ current: null });

  const setRef = (node) => {
    localRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };

  useShakeOnError(shake, localRef);

  return (
    <Component ref={setRef} className={cn(className)} {...props}>
      {children}
    </Component>
  );
});

ShakeTarget.propTypes = {
  shake: PropTypes.any,
  as: PropTypes.elementType,
  className: PropTypes.string,
  children: PropTypes.node,
};

export default ShakeTarget;
