import { apiErrorMessage, getJson, postJson, putJson } from "./api";
import { canonical, derive, encrypt, packId, phraseToEntropy, SIG_PUBLIC_LEN, sign } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { openScopeSecret, sealScopeSecret } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/**
 * Cloud recovery phrase: the API calls and the key steps behind it.
 * The recovery phrase never leaves the browser. Only public keys, a sealed copy of the
 * signing public key, and signatures are sent (see luna/crates/lunad/src/api/cloud_phrase.rs).
 */

export const PHRASE_PATH = "/api/v1/cloud/phrase";

/** TanStack Query key for GET status. */
export const PHRASE_QUERY_KEY = ["cloud-phrase"];

/** Must match CHECK_DOMAIN in cloud_phrase.rs. */
const CHECK_DOMAIN = "phrase-check";

/** Must match the phrase-replace domain in cloud_phrase.rs. A check signature can never be replayed as a replacement. */
export const REPLACE_DOMAIN = "phrase-replace";

/** The toast a passed "Check my phrase" shows (the check is due again after 90 days). */
export const PHRASE_CHECKED_TOAST = {
  type: "success",
  message: "Your recovery phrase is correct.",
  description: "Luna will ask you to check it again in 90 days.",
};

/** Shown when Luna stops taking tries for a while (HTTP 429). */
export const LOCKED_OUT_MESSAGE = "Too many wrong tries. Wait a few minutes, then try again.";

/** Refused by the server: a wrong phrase is 403. Any other 4xx (an expired check, say) throws Luna's own message. */
const REFUSED_STATUSES = new Set([403]);

/** Shown when the new phrase could not open a re-sealed private backup key. Nothing is sent. */
export const RESEAL_CHECK_FAILED = "Your phrase was not changed. Luna could not safely move your private backups to the new phrase. Your old phrase still works.";

const encoder = new TextEncoder();

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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

/**
 * Fills in every status field with a safe default, so the card never reads an undefined.
 * @param {any} raw GET reply
 */
export function normalizePhraseStatus(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const copies = r.old_phrase_copies && typeof r.old_phrase_copies === "object" ? r.old_phrase_copies : {};
  const count = Number(copies.count);
  return {
    ...r,
    set: Boolean(r.set),
    set_at: Number(r.set_at) || 0,
    check_due: Boolean(r.check_due),
    last_checked_at: Number(r.last_checked_at) || 0,
    phrase_words: r.phrase_words === 12 || r.phrase_words === 24 ? r.phrase_words : 0,
    luna_id: r.luna_id ?? null,
    signing_public: r.signing_public ?? null,
    resealing: Boolean(r.resealing),
    old_phrase_copies: {
      count: Number.isFinite(count) && count > 0 ? count : 0,
      removed_at: Number(copies.removed_at) || 0,
    },
  };
}

