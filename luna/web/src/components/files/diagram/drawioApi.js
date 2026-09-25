/**
 * Client-side bridge to the self-hosted diagrams.net (draw.io) webapp.
 *
 * The pack lives in `{data_dir}/drawio` (installed by
 * `scripts/install-drawio-assets.sh`) and lunad serves it at `/drawio`. The
 * editor runs in a same-origin iframe and speaks draw.io's embed protocol:
 * JSON `postMessage` events/actions — `init` → `load` → `autosave`/`save` →
 * `status`. Nothing is sent to JGraph's servers: the pack is local and the
 * iframe URL carries `stealth=1`, which disables draw.io's own realtime
 * channel (that one phones home). Live edits are relayed by Luna's collab
 * hub instead, using the embed diff-sync protocol.
 *
 * The `.drawio` file on the drive IS the document — saves write the XML back
 * through the normal files upload API, same as the text editor. The
 * self-describing `.drawio.svg` / `.drawio.png` variants load as data URIs
 * and save back through the editor's `export` action (xmlsvg / xmlpng), so
 * they keep their embedded preview.
 */

import { apiFetch } from "../../../lib/api.js";
import { BLANK_DRAWIO_XML, diagramContainer } from "../../../lib/diagramFile.js";

export const DRAWIO_INDEX = "/drawio/index.html";
export const DRAWIO_PACK_MARKER = "/drawio/pack.json";

/**
 * The install script drops this marker at the pack root. Without the pack,
 * lunad never mounts the /drawio route and the request falls through to the
 * SPA fallback — which answers 200 text/html — so the marker's content type
 * AND body both have to check out before the pack counts as present.
 *
 * @returns {Promise<"present" | "missing" | "unreachable">}
 */
export async function probeDrawioPack() {
  try {
    const res = await apiFetch(DRAWIO_PACK_MARKER);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/json/i.test(type)) return "missing";
    const body = await res.json().catch(() => null);
    return body?.pack === "luna-drawio" ? "present" : "missing";
  } catch {
    return "unreachable";
  }
}

/**
 * Iframe URL for the embedded editor. `noExitBtn`/`saveAndExit=0` keep the
 * editor's own close buttons hidden — Luna's fullscreen frame owns close and
 * the unsaved-changes guard. `stealth=1` disables draw.io's own realtime
 * channel so nothing leaves this Luna. Collaboration uses Luna's collab
 * hub and the embed `diffSync` load option.
 *
 * @param {{ dark?: boolean, canWrite?: boolean }} opts
 */
export function drawioEmbedUrl({ dark = false, canWrite = true } = {}) {
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    libraries: "1",
    stealth: "1",
    noExitBtn: "1",
    saveAndExit: "0",
  });
  if (dark) params.set("ui", "dark");
  if (!canWrite) params.set("noSaveBtn", "1");
  return `${DRAWIO_INDEX}?${params.toString()}`;
}

/**
 * Send an action to the editor iframe. Same-origin, so the target origin is
 * our own — never `*`.
 *
 * @param {HTMLIFrameElement | null} iframe
 * @param {Record<string, unknown>} msg
 */
export function postToEditor(iframe, msg) {
  const target = iframe?.contentWindow;
  if (!target || typeof window === "undefined") return;
  target.postMessage(JSON.stringify(msg), window.location.origin);
}

/**
 * Parse an embed-protocol message. The editor always sends JSON strings;
 * anything else (or malformed JSON) is ignored.
 *
 * @param {unknown} data `event.data` from a `message` event
 * @returns {{ event?: string, action?: string, [k: string]: unknown } | null}
 */
export function parseEmbedMessage(data) {
  if (typeof data !== "string" || !data) return null;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg === "object" ? msg : null;
  } catch {
    return null;
  }
}

/**
 * The `xml` field of a `load` action for this file's bytes. Plain `.drawio`
 * files go in as text; the image-container variants go in as data URIs —
 * draw.io accepts SVG/PNG data URIs with embedded XML and re-extracts the
 * diagram. An empty `.drawio` becomes a blank diagram (the create kind
 * already writes one, but a hand-made empty file shouldn't error).
 *
 * @param {string} text file body as text (xml containers)
 * @param {ArrayBuffer | Uint8Array | null | undefined} bytes file body as bytes (svg/png containers)
 * @param {"xml" | "svg" | "png"} container
 */
export function diagramLoadXml(text, bytes, container) {
  if (container === "xml") {
    return text.trim() ? text : BLANK_DRAWIO_XML;
  }
  // An empty image-container file can't carry a diagram — start blank; the
  // next save writes a proper embedded-preview file back.
  if (!bytes || bytes.byteLength === 0) return BLANK_DRAWIO_XML;
  const mime = container === "svg" ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(bytes))}`;
}

/**
 * Turn an `export` event's payload into the bytes that belong on the drive:
 * `xml` for plain .drawio, base64 (or utf8) data URI for svg/png.
 *
 * @param {"xml" | "svg" | "png"} container
 * @param {{ xml?: unknown, data?: unknown }} exportMsg
 * @returns {Uint8Array}
 */
export function diagramBytesFromExport(container, exportMsg) {
  if (container === "xml") {
    const xml = typeof exportMsg?.xml === "string" ? exportMsg.xml : "";
    if (!xml.trim()) {
      throw new Error("The diagram editor returned an empty file. Try again.");
    }
    return new TextEncoder().encode(xml);
  }
  const data = typeof exportMsg?.data === "string" ? exportMsg.data : "";
  const bytes = dataUriToBytes(data);
  if (!bytes.length) {
    throw new Error("The diagram editor returned an empty file. Try again.");
  }
  return bytes;
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Decode a `data:` URI to bytes. draw.io exports base64 for images, but a
 * plain (percent-encoded) utf8 payload is handled too.
 *
 * @param {string} uri
 * @returns {Uint8Array}
 */
export function dataUriToBytes(uri) {
  const comma = String(uri || "").indexOf(",");
  if (comma < 0) return new Uint8Array(0);
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return new Uint8Array(0);
  }
}

export { diagramContainer };
