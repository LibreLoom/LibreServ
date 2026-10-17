import { api } from "../api.js";

/** @typedef {{ name: string, data: Uint8Array }} CloudRecord */
/** @typedef {{ lunaId: string, listRecords: (kind: string) => Promise<CloudRecord[]>, getPack: (idHex: string) => Promise<Uint8Array> }} CloudSource */

const RECORDS_FAILED = "Could not load your cloud backups. Check your connection, then try again.";
const PACK_FAILED = "Could not download part of this backup. Check your connection, then try again.";

/**
 * Decode base64 to bytes.
 * @param {string} text
 */
function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Throw the server's sentence (or the fallback) with the HTTP status attached.
 * @param {Response} res
 * @param {string} fallback
 */
async function failed(res, fallback) {
  const body = await res.json().catch(() => ({}));
  const err = /** @type {Error & { status?: number }} */ (new Error(body.error || fallback));
  err.status = res.status;
  return err;
}

/**
 * Fetch one record list and decode its base64 data.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<CloudRecord[]>}
 */
async function fetchRecords(url, headers) {
  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw await failed(res, RECORDS_FAILED);
  const body = await res.json();
  return (body.records || []).map((/** @type {{ name: string, data: string }} */ r) => ({
    name: r.name,
    data: fromBase64(r.data),
  }));
}

/**
 * Fetch one pack as bytes.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<Uint8Array>}
 */
async function fetchPack(url, headers) {
  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw await failed(res, PACK_FAILED);
  return new Uint8Array(await res.arrayBuffer());
}

/** GET /api/v1/cloud/lunas → lunas array. */
export async function listLunas() {
  const body = await api("/api/v1/cloud/lunas");
  return body.lunas;
}

/** Data of one Luna on the signed-in account: GET /api/v1/cloud/lunas/{lunaId}/records/{kind} and /packs/{id}. */
export function accountSource(lunaId) {
  const base = `/api/v1/cloud/lunas/${encodeURIComponent(lunaId)}`;
  return {
    lunaId,
    listRecords: (/** @type {string} */ kind) => fetchRecords(`${base}/records/${encodeURIComponent(kind)}`, {}),
    getPack: (/** @type {string} */ idHex) => fetchPack(`${base}/packs/${encodeURIComponent(idHex)}`, {}),
  };
}

/** GET /api/v1/share with header X-Share-Token → { luna_id, luna_name, sent_by, scope: { kind, value }, expires_at }. */
export async function getShareInfo(token) {
  return api("/api/v1/share", { headers: { "X-Share-Token": token } });
}

/** Data reached through a share link: GET /api/v1/share/records/{kind} and /api/v1/share/packs/{id}, header X-Share-Token. */
export function shareSource(token, lunaId) {
  const headers = { "X-Share-Token": token };
  return {
    lunaId,
    listRecords: (/** @type {string} */ kind) => fetchRecords(`/api/v1/share/records/${encodeURIComponent(kind)}`, headers),
    getPack: (/** @type {string} */ idHex) => fetchPack(`/api/v1/share/packs/${encodeURIComponent(idHex)}`, headers),
  };
}
