import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import useLabelErrorState from "../../../hooks/useLabelErrorState";

/**
 * FieldLabel — standard label for text inputs.
 *
 * Offset 20px (translate-x-5) so the label text sits over the start of the
 * pill's straight edge, past the rounded corner. Use on every text input.
 * Pair with a `px-5` (or `pl-5`+) pill input so the label aligns with the
 * input text.
 *
 * Pass `error` / `shake` / `loading` to turn the label `text-error` on failure,
 * fade back on resubmit, and return to error if the field is still invalid.
 *
 * @typedef {object} FieldLabelProps
 * @property {string} [htmlFor]
 * @property {import("react").ReactNode} children
 * @property {"primary"|"secondary"} [surface] - surface the label sits on.
 *   "primary" (page bg) -> text-secondary; "secondary" (card bg) -> text-primary.
 * @property {boolean} [required]
 * @property {string} [className]
 * @property {unknown} [error]
 * @property {unknown} [shake]
 * @property {boolean} [loading]
 * @property {boolean} [invalid] - explicit invalid state (skips hook when set)
 */

/** @param {FieldLabelProps} props */
export default function FieldLabel({
  htmlFor,
  children,
  surface = "primary",
  required = false,
  className = "",
  error,
  shake,
  loading = false,
  invalid,
}) {
  const usesErrorState = invalid === undefined && (error !== undefined || shake !== undefined);
  const { labelError: hookLabelError, containerRef } = useLabelErrorState(error, shake, {
    loading,
    enabled: usesErrorState,
  });
  const labelError = invalid ?? hookLabelError;
  const text = labelError
    ? "text-error"
    : surface === "secondary"
      ? "text-primary"
      : "text-secondary";

  return (
    <label
      ref={containerRef}
      data-slot="label"
      htmlFor={htmlFor}
      className={cn(
        "block font-mono text-sm translate-x-5 motion-safe:transition-colors duration-300 mb-2",
        text,
        className,
      )}
    >
      {children}
      {required && <span className="text-accent ml-1">*</span>}
    </label>
  );
}

FieldLabel.propTypes = {
  htmlFor: PropTypes.string,
  children: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  required: PropTypes.bool,
  className: PropTypes.string,
  error: PropTypes.any,
  shake: PropTypes.any,
  loading: PropTypes.bool,
  invalid: PropTypes.bool,
};
