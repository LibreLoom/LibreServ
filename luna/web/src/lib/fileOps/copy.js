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

/**
 * What a batch did, naming the items when there are few enough to name.
 *
 * "Moving 3 items to Trash" tells you nothing about what is going. A person
 * about to lose three things should see which three, so up to `NAMES_SHOWN`
 * are listed by name and the rest are counted. The names sit inside the
 * sentence — `Moving ` + names + ` to Trash` — because that is how it reads
 * aloud; a colon would turn it into a log line.
 *
 * @param {string} before e.g. "Moving "
 * @param {string} after e.g. " to Trash"
 * @param {any[]} items
 * @returns {Parts}
 */
export function batchLine(before, after, items) {
  const names = items.map((i) => i.name).filter(Boolean);
  const total = items.length;
  if (total === 0) return [`${before}these items${after}`];
  if (names.length === total && total <= NAMES_SHOWN) {
    /** @type {Parts} */
    const parts = [before];
    names.forEach((name, i) => {
      if (i > 0) parts.push(i === names.length - 1 ? " and " : ", ");
      parts.push(pill(name));
    });
    parts.push(after);
    return parts;
  }
  return [`${before}${total} ${n(total, "item", "items")}${after}`];
}

/** How many names a batch line lists before it counts the rest instead. */
export const NAMES_SHOWN = 3;

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
  appliesToRest: "Applies to the rest of this upload too.",
  dockRegion: "File tasks",
};

export const dockTitle = {
  working: "Working on your files",
  needsYou: "Some files need you",
  done: "Finished",
  stopped: "Stopped",
};

export const text = {
  connectionLost: "Connection lost. Trying again…",
  unreadable: "Your browser couldn't read this file from your device.",
  waitingForQueue: "Waiting for Luna to finish other copies…",
  starting: "Starting…",
  singleFileLink: "Choose one file to replace this file.",
  offline: "Couldn't reach Luna. Check this device's connection and try again.",
};

/**
 * Why an empty folder wasn't made: a file already has one of the names it
 * needs. The failed row already shows the folder's own name as a pill, so this
 * continues that sentence — and names the file in the way when it isn't the
 * folder itself (a folder three levels down can be blocked by its parent).
 * @param {string} folder the folder that wasn't made
 * @param {string} blocking the file name that is in the way
 */
export function folderBlocked(folder, blocking) {
  return folder === blocking
    ? "couldn't be made: a file with that name is already there."
    : `couldn't be made: a file named ${blocking} is already there.`;
}

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

/**
 * The header. Three states, not two: something is still running, something
 * needs an answer or failed, or everything finished. The old version had only
 * "running" and "needs you", so a finished upload that was merely waiting to
 * be dismissed announced "Some files need you" — a lie, and part of why the
 * card felt unreliable.
 *
 * @param {{ running: number, problems: number, finished: number, cancelled?: number }} s
 */
export function dockHeaderTitle(s) {
  if (s.running > 0) return dockTitle.working;
  if (s.problems > 0) return dockTitle.needsYou;
  // A cancelled operation is not "Finished": saying so would claim work that
  // didn't happen. "Stopped" covers cancel and dismiss alike.
  if (s.finished > 0) return s.cancelled > 0 && s.cancelled === s.finished ? dockTitle.stopped : dockTitle.done;
  return dockTitle.working;
}

/**
 * The collapsed summary, split so the counting part can move on its own.
 *
 * The summary changes on every progress tick. Animating the whole string would
 * restart an exit/enter 10 times a second, so the stable words are separated
 * from the numbers that actually count: the words swap (a real state change),
 * the numbers roll like the file explorer's selection count.
 *
 * @param {{ running: number, problems: number, finished: number, finishedLabel?: string, pct: number|null, singleUpload?: { files: number }|null }} s
 * @returns {{ key: string, lead: string, count: number|null, unit: string, pct: number|null, need: number }}
 *   `key` changes only when the words change, never when a number does.
 */
export function dockSummaryParts(s) {
  const need = s.problems;
  if (s.running === 0) {
    if (s.problems > 0) {
      return { key: "need", lead: "", count: s.problems, unit: ` ${n(s.problems, "needs", "need")} you`, pct: null, need };
    }
    if (s.finishedLabel) {
      // Already a whole phrase ("12 files uploaded"): no number to roll.
      return { key: `done:${s.finishedLabel}`, lead: s.finishedLabel, count: null, unit: "", pct: null, need };
    }
    if (s.finished > 0) {
      return { key: "finished", lead: "", count: s.finished, unit: " finished", pct: null, need };
    }
    return { key: "idle", lead: "", count: null, unit: "", pct: null, need };
  }
  if (s.singleUpload) {
    const files = s.singleUpload.files;
    return {
      key: "uploading",
      lead: "Uploading ",
      count: files,
      unit: ` ${n(files, "file", "files")}`,
      pct: s.pct,
      need,
    };
  }
  return { key: "running", lead: "", count: s.running, unit: " running", pct: s.pct, need };
}

