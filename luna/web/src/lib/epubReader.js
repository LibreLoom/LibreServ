/**
 * EPUB plumbing for the ebook reader, built on foliate-js.
 *
 * foliate-js paginates by measuring a sandboxed iframe's document, which
 * requires `allow-same-origin` — book markup loaded from blob: URLs then runs
 * in Luna's origin. So every markup resource is scrubbed of scripted content
 * (and given a `script-src 'none'` CSP) before it becomes a blob URL. See
 * sanitizeBookHtml / attachSanitizer.
 *
 * The pure helpers in this file (metadata, TOC flattening, position storage)
 * are covered by epubReader.test.js.
 */
import { listZipEntries, readZipEntry } from "./archiveReader.js";

const POSITION_PREFIX = "luna-epub-position:";

/**
 * Adapt an EPUB zip (as bytes) to the loader interface foliate-js expects:
 * `{ entries, loadText, loadBlob, getSize }` keyed by archive path.
 * @param {ArrayBuffer} bytes
 */
export function makeZipLoader(bytes) {
  const byName = new Map();
  for (const entry of listZipEntries(bytes)) {
    if (entry.name.endsWith("/")) continue;
    byName.set(entry.name, entry);
    // Some packages are written with a leading "./" or "/".
    byName.set(entry.name.replace(/^\.?\/+/, ""), entry);
  }
  const find = (name) => byName.get(name) ?? byName.get(name.replace(/^\.?\/+/, ""));
  const read = async (name) => {
    const entry = find(name);
    if (!entry) return null;
    try {
      return await readZipEntry(bytes, entry);
    } catch {
      return null;
    }
  };
  return {
    entries: [...new Set(byName.values())].map((e) => ({ filename: e.name })),
    loadText: async (name) => {
      const data = await read(name);
      return data ? new TextDecoder("utf-8").decode(data) : null;
    },
    loadBlob: async (name) => {
      const data = await read(name);
      return data ? new Blob([data]) : null;
    },
    getSize: (name) => find(name)?.size ?? 0,
  };
}

/**
 * Parse an EPUB: container.xml → OPF → manifest/spine/metadata, NAV (EPUB 3)
 * or NCX (EPUB 2) table of contents. Returns a foliate-js book object with
 * the content sanitizer already attached.
 * @param {ArrayBuffer} bytes
 */
export async function openEpub(bytes) {
  const { EPUB } = await import("foliate-js/epub.js");
  const book = await new EPUB(makeZipLoader(bytes)).init();
  attachSanitizer(book);
  if (!book.sections?.length) throw new Error("This book has no readable pages.");
  return book;
}

const SCRIPT_URI = /^\s*(javascript|vbscript)\s*:/i;
const MARKUP_TYPE = /xhtml|html|svg/i;

/**
 * Remove anything that could run script from a book document: <script>
 * elements, on* event-handler attributes, and javascript:/vbscript: URLs.
 * HTML documents also get a `script-src 'none'` CSP meta injected at the top
 * of <head> as a second layer (it must precede any content to take effect).
 * @param {string} source
 * @param {string} [mediaType]
 */
