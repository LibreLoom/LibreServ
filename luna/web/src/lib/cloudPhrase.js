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

/** GET: `{ set, set_at, luna_id, signing_public }` (`signing_public` is base64, 32 bytes). */
export function getPhraseStatus() {
  return getJson(PHRASE_PATH);
}

/**
 * POST: `{ luna_id, signing_public }`. Creates Luna's identity the first time
 * (a fresh Luna has no `luna_id` yet). Safe to call again; returns the same identity.
 */
export function createIdentity() {
  return postJson("/api/v1/cloud/identity", {});
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
 * `self_sealed` is `encrypt(selfKey, aad, signingPublic)`: Luna's signing public key
 * (from GET `signing_public`), sealed with the phrase-derived `selfKey` so only someone
 * with the phrase can read it back. Connect keeps this copy, so a browser can later
 * check Luna's signatures against a key Connect could not swap. The AAD binds it to
 * this Luna, this user, and the purpose. Luna only checks that the field is non-empty
 * base64; it does not open it.
 *
 * @param {Uint8Array} entropy 16 bytes of phrase entropy
 * @param {{ lunaId: string, userId: string, signingPublic: Uint8Array | string }} opts
 *   `signingPublic` is 32 bytes, or base64 of 32 bytes.
 */
export function buildPhraseBody(entropy, { lunaId, userId, signingPublic }) {
  const signingBytes = typeof signingPublic === "string" ? fromBase64(signingPublic) : signingPublic;
  if (!signingBytes || signingBytes.length !== 32) {
    throw new Error("Luna's signing key is missing. Reload the page and try again.");
  }
  const keys = derive(entropy, lunaId);
  const aad = canonical([
    ["luna_id", encoder.encode(lunaId)],
    ["user_id", encoder.encode(userId)],
    ["purpose", encoder.encode("signing-public")],
  ]);
  const body = {
    x25519_public: toBase64(keys.x25519Public),
    auth_public: toBase64(keys.authPublic),
    self_sealed: toBase64(encrypt(keys.selfKey, aad, signingBytes)),
  };
  return body;
}
