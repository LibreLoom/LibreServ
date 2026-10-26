import { beforeEach, describe, expect, it, vi } from "vitest";
import { derive, entropyToPhrase, sign } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyPrivateScopes, sealScopeSecret } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../crates/lunad/src/backup/cloud/fixture.json";
import { apiFetch, getJson, postJson } from "./api";
import { toBase64 } from "./cloudPhrase";
import { snapshotSignedBytes } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import {
  getPrivateRestoreStatus,
  KEPT_SCOPES_PATH,
  PRIVATE_RESTORE_PATH,
  restorePrivateFromPhrase,
} from "./privateRestore";

vi.mock("./api", () => ({
  apiFetch: vi.fn(),
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);
const getJsonMock = vi.mocked(getJson);
const postJsonMock = vi.mocked(postJson);

const hex = (value) => toBase64(hexToBytes(value));
const encodedRecordData = (data) => typeof data === "string" ? hex(data) : toBase64(data);
const priv = fixture.private;
const ctx = { lunaId: fixture.luna_id, signingPublic: hex(fixture.signing_public) };

function secondPrivateSnapshot() {
  const signed = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data)));
  const record = {
    ...signed.record,
    snapshot_id: "fedcba9876543210fedcba9876543211",
    created_at: signed.record.created_at + 1,
  };
  const msg = snapshotSignedBytes({
    lunaId: record.luna_id,
    protectionId: record.protection_id,
    snapshotId: record.snapshot_id,
    createdAt: record.created_at,
    keyVersion: record.key_version,
    treePackId: record.tree_pack_id,
    treeHash: hexToBytes(record.tree_hash),
    meta: hexToBytes(record.meta),
  });
  const seed = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
  const bytes = new TextEncoder().encode(JSON.stringify({
    record,
    signature: bytesToHex(sign(seed, "private-snapshot", msg)),
  }));
  return { name: `${priv.scope}.${record.snapshot_id}`, data: bytes };
}

/** Serve the fixture's private records and tree packs through the mocked API. */
function serveFixture(kept, snapshots = priv.records.psnapshots) {
  getJsonMock.mockImplementation(async (path) => {
    if (path === KEPT_SCOPES_PATH) return { kept: kept ?? [] };
    const recordPath = path.split("/records/")[1];
    if (recordPath.endsWith("/names")) {
      const kind = recordPath.slice(0, -"/names".length);
      const records = kind === "psnapshots" ? snapshots : priv.records[kind];
      return { names: records.map((r) => r.name) };
    }
    const [kind, name] = recordPath.split("/");
    if (name) {
      const records = kind === "psnapshots" ? snapshots : priv.records[kind];
      const record = records.find((r) => r.name === decodeURIComponent(name));
      if (!record) throw new Error("record missing");
      return { name: record.name, data: encodedRecordData(record.data) };
    }
    const records = kind === "psnapshots" ? snapshots : priv.records[kind];
    return { records: records.map((r) => ({ name: r.name, data: encodedRecordData(r.data) })) };
  });
  apiFetchMock.mockImplementation(async (path) => {
    const id = path.split("/packs/")[1];
    const bytes = hexToBytes(priv.packs[id]);
    return /** @type {any} */ ({ ok: true, arrayBuffer: async () => bytes.buffer });
  });
  postJsonMock.mockResolvedValue({ restored: 1 });
}

/** The body posted to the private restore route, one per scope. */
function restoreBodies() {
  return postJsonMock.mock.calls.filter(([path]) => path === PRIVATE_RESTORE_PATH).map(([, body]) => body);
}

