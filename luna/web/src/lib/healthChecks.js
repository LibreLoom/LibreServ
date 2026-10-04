// Plain-language labels for health-check names (AGENTS.md).
// Shared by the setup System check, SystemHealthPill, and the About page
// System Checks card. The backend's messages say what stops working and what
// to do; these are just the row titles.
export const CHECK_LABELS = {
  database: "Accounts and settings",
  data_path_writable: "Luna data folder",
  logs_path_writable: "Logs folder",
  disk_space: "Storage space",
  clock: "Clock",
  update_signing: "Update safety check",
  os_update_tools: "System updates",
  network: "Network",
  connect: "Luna Connect",
  remote_access: "Remote access",
  office_pack: "Documents, spreadsheets, and presentations",
  diagram_pack: "Diagrams",
  whiteboard: "Whiteboards",
  video_tools: "Video previews",
  heic_tools: "iPhone photos",
  drive_tools: "Adding and ejecting drives",
  ntfs_support: "NTFS drives",
  erase_tools: "Erasing drives",
  smart_tool: "Hard drive health reports",
  trim_tool: "SSD upkeep",
  cloud_backup: "Cloud backup",
};

export const CATEGORY_LABELS = {
  system: "System",
  storage: "Storage",
  network: "Network",
  drives: "Drives",
  backups: "Backups",
  features: "Features",
};

export const CATEGORY_ORDER = ["system", "storage", "network", "drives", "backups", "features"];

/** Areas the setup system check covers — backups don't exist yet then. */
export const SETUP_CATEGORY_ORDER = CATEGORY_ORDER.filter((id) => id !== "backups");

/** @typedef {"passed" | "warning" | "failed"} CheckStatus */

/** Failures first, then warnings, then passes. */
export function statusRank(status) {
  if (status === "failed") return 0;
  if (status === "warning") return 1;
  return 2;
}

export function labelFor(name) {
  if (CHECK_LABELS[name]) return CHECK_LABELS[name];
  const driveRw = name.match(/^drive_(.+)_read_write$/);
  if (driveRw) return `Drive save test`;
  const driveSmart = name.match(/^drive_(.+)_smart$/);
  if (driveSmart) return "Hard drive wear check";
  if (name.startsWith("protect_")) return "Protected folder";
  return String(name)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Prefer the drive label (or protected folder) from check details when present. */
export function displayLabel(name, check) {
  const folder = check?.details?.folder;
  if (folder && name.startsWith("protect_")) {
    const target = check?.details?.target_drive;
    return target ? `${folder} — copy on ${target}` : `${folder} — protected copy`;
  }
  const label = check?.details?.drive_label;
  if (label && name.startsWith("drive_")) {
    if (name.endsWith("_read_write")) return `${label} — save test`;
    if (name.endsWith("_smart")) return `${label} — hard drive wear`;
  }
  return labelFor(name);
}
