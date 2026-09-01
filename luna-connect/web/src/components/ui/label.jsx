import { cn } from "../../lib/utils.js";
import useLabelErrorState from "../../hooks/useLabelErrorState.js";

/** @param {any} props */
export function Label({
  className = "",
  error,
  shake,
  loading = false,
  invalid,
  ...props
}) {
  const usesErrorState = invalid === undefined && (error !== undefined || shake !== undefined);
  const { labelError: hookLabelError, containerRef } = useLabelErrorState(error, shake, {
    loading,
    enabled: usesErrorState,
  });
  const labelError = invalid ?? hookLabelError;

  return (
    <label
      ref={containerRef}
      className={cn(
        "block font-mono text-sm font-medium leading-none mb-1.5 motion-safe:transition-colors duration-300",
        labelError ? "text-error" : "text-foreground",
        className,
      )}
      {...props}
    />
  );
}
