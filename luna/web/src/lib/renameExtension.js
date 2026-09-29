import { RESPONSES_SUFFIX } from "./formDocument.js";

const FORM_EXT = ".lunaform";

/**
 * The lowercase extension of a name, with its dot (".txt"), or "" when there
 * is none. Dotfiles like ".env" and names ending in a dot have no extension.
 *
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const trimmed = String(name ?? "").trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot).toLowerCase();
}

/**
 * Describe what the user should confirm before a file rename is sent, or
 * null when nothing needs confirming (folders, same extension, base name only).
 *
 * @param {string} oldName
 * @param {string} newName
 * @param {boolean} [isDir]
 * @returns {{ kind: "form" | "change" | "add" | "remove", title: string, message: string, confirmLabel: string } | null}
 */
export function renameExtensionWarning(oldName, newName, isDir = false) {
  if (isDir) return null;
  const from = extensionOf(oldName);
  const to = extensionOf(newName);
  if (from === to) return null;
  if (from === FORM_EXT) {
    return {
      kind: "form",
      title: "Stop treating this as a form?",
      message: `Its answers will stay in ${String(oldName).trim()}${RESPONSES_SUFFIX.slice(FORM_EXT.length)}.`,
      confirmLabel: "Rename",
    };
  }
  if (from && to) {
    return {
      kind: "change",
      title: `Change ${from} to ${to}?`,
      message: "The file may not open with the same app afterward.",
      confirmLabel: "Rename",
    };
  }
  if (from) {
    return {
      kind: "remove",
      title: `Remove the ${from} ending?`,
      message: "The file may not open with the same app afterward.",
      confirmLabel: "Rename",
    };
  }
  return {
    kind: "add",
    title: `Add a ${to} ending?`,
    message: "The file may not open with the same app afterward.",
    confirmLabel: "Rename",
  };
}
