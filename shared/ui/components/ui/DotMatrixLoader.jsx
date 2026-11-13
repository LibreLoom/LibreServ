// @ts-nocheck
import { useEffect, useLayoutEffect, useRef } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

const DOT_PITCH = 18; // 18px grid: a fine field of dots across the whole viewport
const DOT_RADIUS = 1.5; // delicate 3px dots
const WAVE_PERIOD_MS = 5400; // one slow swell every 5.4s
const RESTING_ALPHA = 0.08; // the field at rest
const PEAK_ALPHA = 0.7; // under the crest of the swell

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const DOT = `radial-gradient(circle at center, currentColor ${DOT_RADIUS}px, transparent ${DOT_RADIUS + 0.6}px)`;
const dotsStyle = {
  WebkitMaskImage: DOT,
  maskImage: DOT,
  WebkitMaskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
  maskSize: `${DOT_PITCH}px ${DOT_PITCH}px`,
  WebkitMaskPosition: "center",
  maskPosition: "center",
};

/**
 * DotMatrixLoader: a viewport-filling field of dots with a slow diagonal
 * swell rolling across it.
 *
 * The dots are a CSS mask over two plain layers, and the swell is a soft
 * gradient band that the browser slides across them on the compositor. Nothing
 * runs on the main thread per frame, so the wave keeps moving smoothly even
 * while the page is busy building the thing it is waiting for. (It used to be a
 * canvas redrawn every frame, which froze exactly when it was needed.)
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
  waveSpeedMs: _waveSpeedMs, // accepted for old callers; the swell is one band now
  ...props
}) {
  const fieldRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const bandRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  useIsomorphicLayoutEffect(() => {
    const field = fieldRef.current;
    const band = bandRef.current;
    if (!field || !band || typeof band.animate !== "function") return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return undefined;

    let anim = null;
    const start = () => {
      const w = field.clientWidth || window.innerWidth || 800;
      const h = field.clientHeight || window.innerHeight || 600;
      // The band's centre line runs perpendicular to the sweep; moving the band
      // by (d, d) moves that line along x + y, so d covers the whole field.
      const d = (w + h) / 2.6;
      const at = anim ? anim.currentTime : 0;
      anim?.cancel();
      anim = band.animate(
        [
          { transform: `translate3d(${-d}px, ${-d}px, 0)` },
          { transform: `translate3d(${d}px, ${d}px, 0)` },
        ],
        { duration: wavePeriodMs, iterations: Infinity, easing: "linear" },
      );
      if (at) anim.currentTime = at;
    };
    start();
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      let first = true;
      ro = new ResizeObserver(() => {
        if (first) {
          first = false;
          return;
        }
        start();
      });
      ro.observe(field);
    }
    return () => {
      ro?.disconnect();
      anim?.cancel();
    };
  }, [wavePeriodMs]);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const fieldElement = (
    <div
      ref={fieldRef}
      aria-hidden="true"
      data-slot="matrix-canvas"
      className="absolute inset-0 block h-full w-full overflow-hidden pointer-events-none"
    >
      <div
        className="absolute inset-0 bg-current"
        style={{ ...dotsStyle, opacity: reduced ? 0.2 : RESTING_ALPHA }}
      />
      {reduced ? null : (
        <div className="absolute inset-0 overflow-hidden" style={dotsStyle}>
          <div
            ref={bandRef}
            className="absolute"
            style={{
              left: "-100%",
              top: "-100%",
              width: "300%",
              height: "300%",
              opacity: PEAK_ALPHA,
              willChange: "transform",
              backgroundImage:
                "linear-gradient(135deg, transparent 28%, currentColor 50%, transparent 72%)",
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
  waveSpeedMs: PropTypes.number,
  wavePeriodMs: PropTypes.number,
};
