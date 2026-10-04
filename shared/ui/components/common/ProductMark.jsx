import PropTypes from "prop-types";

// Brand marks for the two products, from the design repo (logos/LibreServ).
// Flat, one color: they take the surrounding text color, so on an inverted card
// they flip with it. Nothing else to theme.

const LUNA_MOON = "M88 40.2V99.7A48 48 0 0 0 136.0 147.7H201.4A86 86 0 1 1 88 40.2Z";

/** Luna: a moon cradling a disc. */
export function LunaMark({ size = 64, className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="30 30 180 180"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <path d={LUNA_MOON} />
      <circle cx="136" cy="99.7" r="30" />
    </svg>
  );
}
LunaMark.propTypes = { size: PropTypes.number, className: PropTypes.string };

// Sol: 37 threads spiral into the edge of a circle and merge with it. Each thread
// starts at radius 94 and eases inward to radius 34 while turning 200 degrees; the
// cubic ease gives zero radial speed at the start, so it leaves the edge tangentially.
const THREADS = 37;
const SOL_PATHS = Array.from({ length: THREADS }, (_, i) => {
  const start = (i * 360) / THREADS - 90;
  const steps = 90;
  let d = "";
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    const r = 34 + 60 * (1 - t) ** 3;
    const a = ((start + 200 * t) * Math.PI) / 180;
    d += `${k === 0 ? "M" : "L"}${(120 + r * Math.cos(a)).toFixed(1)} ${(120 + r * Math.sin(a)).toFixed(1)}`;
  }
  return d;
});

/** Sol: thirty-seven threads spiraling into a circle. `strokeWidth` is in 240-unit
 *  drawing space; raise it at small sizes so the threads stay visible. */
export function SolMark({ size = 64, className, strokeWidth = 3 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="22 22 196 196"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      {SOL_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
SolMark.propTypes = {
  size: PropTypes.number,
  className: PropTypes.string,
  strokeWidth: PropTypes.number,
};
