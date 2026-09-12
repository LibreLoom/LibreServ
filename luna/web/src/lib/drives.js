/**
 * Drive-state predicates shared by the Files page, the drive menu,
 * and the file explorer.
 */

/**
 * Drive is plugged in and listed (not missing, ejected, or failed).
 * @param {{ state?: string }} drive
 */
export function isPresentDrive(drive) {
  return drive.state !== "missing" && drive.state !== "ejected" && drive.state !== "failed";
}

/**
 * Drive can accept writes — present and not read-only.
 * @param {{ state?: string }} drive
 */
export function isWritableDrive(drive) {
  return isPresentDrive(drive) && drive.state !== "readonly";
}
