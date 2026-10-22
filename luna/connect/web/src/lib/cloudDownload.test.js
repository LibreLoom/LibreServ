import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../../crates/lunad/src/backup/cloud/fixture.json";
import { downloadFile, downloadFolder } from "./cloudDownload.js";
import { loadTree, unlockBackups } from "./cloudUnlock.js";
import { ZIP_TOO_BIG } from "./zip.js";
import { saveBlob } from "./download.js";
import { derive, entropyToPhrase, verify } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { openPrivateTreeBytes, privateOpenMessage, privateUnwrap } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { NO_KEY, readTreeWith } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import { openPrivateScope } from "./privateUnlock.js";

vi.mock("./download.js", () => ({ saveBlob: vi.fn() }));

/** A CloudSource over the Rust fixture's records and packs. */
function fixtureSource() {
  return {
    lunaId: fixture.luna_id,
    listRecords: async (kind) =>
      (fixture.records[kind] || []).map((r) => ({ name: r.name, data: hexToBytes(r.data) })),
    getPack: vi.fn(async (idHex) => hexToBytes(fixture.packs[idHex])),
  };
}

async function openFixture(source) {
  const { backups } = await unlockBackups(source, entropyToPhrase(hexToBytes(fixture.alice_entropy)));
  const [backup] = backups;
  const version = backup.versions[0];
  const entries = await loadTree(source, backup, version);
  return { backup, version, entries };
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Read a Blob's bytes in jsdom (Node's Response cannot read jsdom Blobs). */
function bytesOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  saveBlob.mockClear();
});

describe("downloadFile", () => {
  it("saves the decrypted file under its own name", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    const entry = entries.find((e) => e.path === "docs/a.txt");

    await downloadFile(source, backup, version, entry);

    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0];
    expect(name).toBe("a.txt");
    expect(toHex(await bytesOf(blob))).toBe(fixture.expected.files["docs/a.txt"]);
  });
});

