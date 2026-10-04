import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { TriangleAlert } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** @typedef {[number, number, number, number]} Bbox west, south, east, north */

const EDGES = [
  { key: "north", label: "North edge (latitude)", step: 0.01, min: -90, max: 90 },
  { key: "south", label: "South edge (latitude)", step: 0.01, min: -90, max: 90 },
  { key: "west", label: "West edge (longitude)", step: 0.01, min: -180, max: 180 },
  { key: "east", label: "East edge (longitude)", step: 0.01, min: -180, max: 180 },
];

/** @param {Bbox | null | undefined} bbox */
function toDraft(bbox) {
  const [west, south, east, north] = bbox || [];
  const show = (/** @type {number | undefined} */ n) => (Number.isFinite(n) ? String(Number(n?.toFixed(5))) : "");
  return { north: show(north), south: show(south), west: show(west), east: show(east) };
}

/**
 * Checks four typed edges. Returns the box, or the plain-language reason it
 * can't be used.
 * @param {Record<string, string>} draft
 * @returns {{ bbox: Bbox } | { error: string }}
 */
export function parseAreaFields(draft) {
  const nums = EDGES.map((e) => ({ ...e, n: draft[e.key] === "" ? NaN : Number(draft[e.key]) }));
  const missing = nums.find((e) => !Number.isFinite(e.n));
  if (missing) return { error: `Type a number for the ${missing.key} edge.` };
  const bad = nums.find((e) => e.n < e.min || e.n > e.max);
  if (bad) return { error: `The ${bad.key} edge must be between ${bad.min} and ${bad.max}.` };
  const [north, south, west, east] = nums.map((e) => e.n);
  if (south >= north) return { error: "The south edge must be below the north edge." };
  if (west >= east) return { error: "The west edge must be left of the east edge." };
  return { bbox: [west, south, east, north] };
}

/**
 * Moves (arrows) or resizes (Shift + arrows) a box by a tenth of its size.
 * Right and Up grow it, Left and Down shrink it. The box stays on the map.
 * @param {Bbox} bbox
 * @param {string} key
 * @param {boolean} resize
 * @returns {Bbox | null}
 */
export function nudgeBbox(bbox, key, resize) {
  const [west, south, east, north] = bbox;
  const dx = (east - west) / 10;
  const dy = (north - south) / 10;
  /** @type {Bbox} */
  let next;
  if (!resize) {
    const sx = key === "ArrowLeft" ? -dx : key === "ArrowRight" ? dx : 0;
    const sy = key === "ArrowDown" ? -dy : key === "ArrowUp" ? dy : 0;
    if (!sx && !sy) return null;
    next = [west + sx, south + sy, east + sx, north + sy];
  } else if (key === "ArrowRight") next = [west, south, east + dx, north];
  else if (key === "ArrowLeft") next = [west, south, east - dx, north];
  else if (key === "ArrowUp") next = [west, south, east, north + dy];
  else if (key === "ArrowDown") next = [west, south, east, north - dy];
  else return null;
  if (next[0] >= next[2] || next[1] >= next[3]) return null;
  const clamp = (/** @type {number} */ n, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, n));
  return [clamp(next[0], -180, 180), clamp(next[1], -90, 90), clamp(next[2], -180, 180), clamp(next[3], -90, 90)];
}

/**
 * Keyboard-friendly way to set the map area the drag tool draws: type the
 * four edges, or focus the area summary and use the arrow keys to move it
 * (Shift + arrows to resize).
 *
 * @param {{
 *   value?: Bbox | null,
 *   onChange: (bbox: Bbox) => void,
 *   idPrefix?: string,
 * }} props
 */
export default function MapAreaFields({ value = null, onChange, idPrefix = "map-area" }) {
  const [draft, setDraft] = useState(() => toDraft(value));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  // A drag on the map (or a nudge) rewrites the fields.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the map's box into the fields
    setDraft(toDraft(value));
    setError(null);
  }, [value]);

  function apply() {
    const parsed = parseAreaFields(draft);
    if ("error" in parsed) {
      haptic("error");
      setError(parsed.error);
      return;
    }
    setError(null);
    haptic("success");
    onChange(parsed.bbox);
  }

  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-mono text-sm">Set the area with the keyboard</legend>
      <p>Type the four edges, then choose Set area. Positive latitude is north, positive longitude is east.</p>
      <div className="grid grid-cols-2 gap-2">
        {EDGES.map((edge) => (
          <label key={edge.key} className="block" htmlFor={`${idPrefix}-${edge.key}`}>
            <span className="block">{edge.label}</span>
            <input
              id={`${idPrefix}-${edge.key}`}
              type="number"
              inputMode="decimal"
              step={edge.step}
              min={edge.min}
              max={edge.max}
              value={draft[edge.key]}
              onChange={(e) => setDraft((d) => ({ ...d, [edge.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply();
                }
              }}
              aria-invalid={error ? true : undefined}
              className="mt-1 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-2">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
      <Button type="button" size="sm" variant="secondary" surface="primary" onClick={apply}>
        Set area
      </Button>
      {value ? (
        <div
          role="group"
          tabIndex={0}
          aria-label="Selected area. Use the arrow keys to move it, and Shift with the arrow keys to resize it."
          className="rounded-large-element surface-primary p-3 focus-visible:outline-2 focus-visible:outline-accent"
          onKeyDown={(e) => {
            const next = nudgeBbox(value, e.key, e.shiftKey);
            if (!next) return;
            e.preventDefault();
            haptic("selection");
            onChange(next);
          }}
        >
          <p className="font-mono text-xs">Selected area</p>
          <p>
            {`North ${draft.north}, south ${draft.south}, west ${draft.west}, east ${draft.east}`}
          </p>
          <p className="text-xs">Arrow keys move it. Shift with an arrow key resizes it.</p>
        </div>
      ) : null}
    </fieldset>
  );
}

MapAreaFields.propTypes = {
  value: PropTypes.arrayOf(PropTypes.number),
  onChange: PropTypes.func.isRequired,
  idPrefix: PropTypes.string,
};
