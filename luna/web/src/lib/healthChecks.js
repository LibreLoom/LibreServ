// Plain-language labels for health-check names (AGENTS.md).
// Shared by SystemHealthPill and the About page System Checks card.
export const CHECK_LABELS = {
  disk_space: "Storage space",
  database: "Database",
  database_writable: "Database folder",
  data_path_writable: "Luna data folder",
  logs_path_writable: "Logs folder",
  api_server: "Luna software",
};

export function labelFor(name) {
  if (CHECK_LABELS[name]) return CHECK_LABELS[name];
  const driveRw = name.match(/^drive_(.+)_read_write$/);
  if (driveRw) return `Drive write test`;
  const driveSmart = name.match(/^drive_(.+)_smart$/);
  if (driveSmart) return "Drive hardware report";
  return String(name)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Prefer the drive label from check details when present. */
export function displayLabel(name, check) {
  const label = check?.details?.drive_label;
  if (label && name.startsWith("drive_")) {
    if (name.endsWith("_read_write")) return `${label} — write test`;
    if (name.endsWith("_smart")) return `${label} — hardware report`;
  }
  return labelFor(name);
}
