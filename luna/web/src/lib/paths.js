/** Join a relative drive path with a child name. */
export function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

/** Parent of a relative path, or null at the drive root. */
export function parentPath(path) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

/** Router href for a folder on a drive. */
export function folderHref(driveId, folderPath) {
  if (!folderPath) return `/drives/${driveId}`;
  return `/drives/${driveId}?path=${encodeURIComponent(folderPath)}`;
}

/** Human-readable size (decimal). */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

/** Download URL for a file on a drive. */
export function downloadHref(driveId, filePath) {
  return `/api/v1/drives/${driveId}/files/content?path=${encodeURIComponent(filePath)}&download=1`;
}

/** Inline content URL (images, video, plain text). Luna forces download for unsafe types. */
export function contentHref(driveId, filePath) {
  return `/api/v1/drives/${driveId}/files/content?path=${encodeURIComponent(filePath)}`;
}

/** Last segment of a relative path. */
export function pathBasename(path) {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}
