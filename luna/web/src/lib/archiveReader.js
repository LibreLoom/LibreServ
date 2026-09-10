/**
 * Minimal ZIP / TAR readers for archive listing and comic/epub pages.
 * No third-party deps — covers the common local cases Luna needs.
 */

/**
 * @param {ArrayBuffer} buf
 * @returns {{ name: string, size: number, offset: number, compressedSize: number, method: number }[]}
 */
export function listZipEntries(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This zip file looks damaged.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  /** @type {{ name: string, size: number, offset: number, compressedSize: number, method: number }[]} */
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    entries.push({ name, size, offset: localOffset, compressedSize, method });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * @param {ArrayBuffer} buf
 * @param {{ name: string, size: number, offset: number, compressedSize: number, method: number }} entry
 * @returns {Promise<Uint8Array>}
 */
export async function readZipEntry(buf, entry) {
  const view = new DataView(buf);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new Error("This zip entry looks damaged.");
  }
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const compressed = new Uint8Array(buf, dataStart, entry.compressedSize);
  if (entry.method === 0) return compressed.slice();
  if (entry.method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot unpack zip compression.");
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error("This zip uses a compression Luna cannot open yet.");
}

/**
 * @param {ArrayBuffer} buf
 * @returns {{ name: string, size: number }[]}
 */
export function listTarEntries(buf) {
  const bytes = new Uint8Array(buf);
  /** @type {{ name: string, size: number }[]} */
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const name = asciiField(block, 0, 100).replace(/\0+$/, "");
    const sizeOctal = asciiField(block, 124, 12).trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = block[156];
    if (name) {
      const isDir = typeFlag === 53 || name.endsWith("/");
      entries.push({
        name: isDir ? `${name.replace(/\/?$/, "/")}` : name,
        size,
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * @param {Uint8Array} block
 * @param {number} start
 * @param {number} len
 */
function asciiField(block, start, len) {
  let s = "";
  for (let i = start; i < start + len; i += 1) {
    const c = block[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** @param {string} name */
export function isImageEntryName(name) {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name) && !name.endsWith("/");
}
