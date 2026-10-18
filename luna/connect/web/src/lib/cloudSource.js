import { api } from "../api.js";

/** @typedef {{ name: string, data: Uint8Array }} CloudRecord */
/**
 * @typedef {object} CloudSource
 * @property {string} lunaId
 * @property {(kind: string) => Promise<CloudRecord[]>} listRecords
 * @property {(idHex: string) => Promise<Uint8Array>} getPack
 * @property {() => Promise<string>} privateChallenge hex challenge for a private session
 * @property {(args: { scope: string, challenge: string, signature: string }) => Promise<{ token: string, expiresAt: number }>} privateOpen
 * @property {(token: string) => CloudSource} withPrivateToken the same source, sending X-Private-Token
 */

const RECORDS_FAILED = "Could not load your cloud backups. Check your connection, then try again.";
const PACK_FAILED = "Could not download part of this backup. Check your connection, then try again.";
const PRIVATE_FAILED = "Could not open your private items. Check your connection, then try again.";

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

/**
 * POST to a private-session route and return its JSON body.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} [body] sent as JSON when given
 * @returns {Promise<any>}
 */
async function postPrivate(url, headers, body) {
  /** @type {Record<string, string>} */
  const sent = { ...headers };
  /** @type {RequestInit} */
  const init = { method: "POST", credentials: "include", headers: sent };
  if (body !== undefined) {
    sent["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) throw await failed(res, PRIVATE_FAILED);
  return res.json();
}

/**
 * One Luna's data source. Account and share sources differ only in their URLs and headers.
 * @param {string} lunaId
 * @param {{ recordsUrl: string, packsUrl: string, privateUrl: string, headers: Record<string, string> }} routes
 * @returns {CloudSource}
 */
function buildSource(lunaId, routes) {
  const { recordsUrl, packsUrl, privateUrl, headers } = routes;
  return {
    lunaId,
    listRecords: (kind) => fetchRecords(`${recordsUrl}/${encodeURIComponent(kind)}`, headers),
    getPack: (idHex) => fetchPack(`${packsUrl}/${encodeURIComponent(idHex)}`, headers),
    privateChallenge: async () => {
      const body = await postPrivate(`${privateUrl}/challenge`, headers);
      return body.challenge;
    },
    privateOpen: async ({ scope, challenge, signature }) => {
      const body = await postPrivate(`${privateUrl}/open`, headers, { scope, challenge, signature });
      return { token: body.token, expiresAt: body.expires_at };
    },
    withPrivateToken: (token) =>
      buildSource(lunaId, { ...routes, headers: { ...headers, "X-Private-Token": token } }),
  };
}

/** GET /api/v1/cloud/lunas → lunas array. */
export async function listLunas() {
  const body = await api("/api/v1/cloud/lunas");
  return body.lunas;
}

/**
 * Data of one Luna on the signed-in account: GET /api/v1/cloud/lunas/{lunaId}/records/{kind} and /packs/{id},
 * and POST /private/challenge and /private/open.
 */
export function accountSource(lunaId) {
  const base = `/api/v1/cloud/lunas/${encodeURIComponent(lunaId)}`;
  return buildSource(lunaId, {
    recordsUrl: `${base}/records`,
    packsUrl: `${base}/packs`,
    privateUrl: `${base}/private`,
    headers: {},
  });
}

/** GET /api/v1/share with header X-Share-Token → { luna_id, luna_name, sent_by, scope: { kind, value }, expires_at }. */
export async function getShareInfo(token) {
  return api("/api/v1/share", { headers: { "X-Share-Token": token } });
}

/**
 * Data reached through a share link: GET /api/v1/share/records/{kind} and /api/v1/share/packs/{id},
 * and POST /api/v1/share/private/challenge and /private/open, all with header X-Share-Token.
 */
export function shareSource(token, lunaId) {
  return buildSource(lunaId, {
    recordsUrl: "/api/v1/share/records",
    packsUrl: "/api/v1/share/packs",
    privateUrl: "/api/v1/share/private",
    headers: { "X-Share-Token": token },
  });
}
