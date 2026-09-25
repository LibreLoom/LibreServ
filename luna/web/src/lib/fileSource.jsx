/* eslint-disable react-refresh/only-export-components */
// A FileSource is the seam between the file UI and the wire. The drive
// source talks to /api/v1/drives/{id}; a share source talks to /s/{token}
// with the link password header. Components call source.* — they never
// know which side they're on, so the real browser, viewers, and editors
// run unchanged for link guests.
//
// Methods take (driveId, path) like the drive API; the share source
// ignores driveId and treats `path` as relative to the link root.

import { createContext, useContext } from "react";
import PropTypes from "prop-types";
import {
  apiFetch,
  deleteJson,
  getJson,
  postForm,
  postFormProgress,
  postJson,
  putBinaryProgress,
} from "./api.js";
import { capsBits, CAP } from "./access.js";
import { contentHref, downloadHref, joinPath, parentPath, pathBasename } from "./paths.js";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MULTIPART_LIMIT = 32 * 1024 * 1024;

async function requireOk(res, fallback) {
  if (res.ok) return res;
  let message = "";
  try {
    message = (await res.json()).error || "";
  } catch {
    // fall through
  }
  throw new Error(message || fallback);
}

/**
 * @typedef {{
 *   kind: "drive" | "share",
 *   guest: boolean,
 *   collab: boolean,
 *   token?: string,
 *   capsBits?: number,
 *   isFile?: boolean,
 *   fetch: (url: string, options?: object) => Promise<Response>,
 *   contentHref: (driveId: string, path: string) => string,
 *   downloadHref: (driveId: string, path: string, kind?: string) => string,
 *   collabWsUrl: (driveId: string, path: string) => string,
 *   listDir: (driveId: string, path: string) => Promise<object[]>,
 *   stat: (driveId: string, path: string) => Promise<object>,
 *   fetchBytes: (driveId: string, path: string) => Promise<ArrayBuffer>,
 *   saveFile: (driveId: string, path: string, name: string, blob: Blob, opts?: { headers?: object }) => Promise<unknown>,
 *   mkdir: (driveId: string, path: string) => Promise<unknown>,
 *   createFile: (driveId: string, path: string) => Promise<unknown>,
 *   rename: (driveId: string, path: string, newName: string) => Promise<unknown>,
 *   remove: (driveId: string, path: string) => Promise<unknown>,
 *   move: (driveId: string, paths: string[], dest: string) => Promise<unknown>,
 *   uploadFile: (driveId: string, file: File, destPath: string, name: string, opts?: { signal?: AbortSignal, onSession?: (uploadId: string) => void, onProgress?: (loaded: number, total: number) => void }) => Promise<void>,
 *   cancelUpload: (driveId: string, uploadId: string) => Promise<unknown>,
 *   officeSession: (driveId: string, path: string) => Promise<any>,
 *   formResponses: (driveId: string, path: string) => Promise<object[]>,
 *   uploadBlob?: (path: string, name: string, blob: Blob, opts?: { overwrite?: boolean, signal?: AbortSignal, headers?: object, onSession?: (uploadId: string) => void, onProgress?: (loaded: number, total: number) => void }) => Promise<void>,
 * }} FileSource
 */

/** Same-origin ws(s) base — mirrors the member collab socket. */
function wsBase() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

