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
 * @property {boolean} converting A format is running on this drive.
 * @property {boolean} present The drive is plugged in.
 * @property {string} fs_type
 * @property {boolean} can_encrypt Whether Luna can encrypt this drive.
 * @property {string} cannot_encrypt_reason Why not, in plain words.
 */

/**
 * What a wipe of this drive would destroy.
 * @typedef {object} WipePreview
 * @property {string} drive_id
 * @property {string} label
 * @property {number | null} used_bytes Bytes in use beyond filesystem overhead.
 * @property {boolean} meaningful Holds something a person would miss.
 * @property {string} target_fs The filesystem after the wipe.
 * @property {boolean} target_encrypted Whether it will be encrypted afterwards.
 * @property {{ name: string, kind: string }[]} entries Top-level names.
 * @property {number} folders
 * @property {number} files
 * @property {boolean} readable False when Luna could not look inside.
 */

/** @param {string} driveId @returns {Promise<DriveEncryption>} */
export function getDriveEncryption(driveId) {
  return getJson(`/api/v1/drives/${driveId}/encryption`);
}

/**
 * What a wipe would destroy. Read-only, and shared by every flow that wipes a
 * drive so the confirmation is the same wherever it is reached from.
 *
 * The intent is passed explicitly because the same drive wipes to different
 * things: `reformat` and `decrypt` leave plain exFAT, `encrypt` leaves ext4 in
 * a container. Inferring it from the drive's current state would make
 * "Reformat" promise encryption it is not going to do.
 * @param {string} driveId
 * @param {"encrypt" | "decrypt" | "reformat"} intent
 * @returns {Promise<WipePreview>}
 */
export function getWipePreview(driveId, intent) {
  return getJson(`/api/v1/drives/${driveId}/wipe-preview/${intent}`);
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
 * Wipe a plain drive and put a fresh exFAT filesystem on it, keeping its
 * identity. Refused for an encrypted drive, which needs its password.
 * @param {string} driveId
 */
export function reformatDrive(driveId) {
  return postJson(`/api/v1/drives/${driveId}/reformat`, {});
}

/**
 * Which of the six states the encryption page shows. Kept as one function so
 * the page and its tests cannot disagree about precedence.
 *
 * Takes a partial view: the page may render while the request is still in
 * flight, and every field it reads is optional.
 * @param {Partial<DriveEncryption> | undefined} data
 * @returns {"unencrypted"|"encrypting"|"locked"|"unlocked"|"decrypting"}
 */
export function encryptionState(data) {
  if (data?.converting) {
    // A format in flight is either direction. The drive is being wiped, so
    // `encrypted` still describes what it was; the direction comes from which
    // way it is moving.
    return data.encrypted ? "decrypting" : "encrypting";
  }
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
    default:
      return { title: "", body: "" };
  }
}
