/** Classify drive files for in-app open/edit. Matches lunad `inline_safe` for view. */

// heic/heif/hif are left out on purpose: lunad transcodes them for gallery
// grids, but the file viewer loads raw bytes and no browser we target can
// display them natively.
const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif",
]);

// mkv, wmv etc. are not here: browsers can't play them in <video>, so a
// "video" kind would only surface the player's own error notice.
const VIDEO_EXT = new Set([
  "mp4", "webm", "ogv", "mov", "m4v",
]);

/** Plaintext we let people edit in Luna (saved via upload). */
const TEXT_EXT = new Set([
  "txt", "text", "json", "jsonc",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
  "css", "scss", "less", "html", "htm", "svg",
  "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "env", "gitignore", "dockerfile", "makefile", "r", "rb", "php",
  "sql", "graphql", "vue", "svelte",
]);

/** Markdown — editable text with a rendered preview (MarkdownEditor). */
const MARKDOWN_EXT = new Set(["md", "markdown"]);

const PDF_EXT = new Set(["pdf"]);

const AUDIO_EXT = new Set([
  "mp3", "m4a", "aac", "ogg", "oga", "flac", "wav", "opus",
]);

const ARCHIVE_EXT = new Set([
  "zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar",
]);

const EBOOK_EXT = new Set(["epub"]);

const COMIC_EXT = new Set(["cbz", "cbr"]);

const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);

const NOTEBOOK_EXT = new Set(["ipynb"]);

const GEO_EXT = new Set(["geojson", "gpx", "kml"]);

const CALENDAR_EXT = new Set(["ics"]);

const CONTACT_EXT = new Set(["vcf"]);

/**
 * Formats the bundled EuroOffice pack can actually open, mapped to their
 * DocsAPI documentType. The api.js "supported types" regex declares ~100
 * exts, but most of those converters aren't in the shipped x2t.wasm — every
 * ext here is verified by a real conversion in
 * src/components/files/office/x2tFormats.test.js. Add nothing the test
 * doesn't cover. Deliberately absent: doc (reader absent in this build),
 * csv/tsv (see the "csv" kind below), pdf/djvu/xps/oxps, epub/fb2,
 * mht/mhtml (the converter hangs on them), the vsdx family, iWork/WPS/HWP/
 * StarOffice formats, and gdoc/gsheet/gslides (cloud pointer files, not
 * documents). Mirrors document_type_for in lunad's api/office.rs.
 */
export const OFFICE_FORMATS = {
  // word
  docx: "word", docm: "word", dotx: "word", dotm: "word",
  docxf: "word", oform: "word",
  odt: "word", fodt: "word", ott: "word",
  rtf: "word",
  // cell
  xlsx: "cell", xlsm: "cell", xltx: "cell", xltm: "cell", xlsb: "cell",
  ods: "cell", fods: "cell", ots: "cell",
  xls: "cell", xlt: "cell",
  // slide
  pptx: "slide", pptm: "slide", ppsx: "slide", ppsm: "slide",
  potx: "slide", potm: "slide",
  odp: "slide", fodp: "slide", otp: "slide",
  ppt: "slide", pps: "slide",
};

/**
 * Formats x2t can write back without silent loss — the editor only enables
 * saving for these. Macro-enabled OOXML is view-only: x2t writes the file
 * but strips the embedded VBA project. Flat ODF (fodt/fods/fodp) and legacy
 * xls/ppt have no writer at all in this build.
 */
export const OFFICE_SAVE_EXT = new Set([
  "docx", "dotx", "docxf", "oform", "rtf", "odt", "ott",
  "xlsx", "xltx", "xlsb", "ods", "ots",
  "pptx", "ppsx", "potx", "odp", "otp",
]);

// csv/tsv get their own lightweight table preview — the pack can't convert
// them at all (verified), so classifying them as office produced a raw
// converter error screen.
const CSV_EXT = new Set(["csv", "tsv"]);

// There is deliberately no "cad" kind: nothing in Luna can render 3D
// formats, so stl/obj/gltf/etc. are simply unopenable.

/** @param {string} name */
export function fileExtension(name) {
  const base = String(name || "").split("/").pop() || "";
  const lower = base.toLowerCase();
  // Compound archives
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar.bz2")) return "tar.bz2";
  if (lower.endsWith(".tar.xz")) return "tar.xz";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** @param {string} name */
export function isImageFile(name) {
  return IMAGE_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isVideoFile(name) {
  return VIDEO_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isTextFile(name) {
  const ext = fileExtension(name);
  if (TEXT_EXT.has(ext)) return true;
  // No extension → treat as plain text only for short common names.
  if (!ext) {
    const base = String(name || "").split("/").pop() || "";
    return /^(readme|license|licence|changelog|todo|authors|copying)$/i.test(base);
  }
  return false;
}

/** @param {string} name */
export function isMarkdownFile(name) {
  return MARKDOWN_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isPdfFile(name) {
  return PDF_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isAudioFile(name) {
  return AUDIO_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isArchiveFile(name) {
  const ext = fileExtension(name);
  if (ARCHIVE_EXT.has(ext)) return true;
  return ext === "tar.gz" || ext === "tar.bz2" || ext === "tar.xz";
}

/** @param {string} name */
export function isEbookFile(name) {
  return EBOOK_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isComicFile(name) {
  return COMIC_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isFontFile(name) {
  return FONT_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isNotebookFile(name) {
  return NOTEBOOK_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isGeoFile(name) {
  return GEO_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isCalendarFile(name) {
  return CALENDAR_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isContactFile(name) {
  return CONTACT_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isOfficeFile(name) {
  return fileExtension(name) in OFFICE_FORMATS;
}

export function isCsvFile(name) {
  return CSV_EXT.has(fileExtension(name));
}

/**
 * @typedef {"image"|"video"|"text"|"markdown"|"pdf"|"audio"|"archive"|"ebook"|"comic"|"font"|"notebook"|"geo"|"calendar"|"contact"|"office"|"csv"} OpenableKind
 */

/**
 * @param {string} name
 * @returns {OpenableKind | null}
 */
export function openableKind(name) {
  if (isImageFile(name)) return "image";
  if (isVideoFile(name)) return "video";
  if (isOfficeFile(name)) return "office";
  if (isPdfFile(name)) return "pdf";
  if (isAudioFile(name)) return "audio";
  if (isEbookFile(name)) return "ebook";
  if (isComicFile(name)) return "comic";
  if (isFontFile(name)) return "font";
  if (isNotebookFile(name)) return "notebook";
  if (isGeoFile(name)) return "geo";
  if (isCalendarFile(name)) return "calendar";
  if (isContactFile(name)) return "contact";
  if (isArchiveFile(name)) return "archive";
  if (isCsvFile(name)) return "csv";
  if (isMarkdownFile(name)) return "markdown";
  if (isTextFile(name)) return "text";
  return null;
}
