/* eslint-disable react-refresh/only-export-components -- exports date helpers used by GalleryPage and tests */
import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { dayKey } from "./PhotoTimeline.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * Local-TZ unix day bounds for gallery `from`/`to` and deep links.
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
 * Closest day key (YYYY-MM-DD) present in `photos`, skipping undated items.
 * Used by GalleryPage to land a date jump on the nearest day with photos.
 * @param {Array<{ taken_at?: number|null }>} photos
 * @param {string} ymd YYYY-MM-DD
 */
export function nearestDayKey(photos, ymd) {
  const target = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const photo of photos || []) {
    if (!photo?.taken_at) continue;
    const key = dayKey(photo.taken_at);
    const diff = Math.abs(Date.parse(`${key}T00:00:00Z`) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}

const dayInputClass =
  "w-full rounded-large-element bg-primary text-secondary border-2 border-secondary/30 px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none no-focus-outline";

/**
 * One-field jump dialog: pick a day, the timeline scrolls to the nearest
 * day with photos. Commits on a complete date value — no separate confirm.
 *
 * @param {{
 *   open?: boolean,
 *   onClose?: () => void,
 *   onJump?: (ymd: string) => void,
 * }} props
 */
export default function DayJumpModal({ open = false, onClose, onJump }) {
  const dayInputId = useId();
  const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const [dateInput, setDateInput] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reopen starts with a blank field
    if (open) setDateInput("");
  }, [open]);

  return (
    <ModalCard
      open={open}
      title="Jump to a day"
      onClose={onClose}
      initialFocusRef={inputRef}
    >
      {({ close }) => (
        <div className="space-y-3" data-slot="day-jump">
          <p className="text-sm">
            Pick a day — Luna scrolls your library to it, or to the closest day with photos.
          </p>
          <input
            ref={inputRef}
            id={dayInputId}
            type="date"
            aria-label="Day to jump to"
            value={dateInput}
            className={dayInputClass}
            onChange={(e) => {
              const ymd = e.target.value;
              setDateInput(ymd);
              if (!dayBoundsLocal(ymd)) return;
              haptic("selection");
              onJump?.(ymd);
              close();
            }}
          />
        </div>
      )}
    </ModalCard>
  );
}

DayJumpModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  onJump: PropTypes.func,
};
