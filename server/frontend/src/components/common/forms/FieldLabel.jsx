import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/**
 * FieldLabel — standard label for text inputs.
 *
 * Offset 20px (translate-x-5) so the label text sits over the start of the
 * pill's straight edge, past the rounded corner. Use on every text input.
 * Pair with a `px-5` (or `pl-5`+) pill input so the label aligns with the
 * input text.
 *
 * @typedef {object} FieldLabelProps
 * @property {string} [htmlFor]
 * @property {import("react").ReactNode} children
 * @property {"primary"|"secondary"} [surface] - surface the label sits on.
 *   "primary" (page bg) -> text-secondary; "secondary" (card bg) -> text-primary.
 * @property {boolean} [required]
 * @property {string} [className]
 */

/** @param {FieldLabelProps} props */
export default function FieldLabel({
  htmlFor,
  children,
  surface = "primary",
  required = false,
  className = "",
}) {
  const text = surface === "secondary" ? "text-primary" : "text-secondary";
  return (
    <label
      data-slot="label"
      htmlFor={htmlFor}
      className={cn("block font-mono text-sm translate-x-5 motion-safe:transition-all mb-2", text, className)}
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
};
