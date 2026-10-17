import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { NO_BACKUPS } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import fixture from "../../../../crates/lunad/src/backup/cloud/fixture.json";
import { groupByStarter, loadTree, unlockBackups } from "./cloudUnlock.js";

/** A CloudSource over the Rust fixture's records and packs. */
function fixtureSource(records = fixture.records) {
  return {
    lunaId: fixture.luna_id,
    listRecords: vi.fn(async (kind) =>
      (records[kind] || []).map((r) => ({ name: r.name, data: hexToBytes(r.data) })),
    ),
    getPack: vi.fn(async (idHex) => hexToBytes(fixture.packs[idHex])),
  };
}

const alicePhrase = () => entropyToPhrase(hexToBytes(fixture.alice_entropy));

describe("unlockBackups", () => {
  it("opens the alice phrase's backup with one version", async () => {
    const { userIds, backups } = await unlockBackups(fixtureSource(), alicePhrase());
    expect(userIds).toContain(fixture.alice_user_id);
    expect(backups).toHaveLength(1);
    const [backup] = backups;
    expect(backup.protectionId).toBe(fixture.protection_id);
    expect(backup.name).toBe("Photos");
    expect(backup.startedBy).toBe("alice");
    expect(backup.startedByName).toBe("Alice");
    expect(backup.versions).toHaveLength(1);
    expect(backup.keys[fixture.key_version]).toBeDefined();
  });

  it("keeps the backup when requireLatest is set, since alice has the latest key version", async () => {
    const { backups } = await unlockBackups(fixtureSource(), alicePhrase(), { requireLatest: true });
    expect(backups).toHaveLength(1);
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
    await expect(unlockBackups(fixtureSource(records), alicePhrase())).rejects.toThrow(NO_BACKUPS);
  });

  it("throws NO_BACKUPS for a valid phrase that opens nothing on this Luna", async () => {
    const phrase = entropyToPhrase(new Uint8Array(16));
    await expect(unlockBackups(fixtureSource(), phrase)).rejects.toThrow(NO_BACKUPS);
  });
});

describe("groupByStarter", () => {
  it("groups one backup under its starter's name", async () => {
    const { backups } = await unlockBackups(fixtureSource(), alicePhrase());
    const groups = groupByStarter(backups);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Alice");
    expect(groups[0].startedBy).toBe("alice");
    expect(groups[0].backups).toHaveLength(1);
  });
});

describe("loadTree", () => {
  it("lists the two files in the fixture version", async () => {
    const source = fixtureSource();
    const { backups } = await unlockBackups(source, alicePhrase());
    const [backup] = backups;
    const entries = await loadTree(source, backup, backup.versions[0]);
    expect(entries.map((e) => e.path).sort()).toEqual(["b.bin", "docs/a.txt"]);
  });
});