export function sanitizeBookHtml(source, mediaType = "application/xhtml+xml") {
  const type = /svg/i.test(mediaType)
    ? "image/svg+xml"
    : /xhtml/i.test(mediaType)
      ? "application/xhtml+xml"
      : /html/i.test(mediaType)
        ? "text/html"
        : null;
  if (!type || typeof source !== "string") return source;
  let doc;
  try {
    doc = new DOMParser().parseFromString(source, type);
  } catch {
    return source;
  }
  if (doc.querySelector("parsererror")) return source;

  for (const el of doc.querySelectorAll("script")) el.remove();
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith("on") || SCRIPT_URI.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  if (type !== "image/svg+xml") {
    const head = doc.getElementsByTagName("head")[0];
    if (head) {
      const meta = doc.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", "script-src 'none'");
      head.insertBefore(meta, head.firstChild);
    }
  }
  return type === "text/html"
    ? `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
    : new XMLSerializer().serializeToString(doc);
}

/**
 * Hook the sanitizer into a parsed book so every markup resource is scrubbed
 * as foliate-js turns it into a blob URL.
 * @param {{ transformTarget?: EventTarget }} book
 */
export function attachSanitizer(book) {
  book.transformTarget?.addEventListener("data", (event) => {
    const { detail } = /** @type {CustomEvent} */ (event);
    if (!MARKUP_TYPE.test(detail?.type ?? "")) return;
    detail.data = Promise.resolve(detail.data).then((data) =>
      typeof data === "string" ? sanitizeBookHtml(data, detail.type) : data,
    );
  });
}

/**
 * foliate-js metadata follows the webpub schema: values can be a plain string
 * or a language map like `{ en: "Title" }`.
 * @param {unknown} value
 */
export function langMapValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length ? String(value[keys[0]]) : "";
  }
  return String(value);
}

/** @param {object|undefined} metadata foliate-js book.metadata */
export function bookTitle(metadata) {
  return langMapValue(metadata?.title);
}

/** @param {object|undefined} metadata foliate-js book.metadata */
export function bookAuthor(metadata) {
  if (!metadata?.author) return "";
  const list = Array.isArray(metadata.author) ? metadata.author : [metadata.author];
  return list
    .map((a) => (typeof a === "string" ? a : langMapValue(a?.name)))
    .filter(Boolean)
    .join(", ");
}

/**
 * Flatten the nested TOC into display rows with an indent depth.
 * @param {{ label?: string, href?: string, subitems?: any[] }[]|undefined} toc
 * @returns {{ label: string, href: string|null, depth: number }[]}
 */
export function flattenToc(toc, depth = 0, out = []) {
  for (const item of toc ?? []) {
    if (!item) continue;
    const label = typeof item.label === "string" && item.label.trim()
      ? item.label.trim()
      : "Untitled section";
    out.push({ label, href: item.href ?? null, depth });
    if (item.subitems?.length) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

/**
 * CSS injected into every book document via the renderer's setStyles.
 * `bg`/`fg`/`accent` are resolved Luna theme tokens — the iframe document
 * does not inherit CSS custom properties, so concrete values are passed in.
 * Book text colors and backgrounds are overridden with `!important` so a
 * book that hardcodes dark text can never render dark-on-dark.
 * @param {{ bg: string, fg: string, accent: string }} colors
 */
export function readerCss({ bg, fg, accent }) {
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    :root {
        --theme-bg-color: ${bg};
        --theme-fg-color: ${fg};
    }
    html, body {
        background: ${bg} !important;
    }
    body {
        color: ${fg} !important;
    }
    body * {
        color: ${fg} !important;
        background: transparent !important;
    }
    a, a * {
        color: ${accent} !important;
    }
    p, li, blockquote, dd {
        line-height: 1.6;
        text-align: justify;
        -webkit-hyphens: auto;
        hyphens: auto;
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
  `;
}

/** Read the resolved Luna theme tokens for injection into book documents. */
export function currentReaderColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    bg: style.getPropertyValue("--primary").trim() || "Canvas",
    fg: style.getPropertyValue("--secondary").trim() || "CanvasText",
    accent: style.getPropertyValue("--accent").trim() || "LinkText",
  };
}

/** localStorage key for a book's saved position, scoped to the drive file. */
export function positionKey(driveId, path) {
  return `${POSITION_PREFIX}${driveId}:${path}`;
}

/**
 * @param {string} key
 * @returns {{ cfi: string|null, fraction: number|null }|null}
 */
export function loadReadingPosition(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    const cfi = typeof pos?.cfi === "string" ? pos.cfi : null;
    const fraction = typeof pos?.fraction === "number" && pos.fraction >= 0
      ? Math.min(1, pos.fraction)
      : null;
    if (!cfi && fraction == null) return null;
    return { cfi, fraction };
  } catch {
    return null;
  }
}

/** @param {string} key @param {{ cfi?: string|null, fraction?: number|null }} pos */
export function saveReadingPosition(key, pos) {
  try {
    localStorage.setItem(key, JSON.stringify({
      cfi: pos.cfi ?? null,
      fraction: pos.fraction ?? null,
    }));
  } catch {
    /* storage unavailable or full — reading still works, resume just won't stick */
  }
}

/**
 * Normalize a foliate-js `relocate` event detail for the progress chrome.
 * @param {{ fraction?: number, section?: { current: number, total: number }, tocItem?: { label?: string } }|undefined} detail
 * @returns {{ percent: number, label: string }}
 */
export function progressInfo(detail) {
  const fraction = typeof detail?.fraction === "number"
    ? Math.min(1, Math.max(0, detail.fraction))
    : 0;
  const tocLabel = typeof detail?.tocItem?.label === "string"
    ? detail.tocItem.label.trim()
    : "";
  const section = detail?.section;
  const label = tocLabel
    || (section ? `Section ${section.current + 1} of ${section.total}` : "");
  return { percent: Math.round(fraction * 100), label };
}
