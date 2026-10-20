// Reads a Luna cloud backup's format: signed snapshot records, packs, the file list and backup
// details. Browser side of luna/crates/lunad/src/backup/cloud/format.rs. Every check runs before
// the bytes are used.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonical, chunkId, decrypt, packId, verify } from './backupCrypto.js';

export const DAMAGED = "Part of this backup can't be read. It may be damaged.";
export const CHANGED = "A backup file doesn't match its fingerprint, so it was not used. Try again later.";

export const PACK_KEY_WRAP_AAD = utf8ToBytes('luna-pack-key-wrap-v1');
export const PACK_INDEX_AAD = utf8ToBytes('luna-pack-index-v1');
export const PACK_BODY_AAD = utf8ToBytes('luna-pack-v1');
export const TREE_AAD = utf8ToBytes('luna-tree-v1');
export const META_AAD = utf8ToBytes('luna-meta-v1');

const PACK_VERSION = 1;
const KEY_LEN = 32;
const ID_LEN = 32;
const INDEX_HEADER_LEN = 36; // scope id (32) + count (u32)
const INDEX_ENTRY_LEN = 44; // chunk id (32) + offset (u64) + length (u32)
const HEX64 = /^[0-9a-f]{64}$/;

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** @param {Uint8Array} bytes @param {number} pos */
function u32At(bytes, pos) {
	if (pos + 4 > bytes.length) throw new Error(DAMAGED);
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(pos, false);
}

/** Read a u64 BE that must fit in a safe JS integer. @param {Uint8Array} bytes @param {number} pos */
function u64At(bytes, pos) {
	if (pos + 8 > bytes.length) throw new Error(DAMAGED);
	const big = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(pos, false);
	if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(DAMAGED);
	return Number(big);
}

/** @param {Uint8Array} bytes @param {number} start @param {number} len */
function sliceChecked(bytes, start, len) {
	if (start + len > bytes.length) throw new Error(DAMAGED);
	return bytes.slice(start, start + len);
}

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '');

/**
 * The bytes a snapshot signature covers (format.rs SnapshotRecord::signed_bytes).
 * @param {{ lunaId: string, protectionId: string, snapshotId: string, createdAt: number, keyVersion: number, treePackId: string, treeHash: Uint8Array, meta: Uint8Array }} rec
 *   treePackId is hex. createdAt is Unix seconds.
 * @returns {Uint8Array}
 */
export function snapshotSignedBytes(rec) {
	const createdAt = new Uint8Array(8);
	new DataView(createdAt.buffer).setBigInt64(0, BigInt(rec.createdAt), false);
	const keyVersion = new Uint8Array(4);
	new DataView(keyVersion.buffer).setUint32(0, rec.keyVersion, false);
	return canonical([
		['luna_id', utf8ToBytes(rec.lunaId)],
		['protection_id', utf8ToBytes(rec.protectionId)],
		['snapshot_id', utf8ToBytes(rec.snapshotId)],
		['created_at', createdAt],
		['key_version', keyVersion],
		['tree_pack_id', hexToBytes(rec.treePackId)],
		['tree_hash', rec.treeHash],
		['meta', rec.meta],
	]);
}

/**
 * Parse a signed snapshot record and check its signature against any of the signing keys.
 * @param {Uint8Array} bytes JSON {record, signature}
 * @param {Uint8Array[]} signingPublics
 * @param {string} lunaId the Luna being viewed; other Lunas' snapshots are dropped
 * @param {string} [domain='snapshot'] the signature domain: 'snapshot' for shared backups, 'private-snapshot' for private ones
 * @returns {{ lunaId: string, protectionId: string, snapshotId: string, createdAt: number, keyVersion: number, treePackId: string, treeHash: Uint8Array, meta: Uint8Array } | null}
 *   null when the record is unreadable, signed by none of the keys, or for another Luna. Never throws.
 */
