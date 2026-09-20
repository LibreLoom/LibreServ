import { forwardRef, useCallback, useRef } from "react";
import { cn } from "../../lib/utils.js";
import useShakeOnError from "../../hooks/useShakeOnError.js";

/**
 * Shakes its root element when `shake` becomes a new non-empty failure signal.
 * @param {{ shake?: unknown, as?: import("react").ElementType, className?: string, children?: import("react").ReactNode } & Record<string, unknown>} props
 */
const ShakeTarget = forwardRef(function ShakeTarget(
  { shake, loading, as: Component = "div", className, children, ...props },
  forwardedRef,
) {
  const localRef = useRef(/** @type {HTMLElement | null} */ (null));

  const setRef = useCallback(
    (node) => {
      localRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  const shakeOptions = loading !== undefined ? { loading } : undefined;
  useShakeOnError(shake, localRef, shakeOptions);

  return (
    <Component ref={setRef} className={cn(className)} {...props}>
      {children}
    </Component>
  );
});

export default ShakeTarget;
