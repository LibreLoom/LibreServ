// @ts-nocheck
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

const DOT_PITCH = 18; // 18px grid: a fine field of dots across the whole viewport
const REST_DOT_RADIUS = 1.35; // a delicate 2.7px resting dot
const CREST_DOT_RADIUS = 2.2; // crest dots swell to ~4.4px
const WAVE_PERIOD_MS = 4200; // crests pass a fixed point every 4.2s
const WAVE_LENGTH = 560; // crest-to-crest distance along the sweep
const WAVE_STEP = WAVE_LENGTH / Math.SQRT2; // diagonal translation per cycle
const SWELL_SHARE = 0.78; // fraction of the period lit by one swell
const RESTING_ALPHA = 0.1; // the field between crests
const CREST_ALPHA = 0.72; // the field under a crest
const REDUCED_ALPHA = 0.16; // static field when motion is reduced

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function dotMask(radius, feather) {
  const dot = `radial-gradient(circle at center, currentColor ${radius}px, transparent ${
    radius + feather
  }px)`;
  return {
    WebkitMaskImage: dot,
    maskImage: dot,
    WebkitMaskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
    maskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
}

const REST_MASK = dotMask(REST_DOT_RADIUS, 0.55);
const CREST_MASK = dotMask(CREST_DOT_RADIUS, 0.9);

/**
 * One swell of the wave, repeated every WAVE_LENGTH px along the 135deg sweep
 * axis. A raised cosine gives a smooth rise and fall (no visible edges), and
 * the gap after it keeps the swell a distinct crest rather than a wash.
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
    stops.push(`${color} ${(t * SWELL_SHARE * WAVE_LENGTH).toFixed(1)}px`);
  }
  stops.push(`transparent ${WAVE_LENGTH}px`);
  return `repeating-linear-gradient(135deg, ${stops.join(", ")})`;
})();

// The band must stay bigger than the field for the whole cycle. It is shifted
// by WAVE_STEP, so that much overhang on every side is enough.
const BAND_OVERSCAN = Math.ceil(WAVE_STEP) + 2;

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
 * DotMatrixLoader: a viewport-filling field of dots with a swell rolling
 * diagonally across it.
 *
 * The dots are CSS masks over two plain layers, so the field and the crest stay
 * crisp at any size. The crest layer holds a repeating gradient that an
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
        { transform: `translate3d(${WAVE_STEP}px, ${WAVE_STEP}px, 0)` },
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
    >
      <div
        className="absolute inset-0 bg-current"
        style={{ ...REST_MASK, opacity: reduced ? REDUCED_ALPHA : RESTING_ALPHA }}
      />
      {reduced ? null : (
        <div className="absolute inset-0 overflow-hidden" style={CREST_MASK}>
          <div
            ref={bandRef}
            data-slot="matrix-wave"
            className="absolute"
            style={{
              left: -BAND_OVERSCAN,
              top: -BAND_OVERSCAN,
              width: `calc(100% + ${2 * BAND_OVERSCAN}px)`,
              height: `calc(100% + ${2 * BAND_OVERSCAN}px)`,
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
