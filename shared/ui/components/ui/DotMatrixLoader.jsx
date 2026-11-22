// @ts-nocheck
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

const DOT_PITCH = 18; // 18px grid: a fine field of dots across the whole viewport
const DOT_RADIUS = 1.5; // the original delicate 3px dots
const WAVE_PERIOD_MS = 5400; // one slow swell every 5.4s
const RESTING_ALPHA = 0.08; // the field at rest
const CREST_ALPHA = 0.7; // under the crest of the swell
const REDUCED_ALPHA = 0.2; // static field when motion is reduced

// The wave is measured in (container width + height), which is exactly how
// wide the old 300%-band's bright swell appeared on screen. The swell is
// ~1.3x the field's diagonal, so only one broad crest is ever in view; the
// short, fully transparent gap after it means the field never goes dark and
// the repeating pattern can loop without a jump.
const SWELL_SHARE = 0.933;
const GAP_SHARE = 0.3;
const PERIOD_SHARE = SWELL_SHARE + GAP_SHARE;
const TRAVEL_SHARE = PERIOD_SHARE / Math.SQRT2;
const WAVE_UNIT = "100cqw + 100cqh"; // resolved against the field below
const waveLength = (share) => `calc((${WAVE_UNIT}) * ${share})`;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const DOT = `radial-gradient(circle at center, currentColor ${DOT_RADIUS}px, transparent ${
  DOT_RADIUS + 0.6
}px)`;
const dotMaskStyle = {
  WebkitMaskImage: DOT,
  maskImage: DOT,
  WebkitMaskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
  maskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
  WebkitMaskPosition: "center",
  maskPosition: "center",
};

/**
 * One swell of the wave, repeated every PERIOD_SHARE units along the 135deg
 * sweep axis. A raised cosine gives a smooth rise and fall, and the gap after
 * it keeps the swell a distinct crest rather than a wash.
 */
const CREST_GRADIENT = (() => {
  const steps = 12;
  const stops = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const strength = (1 - Math.cos(2 * Math.PI * t)) / 2;
    const alpha = Math.round(strength * 100);
    const color =
      alpha === 0
        ? "transparent"
        : `color-mix(in srgb, currentColor ${alpha}%, transparent)`;
    stops.push(
      `${color} ${waveLength((t * SWELL_SHARE).toFixed(4))}`,
    );
  }
  stops.push(`transparent ${waveLength(PERIOD_SHARE)}`);
  return `repeating-linear-gradient(135deg, ${stops.join(", ")})`;
})();

// The band must stay bigger than the field for the whole cycle. It is shifted
// by TRAVEL_SHARE units, so that much overhang on every side is enough.
const BAND_OFFSET = `calc(${waveLength(-TRAVEL_SHARE)} - 2px)`;
const BAND_SIZE = `calc(100% + ${waveLength(2 * TRAVEL_SHARE)} + 4px)`;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

/**
 * DotMatrixLoader: a viewport-filling field of dots with one broad swell
 * rolling diagonally across it.
 *
 * The dots are a CSS mask over two plain layers, so the field and the crest
 * stay crisp at any size. The crest layer holds a repeating gradient that an
 * infinite transform slides by exactly one period per cycle: the loop point is
 * visually identical to the frame before it, so the wave never jumps or
 * disappears. Both properties are compositor-friendly, so nothing runs on the
 * main thread per frame and the wave keeps moving while the page is busy
 * building the thing it is waiting for. (It used to be a canvas redrawn every
 * frame, which froze exactly when it was needed.)
 *
 * @param {{
 *   className?: string,
 *   label?: string,
 *   decorative?: boolean,
 *   bare?: boolean,
 *   wavePeriodMs?: number,
 *   [key: string]: any
 * }} props
 */
export default function DotMatrixLoader({
  className = "",
  label = "Loading",
  decorative = false,
  bare = false,
  wavePeriodMs = WAVE_PERIOD_MS,
  ...props
}) {
  const bandRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const reduced = usePrefersReducedMotion();

  useIsomorphicLayoutEffect(() => {
    const band = bandRef.current;
    if (!band || typeof band.animate !== "function") return undefined;
    const anim = band.animate(
      [
        { transform: "translate3d(0, 0, 0)" },
        {
          transform: `translate3d(${waveLength(TRAVEL_SHARE)}, ${waveLength(
            TRAVEL_SHARE,
          )}, 0)`,
        },
      ],
      { duration: wavePeriodMs, iterations: Infinity, easing: "linear" },
    );
    return () => anim.cancel();
  }, [reduced, wavePeriodMs]);

  const fieldElement = (
    <div
      aria-hidden="true"
      data-slot="matrix-canvas"
      className="absolute inset-0 block h-full w-full overflow-hidden pointer-events-none"
      style={{ containerType: "size" }}
    >
      <div
        className="absolute inset-0 bg-current"
        style={{ ...dotMaskStyle, opacity: reduced ? REDUCED_ALPHA : RESTING_ALPHA }}
      />
      {reduced ? null : (
        <div className="absolute inset-0 overflow-hidden" style={dotMaskStyle}>
          <div
            ref={bandRef}
            data-slot="matrix-wave"
            className="absolute"
            style={{
              left: BAND_OFFSET,
              top: BAND_OFFSET,
              width: BAND_SIZE,
              height: BAND_SIZE,
              backgroundImage: CREST_GRADIENT,
              opacity: CREST_ALPHA,
              willChange: "transform",
            }}
          />
        </div>
      )}
    </div>
  );

  if (decorative) {
    return (
      <div
        aria-hidden="true"
        data-slot="matrix-loader"
        className={cn(
          "relative flex h-full w-full min-h-0 flex-1 flex-col items-center justify-center overflow-hidden",
          !bare && "surface-primary",
          className,
        )}
        {...props}
      >
        {fieldElement}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label={label}
      data-slot="matrix-loader"
      className={cn(
        "relative flex h-full w-full min-h-0 flex-1 flex-col items-center justify-center overflow-hidden",
        !bare && "surface-primary",
        className,
      )}
      {...props}
    >
      {fieldElement}
      <span className="sr-only">{label}</span>
    </div>
  );
}

DotMatrixLoader.propTypes = {
  className: PropTypes.string,
  label: PropTypes.string,
  decorative: PropTypes.bool,
  bare: PropTypes.bool,
  wavePeriodMs: PropTypes.number,
};
