// Opens private backup items: scope records, sealed keys and signatures for backups only their owner
// can open. Browser side of luna/crates/lunad/src/backup/cloud/private.rs. Every signature is checked
// before a key is used.
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
	canonical,
	chunkId,
	derive,
	open,
	seal,
	SEAL_PUBLIC_LEN,
	SEAL_SECRET_LEN,
	SIG_LEN,
	SIG_PUBLIC_LEN,
	sign,
	verify,
} from './backupCrypto.js';
import { DAMAGED, verifySnapshot } from './cloudFormat.js';

export const PSCOPES_KIND = 'pscopes';
export const PSNAPSHOTS_KIND = 'psnapshots';
export const SCOPE_RECORD_DOMAIN = 'private-scope';
export const PRIVATE_SNAPSHOT_DOMAIN = 'private-snapshot';
export const PRIVATE_OPEN_DOMAIN = 'private-open';

const PACK_KEY_PURPOSE = 'luna-private-pack-key-v1';
const SCOPE_SECRET_PURPOSE = 'luna-private-scope-secret-v1';
const TREE_PURPOSE = 'luna-private-tree-v1';
const META_PURPOSE = 'luna-private-meta-v1';
const DEDUP_PURPOSE = 'luna-private-dedup-v1';
const SCOPE_PURPOSE = 'luna-scope-v1';
const KEY_LEN = 32;

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Association data for every private seal: binds the purpose, the Luna and the scope.
 * @param {string} purpose
 * @param {string} lunaId
 * @param {string} scope
 * @returns {Uint8Array}
 */
export function privateAad(purpose, lunaId, scope) {
	return canonical([
		['purpose', utf8ToBytes(purpose)],
		['luna_id', utf8ToBytes(lunaId)],
		['scope', utf8ToBytes(scope)],
	]);
}

/**
 * A scope's public name: the first 16 bytes of chunkId(dedup key, "luna-scope-v1"), as 32 hex chars.
 * @param {Uint8Array} dedupKey
 * @returns {string}
 */
export function scopeOf(dedupKey) {
	return bytesToHex(chunkId(dedupKey, utf8ToBytes(SCOPE_PURPOSE)).slice(0, 16));
}

/**
 * Unwrap a private pack key, for `openPackWith` in cloudFormat.js.
 * @param {Uint8Array} sealSecret
 * @param {string} lunaId
 * @param {string} scope
 * @returns {(wrapped: Uint8Array) => Uint8Array}
 */
export function privateUnwrap(sealSecret, lunaId, scope) {
	const aad = privateAad(PACK_KEY_PURPOSE, lunaId, scope);
	return (wrapped) => open(sealSecret, aad, wrapped);
}

/**
 * Open a private tree's sealed JSON, for `readTreeWith` in cloudFormat.js.
 * @param {Uint8Array} sealSecret
 * @param {string} lunaId
 * @param {string} scope
 * @returns {(sealed: Uint8Array) => Uint8Array}
 */
export function openPrivateTreeBytes(sealSecret, lunaId, scope) {
	const aad = privateAad(TREE_PURPOSE, lunaId, scope);
	return (sealed) => {
		try {
			return open(sealSecret, aad, sealed);
		} catch {
			throw new Error(DAMAGED);
		}
	};
}

/**
 * Read a private backup's name and who started it.
 * @param {Uint8Array} sealed the snapshot record's meta
 * @param {Uint8Array} sealSecret
 * @param {string} lunaId
 * @param {string} scope
 * @returns {{ name: string, sourceDrive: string, sourcePath: string, startedBy: string, startedByName: string }}
 */
export function openPrivateMeta(sealed, sealSecret, lunaId, scope) {
	let parsed;
	let plain;
	try {
		plain = open(sealSecret, privateAad(META_PURPOSE, lunaId, scope), sealed);
		parsed = JSON.parse(new TextDecoder().decode(plain));
	} catch {
		throw new Error(DAMAGED);
	} finally {
		plain?.fill(0);
	}
	const fields = [parsed?.name, parsed?.source_drive, parsed?.source_path, parsed?.started_by, parsed?.started_by_name];
	if (!fields.every((f) => typeof f === 'string')) throw new Error(DAMAGED);
	return {
		name: parsed.name,
		sourceDrive: parsed.source_drive,
		sourcePath: parsed.source_path,
		startedBy: parsed.started_by,
		startedByName: parsed.started_by_name,
	};
}