/**
 * Collapsed summary (mono). A lone upload operation reads `Uploading {n} files · {pct}%`.
 * @param {{ running: number, problems: number, finished: number, finishedLabel?: string, pct: number|null, singleUpload?: { files: number }|null }} s
 */
export function dockSummary(s) {
  const pct = s.pct == null ? "" : ` · ${Math.round(s.pct)}%`;
  const need = s.problems > 0 ? ` · ${s.problems} need you` : "";
  if (s.running === 0) {
    if (s.problems > 0) return `${s.problems} ${n(s.problems, "needs", "need")} you`;
    // One finished thing can say what it did; several can only be counted.
    if (s.finishedLabel) return s.finishedLabel;
    if (s.finished > 0) return `${s.finished} finished`;
    return "";
  }
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
      // A folder holding only empty folders has no files to count. Say what
      // was made instead of "Uploaded 0 files". The folders land in the
      // destination, not inside the dropped folder — that one is made too.
      const folders = op.foldersDone || 0;
      const foldersFailed = (op.items || []).filter((i) => i.isDir && i.state === "failed").length;
      if (state === "done" && total === 0 && folders > 0) {
        return [`Made ${folders} ${n(folders, "folder", "folders")} in `, pill(folder)];
      }
      // Every file arrived but a folder didn't: "Uploaded 1 of 1" would read
      // as finished, so name what is missing instead.
      if (partial && foldersFailed > 0 && done === total) {
        const where = op.rootFolder && name ? name : folder;
        return [
          `Uploaded ${done} ${n(done, "file", "files")} in `,
          pill(where),
          `; ${foldersFailed} ${n(foldersFailed, "folder", "folders")} couldn't be made`,
        ];
      }
      // The op failed before any file was counted (a single-file link refused
      // a two-file drop): "Couldn't upload 0 files to X" would be nonsense.
      // Name the file it was for instead.
      if (op.error && total === 0) {
        return ["Couldn't replace ", pill(name || folder)];
      }
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
      if (running) return batchLine("Moving ", " to Trash", op.items);
      if (state === "done") return batchLine("Moved ", " to Trash", op.items);
      if (partial) return [`Moved ${done} of ${total} items to Trash`];
      return [`Couldn't move ${total} items to Trash`];
    case "restore-trash":
      if (running) return batchLine("Putting back ", "", op.items);
      if (state === "done") return batchLine("Put back ", "", op.items);
      if (partial) return [`Put back ${done} of ${total} items`];
      return [`Couldn't put back ${total} items`];
    case "purge":
      if (running) {
        return total > 1 || !name
          ? batchLine("Deleting ", " permanently", op.items)
          : ["Deleting ", pill(name), " permanently"];
      }
      if (state === "done") return total > 1 ? batchLine("Deleted ", " permanently", op.items) : ["Deleted permanently"];
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
    // Nothing to measure: the upload was empty folders only.
    if (total === 0 && !op.bytesTotal) {
      const folders = op.foldersDone || 0;
      return folders > 0 ? `${folders} ${n(folders, "folder", "folders")} made` : "";
    }
    return `${op.itemsDone ?? 0} of ${total} files · ${fmtSize(op.bytesDone)} of ${fmtSize(op.bytesTotal)}`;
  }
  if (op.kind === "copy" || op.kind === "move") {
    if (op.items?.some((i) => i.waitingForQueue)) return text.waitingForQueue;
    if (!op.bytesTotal) return text.starting;
    const pct = Math.round(Math.min(100, (op.bytesDone / op.bytesTotal) * 100));
    return `${pct}% · ${fmtSize(op.bytesDone)} of ${fmtSize(op.bytesTotal)}`;
  }
  // A batch (trash, restore, purge) has no bytes to report, but "which one is
  // it on" is the thing you want to know: 2 of 5 says it is working, and how
  // much is left.
  const batchTotal = op.itemsTotal ?? op.items?.length ?? 0;
  if (batchTotal > 1) {
    const done = op.itemsDone ?? 0;
    if (op.state === "running" || op.state === "preparing" || op.state === "partial") {
      return `${done} of ${batchTotal} done`;
    }
  }
  return "";
}

