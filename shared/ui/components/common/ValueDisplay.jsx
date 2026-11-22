import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

/**
 * ValueDisplay — a label + value row, or a bare value pill.
 *
 * The pill fills from its text color and uses the accent token for its outline.
 * Its text color must match the surface this sits on:
 *   - surface="secondary" (default — inside a Card) → text-primary
 *   - surface="primary"   (on the page background)  → text-secondary
 *
 * @param {object} props
 * @param {import("react").ReactNode} [props.label] If omitted, renders a bare value pill.
 * @param {import("react").ReactNode} [props.value]
 * @param {boolean} [props.mono] Use monospace for the value. Default true.
 * @param {string} [props.fallback] Shown when value is nullish. Default "N/A".
 * @param {"primary"|"secondary"} [props.surface] Surface this sits on. Default "secondary".
 * @param {string} [props.className]
 */
export default function ValueDisplay({
  label,
  value,
  mono = true,
  fallback = "N/A",
  surface = "secondary",
  className = "",
}) {
  const onPage = surface === "primary";
  const text = onPage ? "text-secondary" : "text-primary";
  // The row's tint is the text color at low alpha, so it has to invert with
  // the surface too. A primary tint on a primary panel is invisible.
  const rowTint = onPage
    ? "border-secondary/10 bg-secondary/5"
    : "border-primary/10 bg-primary/5";
  const pill = cn("rounded-chip border border-accent bg-current/10 px-2 py-0.5 text-sm", text, mono && "font-mono");

  if (!label) {
    return (
      <span className={cn("inline-flex items-center", pill, className)} data-slot="value-pill">
        {value ?? fallback}
      </span>
    );
  }

  return (
    <div className={cn("flex items-center justify-between gap-3 py-2 px-3 border rounded-large-element", rowTint, className)} data-slot="value-display">
      <span className={cn("text-sm shrink-0", text, "font-medium")}>{label}</span>
      <span className={cn("min-w-0 text-right", pill)}>
        {value ?? fallback}
      </span>
    </div>
  );
}

ValueDisplay.propTypes = {
  label: PropTypes.node,
  value: PropTypes.node,
  mono: PropTypes.bool,
  fallback: PropTypes.string,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  className: PropTypes.string,
};
