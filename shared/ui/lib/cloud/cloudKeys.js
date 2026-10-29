// Finds the backup keys one recovery phrase opens on one Luna. Browser side of
// luna/crates/lunad/src/backup/cloud/keys.rs. Every signature is checked before a key is used.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonical, decrypt, derive, open, SIG_LEN, SIG_PUBLIC_LEN, verify } from './backupCrypto.js';
import { findMyPrivateScopes } from './cloudPrivate.js';

/** @typedef {{ name: string, data: Uint8Array }} RecordEntry */

export const NO_BACKUPS = "This recovery phrase doesn't open any backups on this Luna. Check each word.";
export const SIGNING_MISMATCH =
	"Luna's backup signing key doesn't match the one saved with your recovery phrase, so nothing was sent.";

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VERSION = '(0|[1-9][0-9]*)';
const KEY_NAME = new RegExp(`^(${UUID})\\.${VERSION}\\.([0-9a-f]{32})$`);
const RECIPIENTS_NAME = new RegExp(`^(${UUID})\\.${VERSION}$`);
const KEY_LEN = 32;

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * hex of the first 16 bytes of SHA-256(utf8(userId)): 32 lowercase hex chars (keys.rs user_record_part).
 * @param {string} userId
 * @returns {string}
 */
export function userRecordPart(userId) {
	return bytesToHex(sha256(utf8ToBytes(userId)).slice(0, 16));
}

/**
 * Read a key record name, "<protection>.<version>.<part>".
 * @param {string} name
 * @returns {{ protectionId: string, version: number, part: string } | null}
 */
export function parseKeyName(name) {
	const m = KEY_NAME.exec(name);
	if (!m) return null;
	return { protectionId: m[1], version: Number(m[2]), part: m[3] };
}

/**
 * Read a recipients record name, "<protection>.<version>".
 * @param {string} name
 * @returns {{ protectionId: string, version: number } | null}
 */
export function parseRecipientsName(name) {
	const m = RECIPIENTS_NAME.exec(name);
	if (!m) return null;
	return { protectionId: m[1], version: Number(m[2]) };
}

/**
 * Association data for a user's own signing key record.
 * @param {string} lunaId
 * @param {string} userId
 * @returns {Uint8Array}
 */
export function selfSealedAad(lunaId, userId) {
	return canonical([
		['luna_id', utf8ToBytes(lunaId)],
		['user_id', utf8ToBytes(userId)],
		['purpose', utf8ToBytes('signing-public')],
	]);
}

/**
 * Association data for one user's copy of one key version.
 * @param {string} lunaId
 * @param {string} protectionId
 * @param {number} version
 * @param {string} userId
 * @returns {Uint8Array}
 */
export function keyCopyAad(lunaId, protectionId, version, userId) {
	return canonical([
		['luna_id', utf8ToBytes(lunaId)],
		['protection_id', utf8ToBytes(protectionId)],
		['version', utf8ToBytes(String(version))],
		['user_id', utf8ToBytes(userId)],
	]);
}

/**
 * Open a user's self record with the self key from their phrase.
 * @param {Uint8Array} selfKey
 * @param {string} lunaId
 * @param {string} userId
 * @param {Uint8Array} data
 * @returns {Uint8Array | null} the signing public key (Ed25519 and ML-DSA), or null when it does not open
 */
export function openSelfRecord(selfKey, lunaId, userId, data) {
	try {
		const publicKey = decrypt(selfKey, selfSealedAad(lunaId, userId), data);
		return publicKey.length === SIG_PUBLIC_LEN ? publicKey : null;
	} catch {
		return null;
	}
}

/**
 * Check a signed recipient list and read its users.
 * @param {Uint8Array} bytes JSON {users, signature}
 * @param {Uint8Array} signingPublic
 * @param {string} lunaId
 * @param {string} protectionId
 * @param {number} version
 * @returns {string[] | null} the users, or null when the list is unreadable or the signature fails
 */
export function verifyRecipients(bytes, signingPublic, lunaId, protectionId, version) {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes));
		const users = parsed.users;
		if (!Array.isArray(users) || !users.every((u) => typeof u === 'string')) return null;
		const sig = hexToBytes(parsed.signature);
		if (sig.length !== SIG_LEN) return null;
		const msg = canonical([
			['luna_id', utf8ToBytes(lunaId)],
			['protection_id', utf8ToBytes(protectionId)],
			['version', utf8ToBytes(String(version))],
			['users', utf8ToBytes(JSON.stringify(users))],
		]);
		return verify(signingPublic, 'recipients', msg, sig) ? users : null;
	} catch {
		return null;
	}
}

/**
 * Check a key copy's signature, then open it with this user's secret sealing key.
 * @param {Uint8Array} record sealed bytes followed by the signature
 * @param {Uint8Array} sealSecret
 * @param {Uint8Array} signingPublic
 * @param {string} lunaId
 * @param {string} protectionId
 * @param {number} version
 * @param {string} userId
 * @returns {{ key: Uint8Array, dedupKey: Uint8Array } | null}
 */
