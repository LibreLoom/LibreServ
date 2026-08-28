import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/**
 * ValueDisplay — a label + value row, or a bare value pill.
 *
 * Renders subtle `bg-primary/5` tinted boxes. Per the theme contrast rule,
 * opacity tints keep the surrounding surface's text token, so the text color
 * must match the surface this sits on:
 *   - surface="secondary" (default — inside a Card) → text-primary
 *   - surface="primary"   (on the page background)  → text-secondary
 *
 * Ported from LibreServ `server/frontend` so Luna cards can reuse the same
 * value-table pattern. Keep the two copies in sync.
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
  const text = surface === "primary" ? "text-secondary" : "text-primary";

  if (!label) {
    return (
      <span className={cn("inline-flex items-center px-2 py-0.5 rounded-pill bg-primary/10 text-sm", mono && "font-mono", text, className)} data-slot="value-pill">
        {value ?? fallback}
      </span>
    );
  }

  return (
    <div className={cn("flex items-center justify-between gap-3 py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5", className)} data-slot="value-display">
      <span className={cn("text-sm shrink-0", text, "font-medium")}>{label}</span>
      <span className={cn("text-sm min-w-0 text-right", text, "px-2 py-0.5 rounded-pill bg-primary/10", mono && "font-mono")}>
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
