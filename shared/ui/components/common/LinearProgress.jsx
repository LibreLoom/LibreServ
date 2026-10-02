import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils.js";

/** Matches `.md-linear-exit` in the app stylesheet. */
const EXIT_MS = 260;

// Track tint: the colour of the text that sits on the surface, so it reads there.
const TRACK = { primary: "bg-secondary/10", secondary: "bg-primary/10" };

/**
 * Material 3 indeterminate linear progress, the same bar as the LibreServ
 * Sol loading screen: a 4px pill track with two accent bars sweeping across
 * it (`animate-md-bar-1` / `animate-md-bar-2` in the app stylesheet).
 *
 * It eases in when `active` turns on (after `delayMs`, so a fast answer never
 * flashes one) and eases out when it turns off, instead of vanishing.
 *
 * @param {{
 *   active?: boolean,
 *   label?: string,
 *   delayMs?: number,
 *   surface?: "primary" | "secondary",
 *   className?: string,
 * }} props `surface` is the surface the bar sits on.
 */
export default function LinearProgress({
  active = true,
  label = "Loading",
  delayMs = 0,
  surface = "primary",
  className = "",
}) {
  const [phase, setPhase] = useState(/** @type {"off" | "in" | "out"} */ ("off"));

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => setPhase("in"), delayMs);
      return () => clearTimeout(t);
    }
    setPhase((p) => (p === "in" ? "out" : "off"));
    return undefined;
  }, [active, delayMs]);

  useEffect(() => {
    if (phase !== "out") return undefined;
    // Only leave if still exiting: loading may have restarted meanwhile.
    const t = setTimeout(() => setPhase((p) => (p === "out" ? "off" : p)), EXIT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "off") return null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-hidden={phase === "out" || undefined}
      data-slot="linear-progress"
      data-phase={phase}
      className={cn(
        "relative h-1 w-full overflow-hidden rounded-full",
        TRACK[surface] || TRACK.primary,
        phase === "in" ? "md-linear-enter" : "md-linear-exit",
        className,
      )}
    >
      <div className="absolute bottom-0 top-0 h-full origin-left bg-accent animate-md-bar-1" />
      <div className="absolute bottom-0 top-0 h-full origin-left bg-accent animate-md-bar-2" />
    </div>
  );
}

LinearProgress.propTypes = {
  active: PropTypes.bool,
  label: PropTypes.string,
  delayMs: PropTypes.number,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  className: PropTypes.string,
};
