import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import fixture from '../../../../luna/crates/lunad/src/backup/cloud/fixture.json';
import {
	CHANGED,
	DAMAGED,
	MissingKeyError,
	NO_KEY,
	PACK_BODY_AAD,
	PACK_INDEX_AAD,
	PACK_KEY_WRAP_AAD,
	decryptMeta,
	makePackReader,
	makePackReaderForVersions,
	openPack,
	openPackWith,
	readFile,
	readRawTreeWith,
	readTree,
	verifySnapshot,
} from './cloudFormat.js';
import { decrypt } from './backupCrypto.js';

// Count decrypt calls so the ordering test can see which key is tried first. Otherwise passthrough.
vi.mock('./backupCrypto.js', async (importOriginal) => {
	const actual = /** @type {typeof import('./backupCrypto.js')} */ (await importOriginal());
	return { ...actual, decrypt: vi.fn(actual.decrypt) };
});

const lunaId = fixture.luna_id;
const signingPublic = hexToBytes(fixture.signing_public);
const backupKey = hexToBytes(fixture.backup_key);
const dedupKey = hexToBytes(fixture.dedup_key);
const dataPackHex = fixture.data_pack_id;
const treePackHex = fixture.tree_pack_id;
const dataPack = hexToBytes(fixture.packs[dataPackHex]);
const treePack = hexToBytes(fixture.packs[treePackHex]);
const snapBytes = hexToBytes(fixture.records.snapshots[0].data);
const wrongKey = new Uint8Array(32).fill(0x33);

/** @param {Uint8Array} data @param {number} index */
function flipByte(data, index) {
	const out = data.slice();
	out[index] ^= 0x01;
	return out;
}

/** The snapshot's JSON with one field changed, re-encoded (signature left alone). */
function editSnapshot(edit) {
	const signed = JSON.parse(new TextDecoder().decode(snapBytes));
	edit(signed.record);
	return new TextEncoder().encode(JSON.stringify(signed));
}

/** @param {string} idHex */
const packsByHex = (idHex) => Promise.resolve(hexToBytes(fixture.packs[idHex]));

