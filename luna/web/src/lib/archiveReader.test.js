import { describe, expect, it } from "vitest";
import { isImageEntryName, listTarEntries, listZipEntries } from "./archiveReader.js";

/** Build a tiny stored (method 0) zip with one file. */
function buildStoredZip(name, content) {
  const nameBytes = new TextEncoder().encode(name);
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.length, true);
  eocdView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out.buffer;
}

describe("archiveReader", () => {
  it("lists stored zip entries", () => {
    const buf = buildStoredZip("hello.txt", "hi");
    const entries = listZipEntries(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("hello.txt");
    expect(entries[0].size).toBe(2);
  });

  it("lists ustar entries", () => {
    const block = new Uint8Array(512 + 512);
    const name = "readme.txt";
    for (let i = 0; i < name.length; i += 1) block[i] = name.charCodeAt(i);
    const size = "00000000005";
    for (let i = 0; i < size.length; i += 1) block[124 + i] = size.charCodeAt(i);
    block[156] = "0".charCodeAt(0);
    block.set(new TextEncoder().encode("hello"), 512);
    const entries = listTarEntries(block.buffer);
    expect(entries.some((e) => e.name === "readme.txt")).toBe(true);
  });

  it("detects image entry names", () => {
    expect(isImageEntryName("pages/1.jpg")).toBe(true);
    expect(isImageEntryName("pages/")).toBe(false);
  });
});