/** GET: `{ set, set_at, check_due, last_checked_at, phrase_words (12, 24 or 0 when unknown), old_phrase_copies {count, removed_at}, luna_id, signing_public }` (`signing_public` is base64, Ed25519 and ML-DSA keys together). */
export async function getPhraseStatus() {
  return normalizePhraseStatus(await getJson(PHRASE_PATH));
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
 * Ask the server for a fresh challenge (single use, so never reused) and sign it with the
 * auth key that `entropy` derives, under `domain`. Returns the base64 signature.
 * @param {Uint8Array} entropy 16 or 32 bytes of phrase entropy (12 or 24 words)
 * @param {string} lunaId
 * @param {string} [domain]
 * @returns {Promise<string>}
 */
export async function signFreshChallenge(entropy, lunaId, domain = CHECK_DOMAIN) {
  const { authSecret } = derive(entropy, lunaId);
  const { challenge } = await requestChallenge();
  return toBase64(sign(authSecret, domain, fromBase64(challenge)));
}

/**
 * The bytes the old phrase signs to replace itself: the challenge plus every new value in the
 * request, so a copied request can't be sent again with someone else's keys. Must match
 * `replace_message` in cloud_phrase.rs.
 * @param {Uint8Array} challenge
 * The re-sealed private scopes are covered too, by a hash of the list sorted by scope.
 * @param {{ seal_public: string, auth_public: string, self_sealed: string, exposed: boolean, rescoped?: Array<{ scope: string, sealed_scope_secret: string }> }} body
 */
export function replaceMessage(challenge, body) {
  return canonical([
    ["challenge", challenge],
    ["seal_public", fromBase64(body.seal_public)],
    ["auth_public", fromBase64(body.auth_public)],
    ["self_sealed_hash", packId(fromBase64(body.self_sealed))],
    ["exposed", Uint8Array.of(body.exposed ? 1 : 0)],
    ["rescoped_hash", rescopedHash(body.rescoped ?? [])],
  ]);
}

/**
 * Hash of the re-sealed scopes, sorted by scope. Must match `rescoped_hash` in cloud_phrase.rs.
 * @param {Array<{ scope: string, sealed_scope_secret: string }>} rescoped
 */
export function rescopedHash(rescoped) {
  const items = rescoped.map((e) => ({ scope: encoder.encode(e.scope), sealed: fromBase64(e.sealed_scope_secret) }));
  items.sort((a, b) => compareBytes(a.scope, b.scope));
  /** @type {Array<[string, Uint8Array]>} */
  const fields = [];
  for (const item of items) {
    fields.push(["scope", item.scope], ["sealed_scope_secret", item.sealed]);
  }
  return packId(canonical(fields));
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Signs a replacement: asks for a fresh challenge and signs it together with the new values.
 * @param {Uint8Array} entropy the phrase being replaced
 * @param {string} lunaId
 * @param {Parameters<typeof replaceMessage>[1]} body
 * @returns {Promise<string>} base64 signature
 */
export async function signReplacement(entropy, lunaId, body) {
  const { authSecret } = derive(entropy, lunaId);
  const { challenge } = await requestChallenge();
  return toBase64(sign(authSecret, REPLACE_DOMAIN, replaceMessage(fromBase64(challenge), body)));
}

/**
 * Proves the phrase to the server ("Check my phrase", and the first step of a change).
 * Resolves the entropy when Luna accepts it, or null when the phrase is refused.
 * A lockout throws LOCKED_OUT_MESSAGE; any other failure throws a plain message.
 * @param {string} phrase the typed words
 * @param {string} lunaId
 * @returns {Promise<Uint8Array | null>}
 */
export async function checkPhraseWords(phrase, lunaId) {
  const entropy = phraseToEntropy(phrase);
  try {
    const signature = await signFreshChallenge(entropy, lunaId);
    await checkPhrase(signature);
    return entropy;
  } catch (err) {
    if (REFUSED_STATUSES.has(err?.status)) return null;
    if (err?.status === 429) throw new Error(LOCKED_OUT_MESSAGE);
    throw new Error(apiErrorMessage(err, "Could not check your phrase. Try again."));
  }
}

/**
 * Re-seals every private scope this phrase can open to the new phrase (plan §5). Reads the list
 * from GET /cloud/phrase/scopes. A scope that won't open is left out, and Luna keeps it for 30
 * days. Throws when the list can't be read, because a save without it would retire every scope.
 * @param {Uint8Array} oldEntropy the phrase being replaced
 * @param {string} lunaId
 * @param {Uint8Array} newSealPublic the new phrase's public sealing key
 * @param {Uint8Array} newSealSecret the new phrase's secret sealing key, used only to check the result opens
 * @returns {Promise<Array<{ scope: string, sealed_scope_secret: string }>>}
 */
export async function resealScopes(oldEntropy, lunaId, newSealPublic, newSealSecret) {
  const unreadable = "Could not read your private backups. Try again.";
  let reply;
  try {
    reply = await getJson(`${PHRASE_PATH}/scopes`);
  } catch {
    throw new Error(unreadable);
  }
  if (!reply || !Array.isArray(reply.scopes)) throw new Error(unreadable);
  const oldSealSecret = derive(oldEntropy, lunaId).sealSecret;
  const out = [];
  for (const entry of reply.scopes) {
    let scopeSecret;
    try {
      scopeSecret = openScopeSecret(fromBase64(entry.sealed_scope_secret), oldSealSecret, lunaId, entry.scope);
    } catch {
      continue;
    }
    const sealed = sealScopeSecret(scopeSecret, newSealPublic, lunaId, entry.scope);
    // Self-check: the new phrase must open what we are about to send, and get the same secret back.
    let reopened;
    try {
      reopened = openScopeSecret(sealed, newSealSecret, lunaId, entry.scope);
    } catch {
      reopened = null;
    }
    if (!reopened || !bytesEqual(reopened, scopeSecret)) throw new Error(RESEAL_CHECK_FAILED);
    out.push({ scope: entry.scope, sealed_scope_secret: toBase64(sealed) });
  }
  return out;
}

/**
 * Body for a replacement (PUT). `proof` is `{ oldEntropy }` (you still have the old phrase,
 * which signs a fresh `phrase-replace` challenge together with the new keys) or `{ password }` (you lost it, and the
 * Luna password is checked on the server). `exposed` is the "Could someone else have your
 * phrase?" answer. With the old phrase, `rescoped` carries the private scopes re-sealed to the new one.
 * @param {{ proof: { oldEntropy: Uint8Array } | { password: string }, exposed: boolean, newPhrase: string, lunaId: string, userId: string, signingPublic: string }} opts
 */
export async function buildReplaceBody({ proof, exposed, newPhrase, lunaId, userId, signingPublic }) {
  const newEntropy = phraseToEntropy(newPhrase);
  /** @type {Record<string, any>} */
  const body = {
    ...buildPhraseBody(newEntropy, { lunaId, userId, signingPublic }),
    exposed: Boolean(exposed),
  };
  if ("oldEntropy" in proof) {
    // Re-seal before signing: the challenge is single use and expires after five minutes.
    const newKeys = derive(newEntropy, lunaId);
    body.rescoped = await resealScopes(proof.oldEntropy, lunaId, newKeys.sealPublic, newKeys.sealSecret);
    body.proof = "old_signature";
    body.signature = await signReplacement(proof.oldEntropy, lunaId, /** @type {any} */ (body));
  } else {
    body.proof = "password";
    body.password = proof.password;
  }
  return body;
}

/**
 * Saves a replacement. Throws; the caller shows the message from `replaceErrorMessage`.
 * @param {Parameters<typeof buildReplaceBody>[0]} opts
 */
export async function replacePhrase(opts) {
  return savePhrase(await buildReplaceBody(opts));
}

/**
 * The line to show inline when a replacement is refused. Nothing is retried.
 * @param {any} err
 * @param {"old" | "password"} proofKind
 */
export function replaceErrorMessage(err, proofKind) {
  if (err?.status === 429) return LOCKED_OUT_MESSAGE;
  if (err?.status === 403) {
    return proofKind === "password"
      ? "That is not your Luna password. Try again."
      : "Luna did not accept your old phrase. Start again from Change phrase.";
  }
  return apiErrorMessage(err, "Could not save your new phrase. Try again.");
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
 * @param {Uint8Array} entropy 16 or 32 bytes of phrase entropy (12 or 24 words)
 * @param {{ lunaId: string, userId: string, signingPublic: Uint8Array | string }} opts
 *   `signingPublic` is the signing public key (Ed25519 and ML-DSA), or its base64.
 */
export function buildPhraseBody(entropy, { lunaId, userId, signingPublic }) {
  const signingBytes = typeof signingPublic === "string" ? fromBase64(signingPublic) : signingPublic;
  if (!signingBytes || signingBytes.length !== SIG_PUBLIC_LEN) {
    throw new Error("Luna's signing key is missing. Reload the page and try again.");
  }
  const keys = derive(entropy, lunaId);
  const aad = canonical([
    ["luna_id", encoder.encode(lunaId)],
    ["user_id", encoder.encode(userId)],
    ["purpose", encoder.encode("signing-public")],
  ]);
  const body = {
    seal_public: toBase64(keys.sealPublic),
    auth_public: toBase64(keys.authPublic),
    self_sealed: toBase64(encrypt(keys.selfKey, aad, signingBytes)),
    // Lets the check show exactly the right number of boxes. Luna keeps it; Connect never gets it.
    words: entropy.length === 32 ? 24 : 12,
  };
  return body;
}

/**
 * Turns pasted or typed text into a list of lowercase words. Drops numbering such as `1.`, `1)` or `#1`,
 * commas and other punctuation. When the text is the downloaded file (numbered lines among other lines),
 * only the numbered lines count, so its title and closing sentence are left out.
 * @param {string} text
 * @returns {string[]}
 */
export function splitPhraseText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const numbered = lines.filter((line) => /^\s*#?\d+\s*[.):]/.test(line));
  const source = numbered.length >= 2 ? numbered.join("\n") : lines.join("\n");
  return source
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.replace(/^#?\d+[.):]*/, "").replace(/^[^a-z]+|[^a-z]+$/g, ""))
    .filter(Boolean);
}

/** Every word on the recovery phrase list. */
export const WORD_SET = new Set(wordlist);

/** Room for the longest phrase. Only the first 12 or 24 boxes show. */
export const blankWords = () => Array(24).fill("");

/**
 * What one word box looks like, judged from the word list only.
 * @param {string} value
 * @param {boolean} focused
 * @returns {"empty" | "typing" | "valid" | "invalid"}
 */
export function boxState(value, focused) {
  if (!value) return "empty";
  if (WORD_SET.has(value)) return "valid";
  if (focused && wordlist.some((w) => w.startsWith(value))) return "typing";
  return "invalid";
}

/** "Word 4 isn't on…", "Words 4 and 9 aren't on…". Positions are 1-based. */
export function notOnListLine(positions) {
  if (positions.length === 1) return `Word ${positions[0]} isn't on the recovery phrase list. Check the spelling.`;
  const head = positions.slice(0, -1).join(", ");
  return `Words ${head} and ${positions[positions.length - 1]} aren't on the recovery phrase list. Check the spelling.`;
}
