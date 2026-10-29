import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import fixture from '../../../../luna/crates/lunad/src/backup/cloud/fixture.json';
import { CHANGED, DAMAGED, makePackReaderWith, readFile, readTreeWith, verifySnapshot } from './cloudFormat.js';
import { derive } from './backupCrypto.js';
import {
	findMyPrivateScopes,
	openPrivateMeta,
	openPrivateTreeBytes,
	openScopeSecret,
	PRIVATE_SNAPSHOT_DOMAIN,
	privateUnwrap,
	readPrivateSnapshots,
	scopeOf,
	sealScopeSecret,
	signPrivateOpen,
	verifyScopeRecord,
} from './cloudPrivate.js';

const lunaId = fixture.luna_id;
const p = fixture.private;
const signingPublic = hexToBytes(fixture.signing_public);
const aliceEntropy = hexToBytes(fixture.alice_entropy);
const bobEntropy = hexToBytes(fixture.bob_entropy);
const alice = derive(aliceEntropy, lunaId);
const bob = derive(bobEntropy, lunaId);
// Everything private is sealed to the scope's own key; the phrase only opens that key.
const scopeSecret = openScopeSecret(
	verifyScopeRecord(hexToBytes(p.records.pscopes[0].data), [hexToBytes(fixture.signing_public)], lunaId).sealedScopeSecret,
	alice.sealSecret,
	lunaId,
	p.scope,
);
const dedupKey = hexToBytes(p.dedup_key);
const challenge = hexToBytes(p.challenge);
const records = (list) => list.map((r) => ({ name: r.name, data: hexToBytes(r.data) }));
const pscopes = records(p.records.pscopes);
const psnapshots = records(p.records.psnapshots);
const snapBytes = psnapshots[0].data;
const packBytes = (idHex) => hexToBytes(p.packs[idHex]);

/** @param {Uint8Array} data @param {number} index */
function flipByte(data, index) {
	const out = data.slice();
	out[index] ^= 0x01;
	return out;
}

/** Flip the first hex digit of a record's JSON signature. */
function flipSignature(data) {
	const text = new TextDecoder().decode(data);
	const marker = '"signature":"';
	return flipByte(data, text.indexOf(marker) + marker.length);
}

