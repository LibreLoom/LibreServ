import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import fixture from '../../../../luna/crates/lunad/src/backup/cloud/fixture.json';
import {
	findMyKeys,
	NO_BACKUPS,
	parseKeyName,
	SIGNING_MISMATCH,
	userRecordPart,
	verifyRecipients,
} from './cloudKeys.js';

/** @param {Array<{ name: string, data: string }>} list */
const records = (list) => list.map((r) => ({ name: r.name, data: hexToBytes(r.data) }));

const lunaId = fixture.luna_id;
const prot = fixture.protection_id;
const aliceEntropy = hexToBytes(fixture.alice_entropy);
const bobEntropy = hexToBytes(fixture.bob_entropy);
const signingPublic = hexToBytes(fixture.signing_public);

/** Records as Connect serves them, decoded from the fixture. */
const all = () => ({
	self: records(fixture.records.self),
	recipients: records(fixture.records.recipients),
	keys: records(fixture.records.keys),
});

/**
 * Flip the first hex digit of a record's JSON signature, keeping the record valid JSON.
 * @param {Uint8Array} data
 * @returns {Uint8Array<ArrayBuffer>}
 */
function flipRecipientsSig(data) {
	const parsed = JSON.parse(new TextDecoder().decode(data));
	const first = parsed.signature[0] === '0' ? '1' : '0';
	parsed.signature = first + parsed.signature.slice(1);
	return new Uint8Array(new TextEncoder().encode(JSON.stringify(parsed)));
}

/** @param {Uint8Array} data @param {number} index */
function flipByte(data, index) {
	const out = data.slice();
	out[index] ^= 0x01;
	return out;
}

describe('cloudKeys', () => {
	it('userRecordPart matches the alice record name in the fixture', () => {
		const aliceKey = parseKeyName(fixture.records.keys[0].name);
		expect(userRecordPart('alice')).toBe(aliceKey.part);
		expect(userRecordPart('alice')).toBe(fixture.records.self[0].name);
	});

	it('findMyKeys opens the fixture keys for alice', () => {
		const found = findMyKeys({ lunaId, entropy: aliceEntropy, ...all() });
		expect(found.keys).toHaveLength(1);
		expect(found.keys[0].protectionId).toBe(prot);
		expect(found.keys[0].version).toBe(fixture.key_version);
		expect(found.keys[0].userId).toBe('alice');
		expect(found.keys[0].key).toEqual(hexToBytes(fixture.backup_key));
		expect(found.keys[0].dedupKey).toEqual(hexToBytes(fixture.dedup_key));
		expect(found.userIds).toEqual(['alice']);
		expect(found.signingPublics[0]).toEqual(signingPublic);
		expect(found.latestVersion[prot]).toBe(2);
	});

	it('findMyKeys throws SIGNING_MISMATCH when the expected signing key differs', () => {
		expect(() =>
			findMyKeys({
				lunaId,
				entropy: aliceEntropy,
				...all(),
				expectSigningPublic: new Uint8Array(32).fill(0x01),
			}),
		).toThrow(SIGNING_MISMATCH);
	});

	it('findMyKeys throws NO_BACKUPS when a recipients signature is flipped', () => {
		const set = all();
		set.recipients = set.recipients.map((r) => ({ name: r.name, data: flipRecipientsSig(r.data) }));
		expect(() => findMyKeys({ lunaId, entropy: aliceEntropy, ...set })).toThrow(NO_BACKUPS);
	});

	it('findMyKeys throws NO_BACKUPS when alice key copy is changed', () => {
		const set = all();
		const aliceName = `${prot}.${fixture.key_version}.${userRecordPart('alice')}`;
		set.keys = set.keys.map((r) => (r.name === aliceName ? { name: r.name, data: flipByte(r.data, 0) } : r));
		expect(() => findMyKeys({ lunaId, entropy: aliceEntropy, ...set })).toThrow(NO_BACKUPS);
	});

	it('findMyKeys throws NO_BACKUPS for bob entropy, which has no self record', () => {
		expect(() => findMyKeys({ lunaId, entropy: bobEntropy, ...all() })).toThrow(NO_BACKUPS);
	});

	it('findMyKeys also reports the private scope for alice and keeps her shared keys', () => {
		const pscopes = records(fixture.private.records.pscopes);
		const found = findMyKeys({ lunaId, entropy: aliceEntropy, ...all(), pscopes });
		expect(found.privateScopes).toHaveLength(1);
		expect(found.privateScopes[0].scope).toBe(fixture.private.scope);
		expect(found.keys).toHaveLength(1);
		expect(found.keys[0].key).toEqual(hexToBytes(fixture.backup_key));
	});

	it('findMyKeys returns no shared keys, without throwing, for a private-only user', () => {
		const pscopes = records(fixture.private.records.pscopes);
		const self = records(fixture.records.self);
		const found = findMyKeys({ lunaId, entropy: aliceEntropy, self, recipients: [], keys: [], pscopes });
		expect(found.keys).toEqual([]);
		expect(found.privateScopes).toHaveLength(1);
	});

	it('verifyRecipients returns the signed users in order', () => {
		const users = verifyRecipients(
			records(fixture.records.recipients)[0].data,
			signingPublic,
			lunaId,
			prot,
			fixture.key_version,
		);
		expect(users).toEqual(['alice', 'bob']);
	});
});
