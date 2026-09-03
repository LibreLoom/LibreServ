/**
 * Protect is useful when Luna can keep a spare copy somewhere:
 * another plugged-in drive, or cloud backup when that is unlocked.
 *
 * Use logical OR (`||`), not bitwise OR (`|`).
 *
 * @param {{ driveCount?: number, cloudBackupConnected?: boolean }} opts
 * @returns {boolean}
 */
export function canProtect({ driveCount = 0, cloudBackupConnected = false } = {}) {
  return driveCount >= 2 || Boolean(cloudBackupConnected);
}

/**
 * Absolute path on disk for a folder under a drive mount (Connect backup sources).
 * @param {string | undefined | null} mountPoint
 * @param {string | undefined | null} relPath
 * @returns {string}
 */
export function absoluteFolderPath(mountPoint, relPath) {
  const root = String(mountPoint || "").replace(/\/+$/, "");
  const rel = String(relPath || "").replace(/^\/+/, "");
  if (!root) return "";
  return rel ? `${root}/${rel}` : root;
}
