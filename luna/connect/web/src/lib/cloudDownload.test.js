import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../../crates/lunad/src/backup/cloud/fixture.json";
import { downloadFile, downloadFolder } from "./cloudDownload.js";
import { loadTree, unlockBackups } from "./cloudUnlock.js";
import { ZIP_TOO_BIG } from "./zip.js";
import { saveBlob } from "./download.js";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";

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
});
