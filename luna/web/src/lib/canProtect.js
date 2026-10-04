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
