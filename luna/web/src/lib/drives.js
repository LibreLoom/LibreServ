/**
 * Drive-state predicates shared by the Files page, the drive menu,
 * and the file explorer.
 */

import { postJson } from "./api.js";
import { isMockUnknownDrive } from "./devMockDrives.js";

/**
 * The drive is encrypted and its container is not open, so nothing can be read
 * until someone enters the password. Checked before {@link isUnopenable}: a
 * locked drive has no mount, and calling that "can't open" would blame the
 * drive for working exactly as designed.
 * @param {{ locked?: boolean }} drive
 */
export function isLockedDrive(drive) {
  return drive?.locked === true;
}

/**
 * The drive is held exclusively by an in-place conversion.
 * @param {{ converting?: boolean }} drive
 */
export function isConvertingDrive(drive) {
  return drive?.converting === true;
}

/**
 * Luna knows this drive and it is plugged in, but Luna can't open it (its
 * mount is gone). Its files and free space aren't available.
 * @param {{ state?: string, mounted?: boolean, locked?: boolean, converting?: boolean }} drive
 */
export function isUnopenable(drive) {
  if (isLockedDrive(drive) || isConvertingDrive(drive)) return false;
  return (drive.state === "as_is" || drive.state === "readonly") && drive.mounted === false;
}

/**
 * Drive is plugged in, listed and open (not missing, ejected, failed, locked,
 * converting, or unopenable). A failed drive has mount or I/O errors, so it
 * can't be browsed.
 * @param {{ state?: string, mounted?: boolean, locked?: boolean, converting?: boolean }} drive
 */
export function isPresentDrive(drive) {
  return (
    drive.state !== "missing"
    && drive.state !== "ejected"
    && drive.state !== "failed"
    && drive.mounted !== false
    && !isLockedDrive(drive)
    && !isConvertingDrive(drive)
  );
}

/**
 * Drive can accept writes — present and not read-only.
 * @param {{ state?: string, locked?: boolean, converting?: boolean }} drive
 */
export function isWritableDrive(drive) {
  return isPresentDrive(drive) && drive.state !== "readonly";
}

/**
 * The encryption page's route for a drive.
 * @param {{ id: string }} drive
 */
export function encryptionHref(drive) {
  return `/files/${drive.id}/encryption`;
}

/**
 * One line describing a drive's encryption state, for the drive card. Empty
 * when the drive is not encrypted and not converting — most drives.
 * @param {{ encrypted?: boolean, locked?: boolean, converting?: boolean }} drive
 */
export function driveEncryptionLine(drive) {
  if (drive?.converting) return "Encrypting";
  if (!drive?.encrypted) return "";
  // The card's button is an action, not a state: the pill already says Locked.
  return drive.locked ? "Unlock" : "Encryption";
}

/**
 * Let go of a drive Luna opened read-only to show its contents, once the
 * inspect window closes. Nothing happens for a missing drive or a demo
 * drive. A failure is thrown so the caller can tell the person.
 * @param {{ name?: string } | null | undefined} drive
 * @returns {Promise<void>}
 */
export async function releaseInspectedDrive(drive) {
  if (!drive?.name || isMockUnknownDrive(drive.name)) return;
  await postJson(`/api/v1/drives/${encodeURIComponent(drive.name)}/release`, {});
}