export function openKeyCopy(record, sealSecret, signingPublic, lunaId, protectionId, version, userId) {
	if (record.length <= SIG_LEN) return null;
	const sealed = record.slice(0, record.length - SIG_LEN);
	const sig = record.slice(record.length - SIG_LEN);
	const aad = keyCopyAad(lunaId, protectionId, version, userId);
	const msg = canonical([
		['aad', aad],
		['sealed', sealed],
	]);
	if (!verify(signingPublic, 'key-copy', msg, sig)) return null;
	try {
		const plain = open(sealSecret, aad, sealed);
		if (plain.length !== 2 * KEY_LEN) return null;
		return { key: plain.slice(0, KEY_LEN), dedupKey: plain.slice(KEY_LEN) };
	} catch {
		return null;
	}
}

/**
 * Everything one recovery phrase opens on one Luna.
 * @param {{ lunaId: string, entropy: Uint8Array, self: RecordEntry[], recipients: RecordEntry[], keys: RecordEntry[], pscopes?: RecordEntry[], expectSigningPublic?: Uint8Array }} input
 * @returns {{ signingPublics: Uint8Array[], userIds: string[], keys: Array<{ protectionId: string, version: number, key: Uint8Array, dedupKey: Uint8Array, userId: string }>, latestVersion: Record<string, number>, privateScopes: Array<{ scope: string, userId: string, createdAt: number, dedupKey: Uint8Array, sealSecret: Uint8Array }> }}
 */
export function findMyKeys({ lunaId, entropy, self, recipients, keys, pscopes = [], expectSigningPublic }) {
	const k = derive(entropy, lunaId);
	const decoder = new TextDecoder();
	const selfByName = new Map(self.map((r) => [r.name, r.data]));
	const keyByName = new Map(keys.map((r) => [r.name, r.data]));

	// Candidate user ids come from the recipient lists and the private scope records. A person's id
	// can change after Luna loses its database, so no current id is assumed. Nothing here is trusted
	// until a signature checks.
	const candidates = new Set();
	for (const r of recipients) {
		try {
			const users = JSON.parse(decoder.decode(r.data)).users;
			if (Array.isArray(users)) for (const u of users) if (typeof u === 'string') candidates.add(u);
		} catch {
			// Unreadable record: skipped for now.
		}
	}
	for (const r of pscopes) {
		try {
			const uid = JSON.parse(decoder.decode(r.data)).record?.user_id;
			if (typeof uid === 'string') candidates.add(uid);
		} catch {
			// Unreadable record: skipped for now.
		}
	}

	/** @type {Uint8Array[]} */
	let signingPublics = [];
	for (const uid of candidates) {
		const data = selfByName.get(userRecordPart(uid));
		if (!data) continue;
		const publicKey = openSelfRecord(k.selfKey, lunaId, uid, data);
		if (publicKey && !signingPublics.some((p) => sameBytes(p, publicKey))) signingPublics.push(publicKey);
	}
	// No signing key is not an error yet: a phrase can still open private scopes, which are checked
	// below. NO_BACKUPS is thrown only when nothing at all opens.
	if (expectSigningPublic && signingPublics.length > 0) {
		const expected = expectSigningPublic;
		signingPublics = signingPublics.filter((p) => sameBytes(p, expected));
		if (signingPublics.length === 0) throw new Error(SIGNING_MISMATCH);
	}

	/** @type {Record<string, number>} */
	const latestVersion = {};
	/** @type {Array<{ protectionId: string, version: number, key: Uint8Array, dedupKey: Uint8Array, userId: string }>} */
	const found = [];
	/** @type {string[]} */
	const userIds = [];
	for (const r of recipients) {
		const parsed = parseRecipientsName(r.name);
		if (!parsed) continue;
		const { protectionId, version } = parsed;
		let users = null;
		for (const pub of signingPublics) {
			users = verifyRecipients(r.data, pub, lunaId, protectionId, version);
			if (users) break;
		}
		if (!users) continue;
		latestVersion[protectionId] = Math.max(latestVersion[protectionId] ?? 0, version);

		for (const uid of users) {
			const data = keyByName.get(`${protectionId}.${version}.${userRecordPart(uid)}`);
			if (!data) continue;
			let opened = null;
			for (const pub of signingPublics) {
				opened = openKeyCopy(data, k.sealSecret, pub, lunaId, protectionId, version, uid);
				if (opened) break;
			}
			if (opened) {
				found.push({ protectionId, version, key: opened.key, dedupKey: opened.dedupKey, userId: uid });
				if (!userIds.includes(uid)) userIds.push(uid);
				break;
			}
		}
	}
	const privateScopes = findMyPrivateScopes({ lunaId, entropy, pscopes, signingPublics });
	if (found.length === 0 && privateScopes.length === 0) throw new Error(NO_BACKUPS);
	return { signingPublics, userIds, keys: found, latestVersion, privateScopes };
}
