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
 * @param {string} pathOrName
 * @returns {"word"|"cell"|"slide"|null}
 */
export function euroOfficeDocumentType(pathOrName) {
  const base = String(pathOrName || "").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (["doc", "docx", "odt", "rtf", "txt"].includes(ext)) return "word";
  if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "cell";
  if (["ppt", "pptx", "odp"].includes(ext)) return "slide";
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