export function verifySnapshot(bytes, signingPublics, lunaId, domain = 'snapshot') {
	try {
		const signed = JSON.parse(new TextDecoder().decode(bytes));
		const rec = signed.record;
		if (rec.luna_id !== lunaId) return null;
		const treePackId = hexToBytes(rec.tree_pack_id);
		const treeHash = hexToBytes(rec.tree_hash);
		if (treePackId.length !== ID_LEN || treeHash.length !== ID_LEN) return null;
		const view = {
			lunaId: rec.luna_id,
			protectionId: rec.protection_id,
			snapshotId: rec.snapshot_id,
			createdAt: rec.created_at,
			keyVersion: rec.key_version,
			treePackId: bytesToHex(treePackId),
			treeHash,
			meta: hexToBytes(rec.meta),
		};
		const msg = snapshotSignedBytes(view);
		const signature = hexToBytes(signed.signature);
		return signingPublics.some((pub) => verify(pub, domain, msg, signature)) ? view : null;
	} catch {
		return null;
	}
}

/**
 * Read a backup's name and who started it.
 * @param {Uint8Array} meta sealed bytes from the snapshot record
 * @param {Uint8Array} key the backup key
 * @returns {{ name: string, sourceDrive: string, sourcePath: string, startedBy: string, startedByName: string }}
 */
export function decryptMeta(meta, key) {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(decrypt(key, META_AAD, meta)));
		return {
			name: text(parsed.name),
			sourceDrive: text(parsed.source_drive),
			sourcePath: text(parsed.source_path),
			startedBy: text(parsed.started_by),
			startedByName: text(parsed.started_by_name),
		};
	} catch {
		throw new Error(DAMAGED);
	}
}

/**
 * The unwrap step for a backup key: opens a pack's wrapped pack key with the backup key.
 * @param {Uint8Array} backupKey
 * @returns {(wrapped: Uint8Array) => Uint8Array}
 */
function unwrapWithBackupKey(backupKey) {
	return (wrapped) => decrypt(backupKey, PACK_KEY_WRAP_AAD, wrapped);
}

/**
 * Open a pack (format.rs open_pack): check its hash, unwrap its key, then read its index and body.
 * @param {Uint8Array} bytes the whole pack
 * @param {string} idHex the pack id, lowercase hex (SHA-256 of bytes)
 * @param {Uint8Array} backupKey
 * @returns {{ scopeId: Uint8Array, chunk: (idBytes: Uint8Array) => Uint8Array | null }}
 *   chunk returns the plain bytes of one chunk, or null if this pack does not hold it.
 */
export function openPack(bytes, idHex, backupKey) {
	return openPackWith(bytes, idHex, unwrapWithBackupKey(backupKey));
}

/**
 * Open a pack like openPack, but unwrap its pack key with a caller-supplied function. Private
 * items use this: their pack keys are sealed to the owner's sealing key, not the backup key.
 * @param {Uint8Array} bytes the whole pack
 * @param {string} idHex the pack id, lowercase hex (SHA-256 of bytes)
 * @param {(wrapped: Uint8Array) => Uint8Array} unwrapKey returns the 32-byte pack key; throws if it cannot
 * @returns {{ scopeId: Uint8Array, chunk: (idBytes: Uint8Array) => Uint8Array | null }}
 */
export function openPackWith(bytes, idHex, unwrapKey) {
	if (bytesToHex(packId(bytes)) !== idHex) throw new Error(CHANGED);
	try {
		return openPackParts(bytes, unwrapKey);
	} catch {
		throw new Error(DAMAGED);
	}
}

