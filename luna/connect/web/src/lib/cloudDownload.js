import { makePackReader, readFile } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import { checkZipFits, buildZip } from "./zip.js";
import { baseName, filesUnder } from "./cloudTree.js";
import { saveBlob } from "./download.js";

/**
 * Decrypt one file of one version and save it under its own name.
 * @param {import("./cloudSource.js").CloudSource} source
 * @param {import("./cloudUnlock.js").CloudBackup} backup
 * @param {import("./cloudUnlock.js").CloudVersion} version
 * @param {{ path: string, size: number, mtime: number, chunks: Array<{ id: string, pack: string, offset: number, len: number }> }} entry
 */
export async function downloadFile(source, backup, version, entry) {
  const keys = backup.keys[version.keyVersion];
  const reader = makePackReader(source.getPack, keys.key);
  const blob = await readFile(entry, reader, keys.dedupKey);
  saveBlob(blob, baseName(entry.path));
}

/** A zip entry name must be a plain relative path: no "..", no leading "/", no backslash. */
function isSafeZipPath(path) {
  return !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

/**
 * Decrypt every file under `folder` ("" = whole backup) into one zip named "<folder name or backup name>.zip".
 * Calls checkZipFits before fetching anything; ZipTooBigError's message is the copy shown to the person.
 * @param {import("./cloudSource.js").CloudSource} source
 * @param {import("./cloudUnlock.js").CloudBackup} backup
 * @param {import("./cloudUnlock.js").CloudVersion} version
 * @param {Array<{ path: string, size: number, mtime: number, chunks: Array<{ id: string, pack: string, offset: number, len: number }> }>} entries
 * @param {string} folder
 */
export async function downloadFolder(source, backup, version, entries, folder) {
  const relative = (/** @type {string} */ path) => (folder ? path.slice(folder.length + 1) : path);
  const under = /** @type {typeof entries} */ (filesUnder(entries, folder)).filter((entry) =>
    isSafeZipPath(relative(entry.path)),
  );
  checkZipFits(under.map((entry) => ({ path: relative(entry.path), size: entry.size })));

  const keys = backup.keys[version.keyVersion];
  const reader = makePackReader(source.getPack, keys.key);
  // Read in pack order so each 32 MiB pack is fetched once, then put the files back in tree order for the zip.
  const packOf = (entry) => entry.chunks[0]?.pack ?? "";
  const byPack = [...under].sort((a, b) => packOf(a).localeCompare(packOf(b)) || a.path.localeCompare(b.path));
  const dataByPath = new Map();
  for (const entry of byPack) {
    dataByPath.set(entry.path, await readFile(entry, reader, keys.dedupKey));
  }
  const files = under.map((entry) => ({
    path: relative(entry.path),
    data: dataByPath.get(entry.path),
    mtime: entry.mtime,
  }));
  const zip = await buildZip(files);
  const name = folder ? baseName(folder) : backup.name;
  saveBlob(zip, `${name}.zip`);
}