describe("downloadFolder", () => {
  it("saves the whole backup as Photos.zip with both file names inside", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);

    await downloadFolder(source, backup, version, entries, "");

    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0];
    expect(name).toBe("Photos.zip");
    const text = new TextDecoder("latin1").decode(await bytesOf(blob));
    expect(text).toContain("b.bin");
    expect(text).toContain("docs/a.txt");
  });

  it("stops before any pack is fetched when the zip would be too big", async () => {
    const source = fixtureSource();
    const { backup, version } = await openFixture(source);
    source.getPack.mockClear();
    const huge = [{ path: "huge.bin", size: 0xffffffff + 1, mtime: 0, chunks: [] }];

    await expect(downloadFolder(source, backup, version, huge, "")).rejects.toThrow(ZIP_TOO_BIG);
    expect(source.getPack).not.toHaveBeenCalled();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("leaves out entries whose path would escape the zip", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    const escape = { path: "../escape.txt", size: 1, mtime: 0, chunks: [] };
    const absolute = { path: "/etc/passwd", size: 1, mtime: 0, chunks: [] };

    await downloadFolder(source, backup, version, [...entries, escape, absolute], "");

    const [blob] = saveBlob.mock.calls[0];
    const text = new TextDecoder("latin1").decode(await bytesOf(blob));
    expect(text).toContain("docs/a.txt");
    expect(text).not.toContain("escape.txt");
    expect(text).not.toContain("etc/passwd");
  });

  it("reads packs in sorted order and keeps the zip in tree order", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    source.getPack.mockClear();

    await downloadFolder(source, backup, version, entries, "");

    const packIds = source.getPack.mock.calls.map(([id]) => id);
    expect(packIds).toEqual([...packIds].sort());
    const [blob] = saveBlob.mock.calls[0];
    const text = new TextDecoder("latin1").decode(await bytesOf(blob));
    const positions = entries.map((e) => text.indexOf(e.path));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("packs sealed under older key versions", () => {
  // A new phrase starts key version N+1 and copies only changed chunks, so a file's version can name a
  // key whose packs were sealed under an older version. These tests build such a backup from the fixture.
  const wrongKey = new Uint8Array(32).fill(0x33);

  /** The fixture backup with its keys and the file's key version replaced. */
  function backupWith(backup, version, keys, keyVersion) {
    return { ...backup, keys, versions: [{ ...version, keyVersion }] };
  }

  it("downloads a file whose snapshot is key version 2 when the packs are sealed under version 1", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    const real = backup.keys[version.keyVersion];
    // Version 2 is held but is the wrong key for these packs; version 1 is the one that opens them.
    const keys = { 1: real, 2: { key: wrongKey, dedupKey: real.dedupKey } };
    const b = backupWith(backup, version, keys, 2);
    const entry = entries.find((e) => e.path === "docs/a.txt");

    await downloadFile(source, b, b.versions[0], entry);

    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0];
    expect(name).toBe("a.txt");
    expect(toHex(await bytesOf(blob))).toBe(fixture.expected.files["docs/a.txt"]);
  });

  it("refuses with a clear message, not garbage, when no held key opens the packs", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    const real = backup.keys[version.keyVersion];
    const keys = { 2: { key: wrongKey, dedupKey: real.dedupKey } };
    const b = backupWith(backup, version, keys, 2);
    const entry = entries.find((e) => e.path === "docs/a.txt");

    await expect(downloadFile(source, b, b.versions[0], entry)).rejects.toThrow(NO_KEY);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("refuses when the file's own key version is not held at all", async () => {
    const source = fixtureSource();
    const { backup, version, entries } = await openFixture(source);
    const b = backupWith(backup, version, {}, 2);
    const entry = entries.find((e) => e.path === "docs/a.txt");

    await expect(downloadFile(source, b, b.versions[0], entry)).rejects.toThrow(NO_KEY);
    expect(saveBlob).not.toHaveBeenCalled();
  });
});

describe("private backups", () => {
  const priv = fixture.private;
  const entropy = () => hexToBytes(fixture.alice_entropy);
  const scopeInfo = () => ({ scope: priv.scope, dedupKey: hexToBytes(priv.dedup_key) });

  /** A private session that opens only with alice's signed challenge; packs and records come from the fixture. */
  function privateSource() {
    const authPublic = derive(entropy(), fixture.luna_id).authPublic;
    const tokenSource = {
      lunaId: fixture.luna_id,
      listRecords: async (kind) =>
        (priv.records[kind] || []).map((r) => ({ name: r.name, data: hexToBytes(r.data) })),
      getPack: vi.fn(async (idHex) => hexToBytes(priv.packs[idHex])),
    };
    const source = {
      lunaId: fixture.luna_id,
      listRecords: vi.fn(async () => []),
      getPack: vi.fn(async () => {
        throw new Error("the shared source must not be read for a private backup");
      }),
      privateChallenge: vi.fn(async () => priv.challenge),
      privateOpen: vi.fn(async ({ scope, challenge, signature }) => {
        const ok = verify(authPublic, "private-open", privateOpenMessage(fixture.luna_id, scope, hexToBytes(challenge)), hexToBytes(signature));
        if (!ok) throw Object.assign(new Error("Bad signature."), { status: 403 });
        return { token: "tok" };
      }),
      withPrivateToken: vi.fn(() => tokenSource),
    };
    return source;
  }

  async function openPrivate(source) {
    const [backup] = await openPrivateScope(source, entropy(), fixture.luna_id, scopeInfo(), [hexToBytes(fixture.signing_public)]);
    const version = backup.versions[0];
    const { sealSecret, scope } = backup.private;
    const treeBytes = await backup.private.source.getPack(version.treePackId);
    const entries = readTreeWith(
      treeBytes,
      { treePackId: version.treePackId, treeHash: version.treeHash },
      privateUnwrap(sealSecret, fixture.luna_id, scope),
      openPrivateTreeBytes(sealSecret, fixture.luna_id, scope),
    );
    return { backup, version, entries };
  }

  it("downloads docs/a.txt from the private fixture with the fixture's bytes", async () => {
    const source = privateSource();
    const { backup, version, entries } = await openPrivate(source);
    const entry = entries.find((e) => e.path === "docs/a.txt");
    expect(entry).toBeDefined();

    await downloadFile(source, backup, version, entry);

    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0];
    expect(name).toBe("a.txt");
    expect(toHex(await bytesOf(blob))).toBe(priv.expected.files["docs/a.txt"]);
    expect(source.getPack).not.toHaveBeenCalled();
  });
});
