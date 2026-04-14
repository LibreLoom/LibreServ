export function formatDate(dateStr, use12Hour = false) {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return (
    date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) +
    " " +
    date.toLocaleTimeString(use12Hour ? "en-US" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: use12Hour,
    })
  );
}

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
