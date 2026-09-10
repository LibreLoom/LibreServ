/** Classify drive files for in-app open/edit. Matches lunad `inline_safe` for view. */

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif", "heic", "heif", "hif",
]);

const VIDEO_EXT = new Set([
  "mp4", "webm", "ogv", "mov", "m4v", "mkv",
]);

/** Plaintext we let people edit in Luna (saved via upload). */
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonc",
  "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
  "css", "scss", "less", "html", "htm", "svg",
  "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "env", "gitignore", "dockerfile", "makefile", "r", "rb", "php",
  "sql", "graphql", "vue", "svelte",
]);

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

/** Office docs open in the EuroOffice collab editor. */
const OFFICE_EXT = new Set([
  "doc", "docx", "odt", "rtf",
  "xls", "xlsx", "ods",
  "ppt", "pptx", "odp",
]);

/**
 * CAD / 3D — never open in Luna (no Luna 3D). Download / Open with OS only.
 * Kept here so the UI can show a clear message instead of a dead click.
 */
const CAD_EXT = new Set([
  "stl", "obj", "gltf", "glb", "step", "stp", "iges", "igs",
]);

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
  return OFFICE_EXT.has(fileExtension(name));
}

/** @param {string} name */
export function isCadFile(name) {
  return CAD_EXT.has(fileExtension(name));
}

/**
 * @typedef {"image"|"video"|"text"|"pdf"|"audio"|"archive"|"ebook"|"comic"|"font"|"notebook"|"geo"|"calendar"|"contact"|"office"|"cad"} OpenableKind
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
  if (isCadFile(name)) return "cad";
  if (isTextFile(name)) return "text";
  return null;
}
