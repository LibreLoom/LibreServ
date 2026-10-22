// Cloud backup crypto, a browser port of luna/crates/lunad/src/backup/cloud/crypto.rs.
// The output must match luna/crates/lunad/src/backup/cloud/vectors.json byte for byte;
// changing any output here is a format change.
// Sealing is hybrid: a copy opens only with both the X25519 secret and the ML-KEM-768 secret,
// so it stays safe if either one is broken later (for example by a quantum computer).
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** @typedef {Uint8Array} Bytes */

/** Fixed HKDF salt for deriving keys from a recovery phrase. */
const DERIVE_SALT = utf8ToBytes('luna-backup-v1');
/** Prefix for the bytes a signature covers, so a signature for one purpose never passes for another. */
const SIG_PREFIX = utf8ToBytes('luna-sig-v2\0');
/** HKDF label that turns a 32-byte signing seed into the ML-DSA seed beside the Ed25519 key. */
const MLDSA_SEED_INFO = utf8ToBytes('luna-mldsa-v1');
/** Ed25519 public key length. */
const ED_PUBLIC_LEN = 32;
/** ML-DSA-65 public key length. */
const MLDSA_PUBLIC_LEN = 1952;
/** Ed25519 signature length. */
const ED_SIG_LEN = 64;
/** ML-DSA-65 signature length. */
const MLDSA_SIG_LEN = 3309;
/** A public signing key: Ed25519 public key (32) | ML-DSA-65 public key (1952). */
export const SIG_PUBLIC_LEN = ED_PUBLIC_LEN + MLDSA_PUBLIC_LEN;
/** A signature: Ed25519 signature (64) | ML-DSA-65 signature (3309). Valid only if both halves verify. */
export const SIG_LEN = ED_SIG_LEN + MLDSA_SIG_LEN;
/** HKDF label for the key that seals a copy to a user's public key. */
const SEAL_INFO = utf8ToBytes('luna-seal-v2');
const NONCE_LEN = 24;
const TAG_LEN = 16;
/** X25519 public key length. */
const X25519_LEN = 32;
/** ML-KEM-768 encapsulation (public) key length. */
const MLKEM_PUBLIC_LEN = 1184;
/** ML-KEM-768 ciphertext length. */
const MLKEM_CT_LEN = 1088;
/** ML-KEM-768 key seed length (FIPS 203 `d` then `z`). */
const MLKEM_SEED_LEN = 64;
/** A public sealing key: X25519 public key (32) | ML-KEM-768 encapsulation key (1184). */
export const SEAL_PUBLIC_LEN = X25519_LEN + MLKEM_PUBLIC_LEN;
/** A secret sealing key: clamped X25519 secret (32) | ML-KEM-768 seed (64). */
export const SEAL_SECRET_LEN = X25519_LEN + MLKEM_SEED_LEN;

/**
 * @typedef {object} UserKeys
 * @property {Bytes} sealSecret
 * @property {Bytes} sealPublic
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

/** The ML-KEM-768 key pair for a 64-byte seed. @param {Bytes} seed */
function mlkemKeys(seed) {
	return ml_kem768.keygen(seed);
}

/**
 * Derive the user's keys from the recovery phrase entropy: 16 bytes (12 words) or 32 bytes (24 words).
 * Every key comes from the same entropy, so the phrase's strength (128 or 256 bits) caps the
 * strength of all of them.
 * @param {Bytes} entropy 16 or 32 bytes
 * @param {string} lunaId
 * @returns {UserKeys}
 */
export function derive(entropy, lunaId) {
	if (entropy.length !== 16 && entropy.length !== 32) {
		throw new Error('Recovery phrase entropy must be 16 or 32 bytes.');
	}
	const x25519Secret = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('x25519'), lunaId));
	// Clamp as X25519 does, so the stored secret and its public key always agree.
	x25519Secret[0] &= 248;
	x25519Secret[31] &= 127;
	x25519Secret[31] |= 64;
	const mlkemSeed = hkdf(sha256, entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('mlkem'), lunaId), MLKEM_SEED_LEN);
	try {
		const sealSecret = cat(x25519Secret, mlkemSeed);
		const sealPublic = cat(x25519.getPublicKey(x25519Secret), mlkemKeys(mlkemSeed).publicKey);
		const selfKey = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('self'), lunaId));
		const authSecret = hkdf32(entropy, DERIVE_SALT, deriveInfo(utf8ToBytes('auth'), lunaId));
		const authPublic = signerPublic(authSecret);
		return { sealSecret, sealPublic, selfKey, authSecret, authPublic };
	} finally {
		x25519Secret.fill(0);
		mlkemSeed.fill(0);
	}
}