/**
 * The meta line, split into words and numbers so only the numbers move.
 *
 * The line changes on every progress emit. Re-rendering the whole string as
 * one animated unit would restart it ten times a second, so it is a list of
 * segments: text stays put, numbers roll like the file explorer's count.
 *
 * @param {any} op
 * @returns {Array<string | { number: number, suffix?: string }>}
 */
export function opMetaParts(op) {
  if (op.kind === "upload" || op.kind === "gallery") {
    if (op.walking) return ["Counting files… ", { number: op.itemsTotal ?? 0 }, " found"];
    const total = op.itemsTotal ?? 0;
    if (total === 0 && !op.bytesTotal) {
      const folders = op.foldersDone || 0;
      return folders > 0 ? [{ number: folders }, ` ${n(folders, "folder", "folders")} made`] : [];
    }
    return [
      { number: op.itemsDone ?? 0 },
      " of ",
      { number: total },
      " files · ",
      fmtSize(op.bytesDone),
      " of ",
      fmtSize(op.bytesTotal),
    ];
  }
  if (op.kind === "copy" || op.kind === "move") {
    if (op.items?.some((i) => i.waitingForQueue)) return [text.waitingForQueue];
    if (!op.bytesTotal) return [text.starting];
    const pct = Math.round(Math.min(100, (op.bytesDone / op.bytesTotal) * 100));
    return [
      { number: pct, suffix: "%" },
      " · ",
      fmtSize(op.bytesDone),
      " of ",
      fmtSize(op.bytesTotal),
    ];
  }
  const batchTotal = op.itemsTotal ?? op.items?.length ?? 0;
  if (batchTotal > 1) {
    const done = op.itemsDone ?? 0;
    if (op.state === "running" || op.state === "preparing" || op.state === "partial") {
      return [{ number: done }, " of ", { number: batchTotal }, " done"];
    }
  }
  return [];
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

/**
 * The words on the "there are more of these" control. The arrow is drawn by
 * the component as a real icon, so this is only the text.
 * @param {number} count
 */
export function moreProblems(count) {
  return `${count} more ${n(count, "problem", "problems")}`;
}

/** @param {string} kind */
export function problemsTitle(kind) {
  if (kind === "upload" || kind === "gallery") return "Problems with this upload";
  if (kind === "copy") return "Problems with this copy";
  if (kind === "move") return "Problems with this move";
  return "Problems with this task";
}

// -- What just finished ------------------------------------------------------

/**
 * One short line saying what a finished operation did, for the collapsed
 * summary. Only used when a single operation has finished and nothing needs an
 * answer, so it can afford to be specific: "3 files uploaded", "Moved 2 items
 * to Trash", "Family photos.zip ready".
 *
 * @param {any} op
 * @returns {string}
 */
export function finishedText(op) {
  const done = op.itemsDone ?? 0;
  const total = op.itemsTotal ?? 0;
  const folders = op.foldersDone ?? 0;
  switch (op.kind) {
    case "upload":
      if (done === 0 && folders > 0) return `${folders} ${n(folders, "folder", "folders")} made`;
      return `${done} ${n(done, "file", "files")} uploaded`;
    case "gallery":
      if (done === 0 && folders > 0) return `${folders} ${n(folders, "folder", "folders")} made`;
      return `${done} ${n(done, "photo", "photos")} uploaded`;
    case "copy":
      return total === 1 && op.title ? `Copied ${op.title}` : `${done} items copied`;
    case "move":
      return total === 1 && op.title ? `Moved ${op.title}` : `${done} items moved`;
    case "trash":
      return total === 1 ? "Moved to Trash" : `${done} items moved to Trash`;
    case "restore-trash":
      return total === 1 ? "Put back" : `${done} items put back`;
    case "purge":
      return total === 1 ? "Deleted permanently" : `${done} items deleted permanently`;
    case "empty-trash":
      return "Trash emptied";
    case "restore-backup":
      return `Restored ${op.title || "the backup"}`;
    case "zip":
      return `${op.title || "The folder"}.zip ready`;
    default:
      return "Finished";
  }
}

// -- Success toasts (plain text, one per operation) -------------------------

/**
 * @param {any} op
 * @param {number} done number of files that succeeded
 * @returns {string|null}
 */
export function successToast(op, done) {
  const name = op.title || "";
  const dest = op.destLabel || "";
  if (done <= 0) {
    // A folder holding only empty folders uploads no files, but it did make
    // folders on the drive — say that rather than stay silent.
    const folders = op.foldersDone || 0;
    if (folders > 0 && (op.kind === "upload" || op.kind === "gallery") && op.state !== "failed") {
      return `Made ${folders} ${n(folders, "folder", "folders")}.`;
    }
    return null;
  }
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
