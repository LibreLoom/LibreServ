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
    /** @type {Promise<File[]>[]} */
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

/**
 * @typedef {{ entries: FileSystemEntry[], files: File[] }} DroppedItems
 *   What a drop held. `entries` are files and folders the browser can walk;
 *   `files` are plain Files (browsers or inputs without entry support).
 */

/**
 * Read a drop into walkable pieces. Call it synchronously inside the `drop`
 * event: `webkitGetAsEntry` and `getAsFile` only work while the event runs.
 * The walk itself (`walkDropped`) can happen later.
 *
 * @param {DataTransfer|null|undefined} dataTransfer
 * @returns {DroppedItems}
 */
export function takeDropped(dataTransfer) {
  /** @type {FileSystemEntry[]} */
  const entries = [];
  /** @type {File[]} */
  const files = [];
  if (!dataTransfer) return { entries, files };
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry) {
        entries.push(entry);
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!entries.length && !files.length) files.push(...filesFromFileList(dataTransfer.files));
  return { entries, files };
}

/** @param {FileSystemFileEntry} entry @returns {Promise<File>} */
function fileOf(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** @param {FileSystemDirectoryReader} reader @returns {Promise<FileSystemEntry[]>} */
function nextBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Walk what a drop (or a folder picker) held, reporting as it goes so uploads
 * can start while the walk is still running. One bad entry never stops the
 * others: its error goes to `onError` and the walk carries on.
 *
 * Paths are relative to the drop, with the dropped folder's own name first:
 * `Photos/2024/a.jpg`.
 *
 * @param {DroppedItems} dropped
 * @param {{
 *   onFile: (file: File, relPath: string) => void,
 *   onDir?: (relPath: string) => void,
 *   onError?: (relPath: string, err: unknown) => void,
 *   signal?: AbortSignal,
 * }} handlers `onDir` is called for empty folders only.
 * @returns {Promise<void>}
 */
export async function walkDropped(dropped, { onFile, onDir, onError, signal }) {
  /** @param {FileSystemEntry} entry @param {string} prefix */
  async function walk(entry, prefix) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (signal?.aborted) return;
    try {
      if (entry.isFile) {
        onFile(await fileOf(/** @type {FileSystemFileEntry} */ (entry)), rel);
      } else if (entry.isDirectory) {
        const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader();
        let count = 0;
        for (;;) {
          if (signal?.aborted) return;
          const batch = await nextBatch(reader);
          if (!batch.length) break;
          count += batch.length;
          for (const child of batch) await walk(child, rel);
        }
        if (count === 0) onDir?.(rel);
      }
    } catch (err) {
      onError?.(rel, err);
    }
  }

  // Picker input and browsers without entry support: plain files, with
  // webkitRelativePath when a folder was picked.
  for (const file of dropped.files || []) {
    if (signal?.aborted) return;
    onFile(file, String(file.webkitRelativePath || file.name));
  }
  for (const entry of dropped.entries || []) {
    await walk(entry, "");
  }
}