/**
 * HKDF over both shared secrets, bound to the ephemeral key, the ML-KEM ciphertext and the
 * recipient's whole public key (the ML-KEM half by its SHA-256).
 * @param {Bytes} sharedX @param {Bytes} sharedK @param {Bytes} ephPublic
 * @param {Bytes} recipientPublic @param {Bytes} mlkemCt
 */
function sealKey(sharedX, sharedK, ephPublic, recipientPublic, mlkemCt) {
	const info = cat(
		SEAL_INFO,
		ephPublic,
		recipientPublic.slice(0, X25519_LEN),
		mlkemCt,
		sha256(recipientPublic.slice(X25519_LEN)),
	);
	return hkdf32(cat(sharedX, sharedK), undefined, info);
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
 * Throws when a public sealing key is unusable: the wrong length, an X25519 half that is a
 * low-order point, or an ML-KEM half that fails the FIPS 203 encapsulation key check.
 * @param {Bytes} publicKey
 */
export function checkPublicKey(publicKey) {
	const bad = 'This recovery key is not valid. Set up the recovery phrase again.';
	if (publicKey.length !== SEAL_PUBLIC_LEN) throw new Error(bad);
	// Multiplying a low-order point by a clamped scalar gives the identity (all zeros).
	if (
		!sharedSecret(
			Uint8Array.from({ length: 32 }, () => 0x42),
			publicKey.slice(0, X25519_LEN),
		)
	) {
		throw new Error(bad);
	}
	try {
		// Encapsulating runs the FIPS 203 modulus check on the key.
		ml_kem768.encapsulate(publicKey.slice(X25519_LEN), new Uint8Array(32));
	} catch {
		throw new Error(bad);
	}
}

/**
 * Seal `msg` so only the holder of the secret half of `recipientPublic` can open it.
 * Layout: ephemeral X25519 public key (32) | ML-KEM ciphertext (1088) | nonce (24) | ciphertext and tag.
 * @param {Bytes} recipientPublic
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function seal(recipientPublic, aad, msg) {
	return sealWith(randomBytes(32), randomBytes(32), randomBytes(NONCE_LEN), recipientPublic, aad, msg);
}

/**
 * `seal` with the ephemeral secret, ML-KEM message and nonce supplied by the caller. Test-only: it
 * exists so the vectors can be reproduced; production code uses `seal`.
 * @param {Bytes} ephSecret 32 bytes
 * @param {Bytes} m 32 bytes, the ML-KEM encapsulation randomness
 * @param {Bytes} nonce 24 bytes
 * @param {Bytes} recipientPublic
 * @param {Bytes} aad
 * @param {Bytes} msg
 * @returns {Bytes}
 */
export function sealWith(ephSecret, m, nonce, recipientPublic, aad, msg) {
	// Seal only to keys that pass the checks; a low-order key would make the shared secret all zeros.
	checkPublicKey(recipientPublic);
	const ephPublic = x25519.getPublicKey(ephSecret);
	const sharedX = sharedSecret(ephSecret, recipientPublic.slice(0, X25519_LEN));
	if (!sharedX) throw new Error('This sealed copy is not valid.');
	const { cipherText, sharedSecret: sharedK } = ml_kem768.encapsulate(recipientPublic.slice(X25519_LEN), m);
	const key = sealKey(sharedX, sharedK, ephPublic, recipientPublic, cipherText);
	return cat(ephPublic, cipherText, nonce, aeadEncrypt(key, nonce, aad, msg));
}

/**
 * Open a sealed copy with the recipient's secret sealing key.
 * @param {Bytes} secret
 * @param {Bytes} aad
 * @param {Bytes} sealed
 * @returns {Bytes}
 */
export function open(secret, aad, sealed) {
	const head = X25519_LEN + MLKEM_CT_LEN + NONCE_LEN;
	if (sealed.length < head + TAG_LEN) {
		throw new Error('This sealed copy is too short to be valid.');
	}
	if (secret.length !== SEAL_SECRET_LEN) throw new Error('This recovery key is not valid.');
	const ephPublic = sealed.slice(0, X25519_LEN);
	const mlkemCt = sealed.slice(X25519_LEN, X25519_LEN + MLKEM_CT_LEN);
	const nonce = sealed.slice(X25519_LEN + MLKEM_CT_LEN, head);
	const body = sealed.slice(head);
	const xSecret = secret.slice(0, X25519_LEN);
	const mlkem = mlkemKeys(secret.slice(X25519_LEN));
	const recipientPublic = cat(x25519.getPublicKey(xSecret), mlkem.publicKey);
	const sharedX = sharedSecret(xSecret, ephPublic);
	if (!sharedX) throw new Error('This sealed copy is not valid.');
	// A wrong ciphertext gives an unrelated secret rather than an error; the open fails below.
	const sharedK = ml_kem768.decapsulate(mlkemCt, mlkem.secretKey);
	const key = sealKey(sharedX, sharedK, ephPublic, recipientPublic, mlkemCt);
	try {
		return aeadDecrypt(key, nonce, aad, body);
	} catch {
		throw new Error('This sealed copy could not be opened. It was changed, or it was sealed to a different key.');
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

/** The ML-DSA key pair that goes with a 32-byte Ed25519 signing seed. @param {Bytes} seed */
function mldsaKeys(seed) {
	return ml_dsa65.keygen(hkdf32(seed, undefined, MLDSA_SEED_INFO));
}

/**
 * Public signing key for a 32-byte signing seed: Ed25519 public key | ML-DSA-65 public key.
 * @param {Bytes} seed 32 bytes
 * @returns {Bytes} SIG_PUBLIC_LEN bytes
 */
export function signerPublic(seed) {
	return cat(ed25519.getPublicKey(seed), mldsaKeys(seed).publicKey);
}

/**
 * Sign `msg` under `domain` with a 32-byte signing seed. Matches `Signer::sign` in Rust: both
 * signatures are deterministic, so the same input always gives the same bytes.
 * @param {Bytes} seed 32 bytes
 * @param {string} domain
 * @param {Bytes} msg
 * @returns {Bytes} SIG_LEN bytes
 */
export function sign(seed, domain, msg) {
	const signed = signedBytes(domain, msg);
	const mldsa = ml_dsa65.sign(signed, mldsaKeys(seed).secretKey, { extraEntropy: false });
	return cat(ed25519.sign(signed, seed), mldsa);
}

/**
 * Check a signature made by `sign` with the same `domain`. Both halves must verify. Strict, like
 * `verify_strict` in Rust.
 * @param {Bytes} publicKey SIG_PUBLIC_LEN bytes
 * @param {string} domain
 * @param {Bytes} msg
 * @param {Bytes} sig SIG_LEN bytes
 * @returns {boolean}
 */
export function verify(publicKey, domain, msg, sig) {
	if (publicKey.length !== SIG_PUBLIC_LEN || sig.length !== SIG_LEN) return false;
	const signed = signedBytes(domain, msg);
	try {
		const edOk = ed25519.verify(sig.slice(0, ED_SIG_LEN), signed, publicKey.slice(0, ED_PUBLIC_LEN), {
			zip215: false,
		});
		const mldsaOk = ml_dsa65.verify(sig.slice(ED_SIG_LEN), signed, publicKey.slice(ED_PUBLIC_LEN));
		return edOk && mldsaOk;
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
 * Read 12 or 24 English recovery words (case and extra spaces ignored) into their 16 or 32 bytes of entropy.
 * @param {string} words
 * @returns {Bytes}
 */
export function phraseToEntropy(words) {
	const list = words
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
	if (list.length !== 12 && list.length !== 24) {
		throw new Error(`Your recovery phrase has ${list.length} words. It needs 12 or 24.`);
	}
	for (const word of list) {
		if (!wordlist.includes(word)) {
			throw new Error(`That word isn't on the recovery phrase list: ${word}`);
		}
	}
	try {
		const entropy = mnemonicToEntropy(list.join(' '), wordlist);
		if (entropy.length === 16 || entropy.length === 32) return entropy;
	} catch {
		// Fall through to the same plain sentence as a bad checksum.
	}
	throw new Error(`These ${list.length} words don't form a valid recovery phrase. Check each word.`);
}

/**
 * The 12 or 24 English words for 16 or 32 bytes of entropy.
 * @param {Bytes} entropy 16 or 32 bytes
 * @returns {string}
 */
export function entropyToPhrase(entropy) {
	return entropyToMnemonic(entropy, wordlist);
}

/**
 * Fresh recovery phrase entropy from the platform CSPRNG: 16 bytes (12 words) or 32 bytes (24 words).
 * @param {12 | 24} [words] how many words the phrase will have
 * @returns {Bytes}
 */
export function newEntropy(words = 12) {
	if (words !== 12 && words !== 24) throw new Error('A recovery phrase has 12 or 24 words.');
	return randomBytes(words === 24 ? 32 : 16);
}
