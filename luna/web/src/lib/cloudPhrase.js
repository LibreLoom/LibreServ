import { getJson, postJson, putJson } from "./api";
import { canonical, derive, encrypt, sign } from "./backupCrypto";

/**
 * Cloud recovery phrase: the API calls and the key steps behind it.
 * The 12 words never leave the browser. Only public keys, a sealed copy of the
 * signing public key, and signatures are sent (see luna/crates/lunad/src/api/cloud_phrase.rs).
 */

export const PHRASE_PATH = "/api/v1/cloud/phrase";

/** TanStack Query key for GET status. */
export const PHRASE_QUERY_KEY = ["cloud-phrase"];

/** Must match CHECK_DOMAIN in cloud_phrase.rs. */
const CHECK_DOMAIN = "phrase-check";

const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @param {string} text */
export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** GET: `{ set, set_at, luna_id }`. */
export function getPhraseStatus() {
  return getJson(PHRASE_PATH);
}

/** POST: `{ challenge }` (base64, 32 bytes, single-use). */
export function requestChallenge() {
  return postJson(`${PHRASE_PATH}/challenge`, {});
}

/** POST: `{ ok: true }` when the signature proves the phrase. */
export function checkPhrase(signature) {
  return postJson(`${PHRASE_PATH}/check`, { signature });
}

/** PUT: `{ set: true, set_at }`. */
export function savePhrase(body) {
  return putJson(PHRASE_PATH, body);
}

/**
 * Ask the server for a fresh challenge and sign it with the auth key that
 * `entropy` derives. Returns the base64 signature.
 * @param {Uint8Array} entropy 16 bytes of phrase entropy
 * @param {string} lunaId
 * @returns {Promise<string>}
 */
export async function signFreshChallenge(entropy, lunaId) {
  const { authSecret } = derive(entropy, lunaId);
  const { challenge } = await requestChallenge();
  return toBase64(sign(authSecret, CHECK_DOMAIN, fromBase64(challenge)));
}

/**
 * Body for PUT /api/v1/cloud/phrase.
 *
 * `self_sealed` is `encrypt(selfKey, aad, authPublic)`: the signing public key,
 * sealed with the phrase-derived `selfKey` so only someone with the phrase can read
 * it back. The AAD binds it to this Luna and this user. Luna only checks that the
 * field is non-empty base64; it does not open it.
 *
 * @param {Uint8Array} entropy 16 bytes of phrase entropy
 * @param {{ lunaId: string, userId: string, signature?: string }} opts
 *   `signature` is required when replacing an existing phrase.
 */
export function buildPhraseBody(entropy, { lunaId, userId, signature }) {
  const keys = derive(entropy, lunaId);
  const aad = canonical([
    ["luna_id", encoder.encode(lunaId)],
    ["user_id", encoder.encode(userId)],
  ]);
  const body = {
    x25519_public: toBase64(keys.x25519Public),
    auth_public: toBase64(keys.authPublic),
    self_sealed: toBase64(encrypt(keys.selfKey, aad, keys.authPublic)),
  };
  if (signature) body.signature = signature;
  return body;
}
