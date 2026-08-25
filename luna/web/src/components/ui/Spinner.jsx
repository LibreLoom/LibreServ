/**
 * Spinner — 3×3 comet-trail loading indicator.
 *
 * Outer eight same-size dots chase around the ring; trail is opacity only.
 * The center cell stays off (or faintly present). Color comes from
 * `currentColor` so it inherits contrasting button text on every variant.
 *
 * Pass decorative when the parent already exposes loading (e.g. Button
 * aria-busy) so the dots stay visual-only.
 */
// @ts-nocheck
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/** Clockwise ring order starting at top-left (skipping center index 4). */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];

const SIZE_PX = {
  sm: 12,
  md: 16,
  lg: 20,
};

/**
 * @param {{
 *   className?: string,
 *   size?: "sm"|"md"|"lg"|number,
 *   label?: string,
 *   decorative?: boolean,
 *   [key: string]: any
 * }}
 */
export default function Spinner({
  className = "",
  size = "md",
  label = "Loading",
  decorative = false,
  ...props
}) {
  const px = typeof size === "number" ? size : SIZE_PX[size] ?? SIZE_PX.md;

  const dots = Array.from({ length: 9 }, (_, i) => {
    const ringIndex = RING_ORDER.indexOf(i);
    const isCenter = i === 4;
    return (
      <span
        key={i}
        aria-hidden="true"
        className={isCenter ? "comet-spinner__center" : "comet-spinner__dot"}
        style={isCenter ? undefined : { "--comet-i": ringIndex }}
      />
    );
  });

  if (decorative) {
    return (
      <span
        aria-hidden="true"
        data-slot="spinner"
        className={cn("comet-spinner shrink-0", className)}
        style={{ width: px, height: px }}
        {...props}
      >
        {dots}
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-label={label}
      data-slot="spinner"
      className={cn("comet-spinner shrink-0", className)}
      style={{ width: px, height: px }}
      {...props}
    >
      {dots}
      <span className="sr-only">{label}</span>
    </span>
  );
}

Spinner.propTypes = {
  className: PropTypes.string,
  size: PropTypes.oneOfType([
    PropTypes.oneOf(["sm", "md", "lg"]),
    PropTypes.number,
  ]),
  label: PropTypes.string,
  decorative: PropTypes.bool,
};
