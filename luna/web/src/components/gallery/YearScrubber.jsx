/* eslint-disable react-refresh/only-export-components -- scrubber exports date helpers used by GalleryPage and tests */
import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Button from "../ui/Button.jsx";
import ModalCard from "../cards/ModalCard.jsx";
import { haptic } from "../../utils/haptics.js";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Local-TZ unix day/month bounds helpers for gallery `from`/`to`.
 * @param {string} ymd YYYY-MM-DD
 */
export function dayBoundsLocal(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000),
    label: start.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  };
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function monthBoundsLocal(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000),
    label: start.toLocaleDateString(undefined, { year: "numeric", month: "long" }),
  };
}

/**
 * Derive year/month pills from loaded photos when no year API exists.
 * @param {Array<{ taken_at?: number|null }>} photos
 */
export function yearsFromPhotos(photos) {
  /** @type {Map<number, Set<number>>} */
  const map = new Map();
  for (const photo of photos || []) {
    if (!photo?.taken_at) continue;
    const d = new Date(photo.taken_at * 1000);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    if (!map.has(y)) map.set(y, new Set());
    map.get(y).add(m);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      months: [...months].sort((a, b) => a - b),
    }));
}

/**
 * Year + month scrubber: pills that set from/to on the gallery query.
 *
 * @param {{
 *   photos?: object[],
 *   onPick: (range: { from: number, to: number, label: string, kind: 'day'|'month'|'year' }) => void,
 *   open?: boolean,
 *   onClose?: () => void,
 * }} props
 */
export default function YearScrubber({ photos = [], onPick, open = false, onClose }) {
  const years = useMemo(() => yearsFromPhotos(photos), [photos]);
  const [year, setYear] = useState(/** @type {number|null} */ (null));
  const [dateInput, setDateInput] = useState("");

  const active = years.find((y) => y.year === year) || years[0];

  return (
    <ModalCard open={open} title="Jump to a date" onClose={onClose}>
      {({ close }) => (
        <div className="space-y-4" data-slot="year-scrubber">
          {years.length === 0 ? (
            <p className="text-sm">
              No dated photos loaded yet. Scroll the library or pick a day below.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {years.map((entry) => (
                  <Button
                    key={entry.year}
                    type="button"
                    size="sm"
                    variant={entry.year === (year ?? active?.year) ? "accent" : "outline"}
                    onClick={() => {
                      haptic("selection");
                      setYear(entry.year);
                      const start = new Date(entry.year, 0, 1, 0, 0, 0, 0);
                      const end = new Date(entry.year, 11, 31, 23, 59, 59, 999);
                      onPick({
                        from: Math.floor(start.getTime() / 1000),
                        to: Math.floor(end.getTime() / 1000),
                        label: String(entry.year),
                        kind: "year",
                      });
                    }}
                  >
                    {entry.year}
                  </Button>
                ))}
              </div>
              {active && (
                <div className="flex flex-wrap gap-2">
                  {active.months.map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        haptic("selection");
                        const bounds = monthBoundsLocal(active.year, m);
                        onPick({ ...bounds, kind: "month" });
                        close();
                      }}
                    >
                      {MONTHS[m - 1]}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
          <label className="block text-sm">
            Or jump to a day
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              className="mt-1 w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 focus:border-accent focus:outline-none"
            />
          </label>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="accent"
              disabled={!dateInput}
              onClick={() => {
                const bounds = dayBoundsLocal(dateInput);
                if (!bounds) return;
                haptic("selection");
                onPick({ ...bounds, kind: "day" });
                close();
              }}
            >
              Go
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

YearScrubber.propTypes = {
  photos: PropTypes.arrayOf(PropTypes.object),
  onPick: PropTypes.func.isRequired,
  open: PropTypes.bool,
  onClose: PropTypes.func,
};
