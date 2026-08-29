const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml",
  "log", "css", "html", "htm", "svg",
]);

export function fileExtension(name) {
  const base = String(name || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** @param {string} name */
export function openableKind(name) {
  const ext = fileExtension(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (TEXT_EXT.has(ext)) return "text";
  return null;
}

/** Short label for a file name. */
export function fileKindLabel(name) {
  const kind = openableKind(name);
  if (kind === "image") return "Photo";
  if (kind === "video") return "Video";
  if (kind === "text") return "Text file";
  const ext = fileExtension(name);
  return ext ? `File (${ext})` : "File";
}
