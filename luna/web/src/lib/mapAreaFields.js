// Pure helpers behind the keyboard area fields (kept out of the component
// file so editing the component keeps hot reload working).

/** @typedef {[number, number, number, number]} Bbox west, south, east, north */

export const EDGES = [
  { key: "north", label: "North edge (latitude)", step: 0.01, min: -90, max: 90 },
  { key: "south", label: "South edge (latitude)", step: 0.01, min: -90, max: 90 },
  { key: "west", label: "West edge (longitude)", step: 0.01, min: -180, max: 180 },
  { key: "east", label: "East edge (longitude)", step: 0.01, min: -180, max: 180 },
];

/** @param {Bbox | null | undefined} bbox */
export function toDraft(bbox) {
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