describe('cloudFormat', () => {
	it('verifySnapshot accepts the fixture snapshot and rejects a changed or foreign one', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		expect(snap).not.toBeNull();
		expect(snap.treePackId).toBe(treePackHex);
		expect(snap.keyVersion).toBe(fixture.key_version);

		const changed = editSnapshot((rec) => {
			rec.created_at += 1;
		});
		expect(verifySnapshot(changed, [signingPublic], lunaId)).toBeNull();
		expect(verifySnapshot(snapBytes, [signingPublic], 'other-luna')).toBeNull();
	});

	it('verifySnapshot needs the private-snapshot domain for a private psnapshot', () => {
		const privateSnap = hexToBytes(fixture.private.records.psnapshots[0].data);
		const signingPublics = [signingPublic];
		expect(verifySnapshot(privateSnap, signingPublics, lunaId)).toBeNull();
		expect(verifySnapshot(privateSnap, signingPublics, lunaId, 'private-snapshot')).not.toBeNull();
	});

	it('decryptMeta returns the backup name and who started it, in camelCase', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		expect(decryptMeta(snap.meta, backupKey)).toEqual({
			name: fixture.expected.meta.name,
			sourceDrive: fixture.expected.meta.source_drive,
			sourcePath: fixture.expected.meta.source_path,
			startedBy: fixture.expected.meta.started_by,
			startedByName: fixture.expected.meta.started_by_name,
		});
	});

	it('openPack opens the data pack, throws CHANGED for a flipped byte and DAMAGED for the wrong key', () => {
		const pack = openPack(dataPack, dataPackHex, backupKey);
		expect(bytesToHex(pack.scopeId).slice(0, 32)).toBe(fixture.scope_tag);
		pack.dispose();

		expect(() => openPack(flipByte(dataPack, 10), dataPackHex, backupKey)).toThrow(CHANGED);
		expect(() => openPack(dataPack, dataPackHex, new Uint8Array(32).fill(0x33))).toThrow(DAMAGED);
	});

	it('clears an unwrapped pack key after opening or rejecting a pack', () => {
		const openedKeys = [];
		const unwrap = (wrapped) => {
			const key = decrypt(backupKey, PACK_KEY_WRAP_AAD, wrapped);
			openedKeys.push(key);
			return key;
		};

		openPackWith(dataPack, dataPackHex, unwrap);
		expect(openedKeys).toHaveLength(1);
		const openedKey = openedKeys[0];
		expect(Array.from(openedKey)).toEqual(new Array(openedKey.length).fill(0));

		const damagedPack = dataPack.slice();
		damagedPack[damagedPack.length - 1] ^= 1;
		const damagedKeys = [];
		expect(() =>
			openPackWith(damagedPack, bytesToHex(sha256(damagedPack)), (wrapped) => {
				const key = decrypt(backupKey, PACK_KEY_WRAP_AAD, wrapped);
				damagedKeys.push(key);
				return key;
			}),
		).toThrow(DAMAGED);
		expect(damagedKeys).toHaveLength(1);
		const damagedKey = damagedKeys[0];
		expect(Array.from(damagedKey)).toEqual(new Array(damagedKey.length).fill(0));
	});

	it('clears decrypted pack index and body on disposal and on open failure', () => {
		vi.mocked(decrypt).mockClear();
		const pack = openPack(dataPack, dataPackHex, backupKey);
		const outputs = vi.mocked(decrypt).mock.results.map((result) => result.value);
		const index = outputs[vi.mocked(decrypt).mock.calls.findIndex(([, aad]) => aad === PACK_INDEX_AAD)];
		const body = outputs[vi.mocked(decrypt).mock.calls.findIndex(([, aad]) => aad === PACK_BODY_AAD)];
		expect(Array.from(index)).toEqual(new Array(index.length).fill(0));
		expect(body.some((byte) => byte !== 0)).toBe(true);
		const scopeId = pack.scopeId;
		pack.dispose();
		pack.dispose();
		expect(Array.from(body)).toEqual(new Array(body.length).fill(0));
		expect(Array.from(scopeId)).toEqual(new Array(scopeId.length).fill(0));
		expect(() => pack.chunk(new Uint8Array(32))).toThrow(DAMAGED);

		vi.mocked(decrypt).mockClear();
		const damagedPack = dataPack.slice();
		damagedPack[damagedPack.length - 1] ^= 1;
		expect(() => openPackWith(damagedPack, bytesToHex(sha256(damagedPack)), (wrapped) =>
			decrypt(backupKey, PACK_KEY_WRAP_AAD, wrapped),
		)).toThrow(DAMAGED);
		const failedIndex = vi.mocked(decrypt).mock.results[
			vi.mocked(decrypt).mock.calls.findIndex(([, aad]) => aad === PACK_INDEX_AAD)
		].value;
		expect(Array.from(failedIndex)).toEqual(new Array(failedIndex.length).fill(0));
	});

	it('readTree lists docs/a.txt and b.bin', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		const tree = readTree(treePack, snap, backupKey);
		const paths = tree.map((e) => e.path).sort();
		expect(paths).toEqual(['b.bin', 'docs/a.txt']);
	});

	it('clears opened tree bytes after parsing the tree', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		const plaintext = new TextEncoder().encode('{"entries":[]}');
		readRawTreeWith(
			treePack,
			snap,
			(wrapped) => decrypt(backupKey, PACK_KEY_WRAP_AAD, wrapped),
			() => plaintext,
		);
		expect(Array.from(plaintext)).toEqual(new Array(plaintext.length).fill(0));
	});

	it('readFile returns the expected bytes, and CHANGED with the wrong dedup key', async () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		const tree = readTree(treePack, snap, backupKey);
		const readPack = (idHex) => openPack(hexToBytes(fixture.packs[idHex]), idHex, backupKey);
		const readPackAsync = async (idHex) => readPack(idHex);

		for (const entry of tree) {
			const blob = await readFile(entry, readPackAsync, dedupKey);
			const got = new Uint8Array(await blob.arrayBuffer());
			expect(got).toEqual(hexToBytes(fixture.expected.files[entry.path]));
		}

		const [first] = tree;
		await expect(readFile(first, readPackAsync, new Uint8Array(32).fill(0x44))).rejects.toThrow(CHANGED);
	});

	it('makePackReader fetches and opens a pack once for two reads', async () => {
		let calls = 0;
		const getPack = (idHex) => {
			calls++;
			return packsByHex(idHex);
		};
		const reader = makePackReader(getPack, backupKey);
		const a = await reader(dataPackHex);
		const b = await reader(dataPackHex);
		expect(calls).toBe(1);
		expect(a).not.toBe(b);
		a.release();
		b.release();
		await reader.dispose();
	});

	it('reader disposal clears cached plaintext and waits for outstanding leases', async () => {
		vi.mocked(decrypt).mockClear();
		const reader = makePackReader(async (idHex) => hexToBytes(fixture.packs[idHex]), backupKey);
		const lease = await reader(dataPackHex);
		const bodyIndex = vi.mocked(decrypt).mock.calls.findIndex(([, aad]) => aad === PACK_BODY_AAD);
		const body = vi.mocked(decrypt).mock.results[bodyIndex].value;
		const cleanup = reader.dispose();
		expect(body.some((byte) => byte !== 0)).toBe(true);
		lease.release();
		await cleanup;
		expect(Array.from(body)).toEqual(new Array(body.length).fill(0));
		await expect(reader(dataPackHex)).rejects.toThrow(DAMAGED);
	});

	it('zeroes evicted packs after outstanding readers release them, including in-flight opens', async () => {
		vi.mocked(decrypt).mockClear();
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		if (!snap) throw new Error('the fixture snapshot did not verify');
		const dataChunk = readTree(treePack, snap, backupKey)
			.flatMap((entry) => entry.chunks)
			.find((chunk) => chunk.pack === dataPackHex);
		if (!dataChunk) throw new Error('the fixture tree has no chunk in the data pack');
		const dataChunkId = hexToBytes(dataChunk.id);
		// Tree discovery opens the tree pack; observe only plaintext opened by the reader below.
		vi.mocked(decrypt).mockClear();
		const reader = makePackReader(
			async (idHex) => hexToBytes(fixture.packs[idHex]),
			backupKey,
			1,
		);
		const first = await reader(dataPackHex);
		const secondReader = await reader(dataPackHex);
		let bodyIndex = vi.mocked(decrypt).mock.calls.findIndex(([, aad]) => aad === PACK_BODY_AAD);
		let firstBody = vi.mocked(decrypt).mock.results[bodyIndex].value;
		const second = await reader(treePackHex);
		const firstChunk = first.chunk(dataChunkId);
		expect(firstChunk).not.toBeNull();
		firstChunk?.fill(0);
		expect(firstBody.some((byte) => byte !== 0)).toBe(true);
		first.release();
		expect(firstBody.some((byte) => byte !== 0)).toBe(true);
		const secondChunk = secondReader.chunk(dataChunkId);
		expect(secondChunk).not.toBeNull();
		secondChunk?.fill(0);
		secondReader.release();
		second.release();
		await reader.dispose();
		expect(Array.from(firstBody)).toEqual(new Array(firstBody.length).fill(0));

		vi.mocked(decrypt).mockClear();
		/** @type {((bytes: Uint8Array) => void) | undefined} */
		let resolveFirst;
		const delayedReader = makePackReader(
			(idHex) =>
				idHex === dataPackHex
					? new Promise((resolve) => {
							resolveFirst = resolve;
						})
					: Promise.resolve(hexToBytes(fixture.packs[idHex])),
			backupKey,
			1,
		);
		const pendingFirst = delayedReader(dataPackHex);
		const secondReady = await delayedReader(treePackHex);
		if (!resolveFirst) throw new Error('the first pack did not start loading');
		resolveFirst(hexToBytes(fixture.packs[dataPackHex]));
		const firstReady = await pendingFirst;
		bodyIndex = vi.mocked(decrypt).mock.calls.map(([, aad]) => aad).lastIndexOf(PACK_BODY_AAD);
		firstBody = vi.mocked(decrypt).mock.results[bodyIndex].value;
		expect(firstBody.some((byte) => byte !== 0)).toBe(true);
		firstReady.release();
		secondReady.release();
		await delayedReader.dispose();
		expect(Array.from(firstBody)).toEqual(new Array(firstBody.length).fill(0));
	});

	describe('makePackReaderForVersions', () => {
		beforeEach(() => {
			vi.mocked(decrypt).mockClear();
		});

		/** The keys tried to unwrap a pack key, in order. Index and body decrypts are left out. */
		const unwrapKeysTried = () =>
			vi.mocked(decrypt).mock.calls.filter(([, aad]) => aad === PACK_KEY_WRAP_AAD).map(([key]) => key);

		/** Read every file of the fixture through a reader, and compare to the fixture's bytes. */
		async function expectFixtureFiles(reader) {
			const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
			const tree = readTree(treePack, snap, backupKey);
			for (const entry of tree) {
				const blob = await readFile(entry, reader, dedupKey);
				expect(new Uint8Array(await blob.arrayBuffer())).toEqual(hexToBytes(fixture.expected.files[entry.path]));
			}
		}

		it('opens a pack sealed with v1 when the snapshot is key version 2 and both keys are held', async () => {
			// Version 2 is listed first and is the wrong key for this pack, so the reader must fall back to version 1.
			const reader = makePackReaderForVersions(packsByHex, {
				1: { key: backupKey },
				2: { key: wrongKey },
			});
			const pack = await reader(dataPackHex);
			expect(bytesToHex(pack.scopeId).slice(0, 32)).toBe(fixture.scope_tag);
			await expectFixtureFiles(reader);
		});

		it('throws MissingKeyError, not garbage, when no held key opens the pack', async () => {
			const reader = makePackReaderForVersions(packsByHex, {
				1: { key: wrongKey },
				2: { key: new Uint8Array(32).fill(0x44) },
			});
			await expect(reader(dataPackHex)).rejects.toBeInstanceOf(MissingKeyError);
			await expect(reader(dataPackHex)).rejects.toThrow(NO_KEY);
		});

		it('throws MissingKeyError when no keys are held at all', async () => {
			const reader = makePackReaderForVersions(packsByHex, {});
			await expect(reader(dataPackHex)).rejects.toThrow(NO_KEY);
		});

		it('throws CHANGED for a tampered pack even with several keys held', async () => {
			const tampered = flipByte(dataPack, 10);
			const reader = makePackReaderForVersions(
				(idHex) => Promise.resolve(tampered),
				{ 1: { key: backupKey }, 2: { key: wrongKey } },
			);
			await expect(reader(dataPackHex)).rejects.toThrow(CHANGED);
		});

		it('tries the newest key version first', async () => {
			const reader = makePackReaderForVersions(packsByHex, {
				1: { key: wrongKey },
				2: { key: backupKey },
			});
			await reader(dataPackHex);
			// Version 2's key opens the pack on the first try, so version 1 is never tried.
			const tried = unwrapKeysTried();
			expect(tried).toHaveLength(1);
			expect(tried[0]).toBe(backupKey);
		});

		it('falls back to an older key only after the newer one fails', async () => {
			const reader = makePackReaderForVersions(packsByHex, {
				1: { key: backupKey },
				2: { key: wrongKey },
			});
			await reader(dataPackHex);
			const tried = unwrapKeysTried();
			expect(tried).toHaveLength(2);
			expect(tried[0]).toBe(wrongKey);
			expect(tried[1]).toBe(backupKey);
		});

		it('with one key, opens the pack the same way as makePackReader', async () => {
			const single = makePackReaderForVersions(packsByHex, { 1: { key: backupKey } });
			const legacy = makePackReader(packsByHex, backupKey);
			const a = await single(dataPackHex);
			const b = await legacy(dataPackHex);
			expect(bytesToHex(a.scopeId)).toBe(bytesToHex(b.scopeId));
			await expectFixtureFiles(single);
		});

		it('fetches and opens a pack once for two reads', async () => {
			let calls = 0;
			const getPack = (idHex) => {
				calls++;
				return packsByHex(idHex);
			};
			const reader = makePackReaderForVersions(getPack, { 1: { key: backupKey }, 2: { key: wrongKey } });
			const a = await reader(dataPackHex);
			const b = await reader(dataPackHex);
			expect(calls).toBe(1);
			const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
			if (!snap) throw new Error('the fixture snapshot did not verify');
			const dataChunk = readTree(treePack, snap, backupKey)
				.flatMap((entry) => entry.chunks)
				.find((chunk) => chunk.pack === dataPackHex);
			if (!dataChunk) throw new Error('the fixture tree has no chunk in the data pack');
			const dataChunkId = hexToBytes(dataChunk.id);
			const aBytes = a.chunk(dataChunkId);
			const bBytes = b.chunk(dataChunkId);
			expect(aBytes).not.toBeNull();
			expect(bBytes).toEqual(aBytes);
			aBytes?.fill(0);
			bBytes?.fill(0);
			a.release();
			expect(() => a.chunk(dataChunkId)).toThrow(DAMAGED);
			const bAfterRelease = b.chunk(dataChunkId);
			expect(bAfterRelease).not.toBeNull();
			bAfterRelease?.fill(0);
			b.release();
			await reader.dispose();
		});
	});
});
