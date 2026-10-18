import { beforeEach, describe, expect, it, vi } from "vitest";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../crates/lunad/src/backup/cloud/fixture.json";
import { apiFetch, getJson, postJson } from "./api";
import { toBase64 } from "./cloudPhrase";
import {
  getPrivateRestoreStatus,
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
const priv = fixture.private;
const ctx = { lunaId: fixture.luna_id, signingPublic: hex(fixture.signing_public) };

/** Serve the fixture's private records and tree packs through the mocked API. */
function serveFixture() {
  getJsonMock.mockImplementation(async (path) => {
    const kind = path.split("/records/")[1];
    return { records: priv.records[kind].map((r) => ({ name: r.name, data: hex(r.data) })) };
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

  it("reads the private restore status", async () => {
    getJsonMock.mockResolvedValueOnce({ needed: true, luna_id: "x", signing_public: "y", scopes: 1 });

    await expect(getPrivateRestoreStatus()).resolves.toMatchObject({ needed: true });
    expect(getJsonMock).toHaveBeenCalledWith(PRIVATE_RESTORE_PATH);
  });
});
