/**
 * Store-only ZIP writer (no compression, no ZIP64), built in browser memory.
 * File data stays in Blob parts; only one file is read into memory at a time.
 */

/** 4 GiB minus 1: the zip format's own limit without ZIP64. */
export const ZIP_MAX_BYTES = 0xffffffff;
export const ZIP_MAX_FILES = 65535;
export const ZIP_TOO_BIG = "This folder is too big to download as one zip (over 4 GB or 65,535 files). Open it and download smaller folders or single files.";

export class ZipTooBigError extends Error {
  constructor() {
    super(ZIP_TOO_BIG);
    this.name = "ZipTooBigError";
  }
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const encoder = new TextEncoder();

/**
 * Standard CRC-32 (IEEE, reflected). Pass the previous value to continue.
 *
 * @param {Uint8Array} bytes
 * @param {number} [previous]
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes, previous = 0) {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Throws ZipTooBigError when the files can't fit one zip.
 *
 * @param {Array<{ path: string, size: number }>} files
 */
export function checkZipFits(files) {
  if (files.length > ZIP_MAX_FILES) throw new ZipTooBigError();
  let total = 22;
  for (const file of files) {
    const nameBytes = encoder.encode(file.path).length;
    total += file.size + (30 + nameBytes) + (46 + nameBytes);
    if (total > ZIP_MAX_BYTES) throw new ZipTooBigError();
  }
}

/**
 * DOS time and date for a unix-seconds mtime, in local time.
 * Years before 1980 become 1980-01-01 00:00.
 *
 * @param {number} mtime
 */
function dosTimeDate(mtime) {
  const date = new Date(mtime * 1000);
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/**
 * Build the zip.
 *
 * @param {Array<{ path: string, data: Uint8Array | Blob, mtime: number }>} files
 * @returns {Promise<Blob>} a Blob of type application/zip
 */
export async function buildZip(files) {
  checkZipFits(
    files.map((file) => {
      const data = /** @type {{ size?: number, byteLength: number }} */ (/** @type {unknown} */ (file.data));
      return {
        path: file.path,
        size: typeof data.size === "number" ? data.size : data.byteLength,
      };
    }),
  );

  /** @type {BlobPart[]} */
  const parts = [];
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer());
    const size = bytes.byteLength;
    const crc = crc32(bytes);
    const { time, date } = dosTimeDate(file.mtime);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_SIG, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const header = new Uint8Array(local.buffer);
    parts.push(header, name, /** @type {BlobPart} */ (file.data));

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, CENTRAL_SIG, true);
    entry.setUint16(4, VERSION, true);
    entry.setUint16(6, VERSION, true);
    entry.setUint16(8, UTF8_FLAG, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true);
    entry.setUint16(32, 0, true);
    entry.setUint16(34, 0, true);
    entry.setUint16(36, 0, true);
    entry.setUint32(38, 0, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(/** @type {ArrayBuffer} */ (entry.buffer)), name);

    offset += header.byteLength + name.byteLength + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_SIG, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
    type: "application/zip",
  });
}
