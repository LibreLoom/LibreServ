import Card from "./Card";

/**
 * UptimeCard — dashboard metric showing how long the device has been running.
 *
 * Design: the uptime value is the hero — large monospace text. The "UPTIME"
 * label sits as a quiet eyebrow above it. A small accent dot to the left of
 * the label marks the system as live — static, not animated, the color does
 * the work. No icon circle, no pulse animation.
 *
 * @param {{ value: string }} props
 */
export default function UptimeCard({ value }) {
  return (
    <Card data-slot="uptime-card">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
          aria-hidden="true"
        />
        <span className="text-xs font-mono uppercase tracking-widest text-accent">
          Uptime
        </span>
      </div>
      <div className="text-3xl font-mono font-normal leading-tight">
        {value}
      </div>
    </Card>
  );
}
