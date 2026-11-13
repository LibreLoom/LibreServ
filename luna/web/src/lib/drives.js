/**
 * Drive-state predicates shared by the Files page, the drive menu,
 * and the file explorer.
 */

import { postJson } from "./api.js";
import { isMockUnknownDrive } from "./devMockDrives.js";

/**
 * The drive is protected with a password and is closed right now. It is not
 * broken: it needs its password, and its mount is gone on purpose.
 * @param {{ encrypted?: boolean, locked?: boolean }} drive
 */
export function isLocked(drive) {
  return Boolean(drive.encrypted && drive.locked);
}

/**
 * Luna knows this drive and it is plugged in, but Luna can't open it (its
 * mount is gone). Its files and free space aren't available. A locked drive
 * is not this: it just needs its password.
 * @param {{ state?: string, mounted?: boolean, encrypted?: boolean, locked?: boolean }} drive
 */
export function isUnopenable(drive) {
  return (drive.state === "as_is" || drive.state === "readonly") && drive.mounted === false && !isLocked(drive);
}

/**
 * Drive is plugged in, listed and open (not missing, ejected, failed, or
 * unopenable). A failed drive has mount or I/O errors, so it can't be browsed.
 * @param {{ state?: string, mounted?: boolean }} drive
 */
export function isPresentDrive(drive) {
  return (
    drive.state !== "missing"
    && drive.state !== "ejected"
    && drive.state !== "failed"
    && drive.mounted !== false
  );
}

/**
 * Drive can accept writes — present and not read-only.
 * @param {{ state?: string }} drive
 */
export function isWritableDrive(drive) {
  return isPresentDrive(drive) && drive.state !== "readonly";
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
