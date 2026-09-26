/**
 * Universal access model — the frontend mirror of `access.rs`.
 *
 * One capability vocabulary for every shareable subject (file, folder,
 * drive, album): members are Luna users, links are "anyone with the URL".
 * The wire format is a string: "view" | "upload" | "view+upload" | "full"
 * | "respond", plus an optional "+share" tail ("full+share") marking
 * share-management rights. These helpers turn that string into bits so
 * the UI can ask "does the caller hold everything this option gives?".
 */

import { folderHref } from "./paths.js";

export const CAP = {
  VIEW: 1,
  UPLOAD: 2,
  EDIT: 4,
  RESPOND: 8,
  // Share-management: required to add members, mint links, or retune
  // grants. Never grantable on public links (a guest URL has no identity).
  SHARE: 16,
};
export const CAP_FULL = CAP.VIEW | CAP.UPLOAD | CAP.EDIT;
export const CAP_MANAGE = CAP_FULL | CAP.SHARE;

export const KIND_PATH = "path";
export const KIND_ALBUM = "album";

/** @param {string|number|null|undefined} caps */
export function capsBits(caps) {
  if (typeof caps === "number") return caps;
  const s = String(caps || "").trim().toLowerCase();
  // Whole-set aliases that don't compose as parts — "full" is not a sum.
  switch (s) {
    case "read_write":
    case "write":
      return CAP.VIEW | CAP.UPLOAD;
    case "full":
    case "edit":
      return CAP_FULL;
    case "full+share":
    case "edit+share":
      return CAP_MANAGE;
    case "respond":
      return CAP.RESPOND;
    case "none":
    case "":
      return 0;
    default:
      break;
  }
  let bits = 0;
  for (const part of s.split("+")) {
    switch (part) {
      case "view":
      case "read":
        bits |= CAP.VIEW;
        break;
      case "upload":
        bits |= CAP.UPLOAD;
        break;
      case "share":
        bits |= CAP.SHARE;
        break;
      case "":
        break;
      default:
        return 0;
    }
  }
  return bits;
}

/**
 * Split a wire caps string into its content set and the share bit —
 * "full+share" → `{ content: "full", share: true }`.
 * @param {string|number} caps
 */
export function splitShareCaps(caps) {
  const bits = capsBits(caps);
  const share = (bits & CAP.SHARE) !== 0;
  const content = bits & ~CAP.SHARE;
  const base = content === CAP_FULL ? "full"
    : content === CAP.RESPOND ? "respond"
      : content === (CAP.VIEW | CAP.UPLOAD) ? "view+upload"
        : content === CAP.UPLOAD ? "upload"
          : content === CAP.VIEW ? "view"
            : "";
  return { content: base, share };
}

/** Join a content set with the share bit back into a wire string. */
export function joinShareCaps(content, share) {
  return share ? `${content || "view"}+share` : content;
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
  const { content, share } = splitShareCaps(caps);
  const base = (() => {
    switch (content) {
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
        return share ? "Can share" : "No access";
    }
  })();
  return share ? `${base} + share` : base;
}

/** One-line hint under a caps dropdown — keep it short, no lectures. */
export function capsHint(caps, { album = false, file = false, form = false } = {}) {
  const { content, share } = splitShareCaps(caps);
  const base = (() => {
    switch (content) {
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
  })();
  if (!share) return base;
  const tail = "They can also share this with other people.";
  return base ? `${base} ${tail}` : tail;
}

export function sharedItemHref(row) {
  if (row.kind === KIND_ALBUM) {
    return `/gallery#albums/${encodeURIComponent(row.drive_id)}/${encodeURIComponent(row.album_id)}`;
  }
  // File grants land on the file's own path: `list` answers a one-entry
  // listing there (the file row is the member's virtual root) and the
  // parent folder is not browsable, so `?path=<file>` — never the parent.
  return folderHref(row.drive_id, row.path || "");
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