/** @type {FileSource} */
export const driveSource = {
  kind: "drive",
  guest: false,
  collab: true,
  fetch: (url, options) => apiFetch(url, options),
  contentHref: (driveId, path) => contentHref(driveId, path),
  downloadHref: (driveId, path) => downloadHref(driveId, path), // dirs zip server-side
  collabWsUrl: (driveId, path) =>
    `${wsBase()}/api/v1/collab/ws` +
    `?drive_id=${encodeURIComponent(driveId || "")}` +
    `&path=${encodeURIComponent(path || "")}`,
  listDir: (driveId, path) =>
    getJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(path)}`),
  stat: (driveId, path) =>
    getJson(`/api/v1/drives/${driveId}/files/stat?path=${encodeURIComponent(path)}`),
  async fetchBytes(driveId, path) {
    const res = await apiFetch(contentHref(driveId, path));
    await requireOk(res, "Luna couldn't open this file.");
    return res.arrayBuffer();
  },
  async saveFile(driveId, path, name, blob, opts = {}) {
    const folder = parentPath(path) ?? "";
    const file = new File([blob], name, { type: blob.type || "text/plain" });
    const form = new FormData();
    form.append("path", folder);
    form.append("file", file);
    await postForm(
      `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(folder)}&overwrite=1`,
      form,
      { headers: opts.headers },
    );
  },
  mkdir: (driveId, path) =>
    postJson(`/api/v1/drives/${driveId}/files/mkdir`, { path }),
  createFile: (driveId, path) =>
    postJson(`/api/v1/drives/${driveId}/files/create`, { path }),
  rename: (driveId, path, newName) =>
    postJson(`/api/v1/drives/${driveId}/files/rename`, { path, new_name: newName }),
  remove: (driveId, path) =>
    deleteJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(path)}`),
  // Same-drive moves ride the job queue — there is no synchronous endpoint.
  move: async (driveId, paths, dest) => {
    for (const fromPath of paths) {
      await postJson("/api/v1/jobs", {
        kind: "move",
        from_drive: driveId,
        from_path: fromPath,
        to_drive: driveId,
        to_path: dest,
      });
    }
  },
  async uploadFile(driveId, file, destPath, name, { signal, onSession, onProgress } = {}) {
    if (file.size <= MULTIPART_LIMIT) {
      const form = new FormData();
      form.append("path", destPath);
      const blob = file.name === name ? file : new File([file], name, { type: file.type });
      form.append("file", blob);
      await postFormProgress(
        `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(destPath)}`,
        form,
        {
          signal,
          onProgress: (loaded, total) => {
            onProgress?.(Math.min(loaded, total > 0 ? total : file.size), file.size);
          },
        },
      );
      return;
    }
    const session = await postJson(
      "/api/v1/uploads",
      { drive_id: driveId, path: destPath, name, size: file.size },
      { signal },
    );
    onSession?.(session.upload_id);
    try {
      for (let start = 0; start < file.size; start += CHUNK_SIZE) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const end = Math.min(start + CHUNK_SIZE, file.size) - 1;
        const progress = await putBinaryProgress(
          `/api/v1/uploads/${session.upload_id}`,
          file.slice(start, end + 1),
          {
            signal,
            headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
            onProgress: (loaded) =>
              onProgress?.(Math.min(file.size, start + loaded), file.size),
          },
        );
        onProgress?.(Number(progress.received) || end + 1, file.size);
      }
      await postJson(`/api/v1/uploads/${session.upload_id}/complete`, {}, { signal });
    } catch (err) {
      void deleteJson(`/api/v1/uploads/${session.upload_id}`).catch(() => {});
      throw err;
    }
  },
  cancelUpload: (_driveId, uploadId) => deleteJson(`/api/v1/uploads/${uploadId}`),
  officeSession: (driveId, path) =>
    postJson("/api/v1/office/session", { drive_id: driveId, path }),
  formResponses: async (driveId, path) => {
    const data = await getJson(
      `/api/v1/forms/responses?drive_id=${encodeURIComponent(driveId)}&path=${encodeURIComponent(path)}`,
    );
    return Array.isArray(data?.responses) ? data.responses : [];
  },
};

/**
 * Build the guest-side source for one share link. `meta.kind` decides how
 * paths resolve: a file link has one fixed target (path stays ""), a folder
 * link treats paths as relative to the shared folder.
 *
 * @param {{ token: string, password?: string, kind?: string, fileName?: string, caps?: string|number }} opts
 */
