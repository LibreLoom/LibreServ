// What a name means, in the two places lunad asks: `Path::extension` for the
// extension, and `mime_guess::from_path(..).first_or_octet_stream()` for the
// type. Both the file routes and the share routes read it from here so the two
// can never drift apart.
/**
 * `Path::extension`: a leading dot is part of the name, not an extension, and a
 * name that ends in a dot has none either.
 *
 * @param {unknown} name
 */
export function extOf(name) {
  const text = String(name ?? "");
  const dot = text.lastIndexOf(".");
  if (dot <= 0 || dot === text.length - 1) return "";
  return text.slice(dot + 1).toLowerCase();
}

/**
 * `mime_guess::from_path(..).first_or_octet_stream()`: the type a browser knows
 * from the name alone, and the octet-stream answer when it knows none.
 *
 * @param {unknown} name
 */
export function mimeFromName(name) {
  const ext = extOf(name);
  /** @type {Record<string, string>} */
  const known = {
    txt: "text/plain",
    text: "text/plain",
    log: "text/plain",
    csv: "text/csv",
    md: "text/markdown",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    epub: "application/epub+zip",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp4: "video/mp4",
    m4v: "video/x-m4v",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    m4a: "audio/m4a",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    odt: "application/vnd.oasis.opendocument.text",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return known[ext] || "application/octet-stream";
}
