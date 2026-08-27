/**
 * Plain-language folder/file counts with correct singular/plural.
 *
 * @param {number|null|undefined} folders
 * @param {number|null|undefined} files
 * @returns {string|null} e.g. "1 folder and 2 files", or null when both unknown
 */
export function describeCounts(folders, files) {
  const hasFolders = folders != null && !Number.isNaN(Number(folders));
  const hasFiles = files != null && !Number.isNaN(Number(files));
  if (!hasFolders && !hasFiles) return null;

  const folderN = hasFolders ? Number(folders) : 0;
  const fileN = hasFiles ? Number(files) : 0;

  if (!hasFolders) {
    return `${fileN} file${fileN === 1 ? "" : "s"}`;
  }
  if (!hasFiles) {
    return `${folderN} folder${folderN === 1 ? "" : "s"}`;
  }
  if (folderN === 0 && fileN === 0) return "nothing yet";
  if (folderN === 0) return `${fileN} file${fileN === 1 ? "" : "s"}`;
  if (fileN === 0) return `${folderN} folder${folderN === 1 ? "" : "s"}`;
  return `${folderN} folder${folderN === 1 ? "" : "s"} and ${fileN} file${fileN === 1 ? "" : "s"}`;
}

/**
 * Inspect-modal sentence: "We found 1 folder and 2 files on this drive."
 *
 * @param {{ folders?: number, files?: number, unreadable?: number }} result
 * @returns {string}
 */
export function describeInspectSummary(result) {
  const folders = Number(result?.folders) || 0;
  const files = Number(result?.files) || 0;
  const unreadable = Number(result?.unreadable) || 0;
  const counts = describeCounts(folders, files);
  if (counts === "nothing yet") {
    return "This drive looks empty.";
  }
  const unread =
    unreadable > 0
      ? ` (${unreadable} could not be read)`
      : "";
  return `We found ${counts} on this drive${unread}.`;
}
