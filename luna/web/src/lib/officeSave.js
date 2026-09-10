/**
 * Rebuild a minimal OOXML file from fallback-editor plain text.
 * Only these round-trips are supported; other office types must not overwrite.
 */

import { blankDocx, blankPptx, blankXlsx } from "./officeStubs.js";

/**
 * @param {string} text
 * @param {string} ext
 * @returns {Blob | null} null when this extension cannot safely round-trip
 */
export function textToOfficeBlob(text, ext) {
  const e = String(ext || "")
    .toLowerCase()
    .replace(/^\./, "");
  const body = String(text ?? "");

  if (e === "docx") return blankDocx(body);
  if (e === "xlsx") return blankXlsx(body);
  if (e === "pptx") return blankPptx(body.trim() || " ");
  return null;
}

/**
 * @param {string} ext
 * @returns {boolean}
 */
export function canRoundTripOfficeExt(ext) {
  const e = String(ext || "")
    .toLowerCase()
    .replace(/^\./, "");
  return e === "docx" || e === "xlsx" || e === "pptx";
}
