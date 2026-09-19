/**
 * Client-side conversion of previewable files into formats the EuroOffice
 * editor can open. The editor's bundled x2t can't read these formats at all
 * (csv, epub, pdf…) but opens their adjacent OOXML equivalent — so the file
 * viewer offers "Convert & open": build the converted copy in the browser,
 * upload it next to the original, and open it in editing view.
 */

import { blankDocx, xlsxFromRows } from "./officeStubs.js";
import { parseDelimited } from "./delimited.js";
import { fileExtension, openableKind } from "./fileKinds.js";
import { listZipEntries, readZipEntry } from "./archiveReader.js";

/** @param {ArrayBuffer | Uint8Array} bytes */
function decodeText(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

/** @param {ArrayBuffer} bytes */
function csvToXlsx(bytes, ext) {
  const text = decodeText(bytes);
  const delimiter = ext === "tsv" ? "\t" : undefined;
  return xlsxFromRows(parseDelimited(text, delimiter));
}

/** @param {ArrayBuffer} bytes */
function textToDocx(bytes) {
  return blankDocx(decodeText(bytes));
}

/** epub is a zip of XHTML chapters — strip markup to plain paragraphs. */
function htmlToParagraphs(html) {
  const noBlocks = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return noBlocks
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** @param {ArrayBuffer} bytes */
async function epubToDocx(bytes) {
  const chapters = listZipEntries(bytes)
    .filter((e) => /\.(xhtml|html|htm)$/i.test(e.name) && !e.name.endsWith("/"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parts = [];
  for (const entry of chapters) {
    const data = await readZipEntry(bytes, entry);
    const text = htmlToParagraphs(decodeText(data));
    if (text) parts.push(text);
  }
  return blankDocx(parts.join("\n\n"));
}

/** @param {ArrayBuffer} bytes */
function ipynbToDocx(bytes) {
  let cells = [];
  try {
    const json = JSON.parse(decodeText(bytes));
    cells = Array.isArray(json.cells) ? json.cells : [];
  } catch {
    return blankDocx(decodeText(bytes));
  }
  const text = cells
    .map((cell) => {
      const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
      return `[${cell.cell_type || "code"}]\n${source}`;
    })
    .join("\n\n");
  return blankDocx(text);
}

/** @param {ArrayBuffer} bytes */
function geoToDocx(bytes) {
  const text = decodeText(bytes);
  try {
    return blankDocx(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    return blankDocx(text);
  }
}

/** @param {string} text */
export function parseIcsEvents(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0] || "";
    events.push({
      summary: icsField(body, "SUMMARY"),
      dtstart: icsField(body, "DTSTART"),
      dtend: icsField(body, "DTEND"),
      location: icsField(body, "LOCATION"),
      uid: icsField(body, "UID"),
    });
  }
  return events;
}

/** @param {string} body @param {string} key */
function icsField(body, key) {
  const re = new RegExp(`^${key}[^:]*:(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

/** @param {string} text */
export function parseVcf(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1).trim();
    if (key === "FN") out.fn = value;
    if (key === "N") out.n = value.replace(/;/g, " ").trim();
    if (key === "EMAIL") out.email = value;
    if (key === "TEL") out.tel = value;
    if (key === "ORG") out.org = value;
  }
  return out;
}

/** @param {ArrayBuffer} bytes */
function icsToDocx(bytes) {
  const text = decodeText(bytes);
  const events = parseIcsEvents(text);
  if (events.length === 0) return blankDocx(text);
  const body = events
    .map((ev) =>
      [
        ev.summary || "Untitled event",
        ev.dtstart ? `Starts: ${ev.dtstart}` : "",
        ev.dtend ? `Ends: ${ev.dtend}` : "",
        ev.location || "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return blankDocx(body);
}

/** @param {ArrayBuffer} bytes */
function vcfToDocx(bytes) {
  const text = decodeText(bytes);
  const contact = parseVcf(text);
  const body = [contact.fn || contact.n, contact.email, contact.tel, contact.org]
    .filter(Boolean)
    .join("\n");
  return blankDocx(body || text);
}

/**
 * @typedef {{
 *   targetExt: string,
 *   targetLabel: "document" | "spreadsheet" | "presentation",
 *   convert?: (bytes: ArrayBuffer, ext: string) => Blob | Promise<Blob>,
 * }} OfficeConversion
 */

/** @type {Record<string, OfficeConversion>} */
const BY_KIND = {
  csv: { targetExt: "xlsx", targetLabel: "spreadsheet", convert: csvToXlsx },
  text: { targetExt: "docx", targetLabel: "document", convert: textToDocx },
  markdown: { targetExt: "docx", targetLabel: "document", convert: textToDocx },
  ebook: { targetExt: "docx", targetLabel: "document", convert: epubToDocx },
  notebook: { targetExt: "docx", targetLabel: "document", convert: ipynbToDocx },
  geo: { targetExt: "docx", targetLabel: "document", convert: geoToDocx },
  calendar: { targetExt: "docx", targetLabel: "document", convert: icsToDocx },
  contact: { targetExt: "docx", targetLabel: "document", convert: vcfToDocx },
  // pdf→docx is a real conversion, but it needs a PDF text extractor we don't
  // ship — hint only, the Download button covers the manual path.
  pdf: { targetExt: "docx", targetLabel: "document" },
};

/**
 * Office-adjacent formats with no Luna preview at all — reachable only
 * through the viewer's cannot-open card (stale deep links, embeds). The hint
 * names the editable equivalent; none are convertible in the browser.
 * @type {Record<string, string>}
 */
const HINT_BY_EXT = {
  doc: "docx", dot: "docx", pages: "docx", wps: "docx", hwp: "docx",
  hwpx: "docx", fb2: "docx", mht: "docx", mhtml: "docx", sxw: "docx",
  stw: "docx",
  numbers: "xlsx", et: "xlsx", ett: "xlsx", sxc: "xlsx",
  key: "pptx", dps: "pptx", dpt: "pptx", pot: "pptx", sxi: "pptx",
};

const TARGET_LABEL = {
  docx: "document",
  xlsx: "spreadsheet",
  pptx: "presentation",
};

/**
 * Conversion descriptor for a file, or null when no office-adjacent format
 * exists. `convert` absent means the conversion is real but can't run in the
 * browser — show the hint without the button.
 *
 * @param {string} name file basename
 * @param {string | null} kind openableKind() result
 * @returns {OfficeConversion | null}
 */
export function officeConversionFor(name, kind) {
  if (kind && BY_KIND[kind]) return BY_KIND[kind];
  if (!kind) {
    const target = HINT_BY_EXT[fileExtension(name)];
    if (target) {
      return { targetExt: target, targetLabel: TARGET_LABEL[target] };
    }
  }
  return null;
}

/**
 * Can the file viewer open this name at all? True for real previews plus
 * office-adjacent formats that only get the conversion hint card — clicking
 * a .doc should explain the path forward, not silently do nothing.
 *
 * @param {string} name file basename
 * @returns {boolean}
 */
export function canViewerOpen(name) {
  return Boolean(openableKind(name)) || Boolean(officeConversionFor(name, null));
}
