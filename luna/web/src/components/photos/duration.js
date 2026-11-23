/**
 * Photo/video length formatters shared by the grid and the details panel.
 * Kept in its own tiny module so the grid never imports PhotoInfoPanel's
 * lazy-loaded map and leaflet CSS.
 *
 * @param {number} [secs]
 */
export function fmtDuration(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** Short m:ss chip for a video thumbnail. @param {number} [secs] */
export function fmtDurationClock(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
