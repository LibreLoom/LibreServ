import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import fixture from '../../../../luna/crates/lunad/src/backup/cloud/fixture.json';
import { CHANGED, DAMAGED, decryptMeta, makePackReader, openPack, readFile, readTree, verifySnapshot } from './cloudFormat.js';

const lunaId = fixture.luna_id;
const signingPublic = hexToBytes(fixture.signing_public);
const backupKey = hexToBytes(fixture.backup_key);
const dedupKey = hexToBytes(fixture.dedup_key);
const dataPackHex = fixture.data_pack_id;
const treePackHex = fixture.tree_pack_id;
const dataPack = hexToBytes(fixture.packs[dataPackHex]);
const treePack = hexToBytes(fixture.packs[treePackHex]);
const snapBytes = hexToBytes(fixture.records.snapshots[0].data);

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

		expect(() => openPack(flipByte(dataPack, 10), dataPackHex, backupKey)).toThrow(CHANGED);
		expect(() => openPack(dataPack, dataPackHex, new Uint8Array(32).fill(0x33))).toThrow(DAMAGED);
	});

	it('readTree lists docs/a.txt and b.bin', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId);
		const tree = readTree(treePack, snap, backupKey);
		const paths = tree.map((e) => e.path).sort();
		expect(paths).toEqual(['b.bin', 'docs/a.txt']);
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
		expect(a).toBe(b);
	});
});
