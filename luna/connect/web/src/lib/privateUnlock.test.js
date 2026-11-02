import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { derive, verify } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyPrivateScopes, privateOpenMessage } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import fixture from "../../../../crates/lunad/src/backup/cloud/fixture.json";
import { openPrivateScope, unlockPrivate } from "./privateUnlock.js";

const priv = fixture.private;
const entropy = () => hexToBytes(fixture.alice_entropy);
const signingPublics = () => [hexToBytes(fixture.signing_public)];
// The scope's own key, opened from the phrase the way the browser does it.
const scopeInfo = () =>
  findMyPrivateScopes({
    lunaId: fixture.luna_id,
    entropy: entropy(),
    pscopes: [{ name: priv.scope, data: hexToBytes(priv.records.pscopes[0].data) }],
    signingPublics: signingPublics(),
  })[0];

/**
 * A CloudSource whose private session opens only with a valid signature from alice's auth key.
 * Shared records are empty; the private records and packs come from the Rust fixture.
 */
function privateSource({ openError = null } = {}) {
  const authPublic = derive(entropy(), fixture.luna_id).authPublic;
  const tokenSource = {
    lunaId: fixture.luna_id,
    listRecords: vi.fn(async (kind) =>
      (priv.records[kind] || []).map((r) => ({ name: r.name, data: hexToBytes(r.data) })),
    ),
    getPack: vi.fn(async (idHex) => hexToBytes(priv.packs[idHex])),
    privateChallenge: vi.fn(),
    privateOpen: vi.fn(),
    withPrivateToken: vi.fn(),
  };
  const source = {
    lunaId: fixture.luna_id,
    listRecords: vi.fn(async () => []),
    getPack: vi.fn(),
    privateChallenge: vi.fn(async () => priv.challenge),
    privateOpen: vi.fn(async ({ scope, challenge, signature }) => {
      if (openError) throw openError;
      const ok = verify(authPublic, "private-open", privateOpenMessage(fixture.luna_id, scope, hexToBytes(challenge)), hexToBytes(signature));
      if (!ok) throw Object.assign(new Error("Bad signature."), { status: 403 });
      return { token: "tok", expiresAt: 1700001800 };
    }),
    withPrivateToken: vi.fn((token) => (token === "tok" ? tokenSource : source)),
  };
  return source;
}

describe("openPrivateScope", () => {
  it("opens the scope with a signed challenge and returns one private backup named Diary", async () => {
    const source = privateSource();
    const backups = await openPrivateScope(source, entropy(), fixture.luna_id, scopeInfo(), signingPublics());
    expect(source.privateChallenge).toHaveBeenCalledTimes(1);
    expect(source.privateOpen).toHaveBeenCalledTimes(1);
    expect(backups).toHaveLength(1);
    const [backup] = backups;
    expect(backup.name).toBe("Diary");
    expect(backup.protectionId).toBe(priv.protection_id);
    expect(backup.startedBy).toBe(priv.owner_user_id);
    expect(backup.versions).toHaveLength(1);
    expect(backup.versions[0].snapshotId).toBe(priv.snapshot_id);
    expect(backup.private.scope).toBe(priv.scope);
    expect(backup.private.sealSecret).toHaveLength(96);
    expect(backup.private.dedupKey).toEqual(hexToBytes(priv.dedup_key));
  });

  it("reads snapshots through the token source, not the account source", async () => {
    const source = privateSource();
    const [backup] = await openPrivateScope(source, entropy(), fixture.luna_id, scopeInfo(), signingPublics());
    expect(source.withPrivateToken).toHaveBeenCalledWith("tok");
    expect(source.listRecords).not.toHaveBeenCalled();
    expect(backup.private.source.listRecords).toBeDefined();
  });

  it("keeps the server's sentence on a 403", async () => {
    const source = privateSource({ openError: Object.assign(new Error("Not allowed."), { status: 403 }) });
    await expect(openPrivateScope(source, entropy(), fixture.luna_id, scopeInfo(), signingPublics())).rejects.toThrow(
      "Not allowed.",
    );
  });

  it("uses the private fallback sentence for other session failures", async () => {
    const source = privateSource({ openError: Object.assign(new Error("boom"), { status: 500 }) });
    await expect(openPrivateScope(source, entropy(), fixture.luna_id, scopeInfo(), signingPublics())).rejects.toThrow(
      "Could not open your private items. Try again.",
    );
  });
});

describe("unlockPrivate", () => {
  it("opens every scope and flattens the backups", async () => {
    const source = privateSource();
    const backups = await unlockPrivate(source, entropy(), fixture.luna_id, [scopeInfo()], signingPublics());
    expect(backups.map((b) => b.name)).toEqual(["Diary"]);
  });

  it("returns no backups when the phrase owns no private scopes", async () => {
    const source = privateSource();
    expect(await unlockPrivate(source, entropy(), fixture.luna_id, [], signingPublics())).toEqual([]);
    expect(source.privateChallenge).not.toHaveBeenCalled();
  });
});
