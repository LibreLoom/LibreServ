export function formatTime(date, use12Hour = false) {
  if (!(date instanceof Date)) date = new Date(date);
  if (isNaN(date.getTime())) return "-";

  return date.toLocaleTimeString(use12Hour ? "en-US" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: use12Hour,
  });
}

export function formatDateWithTime(dateInput, use12Hour = false) {
  if (!dateInput) return "-";
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return "-";

  const dateStr = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeStr = formatTime(date, use12Hour);
  return `${dateStr} ${timeStr}`;
}

export function formatDateLong(dateInput, use12Hour = false) {
  if (!dateInput) return "Unknown";
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return "Unknown";

  const dateStr = date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = formatTime(date, use12Hour);
  return `${dateStr} ${timeStr}`;
}

export function formatDateOnly(dateInput) {
  if (!dateInput) return "Unknown";
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