/**
 * Open a scope's secret key with the owner's secret sealing key. Every private item in the scope
 * is sealed to the scope's own key, so this is the first step of every private read (plan §5).
 * Browser side of `open_scope_secret` in private.rs.
 * @param {Uint8Array} sealed the record's sealed_scope_secret
 * @param {Uint8Array} ownerSealSecret the phrase's secret sealing key
 * @param {string} lunaId
 * @param {string} scope
 * @returns {Uint8Array} the scope's secret sealing key
 */
export function openScopeSecret(sealed, ownerSealSecret, lunaId, scope) {
	let plain;
	try {
		plain = open(ownerSealSecret, privateAad(SCOPE_SECRET_PURPOSE, lunaId, scope), sealed);
	} catch {
		throw new Error(DAMAGED);
	}
	if (plain.length !== SEAL_SECRET_LEN) {
		plain.fill(0);
		throw new Error(DAMAGED);
	}
	return plain;
}

/**
 * Seal a scope's secret key to an owner's sealing key: the re-seal step of a phrase change (plan §5).
 * Browser side of `seal_scope_secret` in private.rs.
 * @param {Uint8Array} scopeSecret
 * @param {Uint8Array} ownerSealPublic the new phrase's public sealing key
 * @param {string} lunaId
 * @param {string} scope
 * @returns {Uint8Array}
 */
export function sealScopeSecret(scopeSecret, ownerSealPublic, lunaId, scope) {
	return seal(ownerSealPublic, privateAad(SCOPE_SECRET_PURPOSE, lunaId, scope), scopeSecret);
}

/**
 * Open a scope's sealed dedup key.
 * @param {Uint8Array} sealed
 * @param {Uint8Array} sealSecret
 * @param {string} lunaId
 * @param {string} scope
 * @returns {Uint8Array} 32 bytes
 */
export function openPrivateDedup(sealed, sealSecret, lunaId, scope) {
	let plain;
	try {
		plain = open(sealSecret, privateAad(DEDUP_PURPOSE, lunaId, scope), sealed);
	} catch {
		throw new Error(DAMAGED);
	}
	if (plain.length !== KEY_LEN) {
		plain.fill(0);
		throw new Error(DAMAGED);
	}
	return plain;
}

/**
 * Check a `pscopes/<scope>` record against Luna's signing keys. Never throws.
 * @param {Uint8Array} bytes JSON {record, signature}
 * @param {Uint8Array[]} signingPublics
 * @param {string} lunaId
 * @returns {{ lunaId: string, scope: string, userId: string, sealPublic: Uint8Array, authPublic: Uint8Array, createdAt: number, scopePublic: Uint8Array, sealedScopeSecret: Uint8Array, sealedDedup: Uint8Array } | null}
 */
export function verifyScopeRecord(bytes, signingPublics, lunaId) {
	try {
		const signed = JSON.parse(new TextDecoder().decode(bytes));
		const rec = signed.record;
		if (rec.luna_id !== lunaId) return null;
		if (typeof rec.scope !== 'string' || typeof rec.user_id !== 'string') return null;
		if (!Number.isSafeInteger(rec.created_at)) return null;
		const sealPublic = hexToBytes(rec.seal_public);
		const authPublic = hexToBytes(rec.auth_public);
		const scopePublic = hexToBytes(rec.scope_public);
		const sealedScopeSecret = hexToBytes(rec.sealed_scope_secret);
		const sealedDedup = hexToBytes(rec.sealed_dedup);
		if (sealPublic.length !== SEAL_PUBLIC_LEN || authPublic.length !== SIG_PUBLIC_LEN) return null;
		if (scopePublic.length !== SEAL_PUBLIC_LEN) return null;
		const sig = hexToBytes(signed.signature);
		if (sig.length !== SIG_LEN) return null;
		const createdAt = new Uint8Array(8);
		new DataView(createdAt.buffer).setBigInt64(0, BigInt(rec.created_at), false);
		const msg = canonical([
			['luna_id', utf8ToBytes(rec.luna_id)],
			['scope', utf8ToBytes(rec.scope)],
			['user_id', utf8ToBytes(rec.user_id)],
			['seal_public', sealPublic],
			['auth_public', authPublic],
			['created_at', createdAt],
			['scope_public', scopePublic],
			['sealed_scope_secret', sealedScopeSecret],
			['sealed_dedup', sealedDedup],
		]);
		const ok = signingPublics.some((pub) => verify(pub, SCOPE_RECORD_DOMAIN, msg, sig));
		if (!ok) return null;
		return {
			lunaId: rec.luna_id,
			scope: rec.scope,
			userId: rec.user_id,
			sealPublic,
			authPublic,
			createdAt: rec.created_at,
			scopePublic,
			sealedScopeSecret,
			sealedDedup,
		};
	} catch {
		return null;
	}
}

