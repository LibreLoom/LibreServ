import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { NO_BACKUPS } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import fixture from "../../../../crates/lunad/src/backup/cloud/fixture.json";
import { groupByStarter, loadTree, unlockBackups } from "./cloudUnlock.js";

const PRIVATE = fixture.private;

/**
 * A CloudSource over the Rust fixture's records and packs. Private scopes (pscopes, psnapshots,
 * private packs) are served too unless `withPrivate` is false, which hides them as if none existed.
 */
function fixtureSource(records = fixture.records, { withPrivate = true } = {}) {
  const packs = { ...fixture.packs, ...(withPrivate ? PRIVATE.packs : {}) };
  const served = (set) =>
    vi.fn(async (kind) => (set[kind] || []).map((r) => ({ name: r.name, data: hexToBytes(r.data) })));
  const privateRecords = withPrivate ? PRIVATE.records : {};
  const privateSource = {
    lunaId: fixture.luna_id,
    listRecords: served(privateRecords),
    getPack: vi.fn(async (idHex) => hexToBytes(packs[idHex])),
  };
  return {
    lunaId: fixture.luna_id,
    listRecords: served({ ...records, pscopes: privateRecords.pscopes || [] }),
    getPack: vi.fn(async (idHex) => hexToBytes(packs[idHex])),
    privateChallenge: vi.fn(async () => PRIVATE.challenge),
    privateOpen: vi.fn(async () => ({ token: "fixture-token" })),
    withPrivateToken: vi.fn(() => privateSource),
  };
}

const alicePhrase = () => entropyToPhrase(hexToBytes(fixture.alice_entropy));
const sharedOf = (backups) => backups.filter((b) => !b.private);
const privateOf = (backups) => backups.filter((b) => b.private);

describe("unlockBackups", () => {
  it("opens the alice phrase's shared backup with one version", async () => {
    const { userIds, backups } = await unlockBackups(fixtureSource(), alicePhrase());
    expect(userIds).toContain(fixture.alice_user_id);
    const [backup] = sharedOf(backups);
    expect(sharedOf(backups)).toHaveLength(1);
    expect(backup.protectionId).toBe(fixture.protection_id);
    expect(backup.name).toBe("Photos");
    expect(backup.startedBy).toBe("alice");
    expect(backup.startedByName).toBe("Alice");
    expect(backup.versions).toHaveLength(1);
    expect(backup.keys[fixture.key_version]).toBeDefined();
  });

  it("opens the alice phrase's private backup and lists alice as a private owner", async () => {
    const { backups, privateOwners } = await unlockBackups(fixtureSource(), alicePhrase());
    expect(privateOf(backups)).toHaveLength(1);
    expect(privateOf(backups)[0].private.scope).toBe(PRIVATE.scope);
    expect(privateOwners).toEqual([PRIVATE.owner_user_id]);
  });

  it("keeps the shared backup when requireLatest is set, since alice has the latest key version", async () => {
    const { backups } = await unlockBackups(fixtureSource(), alicePhrase(), { requireLatest: true });
    expect(sharedOf(backups)).toHaveLength(1);
  });

  it("skips a snapshot whose signature is flipped, so nothing opens and it throws NO_BACKUPS", async () => {
    const snapshot = JSON.parse(new TextDecoder().decode(hexToBytes(fixture.records.snapshots[0].data)));
    const sig = snapshot.signature;
    snapshot.signature = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const records = {
      ...fixture.records,
      snapshots: [{ name: fixture.records.snapshots[0].name, data: hex }],
    };
    await expect(unlockBackups(fixtureSource(records, { withPrivate: false }), alicePhrase())).rejects.toThrow(
      NO_BACKUPS,
    );
  });

  it("opens a private backup when the phrase has no shared keys at all", async () => {
    const records = { self: fixture.records.self, recipients: fixture.records.recipients };
    const { backups, privateOwners } = await unlockBackups(fixtureSource(records), alicePhrase());
    expect(sharedOf(backups)).toHaveLength(0);
    expect(privateOf(backups)).toHaveLength(1);
    expect(privateOwners).toEqual([PRIVATE.owner_user_id]);
  });

  it("throws NO_BACKUPS for a valid phrase that opens nothing on this Luna", async () => {
    const phrase = entropyToPhrase(new Uint8Array(16));
    await expect(unlockBackups(fixtureSource(), phrase)).rejects.toThrow(NO_BACKUPS);
  });
});

describe("groupByStarter", () => {
  it("groups alice's shared and private backups under her name, marked as hers", async () => {
    const { backups, privateOwners } = await unlockBackups(fixtureSource(), alicePhrase());
    const groups = groupByStarter(backups, privateOwners);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Alice");
    expect(groups[0].startedBy).toBe("alice");
    expect(groups[0].backups).toHaveLength(2);
    expect(groups[0].privateRow).toBe("mine");
  });

  it("adds an 'Another person on this Luna' group for a private owner with no backups opened", () => {
    const groups = groupByStarter([], ["bob"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Another person on this Luna");
    expect(groups[0].startedBy).toBe("bob");
    expect(groups[0].backups).toHaveLength(0);
    expect(groups[0].privateRow).toBe("other");
  });

  it("leaves privateRow null for a shared-only starter", async () => {
    const { backups } = await unlockBackups(fixtureSource(fixture.records, { withPrivate: false }), alicePhrase());
    const groups = groupByStarter(backups);
    expect(groups[0].privateRow).toBeNull();
  });
});

describe("loadTree", () => {
  it("lists the two files in the shared fixture version", async () => {
    const source = fixtureSource();
    const { backups } = await unlockBackups(source, alicePhrase());
    const [backup] = sharedOf(backups);
    const entries = await loadTree(source, backup, backup.versions[0]);
    expect(entries.map((e) => e.path).sort()).toEqual(["b.bin", "docs/a.txt"]);
  });

  it("lists the files of the private fixture version through the private token source", async () => {
    const source = fixtureSource();
    const { backups } = await unlockBackups(source, alicePhrase());
    const [backup] = privateOf(backups);
    const entries = await loadTree(source, backup, backup.versions[0]);
    expect(entries.map((e) => e.path).sort()).toEqual(Object.keys(PRIVATE.expected.files).sort());
    expect(backup.private.source.getPack).toHaveBeenCalled();
  });
});
