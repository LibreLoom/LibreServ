import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { TriangleAlert } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { EDGES, nudgeBbox, parseAreaFields, toDraft } from "../../lib/mapAreaFields.js";

/** @typedef {import("../../lib/mapAreaFields.js").Bbox} Bbox */

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
