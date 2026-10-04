import { forwardRef, useCallback, useRef } from "react";
import { cn } from "../../lib/utils.js";
import useShakeOnError from "../../hooks/useShakeOnError.js";

/**
 * @typedef {{ shake?: unknown, loading?: boolean, as?: import("react").ElementType, className?: string, children?: import("react").ReactNode } & Record<string, unknown>} ShakeTargetProps
 */

/**
 * Shakes its root element when `shake` becomes a new non-empty failure signal.
 * @type {import("react").ForwardRefExoticComponent<ShakeTargetProps & import("react").RefAttributes<HTMLElement>>}
 */
const ShakeTarget = forwardRef(function ShakeTarget(
  /** @type {ShakeTargetProps} */ { shake, loading, as: Component = "div", className, children, ...props },
  /** @type {import("react").ForwardedRef<HTMLElement>} */ forwardedRef,
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
