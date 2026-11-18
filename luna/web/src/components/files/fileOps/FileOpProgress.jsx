import PropTypes from "prop-types";
import { motion as Motion } from "motion/react";
import { cn } from "@libreloom/ui/lib/utils.js";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import { BAR_FILL } from "../../../lib/fileOps/motion.js";

/**
 * A progress bar. `pct` is 0-100, or null when the size isn't known (a moving bar).
 * `surface` is the surface the bar sits on: the track is an outline in the inverse
 * color and the fill is solid in it. 8px tall with a 1px border, so the fill is a
 * whole 6px and nothing lands between pixels.
 *
 * The fill rides a spring rather than a fixed-duration width transition: a
 * chunked upload reports in bursts, so the bar eases into each new value
 * instead of restarting a 300ms tween on every emit.
 *
 * @param {{ pct: number|null, surface?: "primary"|"secondary", label?: string, className?: string }} props
 */
export default function FileOpProgress({ pct, surface = "primary", label = "Progress", className = "" }) {
  if (pct == null) {
    return <LinearProgress label={label} surface={surface} className={className} />;
  }
  const value = Math.round(Math.max(0, Math.min(100, pct)));
  // The track is an outline on its own surface and the fill is solid in the
  // inverse, so "done" is always the solid part. (A solid track with a fill in
  // the surface's own color read as a hole, not progress.)
  const track = surface === "primary" ? "border-secondary" : "border-primary";
  const fill = surface === "primary" ? "surface-secondary" : "surface-primary";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      data-slot="file-op-progress"
      className={cn("h-2 w-full overflow-hidden rounded-pill border", track, className)}
    >
      <Motion.div
        className={cn("h-full rounded-r-pill", fill)}
        initial={false}
        animate={{ width: `${value}%` }}
        transition={BAR_FILL}
      />
    </div>
  );
}

FileOpProgress.propTypes = {
  pct: PropTypes.number,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  label: PropTypes.string,
  className: PropTypes.string,
};
