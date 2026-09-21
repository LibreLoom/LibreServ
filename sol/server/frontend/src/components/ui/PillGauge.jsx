import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

/**
 * PillGauge — a segmented pill gauge, the Simplex Mono progress bar.
 *
 * A row of pill-shaped segments that fill left-to-right. Filled segments
 * light up in the variant color; empty segments sit as quiet accent-tinted
 * pills at the same size. Flex-distributed so the bar is always fluid —
 * no measurement, no ResizeObserver, just flex.
 *
 * On mount, the bar animates from zero to its target value: each filled
 * segment scales in from left with a staggered delay, giving a "fill-up"
 * effect that makes the gauge feel alive on first render. The stagger
 * is capped so long bars don't take forever.
 *
 * @param {{ value?: number, variant?: "success"|"warning"|"error"|"accent", segments?: number, className?: string, "aria-label"?: string }} props
 */
const VARIANT_FILL = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  accent: "bg-accent",
};

export default function PillGauge({
  value = 0,
  variant = "accent",
  segments = 12,
  className = "",
  "aria-label": ariaLabel,
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const clamped = Math.max(0, Math.min(100, value));
  const filledCount = mounted
    ? Math.round((clamped / 100) * segments)
    : 0;

  // Stagger delay: 40ms per segment, capped at 400ms total
  const stagger = Math.min(400 / segments, 40);

  return (
    <div
      className={cn("flex w-full gap-1", className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={
            i < filledCount
              ? { animationDelay: `${i * stagger}ms` }
              : undefined
          }
          className={cn(
            "flex-1 h-2.5 rounded-pill",
            "motion-safe:transition-colors motion-safe:duration-300",
            "motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
            i < filledCount
              ? cn(
                  VARIANT_FILL[variant] || VARIANT_FILL.accent,
                  "animate-pill-gauge-fill",
                )
              : "bg-accent/15",
          )}
        />
      ))}
    </div>
  );
}
