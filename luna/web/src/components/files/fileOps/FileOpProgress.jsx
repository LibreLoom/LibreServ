import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";

/**
 * A progress bar. `pct` is 0-100, or null when the size isn't known (a moving bar).
 * `surface` is the surface the bar sits on; the track and fill use the inverse pair.
 * @param {{ pct: number|null, surface?: "primary"|"secondary", label?: string, className?: string }} props
 */
export default function FileOpProgress({ pct, surface = "primary", label = "Progress", className = "" }) {
  if (pct == null) {
    return <LinearProgress label={label} surface={surface} className={className} />;
  }
  const value = Math.round(Math.max(0, Math.min(100, pct)));
  const track = surface === "primary" ? "surface-secondary" : "surface-primary";
  const fill = surface === "primary" ? "surface-primary" : "surface-secondary";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      data-slot="file-op-progress"
      className={cn("h-1.5 w-full overflow-hidden rounded-pill p-px", track, className)}
    >
      <div
        className={cn("h-full rounded-pill motion-safe:transition-[width] motion-safe:duration-300", fill)}
        style={{ width: `${value}%` }}
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
