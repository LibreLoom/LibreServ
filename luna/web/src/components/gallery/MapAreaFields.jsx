import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, TriangleAlert } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { EDGES, nudgeBbox, parseAreaFields, toDraft } from "../../lib/mapAreaFields.js";

/** @typedef {import("../../lib/mapAreaFields.js").Bbox} Bbox */

const MOVES = [
  { key: "ArrowLeft", label: "Move area west", icon: ArrowLeft },
  { key: "ArrowUp", label: "Move area north", icon: ArrowUp },
  { key: "ArrowDown", label: "Move area south", icon: ArrowDown },
  { key: "ArrowRight", label: "Move area east", icon: ArrowRight },
];

/**
 * Keyboard-friendly way to set the map area the drag tool draws: type the
 * four edges, or nudge the current area with the move buttons.
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

  function move(key) {
    if (!value) return;
    const next = nudgeBbox(value, key, false);
    if (!next) return;
    haptic("selection");
    onChange(next);
  }

  return (
    <div className="space-y-3 rounded-large-element surface-secondary p-4 text-sm">
      <p>Latitude runs north (+) to south (−). Longitude runs east (+) to west (−).</p>
      <div className="grid grid-cols-2 gap-3">
        {EDGES.map((edge) => (
          <label key={edge.key} className="block" htmlFor={`${idPrefix}-${edge.key}`}>
            <span className="block translate-x-5">{edge.label}</span>
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
              className="mt-1 w-full rounded-large-element surface-primary border-2 border-secondary/30 px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none no-focus-outline"
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" size="sm" variant="primary" onClick={apply}>
          Set area
        </Button>
        {value ? (
          <div role="group" aria-label="Move the area" className="flex items-center gap-1">
            {MOVES.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant="outline"
                aria-label={label}
                title={label}
                onClick={() => move(key)}
              >
                <Icon size={14} aria-hidden="true" />
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

MapAreaFields.propTypes = {
  value: PropTypes.arrayOf(PropTypes.number),
  onChange: PropTypes.func.isRequired,
  idPrefix: PropTypes.string,
};
