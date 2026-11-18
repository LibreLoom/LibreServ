// A guest opening a /s/<token> link used to wait for three things in a row:
// the app's code, the share page's code, then the link's meta, then the
// folder listing. Over a remote link each step is a round trip (W15 in
// luna/perf). The first script now asks for the meta and, for a folder, the
// listing, so both travel while the share page's code is still loading. The
// share page takes them once; anything else (a password, a retry, another
// link) fetches as before.
import { CAP, hasCap } from "./access.js";
import { getJson } from "./api";

/**
 * @type {{
 *   token: string,
 *   path: string,
 *   meta: Promise<Response> | null,
 *   list: Promise<any[] | null> | null,
 * } | null}
 */
let early = null;

/** Start the early requests when the page itself is a share link. Call once, before the app renders. */
export function startShareEarly() {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const match = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!match) return;
  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return;
  }
  const path = new URLSearchParams(window.location.search).get("path") || "";
  const meta = fetch(`/s/${token}?meta=1`, { headers: { Accept: "application/json" } });
  // A listing only for a folder the guest may look into, so a drop box,
  // form, album or password link sends nothing extra.
  const list = meta
    .then((res) =>
      res.ok && (res.headers.get("content-type") || "").includes("json") ? res.clone().json() : null,
    )
    .then((data) => {
      if (data?.kind !== "folder" || !hasCap(data.caps || "", CAP.VIEW)) return null;
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      return getJson(`/s/${token}/list?${params}`).then((d) => (Array.isArray(d?.entries) ? d.entries : []));
    })
    .catch(() => null);
  early = { token, path, meta, list };
}

/**
 * The early meta response for `token`, once. Null when there is none.
 * @param {string} token
 * @returns {Promise<Response> | null}
 */
export function takeEarlyShareMeta(token) {
  if (!early || early.token !== token || !early.meta) return null;
  const { meta } = early;
  early.meta = null;
  return meta;
}

/**
 * The early folder listing for `token` at `path`, once. It resolves to null
 * when it wasn't fetched or failed; the caller then lists the folder itself.
 * @param {string} token
 * @param {string} path
 * @returns {Promise<any[] | null> | null}
 */
export function takeEarlyShareList(token, path) {
  if (!early || early.token !== token || early.path !== path || !early.list) return null;
  const { list } = early;
  early.list = null;
  return list;
}
