/**
 * Drive-state predicates shared by the Files page, the drive menu,
 * and the file explorer.
 */

import { postJson } from "./api.js";
import { isMockUnknownDrive } from "./devMockDrives.js";

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
