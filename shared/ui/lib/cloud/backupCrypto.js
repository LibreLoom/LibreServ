// Cloud backup crypto, a browser port of luna/crates/lunad/src/backup/cloud/crypto.rs.
// The output must match luna/crates/lunad/src/backup/cloud/vectors.json byte for byte;
// changing any output here is a format change.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** @typedef {Uint8Array} Bytes */

/** Fixed HKDF salt for deriving keys from a recovery phrase. */
const DERIVE_SALT = utf8ToBytes('luna-backup-v1');
/** Prefix for the bytes a signature covers, so a signature for one purpose never passes for another. */
const SIG_PREFIX = utf8ToBytes('luna-sig-v1\0');
/** HKDF label for the key that seals a copy to a user's public key. */
const SEAL_INFO = utf8ToBytes('luna-seal-v1');
const NONCE_LEN = 24;
const TAG_LEN = 16;
const PUBLIC_LEN = 32;

/**
 * @typedef {object} UserKeys
 * @property {Bytes} x25519Secret
 * @property {Bytes} x25519Public
 * @property {Bytes} selfKey
 * @property {Bytes} authSecret
 * @property {Bytes} authPublic
 */

/** Concatenate parts that are all byte arrays. @param {...Bytes} parts @returns {Bytes} */
function cat(...parts) {
	return concatBytes(...parts);
}

/** Random bytes from the platform CSPRNG. @param {number} length @returns {Bytes} */
function randomBytes(length) {
	return crypto.getRandomValues(new Uint8Array(length));
}

/** HKDF info: label, a zero byte, then the Luna id. @param {Bytes} label @param {string} lunaId */
function deriveInfo(label, lunaId) {
	return cat(label, Uint8Array.of(0), utf8ToBytes(lunaId));
}

/** @param {Bytes} ikm @param {Bytes | undefined} salt @param {Bytes} info @returns {Bytes} */
function hkdf32(ikm, salt, info) {
	// 32 bytes is always a valid HKDF-SHA256 output length.
	return hkdf(sha256, ikm, salt, info, 32);
}

/**
 * Derive the user's keys from the 16 bytes of recovery phrase entropy.
 * @param {Bytes} entropy 16 bytes
 * @param {string} lunaId
 * @returns {UserKeys}
 */
export function derive(entropy, lunaId) {
	const x25519Secret = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('x25519'), lunaId));
	// Clamp as X25519 does, so the stored secret and its public key always agree.
	x25519Secret[0] &= 248;
	x25519Secret[31] &= 127;
	x25519Secret[31] |= 64;
	const x25519Public = x25519.getPublicKey(x25519Secret);
	const selfKey = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('self'), lunaId));
	const authSecret = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('auth'), lunaId));
	const authPublic = ed25519.getPublicKey(authSecret);
	return { x25519Secret, x25519Public, selfKey, authSecret, authPublic };
}

/**
 * HKDF over the X25519 shared secret, bound to both public keys.
 * @param {Bytes} shared @param {Bytes} ephPublic @param {Bytes} recipientPublic
 */
function sealKey(shared, ephPublic, recipientPublic) {
	return hkdf32(shared, undefined, cat(SEAL_INFO, ephPublic, recipientPublic));
}

/**
 * Shared secret, or null when the key is low order (the secret would be all zeros).
 * @param {Bytes} secret @param {Bytes} publicKey
 * @returns {Bytes | null}
 */
function sharedSecret(secret, publicKey) {
	try {
		return x25519.getSharedSecret(secret, publicKey);
	} catch {
		return null;
	}
}

/**
 * Seal `msg` so only the holder of the secret half of `recipientPublic` can open it.
 * Layout: ephemeral public key (32) | nonce (24) | ciphertext and tag.
 * @param {Bytes} recipientPublic
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function seal(recipientPublic, aad, msg) {
	return sealWith(randomBytes(32), randomBytes(NONCE_LEN), recipientPublic, aad, msg);
}

/**
 * `seal` with the ephemeral secret and nonce supplied by the caller. Test-only: it exists so
 * the vectors can be reproduced; production code uses `seal`.
 * @param {Bytes} ephSecret 32 bytes
 * @param {Bytes} nonce 24 bytes
 * @param {Bytes} recipientPublic
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function sealWith(ephSecret, nonce, recipientPublic, aad, msg) {
	const ephPublic = x25519.getPublicKey(ephSecret);
	const shared = sharedSecret(ephSecret, recipientPublic);
	// Seal only to keys we derived or fetched and checked. A low-order key would make the shared secret all zeros.
	if (!shared) throw new Error('This sealed copy is not valid.');
	const key = sealKey(shared, ephPublic, recipientPublic);
	return cat(ephPublic, nonce, aeadEncrypt(key, nonce, aad, msg));
}

/**
 * Open a sealed copy with the recipient's X25519 secret.
 * @param {Bytes} secret
 * @param {Bytes} aad
 * @param {Bytes} sealed
 * @returns {Bytes}
 */
export function open(secret, aad, sealed) {
	if (sealed.length < PUBLIC_LEN + NONCE_LEN + TAG_LEN) {
		throw new Error('This sealed copy is too short to be valid.');
	}
	const ephPublic = sealed.slice(0, PUBLIC_LEN);
	const nonce = sealed.slice(PUBLIC_LEN, PUBLIC_LEN + NONCE_LEN);
	const body = sealed.slice(PUBLIC_LEN + NONCE_LEN);
	const recipientPublic = x25519.getPublicKey(secret);
	const shared = sharedSecret(secret, ephPublic);
	if (!shared) throw new Error('This sealed copy is not valid.');
	const key = sealKey(shared, ephPublic, recipientPublic);
	try {
		return aeadDecrypt(key, nonce, aad, body);
	} catch {
		throw new Error(
			'This sealed copy could not be opened. It was changed, or it was sealed to a different key.',
		);
	}
}

