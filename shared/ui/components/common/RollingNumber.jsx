import { cn } from "../../lib/utils";

const STEP = "1.25em";

function Digit({ digit }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block overflow-hidden align-bottom animate-in fade-in duration-200"
      style={{ height: STEP, lineHeight: STEP }}
    >
      <span
        className="flex flex-col motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out"
        style={{ transform: `translateY(calc(${digit} * -${STEP}))` }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <span key={d} className="block text-center" style={{ height: STEP }}>{d}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * RollingNumber — an odometer-style counter. Each digit scrolls to its new
 * value on its own column, so only the digits that change move. Columns are
 * keyed by place (ones, tens, …) so a changing count never remounts them.
 *
 * @param {{ value: number, className?: string }} props
 */
export default function RollingNumber({ value, className = "" }) {
  const digits = String(Math.max(0, Math.trunc(value))).split("").reverse();
  return (
    <span className={cn("inline-flex whitespace-nowrap", className)}>
      <span className="sr-only">{value}</span>
      {digits.map((d, place) => (
        <Digit key={place} digit={Number(d)} />
      )).reverse()}
    </span>
  );
}
