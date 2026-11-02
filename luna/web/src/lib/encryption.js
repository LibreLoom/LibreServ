/**
 * The encryption page's API calls.
 *
 * Unlocking is open to anyone who can read the drive; encrypting and decrypting
 * are Admin-only. The server enforces both — these helpers only carry the
 * request.
 */

import { getJson, postJson } from "./api.js";

/**
 * @typedef {object} DriveEncryption
 * @property {string} drive_id
 * @property {string} label
 * @property {boolean} encrypted The drive on disk is a LUKS2 container.
 * @property {boolean} unlocked Its container is open right now.
 * @property {boolean} converting An in-place conversion holds the drive.
 * @property {boolean} interrupted A conversion started and did not finish.
 * @property {boolean} present The drive is plugged in.
 * @property {string} fs_type
 * @property {boolean} can_encrypt Whether Luna can convert this drive in place.
 * @property {string} cannot_encrypt_reason Why not, in plain words.
 */

/** @param {string} driveId @returns {Promise<DriveEncryption>} */
export function getDriveEncryption(driveId) {
  return getJson(`/api/v1/drives/${driveId}/encryption`);
}

/** @param {string} driveId @param {string} password */
export function unlockDrive(driveId, password) {
  return postJson(`/api/v1/drives/${driveId}/unlock`, { password });
}

/** @param {string} driveId */
export function lockDrive(driveId) {
  return postJson(`/api/v1/drives/${driveId}/lock`, {});
}

/** @param {string} driveId @param {string} password */
export function encryptDrive(driveId, password) {
  return postJson(`/api/v1/drives/${driveId}/encrypt`, { password });
}

/** @param {string} driveId @param {string} password */
export function decryptDrive(driveId, password) {
  return postJson(`/api/v1/drives/${driveId}/decrypt`, { password });
}

/**
 * Which of the six states the encryption page shows. Kept as one function so
 * the page and its tests cannot disagree about precedence.
 *
 * Takes a partial view: the page may render while the request is still in
 * flight, and every field it reads is optional.
 * @param {Partial<DriveEncryption> | undefined} data
 * @returns {"unencrypted"|"encrypting"|"locked"|"unlocked"|"decrypting"|"interrupted"}
 */
export function encryptionState(data) {
  if (data?.converting) {
    // A conversion in flight is either direction; `encrypted` is already true
    // for an interrupted encrypt, so the direction comes from which one the
    // drive is moving toward.
    return data.encrypted ? "decrypting" : "encrypting";
  }
  if (data?.interrupted) return "interrupted";
  if (!data?.encrypted) return "unencrypted";
  return data.unlocked ? "unlocked" : "locked";
}

/**
 * The plain-language copy for a state. One sentence each, per the UI rules.
 * @param {string} state
 * @param {Partial<DriveEncryption> | undefined} data
 */
export function encryptionCopy(state, data) {
  const label = data?.label ?? "this drive";
  switch (state) {
    case "unencrypted":
      return {
        title: "Not encrypted",
        body: "Files on this drive are not encrypted. Anyone who plugs it in can read them.",
      };
    case "encrypting":
      return {
        title: "Encrypting",
        body: `${label} is read-only until this finishes. You can close this page.`,
      };
    case "decrypting":
      return {
        title: "Decrypting",
        body: `${label} is read-only until this finishes. You can close this page.`,
      };
    case "locked":
      return {
        title: "Locked",
        body: "Enter the password to open it.",
      };
    case "unlocked":
      return {
        title: "Unlocked",
        body: "It stays open until you lock it or Luna restarts.",
      };
    case "interrupted":
      return {
        title: "Encryption was interrupted",
        body: "Enter the password to finish it.",
      };
    default:
      return { title: "", body: "" };
  }
}
