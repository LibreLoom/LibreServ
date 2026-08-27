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

/** @param {string} name */
export function fileExtension(name) {
  const base = String(name || "").split("/").pop() || "";
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

/**
 * @param {string} name
 * @returns {"image"|"video"|"text"|null}
 */
export function openableKind(name) {
  if (isImageFile(name)) return "image";
  if (isVideoFile(name)) return "video";
  if (isTextFile(name)) return "text";
  return null;
}
