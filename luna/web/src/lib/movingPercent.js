/** Whole percent for a `moving` value: rounded down, kept between 0 and 100. */
export function movingPercent(moving) {
  const n = Number(moving?.percent);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.floor(n)));
}