/** @param {Uint8Array} bytes @param {(wrapped: Uint8Array) => Uint8Array} unwrapKey */
function openPackParts(bytes, unwrapKey) {
	if (bytes[0] !== PACK_VERSION) throw new Error(DAMAGED);
	let pos = 1;
	const wrappedLen = u32At(bytes, pos);
	pos += 4;
	const wrapped = sliceChecked(bytes, pos, wrappedLen);
	pos += wrappedLen;
	const packKey = unwrapKey(wrapped);
	if (packKey.length !== KEY_LEN) throw new Error(DAMAGED);

	const indexLen = u32At(bytes, pos);
	pos += 4;
	const sealedIndex = sliceChecked(bytes, pos, indexLen);
	pos += indexLen;
	const index = decrypt(packKey, PACK_INDEX_AAD, sealedIndex);
	const body = decrypt(packKey, PACK_BODY_AAD, bytes.slice(pos));

	if (index.length < INDEX_HEADER_LEN) throw new Error(DAMAGED);
	const scopeId = index.slice(0, ID_LEN);
	const count = u32At(index, ID_LEN);
	if (index.length !== INDEX_HEADER_LEN + count * INDEX_ENTRY_LEN) throw new Error(DAMAGED);

	/** @type {Map<string, { offset: number, len: number }>} */
	const entries = new Map();
	for (let i = 0; i < count; i++) {
		const at = INDEX_HEADER_LEN + i * INDEX_ENTRY_LEN;
		const id = bytesToHex(index.slice(at, at + ID_LEN));
		const offset = u64At(index, at + ID_LEN);
		const len = u32At(index, at + ID_LEN + 8);
		if (offset + len > body.length) throw new Error(DAMAGED);
		entries.set(id, { offset, len });
	}

	return {
		scopeId,
		chunk(idBytes) {
			const entry = entries.get(bytesToHex(idBytes));
			return entry ? body.slice(entry.offset, entry.offset + entry.len) : null;
		},
	};
}

/**
 * Read a version's file list from its tree pack.
 * @param {Uint8Array} treePackBytes the tree pack, as stored on Connect
 * @param {{ treePackId: string, treeHash: Uint8Array }} snap a verified snapshot
 * @param {Uint8Array} backupKey
 * @returns {Array<{ path: string, size: number, mtime: number, chunks: Array<{ id: string, pack: string, offset: number, len: number }> }>}
 */
export function readTree(treePackBytes, snap, backupKey) {
	return readTreeWith(treePackBytes, snap, unwrapWithBackupKey(backupKey), (sealed) =>
		decrypt(backupKey, TREE_AAD, sealed),
	);
}

/**
 * Read a version's file list like readTree, with caller-supplied keys: the pack key unwrap and the
 * tree opener. Private items use this.
 * @param {Uint8Array} treePackBytes
 * @param {{ treePackId: string, treeHash: Uint8Array }} snap a verified snapshot
 * @param {(wrapped: Uint8Array) => Uint8Array} unwrapKey
 * @param {(sealed: Uint8Array) => Uint8Array} openTreeBytes returns the plain tree JSON; throws if it cannot
 * @returns {Array<{ path: string, size: number, mtime: number, chunks: Array<{ id: string, pack: string, offset: number, len: number }> }>}
 */
export function readTreeWith(treePackBytes, snap, unwrapKey, openTreeBytes) {
	const tree = readRawTreeWith(treePackBytes, snap, unwrapKey, openTreeBytes);
	try {
		const entries = tree.entries;
		if (!Array.isArray(entries)) throw new Error(DAMAGED);
		return entries.map(parseTreeEntry);
	} catch {
		throw new Error(DAMAGED);
	}
}

/**
 * Open a tree pack and return its parsed tree object, without reading the entries.
 * @param {Uint8Array} treePackBytes
 * @param {{ treePackId: string, treeHash: Uint8Array }} snap a verified snapshot
 * @param {(wrapped: Uint8Array) => Uint8Array} unwrapKey
 * @param {(sealed: Uint8Array) => Uint8Array} openTreeBytes
 * @returns {any} the parsed tree JSON, as stored
 */
export function readRawTreeWith(treePackBytes, snap, unwrapKey, openTreeBytes) {
	const pack = openPackWith(treePackBytes, snap.treePackId, unwrapKey);
	const sealed = pack.chunk(snap.treeHash);
	if (!sealed) throw new Error(DAMAGED);
	if (!sameBytes(sha256(sealed), snap.treeHash)) throw new Error(CHANGED);
	try {
		return JSON.parse(new TextDecoder().decode(openTreeBytes(sealed)));
	} catch {
		throw new Error(DAMAGED);
	}
}