/**
 * Encrypt with a random nonce. Layout: nonce (24) | ciphertext and tag.
 * @param {Bytes} key 32 bytes
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function encrypt(key, aad, msg) {
	return encryptWith(key, randomBytes(NONCE_LEN), aad, msg);
}

/**
 * `encrypt` with the nonce supplied by the caller. Test-only, like `sealWith`.
 * @param {Bytes} key
 * @param {Bytes} nonce
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function encryptWith(key, nonce, aad, msg) {
	return cat(nonce, aeadEncrypt(key, nonce, aad, msg));
}

/**
 * Decrypt the output of `encrypt`.
 * @param {Bytes} key
 * @param {Bytes} aad
 * @param {Bytes} sealed
 * @returns {Bytes}
 */
export function decrypt(key, aad, sealed) {
	if (sealed.length < NONCE_LEN + TAG_LEN) {
		throw new Error('This encrypted data is too short to be valid.');
	}
	const nonce = sealed.slice(0, NONCE_LEN);
	try {
		return aeadDecrypt(key, nonce, aad, sealed.slice(NONCE_LEN));
	} catch {
		throw new Error('This encrypted data could not be opened. It was changed, or the key is wrong.');
	}
}

/** @param {Bytes} key @param {Bytes} nonce @param {Bytes} aad @param {Bytes} msg */
function aeadEncrypt(key, nonce, aad, msg) {
	return xchacha20poly1305(key, nonce, aad).encrypt(msg);
}

/** Throws when the tag does not verify. @param {Bytes} key @param {Bytes} nonce @param {Bytes} aad @param {Bytes} body */
function aeadDecrypt(key, nonce, aad, body) {
	return xchacha20poly1305(key, nonce, aad).decrypt(body);
}

/**
 * The bytes a signature covers: SIG_PREFIX | domain | 0x00 | msg.
 * @param {string} domain @param {Bytes} msg
 */
function signedBytes(domain, msg) {
	return cat(SIG_PREFIX, utf8ToBytes(domain), Uint8Array.of(0), msg);
}

/**
 * Public key for an Ed25519 signing seed.
 * @param {Bytes} seed 32 bytes
 * @returns {Bytes}
 */
export function signerPublic(seed) {
	return ed25519.getPublicKey(seed);
}

/**
 * Sign `msg` under `domain` with an Ed25519 seed. Matches `Signer::sign` in Rust.
 * @param {Bytes} seed 32 bytes
 * @param {string} domain
 * @param {Bytes} msg
 * @returns {Bytes} 64-byte signature
 */
export function sign(seed, domain, msg) {
	return ed25519.sign(signedBytes(domain, msg), seed);
}

/**
 * Check a signature made by `sign` with the same `domain`. Strict, like `verify_strict` in Rust.
 * @param {Bytes} publicKey 32 bytes
 * @param {string} domain
 * @param {Bytes} msg
 * @param {Bytes} sig 64 bytes
 * @returns {boolean}
 */
export function verify(publicKey, domain, msg, sig) {
	try {
		return ed25519.verify(sig, signedBytes(domain, msg), publicKey, { zip215: false });
	} catch {
		return false;
	}
}

/**
 * Chunk id = HMAC-SHA256(dedup key, chunk). Equal chunks in one backup get one id.
 * @param {Bytes} dedupKey 32 bytes
 * @param {Bytes} chunk
 * @returns {Bytes}
 */
export function chunkId(dedupKey, chunk) {
	return hmac(sha256, dedupKey, chunk);
}

/**
 * Pack id = SHA-256 of the pack's ciphertext.
 * @param {Bytes} ciphertext
 * @returns {Bytes}
 */
export function packId(ciphertext) {
	return sha256(ciphertext);
}

/**
 * Unambiguous byte encoding for signed data: each name and value gets a u32 BE length prefix.
 * @param {Array<[string, Bytes]>} fields
 * @returns {Bytes}
 */
export function canonical(fields) {
	const parts = [];
	for (const [name, value] of fields) {
		parts.push(lengthPrefixed(utf8ToBytes(name)), lengthPrefixed(value));
	}
	return cat(...parts);
}

/** @param {Bytes} bytes */
function lengthPrefixed(bytes) {
	const len = new Uint8Array(4);
	new DataView(len.buffer).setUint32(0, bytes.length, false);
	return cat(len, bytes);
}

/**
 * Read 12 English recovery words (case and extra spaces ignored) into their 16 bytes of entropy.
 * @param {string} words
 * @returns {Bytes}
 */
export function phraseToEntropy(words) {
	const list = words.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
	if (list.length !== 12) {
		throw new Error(`Your recovery phrase has ${list.length} words. It needs exactly 12.`);
	}
	for (const word of list) {
		if (!wordlist.includes(word)) {
			throw new Error(`That word isn't on the recovery phrase list: ${word}`);
		}
	}
	try {
		const entropy = mnemonicToEntropy(list.join(' '), wordlist);
		if (entropy.length === 16) return entropy;
	} catch {
		// Fall through to the same plain sentence as a bad checksum.
	}
	throw new Error("These 12 words don't form a valid recovery phrase. Check each word.");
}

/**
 * The 12 English words for 16 bytes of entropy.
 * @param {Bytes} entropy 16 bytes
 * @returns {string}
 */
export function entropyToPhrase(entropy) {
	return entropyToMnemonic(entropy, wordlist);
}

/**
 * 16 fresh bytes of recovery phrase entropy from the platform CSPRNG.
 * @returns {Bytes}
 */
export function newEntropy() {
	return randomBytes(16);
}
