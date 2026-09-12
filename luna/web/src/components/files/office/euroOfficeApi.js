/** EuroOffice DocsAPI probe + script loader. Assets are optional AGPL packs. */

export const EUROOFFICE_API_SRC = "/eurooffice/web-apps/apps/api/documents/api.js";

/**
 * Browser-reachable Document Server origin for DocsAPI (dev helper).
 * Empty in production builds unless `VITE_EUROOFFICE_DS_URL` is set.
 */
export function euroOfficeDocumentServerOrigin() {
  const fromEnv =
    typeof import.meta !== "undefined" && import.meta.env?.VITE_EUROOFFICE_DS_URL
      ? String(import.meta.env.VITE_EUROOFFICE_DS_URL).trim().replace(/\/$/, "")
      : "";
  if (fromEnv) return fromEnv;
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    return "http://127.0.0.1:8088";
  }
  return "";
}

export function euroOfficeDocsApiSrc() {
  const ds = euroOfficeDocumentServerOrigin();
  if (ds) return `${ds}/web-apps/apps/api/documents/api.js`;
  return EUROOFFICE_API_SRC;
}

/**
 * True only when a real EuroOffice JS pack is served — not Luna's HTML SPA fallback.
 * Fullscreen editing still needs a Document Server runtime for conversion.
 * @returns {Promise<boolean>}
 */
export async function probeEuroOffice() {
  try {
    const head = await fetch(EUROOFFICE_API_SRC, {
      method: "HEAD",
      credentials: "same-origin",
    });
    if (!head.ok) return false;
    const headCt = (head.headers.get("content-type") || "").toLowerCase();
    if (headCt.includes("html")) return false;

    const get = await fetch(EUROOFFICE_API_SRC, {
      method: "GET",
      credentials: "same-origin",
      headers: { Range: "bytes=0-127" },
    });
    if (!get.ok && get.status !== 206) return false;
    const getCt = (get.headers.get("content-type") || "").toLowerCase();
    if (getCt.includes("html")) return false;
    const snippet = (await get.text()).trimStart();
    if (!snippet || snippet.startsWith("<!") || snippet.startsWith("<html")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Load DocsAPI once. Prefers a side Document Server in dev so conversion works.
 * @returns {Promise<object>}
 */
export function loadEuroOfficeDocsApi() {
  if (typeof window !== "undefined" && window.DocsAPI?.DocEditor) {
    return Promise.resolve(window.DocsAPI);
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-luna-eurooffice="1"]`);
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.DocsAPI?.DocEditor) resolve(window.DocsAPI);
        else reject(new Error("EuroOffice script loaded without DocsAPI."));
      });
      existing.addEventListener("error", () => reject(new Error("EuroOffice failed to load.")));
      return;
    }
    const preferred = euroOfficeDocsApiSrc();
    const fallback = EUROOFFICE_API_SRC;
    const tryLoad = (src, allowFallback) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.lunaEurooffice = "1";
      script.onload = () => {
        if (window.DocsAPI?.DocEditor) resolve(window.DocsAPI);
        else if (allowFallback && src !== fallback) {
          script.remove();
          tryLoad(fallback, false);
        } else {
          reject(new Error("EuroOffice script loaded without DocsAPI."));
        }
      };
      script.onerror = () => {
        if (allowFallback && src !== fallback) {
          script.remove();
          tryLoad(fallback, false);
        } else {
          reject(new Error("EuroOffice failed to load."));
        }
      };
      document.head.appendChild(script);
    };
    tryLoad(preferred, preferred !== fallback);
  });
}

/**
 * Ask lunad for Document Server–reachable document + callback URLs.
 * @param {string} driveId
 * @param {string} path
 */
export async function createEuroOfficeSession(driveId, path) {
  const { postJson } = await import("../../../lib/api.js");
  return postJson("/api/v1/office/session", {
    drive_id: driveId,
    path,
  });
}

/**
 * Force-save the open editor session. DocsAPI has no client-side save command —
 * `editor.serviceCommand("forcesave")` posts an `internalCommand` the iframe
 * apps do not handle — so lunad forwards the `forcesave` to the Document
 * Server command service. This resolves once the DS accepts; the file lands on
 * disk when the DS posts the save callback, after which the editor fires
 * `onDocumentStateChange` with `data === false`.
 *
 * @param {string} driveId
 * @param {string} path
 * @param {string} key session key returned by {@link createEuroOfficeSession}
 */
export async function forceSaveEuroOffice(driveId, path, key) {
  const { postJson } = await import("../../../lib/api.js");
  return postJson("/api/v1/office/forcesave", {
    drive_id: driveId,
    path,
    key,
  });
}

/**
 * Extension → DocsAPI `documentType`. Mirrors the fileType table the bundled
 * DocsAPI validates against (luna/dev/eurooffice/web-apps/apps/api/documents/
 * api.js, `_checkConfigParams`) — the only documentType values it accepts are
 * word/cell/slide/pdf/diagram. djvu/xps/oxps open in the pdf editor; vsdx and
 * friends in the visio (diagram) editor.
 */
const WORD_EXT = new Set([
  "doc", "docx", "odt", "gdoc", "txt", "rtf", "mht", "htm", "html", "mhtml",
  "epub", "docm", "dot", "dotm", "dotx", "fodt", "ott", "fb2", "xml",
  "oform", "docxf", "sxw", "stw", "wps", "wpt", "pages", "hwp", "hwpx",
  "md", "hml",
]);
const CELL_EXT = new Set([
  "xls", "xlsx", "ods", "csv", "tsv", "gsheet", "xlsm", "xlt", "xltm",
  "xltx", "fods", "ots", "xlsb", "sxc", "et", "ett", "numbers",
]);
const SLIDE_EXT = new Set([
  "pps", "ppsx", "ppt", "pptx", "odp", "gslides", "pot", "potm", "potx",
  "ppsm", "pptm", "fodp", "otp", "sxi", "dps", "dpt", "key", "odg",
]);
const PDF_EXT = new Set(["pdf", "djvu", "xps", "oxps"]);
const DIAGRAM_EXT = new Set(["vsdx", "vssx", "vstx", "vsdm", "vssm", "vstm"]);

/**
 * @param {string} pathOrName
 * @returns {"word"|"cell"|"slide"|"pdf"|"diagram"|null}
 */
export function euroOfficeDocumentType(pathOrName) {
  const base = String(pathOrName || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (WORD_EXT.has(ext)) return "word";
  if (CELL_EXT.has(ext)) return "cell";
  if (SLIDE_EXT.has(ext)) return "slide";
  if (PDF_EXT.has(ext)) return "pdf";
  if (DIAGRAM_EXT.has(ext)) return "diagram";
  return null;
}

/**
 * Stable-enough DocsAPI document key for co-editing when EuroOffice supports it.
 * Prefer the server-minted session key when opening a file.
 * @param {string} driveId
 * @param {string} path
 */
export function euroOfficeDocumentKey(driveId, path) {
  const raw = `${driveId}\n${path}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  const safe = `${driveId}-${path}`.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `${safe}-${hex}`;
}