/** @param {any} e */
function parseTreeEntry(e) {
	if (typeof e.path !== 'string' || !Number.isSafeInteger(e.size) || !Number.isSafeInteger(e.mtime)) {
		throw new Error(DAMAGED);
	}
	if (!Array.isArray(e.chunks)) throw new Error(DAMAGED);
	return {
		path: e.path,
		size: e.size,
		mtime: e.mtime,
		chunks: e.chunks.map((c) => {
			if (typeof c.id !== 'string' || !HEX64.test(c.id) || typeof c.pack !== 'string' || !HEX64.test(c.pack)) {
				throw new Error(DAMAGED);
			}
			if (!Number.isSafeInteger(c.offset) || !Number.isSafeInteger(c.len)) throw new Error(DAMAGED);
			return { id: c.id, pack: c.pack, offset: c.offset, len: c.len };
		}),
	};
}

/**
 * Opened-pack cache, so one pack (up to 64 MiB) is not fetched again for every chunk.
 * @param {(idHex: string) => Promise<Uint8Array>} getPack
 * @param {Uint8Array} backupKey
 * @param {number} [keep=3] how many opened packs to keep, most recently used first
 * @returns {(idHex: string) => Promise<{ scopeId: Uint8Array, chunk: (idBytes: Uint8Array) => Uint8Array | null }>}
 */
export function makePackReader(getPack, backupKey, keep = 3) {
	return makePackReaderWith(getPack, unwrapWithBackupKey(backupKey), keep);
}

/**
 * Opened-pack cache like makePackReader, with a caller-supplied pack key unwrap (see openPackWith).
 * @param {(idHex: string) => Promise<Uint8Array>} getPack
 * @param {(wrapped: Uint8Array) => Uint8Array} unwrapKey
 * @param {number} [keep=3] how many opened packs to keep, most recently used first
 * @returns {(idHex: string) => Promise<{ scopeId: Uint8Array, chunk: (idBytes: Uint8Array) => Uint8Array | null }>}
 */
export function makePackReaderWith(getPack, unwrapKey, keep = 3) {
	/** @type {Map<string, Promise<ReturnType<typeof openPackWith>>>} */
	const cache = new Map();
	return async (idHex) => {
		const hit = cache.get(idHex);
		if (hit) {
			cache.delete(idHex);
			cache.set(idHex, hit);
			return hit;
		}
		const opening = getPack(idHex).then((bytes) => openPackWith(bytes, idHex, unwrapKey));
		cache.set(idHex, opening);
		opening.catch(() => {
			if (cache.get(idHex) === opening) cache.delete(idHex);
		});
		while (cache.size > keep) cache.delete(cache.keys().next().value);
		return opening;
	};
}

/**
 * One file's bytes as a Blob. Each chunk is checked against its id before it is used.
 * @param {{ size: number, chunks: Array<{ id: string, pack: string, len: number }> }} entry
 * @param {(idHex: string) => Promise<{ chunk: (idBytes: Uint8Array) => Uint8Array | null }>} readPack
 * @param {Uint8Array} dedupKey
 * @returns {Promise<Blob>}
 */
export async function readFile(entry, readPack, dedupKey) {
	/** @type {BlobPart[]} */
	const parts = [];
	let total = 0;
	for (const chunk of entry.chunks) {
		const pack = await readPack(chunk.pack);
		const bytes = pack.chunk(hexToBytes(chunk.id));
		if (!bytes || bytes.length !== chunk.len) throw new Error(DAMAGED);
		if (bytesToHex(chunkId(dedupKey, bytes)) !== chunk.id) throw new Error(CHANGED);
		parts.push(new Uint8Array(bytes));
		total += bytes.length;
	}
	if (total !== entry.size) throw new Error(DAMAGED);
	return new Blob(parts);
}
