import PropTypes from "prop-types";
import { cn } from "../../lib/utils.js";

/**
 * Reveals its children by growing from nothing to their natural size — the
 * grid-track trick (0fr → 1fr), so there is no measuring and no fixed size.
 * `axis="x"` unfolds sideways (pills, nav groups), `axis="y"` downwards.
 * Closed children are inert: hidden from Tab and screen readers.
 *
 * Motion comes from the shared motion tokens; override with `className`
 * (e.g. a different `duration-[…]`) rather than hardcoding a new one here.
 *
 * @param {{ open: boolean, axis?: "x" | "y", className?: string, children: import("react").ReactNode }} props
 */
export default function Unfold({ open, axis = "x", className, children }) {
  const track = axis === "x"
    ? (open ? "grid-cols-[1fr]" : "grid-cols-[0fr]")
    : (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]");
  return (
    <div
      data-slot="unfold"
      data-open={open || undefined}
      className={cn(
        "grid",
        axis === "x" ? "motion-safe:transition-[grid-template-columns]" : "motion-safe:transition-[grid-template-rows]",
        "duration-[var(--motion-duration-medium1)] ease-[var(--motion-easing-emphasized-decelerate)]",
        track,
        className,
      )}
    >
      <div className="min-w-0 min-h-0 overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}

Unfold.propTypes = {
  open: PropTypes.bool.isRequired,
  axis: PropTypes.oneOf(["x", "y"]),
  className: PropTypes.string,
  children: PropTypes.node,
};
