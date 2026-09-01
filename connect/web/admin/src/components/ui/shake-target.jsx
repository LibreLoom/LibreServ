import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";
import useShakeOnError from "../../hooks/useShakeOnError.js";

/**
 * Shakes its root element when `shake` becomes a new non-empty failure signal.
 * @param {{ shake?: unknown, as?: import("react").ElementType, className?: string, children?: import("react").ReactNode } & Record<string, unknown>} props
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

export default ShakeTarget;
