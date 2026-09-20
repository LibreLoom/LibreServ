export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRelativeTime(dateInput) {
  if (!dateInput) return "Never";
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return "Never";
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value;
  let unit;
  if (absMs < hour) {
    value = Math.max(1, Math.round(absMs / minute));
    unit = "minute";
  } else if (absMs < day) {
    value = Math.round(absMs / hour);
    unit = "hour";
  } else if (absMs < 30 * day) {
    value = Math.round(absMs / day);
    unit = "day";
  } else {
    value = Math.round(absMs / (30 * day));
    unit = "month";
  }
  const plural = value === 1 ? unit : `${unit}s`;
  return diffMs < 0 ? `${value} ${plural} ago` : `in ${value} ${plural}`;
}
