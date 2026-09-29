// @ts-nocheck
import { useEffect, useLayoutEffect, useRef } from "react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";

const DOT_PITCH = 18; // Finer pitch: 18px grid creates a vast, macro perspective across the entire viewport
const DOT_RADIUS = 1.5; // Delicate 3px diameter dots
const WAVE_PERIOD_MS = 5400; // 5.4s cycle for a majestic, slower oceanic swell
const WAVE_STEP_MS = 28; // Tighter step between diagonals so wave fronts span broadly across the dense field

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const RESTING_ALPHA = 0.08; // Subtle resting field for heightened depth
const PEAK_ALPHA = 0.70; // Gentle, understated peak instead of glaring full-white
const HALF_WIDTH = 0.40; // Broad swell spanning 80% of the cycle

/**
 * Maps wave phase (0..1) to opacity using a smooth macro swell:
 * Soft, organic crest that rolls smoothly across the vast dot field with long,
 * expansive tails on both sides.
 * @param {number} p
 */
function phaseToAlpha(p) {
  let dist = Math.abs(p - 0.5);
  if (dist > 0.5) dist = 1.0 - dist;

  if (dist >= HALF_WIDTH) {
    return RESTING_ALPHA;
  }

  // Normalized distance from peak: 0 at center, 1 at cutoff
  const u = dist / HALF_WIDTH;
  // Windowing factor to ensure perfectly smooth decay to 0 at the tail edge
  const windowFactor = Math.cos((u * Math.PI) / 2);
  // Gentle, rounded crest decay with expansive, seamless flanks
  const factor = Math.exp(-1.1 * u) * windowFactor;

  return RESTING_ALPHA + factor * (PEAK_ALPHA - RESTING_ALPHA);
}

/**
 * DotMatrixLoader — Viewport-filling animated dot matrix (Canvas 2D).
 *
 * Renders a field of dots using a high-performance Canvas 2D engine with
 * diagonal batching, giving 60fps silky smooth motion with virtually zero
 * CPU and GPU memory overhead.
 *
 * @param {{
 *   className?: string,
 *   label?: string,
 *   decorative?: boolean,
 *   waveSpeedMs?: number,
 *   wavePeriodMs?: number,
 *   [key: string]: any
 * }} props
 */
export default function DotMatrixLoader({
  className = "",
  label = "Loading",
  decorative = false,
  waveSpeedMs = WAVE_STEP_MS,
  wavePeriodMs = WAVE_PERIOD_MS,
  ...props
}) {
  const canvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));

  useIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    let animId = 0;
    let logicalW = 0;
    let logicalH = 0;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const getThemeColor = () => {
      if (typeof window === "undefined") return "#ffffff";
      const style = window.getComputedStyle(canvas);
      if (style.color && style.color !== "rgba(0, 0, 0, 0)") {
        return style.color;
      }
      return document.documentElement.classList.contains("dark")
        ? "#ffffff"
        : "#000000";
    };

    const draw = (now) => {
      if (!logicalW || !logicalH) return;

      const dpr = window.devicePixelRatio || 1;
      const expectedW = Math.round(logicalW * dpr);
      const expectedH = Math.round(logicalH * dpr);

      if (canvas.width !== expectedW || canvas.height !== expectedH) {
        canvas.width = expectedW;
        canvas.height = expectedH;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, logicalW, logicalH);

      const color = getThemeColor();
      ctx.fillStyle = color;

      const cols = Math.ceil(logicalW / DOT_PITCH) + 1;
      const rows = Math.ceil(logicalH / DOT_PITCH) + 1;
      const startX = (logicalW - (cols - 1) * DOT_PITCH) / 2;
      const startY = (logicalH - (rows - 1) * DOT_PITCH) / 2;
      const maxDiag = rows - 1 + (cols - 1);

      if (prefersReducedMotion) {
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
          const y = startY + r * DOT_PITCH;
          for (let c = 0; c < cols; c++) {
            const x = startX + c * DOT_PITCH;
            ctx.moveTo(x + DOT_RADIUS, y);
            ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
          }
        }
        ctx.fill();
        ctx.restore();
        return;
      }

      // Batch draw calls by diagonal index d = r + c.
      // All dots on the same diagonal have the identical phase & opacity.
      // This reduces 2000+ individual draws down to ~80-100 batch calls per frame!
      for (let d = 0; d <= maxDiag; d++) {
        const offset = d * waveSpeedMs;
        const phase =
          ((((now - offset) % wavePeriodMs) + wavePeriodMs) % wavePeriodMs) /
          wavePeriodMs;
        const alpha = phaseToAlpha(phase);

        ctx.globalAlpha = alpha;
        ctx.beginPath();

        const minR = Math.max(0, d - (cols - 1));
        const maxR = Math.min(rows - 1, d);

        for (let r = minR; r <= maxR; r++) {
          const c = d - r;
          const x = startX + c * DOT_PITCH;
          const y = startY + r * DOT_PITCH;
          ctx.moveTo(x + DOT_RADIUS, y);
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        }

        ctx.fill();
      }

      ctx.restore();
    };

    const updateSize = (w, h) => {
      if (!w || !h) return;
      logicalW = w;
      logicalH = h;
      draw(performance.now());
    };

    // Synchronous immediate measurement on frame 0
    const parent = canvas.parentElement;
    const initialW =
      canvas.clientWidth || parent?.clientWidth || window.innerWidth || 800;
    const initialH =
      canvas.clientHeight || parent?.clientHeight || window.innerHeight || 600;
    updateSize(initialW, initialH);

    if (prefersReducedMotion) {
      return undefined;
    }

    const loop = (time) => {
      draw(time);
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);

    let ro;
    if (typeof ResizeObserver !== "undefined" && parent) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            updateSize(width, height);
          }
        }
      });
      ro.observe(parent);
    }

    return () => {
      if (animId) cancelAnimationFrame(animId);
      ro?.disconnect();
    };
  }, [waveSpeedMs, wavePeriodMs]);

  const canvasElement = (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-slot="matrix-canvas"
      className="absolute inset-0 block h-full w-full pointer-events-none"
    />
  );

  if (decorative) {
    return (
      <div
        aria-hidden="true"
        data-slot="matrix-loader"
        className={cn(
          "relative flex h-full w-full min-h-0 flex-1 flex-col items-center justify-center overflow-hidden surface-primary",
          className,
        )}
        {...props}
      >
        {canvasElement}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label={label}
      data-slot="matrix-loader"
      className={cn(
        "relative flex h-full w-full min-h-0 flex-1 flex-col items-center justify-center overflow-hidden surface-primary",
        className,
      )}
      {...props}
    >
      {canvasElement}
      <span className="sr-only">{label}</span>
    </div>
  );
}

DotMatrixLoader.propTypes = {
  className: PropTypes.string,
  label: PropTypes.string,
  decorative: PropTypes.bool,
  waveSpeedMs: PropTypes.number,
  wavePeriodMs: PropTypes.number,
};
