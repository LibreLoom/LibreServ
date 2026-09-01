import PropTypes from "prop-types";
import { forwardRef, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import useShakeOnError from "../../hooks/useShakeOnError";

/**
 * @typedef {import("react").ComponentPropsWithoutRef<"div"> & {
 *   shake?: unknown,
 *   loading?: boolean,
 *   as?: import("react").ElementType,
 * }} ShakeTargetProps
 */

/**
 * Shakes its root element when `shake` becomes a new non-empty failure signal.
 * Wrap forms or field groups to draw attention on validation / submit errors.
 */
const ShakeTarget = forwardRef(/** @param {ShakeTargetProps} props */ function ShakeTarget(
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

ShakeTarget.propTypes = {
  shake: PropTypes.any,
  loading: PropTypes.bool,
  as: PropTypes.elementType,
  className: PropTypes.string,
  children: PropTypes.node,
};

export default ShakeTarget;
