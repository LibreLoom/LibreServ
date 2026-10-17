// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ZIP_MAX_BYTES,
  ZIP_MAX_FILES,
  ZipTooBigError,
  buildZip,
  checkZipFits,
  crc32,
} from "./zip.js";

const utf8 = (text) => new TextEncoder().encode(text);

/** Read a zip Blob back: end record, then central directory, then each local header and data. */
async function parseZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const decode = (start, length) => new TextDecoder().decode(bytes.subarray(start, start + length));
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    const flags = view.getUint16(pos + 8, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const localOffset = view.getUint32(pos + 42, true);
    const path = decode(pos + 46, nameLength);

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLength;
    const data = bytes.slice(dataStart, dataStart + size);
    entries.push({ path, flags, crc, size, nameLength, localOffset, data });
    pos += 46 + nameLength;
  }
  return { count, entries };
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("continues from a previous value", () => {
    const whole = utf8("hello world");
    const first = crc32(whole.subarray(0, 5));
    expect(crc32(whole.subarray(5), first)).toBe(crc32(whole));
  });
});

describe("buildZip", () => {
  it("writes two files that read back intact", async () => {
    const zip = await buildZip([
      { path: "a.txt", data: utf8("hello"), mtime: 1700000000 },
      { path: "dir/b.txt", data: utf8("world"), mtime: 1700000000 },
    ]);
    expect(zip.type).toBe("application/zip");

    const { count, entries } = await parseZip(zip);
    expect(count).toBe(2);
    expect(entries.map((e) => e.path)).toEqual(["a.txt", "dir/b.txt"]);
    expect(entries.map((e) => e.size)).toEqual([5, 5]);
    expect(entries[0].crc).toBe(crc32(utf8("hello")));
    expect(entries[1].crc).toBe(crc32(utf8("world")));
    expect(new TextDecoder().decode(entries[0].data)).toBe("hello");
    expect(new TextDecoder().decode(entries[1].data)).toBe("world");
    expect(entries[0].localOffset).toBe(0);
    expect(entries[1].localOffset).toBe(30 + "a.txt".length + 5);
  });

  it("accepts Blob data", async () => {
    const zip = await buildZip([
      { path: "blob.txt", data: new Blob([utf8("from a blob")]), mtime: 1700000000 },
    ]);
    const { entries } = await parseZip(zip);
    expect(new TextDecoder().decode(entries[0].data)).toBe("from a blob");
    expect(entries[0].crc).toBe(crc32(utf8("from a blob")));
  });

  it("marks UTF-8 names and writes the byte length of the name", async () => {
    const zip = await buildZip([{ path: "café.txt", data: utf8("x"), mtime: 1700000000 }]);
    const { entries } = await parseZip(zip);
    expect(entries[0].flags & 0x0800).toBe(0x0800);
    expect(entries[0].nameLength).toBe(utf8("café.txt").length);
    expect(entries[0].nameLength).toBe(9);
    expect(entries[0].path).toBe("café.txt");
  });
});

describe("checkZipFits", () => {
  it("refuses more files than the zip format allows", () => {
    const files = Array.from({ length: ZIP_MAX_FILES + 1 }, () => ({ path: "f", size: 0 }));
    expect(() => checkZipFits(files)).toThrow(ZipTooBigError);
  });

  it("refuses one file as large as the zip limit", () => {
    expect(() => checkZipFits([{ path: "huge.bin", size: 0xffffffff }])).toThrow(ZipTooBigError);
    expect(ZIP_MAX_BYTES).toBe(0xffffffff);
  });

  it("accepts a small folder", () => {
    expect(() => checkZipFits([{ path: "a.txt", size: 5 }])).not.toThrow();
  });
});
