import { beforeEach, describe, expect, it, vi } from "vitest";
import { derive, entropyToPhrase, sign } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyPrivateScopes, PSCOPES_KIND, sealScopeSecret } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
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
const submittedBodies = [];

const hex = (value) => toBase64(hexToBytes(value));
const encodedRecordData = (data) => typeof data === "string" ? hex(data) : toBase64(data);
const priv = fixture.private;
const ctx = { lunaId: fixture.luna_id, signingPublic: hex(fixture.signing_public) };

function privateSnapshot(snapshotId, createdAt) {
  const signed = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data)));
  const record = {
    ...signed.record,
    snapshot_id: snapshotId,
    created_at: createdAt,
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

function secondPrivateSnapshot() {
  const signed = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data)));
  return privateSnapshot("fedcba9876543210fedcba9876543211", signed.record.created_at + 1);
}

/**
 * Serve the fixture's private records and tree packs through the mocked API.
 * @param {Array<{ scope: string, seal_public: string, sealed_scope_secret: string, expires_at: number }> | undefined} kept
 * @param {Array<{ name: string, data: string | Uint8Array }>} [snapshots]
 */
function serveFixture(kept, snapshots = priv.records.psnapshots) {
  getJsonMock.mockImplementation(async (path) => {
    if (path === KEPT_SCOPES_PATH) return { kept: kept ?? [] };
    const url = new URL(path, "http://luna.test");
    const recordPath = url.pathname.split("/records/")[1];
    if (recordPath === PSCOPES_KIND) {
      const after = url.searchParams.get("after");
      const allRecords = [...priv.records.pscopes].sort((a, b) => a.name.localeCompare(b.name));
      const records = allRecords.filter((r) => !after || r.name > after);
      const limit = Number(url.searchParams.get("limit") || 64);
      const page = records.slice(0, limit);
      return {
        records: page.map((r) => ({ name: r.name, data: encodedRecordData(r.data) })),
        scanned: page.length,
        total: allRecords.length,
        next_after: records.length > page.length ? page.at(-1).name : null,
        version: 0,
      };
    }
    if (recordPath.endsWith("/names")) {
      const kind = recordPath.slice(0, -"/names".length);
      const scope = url.searchParams.get("scope");
      const after = url.searchParams.get("after");
      const allRecords = (kind === "psnapshots" ? snapshots : priv.records[kind])
        .filter((r) => !scope || r.name.startsWith(`${scope}.`))
        .map((r) => r.name)
        .sort();
      const records = allRecords.filter((name) => !after || name > after);
      const total = allRecords.length;
      const page = records.slice(0, Number(url.searchParams.get("limit") || 64));
      return {
        names: page,
        total,
        next_after: records.length > page.length ? page.at(-1) : null,
        version: 0,
      };
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
    const id = path.split("/").at(-1);
    const bytes = hexToBytes(priv.packs[id]);
    return /** @type {any} */ ({ ok: true, arrayBuffer: async () => bytes.buffer });
  });
  postJsonMock.mockImplementation(async (path, body) => {
    if (path === PRIVATE_RESTORE_PATH) submittedBodies.push(JSON.parse(JSON.stringify(body)));
    return { restored: 1 };
  });
}

/** The body posted to the private restore route, one per scope. */
function restoreBodies() {
  return submittedBodies;
}

describe("privateRestore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submittedBodies.length = 0;
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

  it("continues through bounded scope pages even when a page has no caller-owned records", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const originalGet = getJsonMock.getMockImplementation();
    let scopePageCalls = 0;
    getJsonMock.mockImplementation(async (path, options) => {
      const url = new URL(path, "http://luna.test");
      if (url.pathname === `${PRIVATE_RESTORE_PATH}/records/${PSCOPES_KIND}`) {
        scopePageCalls++;
        if (scopePageCalls === 1) {
          return { records: [], scanned: 64, total: 65, next_after: "0", version: 7 };
        }
        return {
          records: priv.records.pscopes.map((record) => ({
            name: record.name,
            data: encodedRecordData(record.data),
          })),
          scanned: 1,
          total: 65,
          next_after: null,
          version: 7,
        };
      }
      return originalGet(path, options);
    });

    const result = await restorePrivateFromPhrase(phrase, ctx);

    expect(result).toEqual({ restored: 1 });
    expect(scopePageCalls).toBe(2);
    expect(restoreBodies()).toHaveLength(1);
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

    it("reports a retryable error when the kept list cannot be read", async () => {
      serveFixture();
      const base = getJsonMock.getMockImplementation();
      getJsonMock.mockImplementation(async (path) => {
        if (path === KEPT_SCOPES_PATH) throw new Error("offline");
        return base(path);
      });

      await expect(
        restorePrivateFromPhrase(entropyToPhrase(hexToBytes(fixture.bob_entropy)), ctx),
      ).rejects.toThrow("offline");
      expect(restoreBodies()).toHaveLength(0);
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

    expect(getJsonMock).toHaveBeenCalledWith(
      `${PRIVATE_RESTORE_PATH}/records/psnapshots/names?scope=${priv.scope}&limit=64`,
    );
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
      message: "Restoring version 1 of 1 in private backup 1",
    });
  });

  it("walks bounded private-name pages and retries from the first page without duplicate writes", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const signed = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data)));
    const snapshots = Array.from({ length: 65 }, (_, index) => privateSnapshot(
      (index + 1).toString(16).padStart(32, "0"),
      signed.record.created_at + index + 1,
    ));
    const orderedSnapshots = [...snapshots].sort((a, b) => a.name.localeCompare(b.name));
    serveFixture(undefined, snapshots);
    const baseGet = getJsonMock.getMockImplementation();
    const firstPagePath = `${PRIVATE_RESTORE_PATH}/records/psnapshots/names?scope=${priv.scope}&limit=64`;
    let failSecondPage = true;
    let writeCount = 0;
    getJsonMock.mockImplementation(async (path) => {
      if (path.includes("/names?") && path.includes("after=") && failSecondPage) {
        failSecondPage = false;
        throw new Error("Connect stopped responding");
      }
      return baseGet(path);
    });
    postJsonMock.mockImplementation(async (path, body) => {
      if (path === PRIVATE_RESTORE_PATH) submittedBodies.push(JSON.parse(JSON.stringify(body)));
      const restored = writeCount < 64 || writeCount === 128 ? 1 : 0;
      writeCount++;
      return { restored };
    });

    await expect(restorePrivateFromPhrase(phrase, ctx)).rejects.toThrow("Connect stopped responding");
    expect(restoreBodies()).toHaveLength(64);
    const continuation = getJsonMock.mock.calls
      .map(([path]) => new URL(path, "http://luna.test"))
      .find((url) => url.pathname.endsWith("/names") && url.searchParams.has("after"));
    expect(continuation?.searchParams.get("version")).toBe("0");
    expect(continuation?.searchParams.get("total")).toBe("65");
    expect(restoreBodies().every((body) => body.snapshots.length === 1)).toBe(true);

    const progress = vi.fn();
    await expect(restorePrivateFromPhrase(phrase, { ...ctx, onProgress: progress })).resolves.toEqual({ restored: 1 });
    expect(restoreBodies()).toHaveLength(129);
    expect(restoreBodies().every((body) => body.snapshots.length === 1)).toBe(true);
    expect(restoreBodies().map((body) => body.snapshots[0].snapshot_id)).toEqual([
      ...orderedSnapshots.slice(0, 64).map((item) => item.name.slice(priv.scope.length + 1)),
      ...orderedSnapshots.map((item) => item.name.slice(priv.scope.length + 1)),
    ]);
    expect(getJsonMock.mock.calls.filter(([path]) => path === firstPagePath)).toHaveLength(2);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      processed: 65,
      total: 65,
      snapshots: 1,
      already_indexed: 64,
      skipped: 0,
      message: "Restoring version 65 of 65 in private backup 1",
    }));
  });

  it("fails explicitly when a private inventory changes between pages without changing its total", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const signed = JSON.parse(new TextDecoder().decode(hexToBytes(priv.records.psnapshots[0].data)));
    const snapshots = Array.from({ length: 65 }, (_, index) => privateSnapshot(
      (index + 1).toString(16).padStart(32, "0"),
      signed.record.created_at + index + 1,
    ));
    serveFixture(undefined, snapshots);
    const baseGet = getJsonMock.getMockImplementation();
    getJsonMock.mockImplementation(async (path) => {
      if (path.includes("/names?") && path.includes("after=")) {
        const page = await baseGet(path);
        return { ...page, version: page.version + 1 };
      }
      return baseGet(path);
    });

    await expect(restorePrivateFromPhrase(phrase, ctx)).rejects.toThrow("private backup list changed");
    expect(restoreBodies()).toHaveLength(64);
  });

  it("stops before the next snapshot request and keeps an already committed version retryable", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const snapshots = [...priv.records.psnapshots, secondPrivateSnapshot()];
    const orderedNames = snapshots.map((item) => item.name).sort();
    const blockedName = orderedNames[1];
    serveFixture(undefined, snapshots);
    const baseGet = getJsonMock.getMockImplementation();
    let waitingForAbort;
    getJsonMock.mockImplementation((path, options) => {
      if (path.endsWith(`/records/psnapshots/${blockedName}`)) {
        return new Promise((_, reject) => {
          waitingForAbort = () => reject(new DOMException("Restore stopped", "AbortError"));
          options.signal.addEventListener("abort", waitingForAbort, { once: true });
        });
      }
      return baseGet(path, options);
    });
    const controller = new AbortController();
    const restore = restorePrivateFromPhrase(phrase, { ...ctx, signal: controller.signal });

    await vi.waitFor(() => expect(waitingForAbort).toEqual(expect.any(Function)));
    expect(restoreBodies()).toHaveLength(1);
    controller.abort();

    await expect(restore).rejects.toMatchObject({ name: "AbortError" });
    expect(restoreBodies()).toHaveLength(1);
    expect(getJsonMock).toHaveBeenCalledWith(
      expect.stringContaining(`/records/psnapshots/${blockedName}`),
      { signal: controller.signal },
    );
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
    const restoreResponses = [{ restored: 1 }, { restored: 0 }, { restored: 1 }];
    postJsonMock.mockImplementation(async (path, body) => {
      if (path === PRIVATE_RESTORE_PATH) submittedBodies.push(JSON.parse(JSON.stringify(body)));
      return restoreResponses.shift() ?? { restored: 1 };
    });

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
    const secondRecord = JSON.parse(new TextDecoder().decode(snapshots[1].data)).record;
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual([
      `${PRIVATE_RESTORE_PATH}/packs/${priv.scope}/${priv.snapshot_id}/${originalRecord.tree_pack_id}`,
      `${PRIVATE_RESTORE_PATH}/packs/${priv.scope}/${priv.snapshot_id}/${originalRecord.tree_pack_id}`,
      `${PRIVATE_RESTORE_PATH}/packs/${priv.scope}/${secondRecord.snapshot_id}/${secondRecord.tree_pack_id}`,
    ]);
    expect(progress).toHaveBeenLastCalledWith({
      processed: 2,
      total: 2,
      snapshots: 1,
      already_indexed: 1,
      skipped: 0,
      message: "Restoring version 2 of 2 in private backup 1",
    });
  });
});
