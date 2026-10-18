/** Decimal sizes (1 KB = 1000 B), matching the Drives page and the dashboard. */
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