/**
 * The message an owner's auth key signs to open a private scope on Connect.
 * @param {string} lunaId
 * @param {string} scope
 * @param {Uint8Array} challenge 32 bytes
 * @returns {Uint8Array}
 */
export function privateOpenMessage(lunaId, scope, challenge) {
	return canonical([
		['luna_id', utf8ToBytes(lunaId)],
		['scope', utf8ToBytes(scope)],
		['challenge', challenge],
	]);
}

/**
 * Sign a Connect challenge for one private scope, with the owner's auth key.
 * @param {Uint8Array} authSecret
 * @param {string} lunaId
 * @param {string} scope
 * @param {Uint8Array} challenge 32 bytes
 * @returns {Uint8Array} signature (Ed25519 and ML-DSA)
 */
export function signPrivateOpen(authSecret, lunaId, scope, challenge) {
	return sign(authSecret, PRIVATE_OPEN_DOMAIN, privateOpenMessage(lunaId, scope, challenge));
}

/**
 * The private scopes this recovery phrase owns on one Luna, newest first. `sealSecret` is the
 * scope's own secret key (not the phrase's): pass it to the readers in this file.
 * @param {{ lunaId: string, entropy: Uint8Array, pscopes: Array<{ name: string, data: Uint8Array }>, signingPublics: Uint8Array[] }} input
 * @returns {Array<{ scope: string, userId: string, createdAt: number, dedupKey: Uint8Array, sealSecret: Uint8Array }>}
 */
export function findMyPrivateScopes({ lunaId, entropy, pscopes = [], signingPublics }) {
	const k = derive(entropy, lunaId);
	try {
		const found = [];
		for (const r of pscopes) {
			let rec = null;
			for (const pub of signingPublics) {
				rec = verifyScopeRecord(r.data, [pub], lunaId);
				if (rec) break;
			}
			if (!rec || r.name !== rec.scope || !sameBytes(rec.sealPublic, k.sealPublic)) continue;
			let sealSecret;
			let dedupKey;
			try {
				sealSecret = openScopeSecret(rec.sealedScopeSecret, k.sealSecret, lunaId, rec.scope);
				dedupKey = openPrivateDedup(rec.sealedDedup, sealSecret, lunaId, rec.scope);
			} catch {
				sealSecret?.fill(0);
				dedupKey?.fill(0);
				continue;
			}
			if (scopeOf(dedupKey) !== rec.scope) {
				sealSecret.fill(0);
				dedupKey.fill(0);
				continue;
			}
			found.push({ scope: rec.scope, userId: rec.userId, createdAt: rec.createdAt, dedupKey, sealSecret });
		}
		return found.sort((a, b) => b.createdAt - a.createdAt);
	} finally {
		k.sealSecret.fill(0);
		k.selfKey.fill(0);
		k.authSecret.fill(0);
	}
}

/**
 * The verified private snapshots in one scope, newest first. A snapshot whose details do not open
 * with the scope's key is left out.
 * @param {{ lunaId: string, sealSecret: Uint8Array, scope: string, psnapshots: Array<{ name: string, data: Uint8Array }>, signingPublics: Uint8Array[] }} input
 *   `sealSecret` is the scope's secret key (`sealSecret` from `findMyPrivateScopes`).
 * @returns {Array<object>} the verified snapshot fields, with `meta` (decoded) and `sealedMeta`
 */
export function readPrivateSnapshots({ lunaId, sealSecret, scope, psnapshots = [], signingPublics }) {
	const out = [];
	for (const r of psnapshots) {
		if (!r.name.startsWith(`${scope}.`)) continue;
		const snap = verifySnapshot(r.data, signingPublics, lunaId, PRIVATE_SNAPSHOT_DOMAIN);
		if (!snap || r.name !== `${scope}.${snap.snapshotId}`) continue;
		let meta;
		try {
			meta = openPrivateMeta(snap.meta, sealSecret, lunaId, scope);
		} catch {
			continue;
		}
		out.push({ ...snap, sealedMeta: snap.meta, meta });
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}