export function shareSource({ token, password = "", kind = "folder", fileName = "", caps = 0 }) {
  const capsNum = capsBits(caps);
  const canView = (capsNum & CAP.VIEW) !== 0;
  const canEdit = (capsNum & CAP.EDIT) !== 0;
  const isFile = kind === "file";
  const headers = () => (password ? { "X-Share-Password": password } : {});
  const fetchWithAuth = (url, options = {}) =>
    apiFetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  // A file link has exactly one target — the shared file itself. The guest
  // path space is empty, so any `path` a component carries is dropped.
  const rel = (path) => (isFile ? "" : path);

  /**
   * Chunked guest upload — same pipeline as the signed-in one. `opts.headers`
   * carries optional per-save headers.
   * @param {string} path
   * @param {string} name
   * @param {Blob} blob
   * @param {{ overwrite?: boolean, signal?: AbortSignal, headers?: object, onSession?: (uploadId: string) => void, onProgress?: (loaded: number, total: number) => void }} [opts]
   */
  async function uploadBlob(path, name, blob, { overwrite = false, signal, headers: extraHeaders, onSession, onProgress } = {}) {
    const reqHeaders = () => ({ ...headers(), ...(extraHeaders || {}) });
    const folder = isFile ? "" : (parentPath(path) ?? "");
    const session = await postJson(
      `/s/${token}/upload`,
      {
        name: isFile ? fileName || name : name,
        size: blob.size,
        ...(folder ? { path: folder } : {}),
      },
      { headers: reqHeaders(), signal },
    );
    let uploadId = session.upload_id;
    onSession?.(uploadId);
    try {
      for (let start = 0; start < blob.size; start += CHUNK_SIZE) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const end = Math.min(start + CHUNK_SIZE, blob.size) - 1;
        await putBinaryProgress(
          `/s/${token}/upload/${session.upload_id}`,
          blob.slice(start, end + 1),
          {
            signal,
            headers: { ...reqHeaders(), "Content-Range": `bytes ${start}-${end}/${blob.size}` },
            onProgress: (loaded) => onProgress?.(Math.min(blob.size, start + loaded), blob.size),
          },
        );
      }
      await postJson(
        `/s/${token}/upload/${session.upload_id}/complete${overwrite ? "?overwrite=1" : ""}`,
        {},
        { headers: reqHeaders(), signal },
      );
    } catch (err) {
      void deleteJson(`/s/${token}/upload/${uploadId}`, { headers: reqHeaders() }).catch(() => {});
      throw err;
    }
  }

  // Dropping files on a file link replaces the shared file — the server
  // pins the name; `overwrite` is only honored on edit-capable links.
  /**
   * @param {string} _driveId
   * @param {File} file
   * @param {string} destPath
   * @param {string} name
   * @param {{ signal?: AbortSignal, onSession?: (uploadId: string) => void, onProgress?: (loaded: number, total: number) => void }} [opts]
   */
  const uploadFile = (_driveId, file, destPath, name, { signal, onSession, onProgress } = {}) =>
    uploadBlob(joinPath(destPath, name), name, file, {
      overwrite: isFile && canEdit,
      signal,
      onSession,
      onProgress,
    });

  return {
    kind: "share",
    guest: true,
    collab: false,
    token,
    capsBits: capsNum,
    isFile,
    fetch: fetchWithAuth,
    contentHref: (_driveId, path) => {
      const params = new URLSearchParams();
      const p = rel(path);
      if (p) params.set("path", p);
      const q = params.toString();
      return `/s/${token}/file${q ? `?${q}` : ""}`;
    },
    downloadHref: (_driveId, path, kind) => {
      const params = new URLSearchParams();
      const p = rel(path);
      if (p) params.set("path", p);
      // Folders travel as zip; single files stream with download=1.
      if (kind === "dir") return `/s/${token}/zip?${params}`;
      params.set("download", "1");
      return `/s/${token}/file?${params}`;
    },
    collabWsUrl: (_driveId, path) =>
      `${wsBase()}/s/${token}/collab/ws?path=${encodeURIComponent(rel(path) || "")}`,
    listDir: async (_driveId, path) => {
      // Upload-only links (drop boxes) can't see inside — the browser shows
      // its empty state with the upload affordances, no 403 noise.
      if (!canView) return [];
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      const data = await getJson(`/s/${token}/list?${params}`, { headers: headers() });
      return Array.isArray(data?.entries) ? data.entries : [];
    },
    stat: (_driveId, path) => {
      const params = new URLSearchParams();
      const p = rel(path);
      if (p) params.set("path", p);
      return getJson(`/s/${token}/stat?${params}`, { headers: headers() });
    },
    async fetchBytes(_driveId, path) {
      const p = rel(path);
      const res = await fetchWithAuth(
        `/s/${token}/file${p ? `?path=${encodeURIComponent(p)}` : ""}`,
      );
      await requireOk(res, "Luna couldn't open this file.");
      return res.arrayBuffer();
    },
    saveFile: (_driveId, path, name, blob, opts = {}) =>
      uploadBlob(path, name || pathBasename(path), blob, { overwrite: true, ...opts }),
    mkdir: (_driveId, path) =>
      postJson(`/s/${token}/mkdir`, { path }, { headers: headers() }),
    createFile: (_driveId, path) =>
      postJson(`/s/${token}/create`, { path }, { headers: headers() }),
    rename: (_driveId, path, newName) =>
      postJson(`/s/${token}/rename`, { path, new_name: newName }, { headers: headers() }),
    remove: (_driveId, path) =>
      deleteJson(`/s/${token}/file?path=${encodeURIComponent(path)}`, { headers: headers() }),
    move: (_driveId, paths, dest) =>
      postJson(`/s/${token}/move`, { paths, dest }, { headers: headers() }),
    uploadFile,
    cancelUpload: (_driveId, uploadId) =>
      deleteJson(`/s/${token}/upload/${uploadId}`, { headers: headers() }),
    officeSession: (_driveId, path) =>
      postJson(`/s/${token}/office/session`, { path: rel(path) }, { headers: headers() }),
    formResponses: async (_driveId, path) => {
      const params = new URLSearchParams();
      const p = rel(path);
      if (p) params.set("path", p);
      const q = params.toString();
      const data = await getJson(`/s/${token}/responses${q ? `?${q}` : ""}`, { headers: headers() });
      return Array.isArray(data?.responses) ? data.responses : [];
    },
    uploadBlob,
  };
}

export function fileSourceScope(source, driveId) {
  return source.kind === "share" ? `share:${source.token}` : driveId;
}

export function fileListKey(source, driveId, path) {
  const key = ["files", fileSourceScope(source, driveId)];
  return path === undefined ? key : [...key, path];
}

/** @type {import("react").Context<FileSource>} */
const FileSourceContext = createContext(driveSource);

export function FileSourceProvider({ source, children }) {
  return <FileSourceContext.Provider value={source}>{children}</FileSourceContext.Provider>;
}

FileSourceProvider.propTypes = {
  source: PropTypes.object.isRequired,
  children: PropTypes.node,
};

/** The active file source — the signed-in drive API unless overridden. */
export function useFileSource() {
  return useContext(FileSourceContext) || driveSource;
}
