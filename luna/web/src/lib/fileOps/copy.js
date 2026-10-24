// Every user-facing string of the file operation card (§2.11 of
// docs/states-feedback/file-operations.md). Plain language, sentence case.
//
// Strings that name a file, folder or drive return SEGMENTS so the UI can draw
// the names as InlinePill: an array of `string | { pill: string }`. Use
// `plain(parts)` for aria labels, toasts and tests. Toasts are always plain.

import { fmtSize } from "../paths.js";

/** @typedef {string | { pill: string }} Part */
/** @typedef {Part[]} Parts */

/** @param {Parts} parts */
export function plain(parts) {
  return parts.map((p) => (typeof p === "string" ? p : p.pill)).join("");
}

/** @param {string} text */
const pill = (text) => ({ pill: String(text) });

const n = (count, one, many) => (count === 1 ? one : many);

// -- Fixed labels ------------------------------------------------------------

export const labels = {
  replace: "Replace",
  keep_both: "Keep both",
  skip: "Skip",
  confirmMove: "Move anyway",
  confirmCopy: "Copy anyway",
  tryAgain: "Try again",
  remove: "Remove",
  cancel: "Cancel",
  clear: "Clear",
  replaceAll: "Replace all",
  keepBothAll: "Keep both for all",
  skipAll: "Skip all",
  tryAllAgain: "Try all again",
  clearFailed: "Clear failed",
  showDetails: "Show details",
  hideDetails: "Hide details",
  close: "Close",
  appliesToRest: "Applies to the rest of this upload too.",
  dockRegion: "File tasks",
};

export const dockTitle = {
  working: "Working on your files",
  needsYou: "Some files need you",
};

export const text = {
  connectionLost: "Connection lost. Trying again…",
  unreadable: "Your browser couldn't read this file from your device.",
  waitingForQueue: "Waiting for Luna to finish other copies…",
  starting: "Starting…",
  singleFileLink: "Choose one file to replace this file.",
  offline: "Couldn't reach Luna. Check this device's connection and try again.",
};

/** Fallbacks that name the action that failed. */
export const failedFallback = {
  upload: "Luna couldn't upload this file. Try again.",
  gallery: "Luna couldn't upload this file. Try again.",
  copy: "Luna couldn't copy this. Try again.",
  move: "Luna couldn't move this. Try again.",
  "empty-trash": "Luna couldn't empty the trash. Try again.",
  purge: "Luna couldn't delete this permanently. Try again.",
  "restore-backup": "Luna couldn't restore this from the backup. Try again.",
  trash: "Luna couldn't move this to Trash. Try again.",
  "restore-trash": "Luna couldn't put this back. Try again.",
  zip: "Luna couldn't get this folder ready. Try again.",
};

/** @param {string} kind */
export function failedText(kind) {
  return failedFallback[kind] || "Luna couldn't finish this. Try again.";
}

/** A job Luna has no record of any more (after a reload). */
export function jobGone(kind) {
  return kind === "move"
    ? "Luna has no record of this move any more. Check the destination folder to see if it finished."
    : "Luna has no record of this copy any more. Check the destination folder to see if it finished.";
}

// -- Dock header -------------------------------------------------------------

/** @param {{ running: number, problems: number }} s */
export function dockHeaderTitle(s) {
  return s.running > 0 ? dockTitle.working : dockTitle.needsYou;
}

/**
 * Collapsed summary (mono). A lone upload operation reads `Uploading {n} files · {pct}%`.
 * @param {{ running: number, problems: number, pct: number|null, singleUpload?: { files: number }|null }} s
 */
export function dockSummary(s) {
  const pct = s.pct == null ? "" : ` · ${Math.round(s.pct)}%`;
  const need = s.problems > 0 ? ` · ${s.problems} need you` : "";
  if (s.running === 0) return s.problems > 0 ? `${s.problems} need you` : "";
  if (s.singleUpload) {
    return `Uploading ${s.singleUpload.files} ${n(s.singleUpload.files, "file", "files")}${pct}${need}`;
  }
  return `${s.running} running${pct}${need}`;
}

// -- Operation status line ---------------------------------------------------

