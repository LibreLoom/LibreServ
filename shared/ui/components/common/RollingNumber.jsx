import PropTypes from "prop-types";
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
 * `decimals` gives it a fixed decimal part, for values like a file size
 * ("96.0 MB"): the point is static text between two runs of columns, so
 * "96.0" → "96.1" moves the tenths column and nothing else. Without it the
 * counter is a whole number, which is what a count of files wants.
 *
 * @param {{ value: number, decimals?: number, className?: string }} props
 */
export default function RollingNumber({ value, decimals = 0, className = "" }) {
  const places = Math.max(0, Math.trunc(decimals));
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  // toFixed gives the exact digit string to draw, including any leading zero
  // in the decimal part ("96.0", not "96").
  const [whole, fraction = ""] = safe.toFixed(places).split(".");
  const wholeDigits = whole.split("").reverse();
  const fractionDigits = fraction.split("");

  return (
    <span className={cn("inline-flex whitespace-nowrap", className)}>
      <span className="sr-only">{safe.toFixed(places)}</span>
      {wholeDigits.map((d, place) => (
        <Digit key={`w${place}`} digit={Number(d)} />
      )).reverse()}
      {places > 0 && (
        <>
          <span aria-hidden="true">.</span>
          {fractionDigits.map((d, place) => (
            <Digit key={`f${place}`} digit={Number(d)} />
          ))}
        </>
      )}
    </span>
  );
}

RollingNumber.propTypes = {
  value: PropTypes.number.isRequired,
  decimals: PropTypes.number,
  className: PropTypes.string,
};
