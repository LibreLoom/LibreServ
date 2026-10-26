/**
 * The frame address for a scenario. `__mock` goes in the query string, before
 * any `#hash`, because boot.js reads only `location.search`.
 * @param {string} url scenario URL, e.g. "/settings#cloud_backup"
 * @param {string} id scenario id
 */
export function scenarioFrameUrl(url, id) {
  const cut = url.indexOf("#");
  const base = cut === -1 ? url : url.slice(0, cut);
  const hash = cut === -1 ? "" : url.slice(cut);
  return `${base}${base.includes("?") ? "&" : "?"}__mock=${encodeURIComponent(id)}${hash}`;
}
