/**
 * Universal access model — the frontend mirror of `access.rs`.
 *
 * One capability vocabulary for every shareable subject (file, folder,
 * drive, album): members are Luna users, links are "anyone with the URL".
 * The wire format is a string: "view" | "upload" | "view+upload" | "full"
 * | "respond". These helpers turn that string into bits so the UI can ask
 * "does the caller hold everything this option gives?".
 */

import { fileHref, folderHref } from "./paths.js";

export const CAP = {
  VIEW: 1,
  UPLOAD: 2,
  EDIT: 4,
  RESPOND: 8,
};
export const CAP_FULL = CAP.VIEW | CAP.UPLOAD | CAP.EDIT;

export const KIND_PATH = "path";
export const KIND_ALBUM = "album";

/** @param {string|number|null|undefined} caps */
export function capsBits(caps) {
  if (typeof caps === "number") return caps;
  switch (caps) {
    case "view":
      return CAP.VIEW;
    case "upload":
      return CAP.UPLOAD;
    case "view+upload":
      return CAP.VIEW | CAP.UPLOAD;
    case "full":
      return CAP_FULL;
    case "respond":
      return CAP.RESPOND;
    default:
      return 0;
  }
}

/** True when `mine` covers every capability in `want`. */
export function capsCover(mine, want) {
  const m = capsBits(mine);
  const w = capsBits(want);
  return w !== 0 && (m & w) === w;
}

/** True when `caps` includes `bit` (e.g. `hasCap("view+upload", CAP.UPLOAD)`). */
export function hasCap(caps, bit) {
  return (capsBits(caps) & bit) !== 0;
}

/**
 * A shareable subject. `kind` is "path" (file/folder/drive — the backend
 * resolves which) or "album". `isFile` comes back from `/access/subject`.
 * @typedef {{ kind: string, driveId: string, path?: string, albumId?: string, isFile?: boolean, name?: string }} ShareSubject
 */

export function subjectQuery(subject) {
  const params = new URLSearchParams();
  params.set("kind", subject?.kind === KIND_ALBUM ? KIND_ALBUM : KIND_PATH);
  params.set("drive_id", subject?.driveId || "");
  if (subject?.path) params.set("path", subject.path);
  if (subject?.albumId) params.set("album_id", subject.albumId);
  return params.toString();
}

export function subjectKey(subject) {
  return [
    subject?.kind === KIND_ALBUM ? KIND_ALBUM : KIND_PATH,
    subject?.driveId || "",
    subject?.path || "",
    subject?.albumId || "",
  ];
}

/**
 * Capability choices valid for a subject, filtered to what the caller can
 * hand out (`myCaps` — the subset rule: you can only share what you hold).
 *
 * @param {{ kind: string, isFile?: boolean, isForm?: boolean }} subject
 * @param {string|number} myCaps capabilities the signed-in user holds
 * @param {{ forLink?: boolean }} opts links also allow "respond" on forms
 */
export function capsOptions(subject, myCaps, { forLink = false } = {}) {
  const mine = capsBits(myCaps);
  const isAlbum = subject?.kind === KIND_ALBUM;
  const isFile = subject?.isFile === true;
  const labels = isAlbum
    ? {
        view: "Can view",
        "view+upload": "Can view + add photos",
      }
    : isFile
      ? {
          view: "Can view",
          full: "Can view + edit",
        }
      : {
          view: "Can view",
          upload: "Upload only",
          "view+upload": "Can view + upload",
          full: "Can view + edit",
        };
  const order = isAlbum
    ? ["view", "view+upload"]
    : isFile
      ? ["view", "full"]
      : ["view", "upload", "view+upload", "full"];
  const out = [];
  if (forLink && subject?.isForm && (mine & (CAP.UPLOAD | CAP.EDIT)) !== 0) {
    // A respond link lets strangers fill in a form — it needs upload or
    // edit on the file, but grants the guest none of those capabilities.
    out.push({ value: "respond", label: "Collect answers" });
  }
  for (const value of order) {
    if (labels[value] && capsCover(mine, value)) {
      out.push({ value, label: labels[value] });
    }
  }
  return out;
}

/** Short human label for a caps string, tuned to the subject kind. */
export function capsLabel(caps, { album = false, file: _file = false } = {}) {
  switch (caps) {
    case "view":
      return "Can view";
    case "upload":
      return "Upload only";
    case "view+upload":
      return album ? "Can view + add photos" : "Can view + upload";
    case "full":
      return "Can view + edit";
    case "respond":
      return "Collect answers";
    default:
      return "No access";
  }
}

/** One-line hint under a caps dropdown — keep it short, no lectures. */
export function capsHint(caps, { album = false, file = false, form = false } = {}) {
  switch (caps) {
    case "view":
      if (form) return "Opens the form and its responses.";
      return album ? "Opens the album." : file ? "Opens and downloads the file." : "Opens and downloads files.";
    case "upload":
      return "Uploads files without seeing anything already here.";
    case "view+upload":
      return album
        ? "Opens the album and adds their own photos."
        : "Opens files and adds new ones, but can't delete or rename.";
    case "full":
      if (form) return "Edits the form and reads its responses.";
      return file
        ? "Opens, edits, and replaces this file."
        : "Opens, edits, uploads, renames, moves, and deletes files.";
    case "respond":
      return "People fill in the form — they never see other answers or the file itself.";
    default:
      return "";
  }
}

export function sharedItemHref(row) {
  if (row.kind === KIND_ALBUM) {
    return `/gallery#albums/${encodeURIComponent(row.drive_id)}/${encodeURIComponent(row.album_id)}`;
  }
  return row.is_file
    ? fileHref(row.drive_id, row.path)
    : folderHref(row.drive_id, row.path || "");
}

/** Primary action label for opening a shared item — matches the destination. */
export function sharedItemAction(row) {
  if (row.kind === KIND_ALBUM) return "View album";
  return row.is_file ? "Open" : "Browse files";
}

export function shareSubjectFromRow(row) {
  return {
    kind: row.kind,
    driveId: row.drive_id,
    path: row.path || "",
    albumId: row.album_id || "",
    isFile: row.is_file,
    name: row.name,
  };
}

const LINK_SESSION_PREFIX = "luna-link-";

/** Remember a freshly minted link URL so the sheet can show it again. */
export function rememberLinkUrl(linkId, url) {
  try {
    sessionStorage.setItem(`${LINK_SESSION_PREFIX}${linkId}`, url);
  } catch {
    // private mode
  }
}

export function rememberedLinkUrl(linkId) {
  try {
    return sessionStorage.getItem(`${LINK_SESSION_PREFIX}${linkId}`);
  } catch {
    return null;
  }
}