describe('cloudPrivate', () => {
	it('scopeOf derives the fixture scope from the dedup key', () => {
		expect(scopeOf(dedupKey)).toBe(p.scope);
	});

	it('verifyScopeRecord accepts the fixture scope record and rejects a changed one', () => {
		const rec = verifyScopeRecord(pscopes[0].data, [signingPublic], lunaId);
		expect(rec).not.toBeNull();
		expect(rec.scope).toBe(p.scope);
		expect(rec.userId).toBe(p.owner_user_id);

		expect(verifyScopeRecord(flipSignature(pscopes[0].data), [signingPublic], lunaId)).toBeNull();
		expect(verifyScopeRecord(flipByte(pscopes[0].data, 40), [signingPublic], lunaId)).toBeNull();
		expect(verifyScopeRecord(pscopes[0].data, [signingPublic], 'other-luna')).toBeNull();
	});

	it('findMyPrivateScopes returns the fixture scope for its owner, with the scope key', () => {
		const found = findMyPrivateScopes({ lunaId, entropy: aliceEntropy, pscopes, signingPublics: [signingPublic] });
		expect(found).toHaveLength(1);
		expect(found[0].scope).toBe(p.scope);
		expect(found[0].userId).toBe(p.owner_user_id);
		expect(bytesToHex(found[0].dedupKey)).toBe(p.dedup_key);
		expect(found[0].sealSecret).toEqual(scopeSecret);
	});

	it('openScopeSecret opens with the owner phrase only, and only for its own scope', () => {
		const sealed = verifyScopeRecord(pscopes[0].data, [signingPublic], lunaId).sealedScopeSecret;
		expect(openScopeSecret(sealed, alice.sealSecret, lunaId, p.scope)).toEqual(scopeSecret);
		expect(() => openScopeSecret(sealed, bob.sealSecret, lunaId, p.scope)).toThrow(DAMAGED);
		expect(() => openScopeSecret(sealed, alice.sealSecret, lunaId, 'ffffffffffffffffffffffffffffffff')).toThrow(DAMAGED);
	});

	it('the phrase key cannot open the snapshot details, only the scope key can', () => {
		const sealedMeta = verifySnapshot(snapBytes, [signingPublic], lunaId, PRIVATE_SNAPSHOT_DOMAIN).meta;
		expect(() => openPrivateMeta(sealedMeta, alice.sealSecret, lunaId, p.scope)).toThrow(DAMAGED);
		expect(() => openPrivateMeta(sealedMeta, scopeSecret, lunaId, p.scope)).not.toThrow();
	});

	it('a re-sealed scope secret opens with the new phrase and not the old one', () => {
		const next = derive(bobEntropy, lunaId);
		const resealed = sealScopeSecret(scopeSecret, next.sealPublic, lunaId, p.scope);
		expect(openScopeSecret(resealed, next.sealSecret, lunaId, p.scope)).toEqual(scopeSecret);
		expect(() => openScopeSecret(resealed, alice.sealSecret, lunaId, p.scope)).toThrow(DAMAGED);
	});

	it('findMyPrivateScopes returns nothing for another phrase', () => {
		expect(findMyPrivateScopes({ lunaId, entropy: bobEntropy, pscopes, signingPublics: [signingPublic] })).toEqual([]);
	});

	it('readPrivateSnapshots returns the fixture snapshot with its expected meta', () => {
		const snaps = readPrivateSnapshots({
			lunaId,
			sealSecret: scopeSecret,
			scope: p.scope,
			psnapshots,
			signingPublics: [signingPublic],
		});
		expect(snaps).toHaveLength(1);
		expect(snaps[0].snapshotId).toBe(p.snapshot_id);
		expect(snaps[0].meta).toEqual({
			name: p.expected.meta.name,
			sourceDrive: p.expected.meta.source_drive,
			sourcePath: p.expected.meta.source_path,
			startedBy: p.expected.meta.started_by,
			startedByName: p.expected.meta.started_by_name,
		});
	});

	it('readPrivateSnapshots needs the scope key: the phrase key alone opens nothing', () => {
		expect(
			readPrivateSnapshots({ lunaId, sealSecret: alice.sealSecret, scope: p.scope, psnapshots, signingPublics: [signingPublic] }),
		).toEqual([]);
	});

	it('verifySnapshot accepts a private snapshot only under the private domain', () => {
		expect(verifySnapshot(snapBytes, [signingPublic], lunaId)).toBeNull();
		expect(verifySnapshot(snapBytes, [signingPublic], lunaId, PRIVATE_SNAPSHOT_DOMAIN)).not.toBeNull();
	});

	it('readPrivateSnapshots leaves out a snapshot that bob cannot open', () => {
		const snaps = readPrivateSnapshots({
			lunaId,
			sealSecret: bob.sealSecret,
			scope: p.scope,
			psnapshots,
			signingPublics: [signingPublic],
		});
		expect(snaps).toEqual([]);
	});

	it('openPrivateMeta throws DAMAGED with the wrong scope', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId, PRIVATE_SNAPSHOT_DOMAIN);
		expect(() => openPrivateMeta(snap.meta, scopeSecret, lunaId, 'ffffffffffffffffffffffffffffffff')).toThrow(
			DAMAGED,
		);
	});

	it('readTreeWith reads the private tree and files through the private keys', async () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId, PRIVATE_SNAPSHOT_DOMAIN);
		const unwrap = privateUnwrap(scopeSecret, lunaId, p.scope);
		const tree = readTreeWith(packBytes(p.tree_pack_id), snap, unwrap, openPrivateTreeBytes(scopeSecret, lunaId, p.scope));
		expect(tree.map((e) => e.path).sort()).toEqual(['b.bin', 'docs/a.txt']);

		const readPack = makePackReaderWith(async (idHex) => packBytes(idHex), unwrap);
		for (const entry of tree) {
			const blob = await readFile(entry, readPack, dedupKey);
			const got = new Uint8Array(await blob.arrayBuffer());
			expect(got).toEqual(hexToBytes(p.expected.files[entry.path]));
		}
	});

	it('readTreeWith throws CHANGED for a flipped tree pack byte', () => {
		const snap = verifySnapshot(snapBytes, [signingPublic], lunaId, PRIVATE_SNAPSHOT_DOMAIN);
		const unwrap = privateUnwrap(scopeSecret, lunaId, p.scope);
		expect(() =>
			readTreeWith(flipByte(packBytes(p.tree_pack_id), 60), snap, unwrap, openPrivateTreeBytes(scopeSecret, lunaId, p.scope)),
		).toThrow(CHANGED);
	});

	it('signPrivateOpen signs the fixture challenge the same way as the Rust side', () => {
		const sig = signPrivateOpen(alice.authSecret, lunaId, p.scope, challenge);
		expect(sig).toHaveLength(64);
		expect(bytesToHex(sig)).toBe(p.open_signature);
	});
});