describe("privateRestore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serveFixture();
  });

  it("opens alice's phrase and posts one body with the fixture scope, dedup key and tree", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));

    const result = await restorePrivateFromPhrase(phrase, ctx);

    expect(result).toEqual({ restored: 1 });
    const bodies = restoreBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].scope).toBe(priv.scope);
    expect(bodies[0].dedup_key).toBe(hex(priv.dedup_key));
    expect(bodies[0].snapshots).toHaveLength(1);
    const [snap] = bodies[0].snapshots;
    expect(snap.snapshot_id).toBe(priv.snapshot_id);
    expect(snap.protection_id).toBe(priv.protection_id);
    expect(snap.meta).toEqual({
      name: fixture.private.expected.meta.name,
      source_drive: fixture.private.expected.meta.source_drive,
      source_path: fixture.private.expected.meta.source_path,
    });
    expect(snap.tree.entries).toHaveLength(2);
    const names = JSON.stringify(snap.tree);
    for (const file of Object.keys(priv.expected.files)) expect(names).toContain(file);
  });

  it("never sends the phrase or the entropy in the body", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));

    await restorePrivateFromPhrase(phrase, ctx);

    const sent = JSON.stringify(restoreBodies());
    expect(sent).not.toContain(phrase);
    expect(sent).not.toContain(fixture.alice_entropy);
  });

  it("throws the plain sentence for bob's phrase and posts nothing", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.bob_entropy));

    await expect(restorePrivateFromPhrase(phrase, ctx)).rejects.toThrow(
      "This recovery phrase doesn't open any private backups on this Luna. Check each word.",
    );
    expect(restoreBodies()).toHaveLength(0);
  });

  describe("the kept copy after a phrase change", () => {
    /** A kept copy of the fixture scope's secret, sealed to bob's phrase (the "old" phrase here). */
    function keptForBob() {
      const [mine] = findMyPrivateScopes({
        lunaId: fixture.luna_id,
        entropy: hexToBytes(fixture.alice_entropy),
        pscopes: priv.records.pscopes.map((r) => ({ name: r.name, data: hexToBytes(r.data) })),
        signingPublics: [hexToBytes(fixture.signing_public)],
      });
      const bob = derive(hexToBytes(fixture.bob_entropy), fixture.luna_id);
      const sealed = sealScopeSecret(mine.sealSecret, bob.sealPublic, fixture.luna_id, priv.scope);
      return [{ scope: priv.scope, seal_public: toBase64(bob.sealPublic), sealed_scope_secret: toBase64(sealed), expires_at: 1 }];
    }

    it("restores with the old phrase from the kept copy when the current one does not open", async () => {
      serveFixture(keptForBob());

      const result = await restorePrivateFromPhrase(entropyToPhrase(hexToBytes(fixture.bob_entropy)), ctx);

      expect(result).toEqual({ restored: 1 });
      expect(restoreBodies()[0].scope).toBe(priv.scope);
      expect(restoreBodies()[0].dedup_key).toBe(hex(priv.dedup_key));
    });

    it("does not let a kept copy open for a different phrase", async () => {
      serveFixture(keptForBob());
      const stranger = entropyToPhrase(new Uint8Array(16).fill(9));

      await expect(restorePrivateFromPhrase(stranger, ctx)).rejects.toThrow("doesn't open any private backups");
      expect(restoreBodies()).toHaveLength(0);
    });

    it("restores each scope once when the current copy already opens", async () => {
      serveFixture(keptForBob());

      await restorePrivateFromPhrase(entropyToPhrase(hexToBytes(fixture.alice_entropy)), ctx);

      expect(restoreBodies()).toHaveLength(1);
    });

    it("carries on without a fallback when the kept list cannot be read", async () => {
      serveFixture();
      const base = getJsonMock.getMockImplementation();
      getJsonMock.mockImplementation(async (path) => {
        if (path === KEPT_SCOPES_PATH) throw new Error("offline");
        return base(path);
      });

      await expect(
        restorePrivateFromPhrase(entropyToPhrase(hexToBytes(fixture.bob_entropy)), ctx),
      ).rejects.toThrow("doesn't open any private backups");
    });
  });

  it("reads the private restore status", async () => {
    getJsonMock.mockResolvedValueOnce({ needed: true, luna_id: "x", signing_public: "y", scopes: 1 });

    await expect(getPrivateRestoreStatus()).resolves.toMatchObject({ needed: true });
    expect(getJsonMock).toHaveBeenCalledWith(PRIVATE_RESTORE_PATH);
  });

  it("fetches each signed snapshot separately and reports bounded progress", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const progress = vi.fn();

    await restorePrivateFromPhrase(phrase, { ...ctx, onProgress: progress });

    expect(getJsonMock).toHaveBeenCalledWith(`${PRIVATE_RESTORE_PATH}/records/psnapshots/names`);
    expect(getJsonMock).toHaveBeenCalledWith(
      `${PRIVATE_RESTORE_PATH}/records/psnapshots/${priv.records.psnapshots[0].name}`,
    );
    expect(restoreBodies()).toHaveLength(1);
    expect(restoreBodies()[0].snapshots).toHaveLength(1);
    expect(progress).toHaveBeenLastCalledWith({
      processed: 1,
      total: 1,
      snapshots: 1,
      already_indexed: 0,
      skipped: 0,
    });
  });

  it("keeps each private write bounded and retries a later provider failure without duplicates", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const snapshots = [...priv.records.psnapshots, secondPrivateSnapshot()];
    const secondName = snapshots[1].name;
    serveFixture(undefined, snapshots);
    const getJsonBase = getJsonMock.getMockImplementation();
    let failSecondRead = true;
    getJsonMock.mockImplementation(async (path) => {
      if (path.endsWith(`/records/psnapshots/${secondName}`) && failSecondRead) {
        failSecondRead = false;
        throw new Error("Connect stopped responding");
      }
      return getJsonBase(path);
    });
    postJsonMock
      .mockResolvedValueOnce({ restored: 1 })
      .mockResolvedValueOnce({ restored: 0 })
      .mockResolvedValueOnce({ restored: 1 });

    await expect(restorePrivateFromPhrase(phrase, ctx)).rejects.toThrow("Connect stopped responding");
    expect(restoreBodies()).toHaveLength(1);
    expect(restoreBodies()[0].snapshots).toHaveLength(1);

    const progress = vi.fn();
    await expect(restorePrivateFromPhrase(phrase, { ...ctx, onProgress: progress })).resolves.toEqual({ restored: 1 });

    const bodies = restoreBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.snapshots.length === 1)).toBe(true);
    expect(bodies.map((body) => body.snapshots[0].snapshot_id)).toEqual([
      priv.snapshot_id,
      priv.snapshot_id,
      snapshots[1].name.slice(priv.scope.length + 1),
    ]);
    const originalRecord = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data))).record;
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual([
      `${PRIVATE_RESTORE_PATH}/packs/${originalRecord.tree_pack_id}`,
      `${PRIVATE_RESTORE_PATH}/packs/${originalRecord.tree_pack_id}`,
      `${PRIVATE_RESTORE_PATH}/packs/${originalRecord.tree_pack_id}`,
    ]);
    expect(progress).toHaveBeenLastCalledWith({
      processed: 2,
      total: 2,
      snapshots: 1,
      already_indexed: 1,
      skipped: 0,
    });
  });
});
