/** EuroOffice DocsAPI probe + script loader. Assets are optional AGPL packs. */

export const EUROOFFICE_API_SRC = "/eurooffice/web-apps/apps/api/documents/api.js";

/**
 * @returns {Promise<boolean>}
 */
export async function probeEuroOffice() {
  try {
    const res = await fetch(EUROOFFICE_API_SRC, {
      method: "HEAD",
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Load DocsAPI once. Resolves with `window.DocsAPI`.
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
    const script = document.createElement("script");
    script.src = EUROOFFICE_API_SRC;
    script.async = true;
    script.dataset.lunaEurooffice = "1";
    script.onload = () => {
      if (window.DocsAPI?.DocEditor) resolve(window.DocsAPI);
      else reject(new Error("EuroOffice script loaded without DocsAPI."));
    };
    script.onerror = () => reject(new Error("EuroOffice failed to load."));
    document.head.appendChild(script);
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
