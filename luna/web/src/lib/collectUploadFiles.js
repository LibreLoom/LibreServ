/**
 * Collect File objects for upload from a file input or a drag-and-drop
 * DataTransfer, including files inside dropped folders (via webkitGetAsEntry).
 */

/**
 * @param {FileSystemEntry} entry
 * @param {string} prefix
 * @returns {Promise<File[]>}
 */
function readEntry(entry, prefix = "") {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      /** @type {FileSystemFileEntry} */ (entry).file((file) => {
        const relative = prefix ? `${prefix}/${file.name}` : file.name;
        try {
          Object.defineProperty(file, "webkitRelativePath", {
            configurable: true,
            value: relative,
          });
        } catch {
          // Some environments freeze File; name alone still works.
        }
        resolve([file]);
      }, reject);
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const dir = /** @type {FileSystemDirectoryEntry} */ (entry);
    const reader = dir.createReader();
    /** @type {File[][]} */
    const batches = [];
    const nextPrefix = prefix ? `${prefix}/${dir.name}` : dir.name;

    function readBatch() {
      reader.readEntries(async (entries) => {
        if (!entries.length) {
          resolve((await Promise.all(batches)).flat());
          return;
        }
        batches.push(
          Promise.all(entries.map((child) => readEntry(child, nextPrefix))).then((parts) =>
            parts.flat(),
          ),
        );
        readBatch();
      }, reject);
    }

    readBatch();
  });
}

/**
 * @param {FileList|File[]|null|undefined} list
 * @returns {File[]}
 */
export function filesFromFileList(list) {
  return Array.from(list || []).filter((f) => f && typeof f.size === "number");
}

/**
 * Prefer DataTransferItemList so dropped folders expand to their files.
 * Falls back to DataTransfer.files when entries are unavailable.
 *
 * @param {DataTransfer|null|undefined} dataTransfer
 * @returns {Promise<File[]>}
 */
export async function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    /** @type {Promise<File[]>[]} */
    const jobs = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry) {
        jobs.push(readEntry(entry));
        continue;
      }
      const file = item.getAsFile();
      if (file) jobs.push(Promise.resolve([file]));
    }
    if (jobs.length) {
      const nested = (await Promise.all(jobs)).flat();
      if (nested.length) return nested;
    }
  }
  return filesFromFileList(dataTransfer.files);
}

/**
 * Destination folder + leaf name for an upload, honoring webkitRelativePath
 * when the user dropped a folder tree.
 *
 * @param {string} destFolder
 * @param {File} file
 * @returns {{ destPath: string, name: string }}
 */
export function uploadDestForFile(destFolder, file) {
  const relative = String(file.webkitRelativePath || file.name || "").replace(/^\/+/, "");
  const parts = relative.split("/").filter(Boolean);
  const name = parts.pop() || file.name || "file";
  const nested = parts.join("/");
  const destPath = nested
    ? destFolder
      ? `${destFolder}/${nested}`
      : nested
    : destFolder || "";
  return { destPath, name };
}