/**
 * Status line for an operation. `op.title` is the name shown in the pill:
 * the file, the dropped folder, or the single item. `op.destLabel` is the
 * folder (the drive label at the drive root).
 * @param {any} op
 * @returns {Parts}
 */
export function opStatus(op) {
  const state = op.state;
  if (state === "cancelled") return ["Cancelled"];
  const total = op.itemsTotal ?? op.items?.length ?? 0;
  const done = op.itemsDone ?? 0;
  const name = op.title || "";
  const folder = op.destLabel || "";
  const running = state === "preparing" || state === "running" || state === "waiting";
  const partial = state === "partial";

  switch (op.kind) {
    case "upload":
    case "gallery": {
      if (name && (op.rootFolder || total <= 1)) {
        if (running) return ["Uploading ", pill(name)];
        if (state === "done") return ["Uploaded ", pill(name)];
        if (partial) {
          return op.rootFolder
            ? [`Uploaded ${done} of ${total} files in `, pill(name)]
            : ["Uploaded ", pill(name)];
        }
        return ["Couldn't upload ", pill(name)];
      }
      if (running) return [`Uploading ${total} files to `, pill(folder)];
      if (state === "done") return [`Uploaded ${total} files to `, pill(folder)];
      if (partial) return [`Uploaded ${done} of ${total} files to `, pill(folder)];
      return [`Couldn't upload ${total} files to `, pill(folder)];
    }
    case "copy":
    case "move": {
      const verbing = op.kind === "copy" ? "Copying" : "Moving";
      const past = op.kind === "copy" ? "Copied" : "Moved";
      const base = op.kind === "copy" ? "copy" : "move";
      const subject = name && total <= 1 ? [pill(name)] : [`${total} items`];
      if (running) return [`${verbing} `, ...subject, " to ", pill(folder)];
      if (state === "done") return [`${past} `, ...subject, " to ", pill(folder)];
      if (partial) return [`${past} ${done} of ${total} items to `, pill(folder)];
      return [`Couldn't ${base} `, ...subject, " to ", pill(folder)];
    }
    case "trash":
      if (running) return [`Moving ${total} items to Trash`];
      if (state === "done") return [`Moved ${total} items to Trash`];
      if (partial) return [`Moved ${done} of ${total} items to Trash`];
      return [`Couldn't move ${total} items to Trash`];
    case "restore-trash":
      if (running) return [`Putting back ${total} items`];
      if (state === "done") return [`Put back ${total} items`];
      if (partial) return [`Put back ${done} of ${total} items`];
      return [`Couldn't put back ${total} items`];
    case "purge":
      if (running) {
        return total > 1 || !name
          ? [`Deleting ${total} items permanently`]
          : ["Deleting ", pill(name), " permanently"];
      }
      if (state === "done") return ["Deleted permanently"];
      if (partial) return [`Deleted ${done} of ${total} items permanently`];
      return ["Couldn't delete permanently"];
    case "empty-trash":
      if (running) return ["Emptying Trash on ", pill(folder || name)];
      if (state === "done") return ["Trash emptied"];
      return ["Couldn't empty the trash"];
    case "restore-backup":
      if (running) return ["Restoring ", pill(name), " from a backup"];
      if (state === "done") return ["Restored as ", pill(name)];
      return ["Couldn't restore ", pill(name)];
    case "zip":
      if (running) return ["Getting ", pill(`${name}.zip`), " ready"];
      if (state === "done") return ["Download started"];
      return ["Couldn't get ", pill(`${name}.zip`), " ready"];
    default:
      return state === "failed" ? ["Couldn't finish this"] : ["Working on it"];
  }
}

// -- Meta line (mono) --------------------------------------------------------

/** @param {any} op */
export function opMeta(op) {
  if (op.kind === "upload" || op.kind === "gallery") {
    if (op.walking) return `Counting files… ${op.itemsTotal ?? 0} found`;
    const total = op.itemsTotal ?? 0;
    return `${op.itemsDone ?? 0} of ${total} files · ${fmtSize(op.bytesDone)} of ${fmtSize(op.bytesTotal)}`;
  }
  if (op.kind === "copy" || op.kind === "move") {
    if (op.items?.some((i) => i.waitingForQueue)) return text.waitingForQueue;
    if (!op.bytesTotal) return text.starting;
    const pct = Math.round(Math.min(100, (op.bytesDone / op.bytesTotal) * 100));
    return `${pct}% · ${fmtSize(op.bytesDone)} of ${fmtSize(op.bytesTotal)}`;
  }
  return "";
}

// -- Items -------------------------------------------------------------------

/** @param {any} item */
export function itemPercent(item) {
  if (!item.size) return 0;
  return Math.round(Math.min(100, (item.received / item.size) * 100));
}

/** @param {string} name */
export function cancelUploadAria(name) {
  return `Cancel uploading ${name}`;
}

/** @param {string} name */
function splitName(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Text of a decision row.
 * @param {any} op
 * @param {any} item
 * @returns {Parts}
 */
export function decisionText(op, item) {
  const d = item.decision;
  if (!d) return [];
  if (d.type === "broadens") return [d.message];
  const what = d.existingKind === "dir" ? "folder" : "file";
  return [`A ${what} named `, pill(item.name), " is already in ", pill(op.destLabel || ""), "."];
}

/**
 * Buttons of a decision row, with an optional InfoHint text.
 * @param {any} op
 * @param {any} item
 * @returns {{ choice: string, label: string, hint?: string }[]}
 */
export function decisionButtons(op, item) {
  const d = item.decision;
  if (!d) return [];
  const isJob = op.kind === "copy" || op.kind === "move";
  if (d.type === "broadens") {
    return [
      { choice: "confirm", label: op.kind === "copy" ? labels.confirmCopy : labels.confirmMove },
      { choice: "skip", label: labels.skip },
    ];
  }
  const { stem, ext } = splitName(item.name || "");
  return d.options.map((choice) => {
    if (choice === "replace") {
      return {
        choice,
        label: labels.replace,
        hint: isJob ? "The file that's there now goes to Trash." : "The file that's there now is overwritten.",
      };
    }
    if (choice === "keep_both") {
      let hint = `The new one gets a number added, like ${stem} (1)${ext}.`;
      if (d.existingKind === "dir") {
        hint = isJob ? "Luna doesn't merge folders." : "Luna can't replace a folder with a file.";
      }
      return { choice, label: labels.keep_both, hint };
    }
    return { choice, label: labels.skip };
  });
}

// -- Overflow and problems modal --------------------------------------------

/** @param {number} count */
export function moreProblems(count) {
  return `${count} more ${n(count, "problem", "problems")} →`;
}

/** @param {string} kind */
export function problemsTitle(kind) {
  if (kind === "upload" || kind === "gallery") return "Problems with this upload";
  if (kind === "copy") return "Problems with this copy";
  if (kind === "move") return "Problems with this move";
  return "Problems with this task";
}

// -- Success toasts (plain text, one per operation) -------------------------

/**
 * @param {any} op
 * @param {number} done number that succeeded
 * @returns {string|null}
 */
export function successToast(op, done) {
  if (done <= 0) return null;
  const name = op.title || "";
  const dest = op.destLabel || "";
  switch (op.kind) {
    case "upload":
      return `${done} ${n(done, "file", "files")} uploaded.`;
    case "gallery":
      return `${done} ${n(done, "photo", "photos")} uploaded.`;
    case "copy":
      return done === 1 && name ? `Copied ${name} to ${dest}.` : `Copied ${done} items to ${dest}.`;
    case "move":
      return done === 1 && name ? `Moved ${name} to ${dest}.` : `Moved ${done} items to ${dest}.`;
    case "trash":
      return done === 1 ? "Moved to Trash." : `Moved ${done} items to Trash.`;
    case "restore-trash":
      return done === 1 ? "Restored." : `Restored ${done} items.`;
    case "purge":
      return done === 1 ? "Deleted permanently." : `Deleted ${done} items permanently.`;
    case "empty-trash":
      return "Trash emptied.";
    case "restore-backup":
      return `Restored as ${name}.`;
    default:
      return typeof op.successToast === "string" ? op.successToast : null;
  }
}
