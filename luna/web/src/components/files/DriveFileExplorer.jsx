import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FolderInput, Pencil, Trash2 } from "lucide-react";
import PropTypes from "prop-types";
import FileBrowser from "./FileBrowser.jsx";
import FileViewer from "./FileViewer.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";
import CreateNameModal from "./CreateNameModal.jsx";
import NewItemMenu from "./NewItemMenu.jsx";
import AccessSheet, { AccessButton } from "./AccessSheet.jsx";
import ProtectSheet, { ProtectButton } from "./ProtectSheet.jsx";
import ModalCard from "../cards/ModalCard.jsx";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";
import Spinner from "../ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "../ui/Tooltip.jsx";
import PageNotice from "../common/PageNotice.jsx";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  postFormProgress,
  postJson,
  putBinaryProgress,
} from "../../lib/api.js";
import { filesFromFileList, uploadDestForFile } from "../../lib/collectUploadFiles.js";
import { parseCreateName } from "../../lib/createName.js";
import { folderHref as defaultFolderHref, fmtSize, joinPath, pathBasename } from "../../lib/paths.js";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MULTIPART_LIMIT = 32 * 1024 * 1024;
/** Parallel uploads — enough for multi-select without saturating the link. */
const UPLOAD_PARALLEL = 2;

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   received: number,
 *   size: number,
 *   uploadId: string | null,
 *   abort: AbortController,
 * }} UploadRow
 */

/**
 * Compact multi-file upload progress with per-file cancel.
 *
 * @param {{
 *   uploads: Array<{ id: string, name: string, received: number, size: number }>,
 *   onCancel: (id: string) => void,
 * }} props
 */
function UploadProgressList({ uploads, onCancel }) {
  if (!uploads.length) return null;

  return (
    <Card className="mb-3" padding={false} noPopIn>
      <ul className="m-0 p-0 list-none divide-y divide-primary/15" aria-label="Uploads in progress">
        {uploads.map((item) => {
          const total = Number(item.size) || 0;
          const done = Math.min(total, Math.max(0, Number(item.received) || 0));
          const pct = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : null;
          const sizeLine = total > 0
            ? `${fmtSize(done)} of ${fmtSize(total)}`
            : "Starting…";

          return (
            <li key={item.id} className="px-3 py-2.5 space-y-2" role="status" aria-live="polite">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-block h-2 w-2 rounded-full bg-primary shrink-0"
                  aria-hidden="true"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-accent shrink-0">
                  Uploading
                </span>
                <Spinner size="sm" decorative className="text-primary shrink-0" />
                <span className="font-mono text-sm text-primary truncate min-w-0 flex-1">
                  {item.name}
                </span>
                <span className="font-mono text-xs text-primary shrink-0 tabular-nums">
                  {pct != null ? `${pct}%` : "…"}
                </span>
                <Button
                  variant="outline"
                  surface="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onCancel(item.id)}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-primary font-mono">{sizeLine}</p>
              <div
                className="h-1.5 rounded-pill bg-primary overflow-hidden"
                role="progressbar"
                aria-valuenow={pct ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={
                  pct != null
                    ? `Uploading ${item.name}, ${pct}% done`
                    : `Uploading ${item.name}`
                }
              >
                <div
                  className="h-full rounded-pill bg-accent motion-safe:transition-all motion-safe:duration-300"
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

UploadProgressList.propTypes = {
  uploads: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      received: PropTypes.number.isRequired,
      size: PropTypes.number.isRequired,
    }),
  ).isRequired,
  onCancel: PropTypes.func.isRequired,
};

function isAbortError(err) {
  return (
    err?.name === "AbortError"
    || (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError")
  );
}

/**
 * Run async work over items with a fixed concurrency limit.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} worker
 */
async function mapPool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

/**
 * Full file explorer used by the Files page.
 * Same core, same actions; page adds URL sync via linkNavigation.
 *
 * @param {{
 *   driveId: string,
 *   driveLabel: string,
 *   path?: string,
 *   onPathChange?: (next: string) => void,
 *   linkNavigation?: boolean,
 *   folderHref?: (driveId: string, folderPath: string) => string,
 *   isAdmin?: boolean,
 *   showTrashLink?: boolean,
 *   dense?: boolean,
 *   headerExtra?: import("react").ReactNode,
 * }} props
 */
export default function DriveFileExplorer({
  driveId,
  driveLabel,
  path: controlledPath,
  onPathChange,
  linkNavigation = false,
  folderHref = defaultFolderHref,
  isAdmin = false,
  showTrashLink = true,
  dense = false,
  headerExtra = null,
}) {
  const queryClient = useQueryClient();
  const [innerPath, setInnerPath] = useState("");
  const path = controlledPath !== undefined ? controlledPath : innerPath;

  function setPath(next) {
    if (controlledPath === undefined) setInnerPath(next);
    onPathChange?.(next);
  }

  const [actionError, setActionError] = useState(/** @type {string|null} */ (null));
  const [uploads, setUploads] = useState(/** @type {UploadRow[]} */ ([]));
  const uploadsRef = useRef(/** @type {UploadRow[]} */ ([]));
  const [deletePaths, setDeletePaths] = useState(/** @type {string[]|null} */ (null));
  const [renameTarget, setRenameTarget] = useState(/** @type {{ fullPath: string, name: string }|null} */ (null));
  const [renameValue, setRenameValue] = useState("");
  const [transfer, setTransfer] = useState(/** @type {null|{ kind: "copy"|"move", paths: string[] }} */ (null));
  const [viewerPath, setViewerPath] = useState(/** @type {string|null} */ (null));
  const [accessTarget, setAccessTarget] = useState(/** @type {null|{ path: string, kind: string }} */ (null));
  const [protectTarget, setProtectTarget] = useState(/** @type {null|{ path: string }} */ (null));
  const [createKind, setCreateKind] = useState(/** @type {import("../../lib/createKinds.js").CreateKind|null} */ (null));
  const [createName, setCreateName] = useState("");
  const selectedRef = useRef(/** @type {string[]} */ ([]));

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });

  function setUploadRows(next) {
    uploadsRef.current = next;
    setUploads(next);
  }

  function patchUpload(id, patch) {
    setUploadRows(
      uploadsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function removeUpload(id) {
    setUploadRows(uploadsRef.current.filter((row) => row.id !== id));
  }

  function invalidate(paths = [path]) {
    const folders = new Set(paths.map((p) => {
      const idx = p.lastIndexOf("/");
      return idx < 0 ? "" : p.slice(0, idx);
    }));
    folders.add(path);
    for (const folder of folders) {
      queryClient.invalidateQueries({ queryKey: ["files", driveId, folder] });
    }
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.invalidateQueries({ queryKey: ["trash", driveId] });
  }

  /**
   * @param {UploadRow} row
   * @param {File} file
   * @param {string} destPath
   * @param {string} name
   */
  async function uploadMultipart(row, file, destPath, name) {
    const form = new FormData();
    form.append("path", destPath);
    // Keep the leaf name the server expects; File may carry a relative path.
    const blob = file.name === name ? file : new File([file], name, { type: file.type });
    form.append("file", blob);
    await postFormProgress(
      `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(destPath)}`,
      form,
      {
        signal: row.abort.signal,
        onProgress: (loaded, total) => {
          const size = total > 0 ? total : file.size;
          patchUpload(row.id, { received: Math.min(loaded, size), size });
        },
      },
    );
  }

  /**
   * @param {UploadRow} row
   * @param {File} file
   * @param {string} destPath
   * @param {string} name
   */
  async function uploadChunked(row, file, destPath, name) {
    const session = await postJson(
      "/api/v1/uploads",
      {
        drive_id: driveId,
        path: destPath,
        name,
        size: file.size,
      },
      { signal: row.abort.signal },
    );
    patchUpload(row.id, { uploadId: session.upload_id });

    for (let start = 0; start < file.size; start += CHUNK_SIZE) {
      if (row.abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const end = Math.min(start + CHUNK_SIZE, file.size) - 1;
      const chunk = file.slice(start, end + 1);
      const progress = await putBinaryProgress(
        `/api/v1/uploads/${session.upload_id}`,
        chunk,
        {
          signal: row.abort.signal,
          headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
          onProgress: (loaded) => {
            patchUpload(row.id, {
              received: Math.min(file.size, start + loaded),
              size: file.size,
            });
          },
        },
      );
      patchUpload(row.id, {
        received: Number(progress.received) || end + 1,
        size: file.size,
      });
    }
    await postJson(`/api/v1/uploads/${session.upload_id}/complete`, {}, { signal: row.abort.signal });
  }

  function cancelUpload(id) {
    const row = uploadsRef.current.find((item) => item.id === id);
    if (!row) return;
    row.abort.abort();
    if (row.uploadId) {
      void deleteJson(`/api/v1/uploads/${row.uploadId}`).catch(() => {});
    }
    removeUpload(id);
  }

  /**
   * Queue many files at once; upload a few in parallel with per-file cancel.
   * @param {File[]} files
   * @param {string} destFolder
   */
  async function uploadFiles(files, destFolder) {
    const list = filesFromFileList(files);
    if (!list.length) return;
    setActionError(null);

    /** @type {Array<UploadRow & { file: File, destPath: string, leafName: string }>} */
    const batch = list.map((file) => {
      const { destPath, name } = uploadDestForFile(destFolder || "", file);
      return {
        id: crypto.randomUUID(),
        name,
        received: 0,
        size: file.size,
        uploadId: null,
        abort: new AbortController(),
        file,
        destPath,
        leafName: name,
      };
    });

    setUploadRows([...uploadsRef.current, ...batch.map(({ file: _f, destPath: _d, leafName: _n, ...row }) => row)]);

    const touched = new Set(batch.map((item) => (item.destPath ? `${item.destPath}/x` : "x")));
    let hadError = false;

    await mapPool(batch, UPLOAD_PARALLEL, async (item) => {
      const row = uploadsRef.current.find((u) => u.id === item.id) || item;
      try {
        if (item.file.size <= MULTIPART_LIMIT) {
          await uploadMultipart(row, item.file, item.destPath, item.leafName);
        } else {
          await uploadChunked(row, item.file, item.destPath, item.leafName);
        }
        removeUpload(item.id);
      } catch (err) {
        removeUpload(item.id);
        if (isAbortError(err) || item.abort.signal.aborted) return;
        if (!hadError) {
          hadError = true;
          setActionError(apiErrorMessage(err, "Couldn't upload that file. Try again."));
        }
      }
    });

    invalidate([...touched]);
  }

  const removeMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ paths) => {
      for (const p of paths) {
        await deleteJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(p)}`);
      }
    },
    // Modal dismisses via ModalCard close() so exit animation can play.
    onSuccess: (_d, paths) => {
      invalidate(paths);
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't move that to Trash. Try again.")),
  });

  const mkdirMutation = useMutation({
    mutationFn: (/** @type {string} */ fullPath) =>
      postJson(`/api/v1/drives/${driveId}/files/mkdir`, { path: fullPath }),
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't create that folder. Try another name.")),
  });

  const createFileMutation = useMutation({
    mutationFn: (/** @type {string} */ fullPath) =>
      postJson(`/api/v1/drives/${driveId}/files/create`, { path: fullPath }),
    onSuccess: (_data, fullPath) => {
      invalidate();
      if (createKind?.openAfter === "text") setViewerPath(fullPath);
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't create that file. Try another name.")),
  });

  function openCreate(kind) {
    setActionError(null);
    setCreateName(kind.defaultName || "");
    setCreateKind(kind);
  }

  function submitCreate() {
    if (!createKind) return Promise.reject(new Error("Choose what to create."));
    const parsed = parseCreateName(
      createName,
      createKind.defaultExt ? { defaultExt: createKind.defaultExt } : {},
    );
    if (parsed.error) {
      setActionError(parsed.error);
      return Promise.reject(new Error(parsed.error));
    }
    const fullPath = joinPath(path, parsed.name);
    if (createKind.action === "create-file") {
      return createFileMutation.mutateAsync(fullPath);
    }
    return mkdirMutation.mutateAsync(fullPath);
  }

  const renameMutation = useMutation({
    mutationFn: (/** @type {{ fullPath: string, newName: string }} */ { fullPath, newName }) =>
      postJson(`/api/v1/drives/${driveId}/files/rename`, {
        path: fullPath,
        new_name: newName,
      }),
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't rename that. Try again.")),
  });

  const transferMutation = useMutation({
    mutationFn: async (/** @type {{ driveId: string, path: string }} */ { driveId: toDrive, path: toPath }) => {
      if (!transfer) return;
      for (const fromPath of transfer.paths) {
        await postJson("/api/v1/jobs", {
          kind: transfer.kind,
          from_drive: driveId,
          from_path: fromPath,
          to_drive: toDrive || driveId,
          to_path: toPath,
        });
      }
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't start that transfer. Try again.")),
  });

  const internalMoveMutation = useMutation({
    mutationFn: async (/** @type {{ paths: string[], destFolder: string }} */ { paths, destFolder }) => {
      for (const fromPath of paths) {
        await postJson("/api/v1/jobs", {
          kind: "move",
          from_drive: driveId,
          from_path: fromPath,
          to_drive: driveId,
          to_path: destFolder,
        });
      }
    },
    onSuccess: (_d, vars) => {
      invalidate([...vars.paths, joinPath(vars.destFolder, "x")]);
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't move those files. Try again.")),
  });

  const deleteSnapRef = useRef(/** @type {string[]|null} */ (null));
  if (deletePaths) deleteSnapRef.current = deletePaths;
  const shownDeletePaths = deletePaths ?? deleteSnapRef.current;
  const deleteLabel = shownDeletePaths?.length === 1
    ? pathBasename(shownDeletePaths[0])
    : `${shownDeletePaths?.length || 0} items`;

  const renameSnapRef = useRef(/** @type {{ fullPath: string, name: string }|null} */ (null));
  if (renameTarget) renameSnapRef.current = renameTarget;
  const shownRename = renameTarget ?? renameSnapRef.current;
  const nameModalOpen = createKind != null || renameTarget != null;

  return (
    <>
      {actionError && !nameModalOpen && (
        <PageNotice variant="error" className="mb-3">{actionError}</PageNotice>
      )}
      {uploads.length > 0 && (
        <UploadProgressList uploads={uploads} onCancel={cancelUpload} />
      )}

      <FileBrowser
        driveId={driveId}
        driveLabel={driveLabel}
        path={path}
        onPathChange={setPath}
        linkNavigation={linkNavigation}
        folderHref={folderHref}
        enableDownload
        enableUploadDrop
        dense={dense}
        multiSelect
        onSelectedPathsChange={(paths) => { selectedRef.current = paths; }}
        onUploadFiles={uploadFiles}
        onInternalMove={(paths, destFolder) =>
          internalMoveMutation.mutate({ paths, destFolder })}
        onOpenFile={(ctx) => setViewerPath(ctx.fullPath)}
        onShare={(ctx) => setAccessTarget({
          path: ctx.fullPath,
          kind: ctx.entry.kind === "dir" ? "folder" : "file",
        })}
        onCopy={(paths) => setTransfer({ kind: "copy", paths })}
        onMove={(paths) => setTransfer({ kind: "move", paths })}
        onRename={(ctx) => {
          setActionError(null);
          setRenameTarget({ fullPath: ctx.fullPath, name: ctx.entry.name });
          setRenameValue(ctx.entry.name);
        }}
        onDelete={setDeletePaths}
        folderActions={<NewItemMenu onPick={openCreate} />}
        emptyAction={(
          <div className="flex justify-center">
            <NewItemMenu onPick={openCreate} />
          </div>
        )}
        breadcrumbExtra={(
          <>
            <AccessButton
              label={path || driveLabel || "this folder"}
              onClick={() => setAccessTarget({
                path,
                kind: path ? "folder" : "drive",
              })}
            />
            {isAdmin && (
              <ProtectButton
                label={path || driveLabel || "this folder"}
                onClick={() => setProtectTarget({ path })}
              />
            )}
          </>
        )}
        headerExtra={(
          <>
            {showTrashLink && (
              <Button variant="outline" surface="secondary" size="sm" asChild>
                <Link to={`/drives/${driveId}?view=trash`}>Open trash</Link>
              </Button>
            )}
            {headerExtra}
          </>
        )}
        renderRowActions={(ctx) => (
          <ActionTooltipGroup>
            <div className="flex items-center gap-0.5 flex-wrap justify-end">
              <AccessButton
                label={ctx.entry.name}
                onClick={() => setAccessTarget({
                  path: ctx.fullPath,
                  kind: ctx.entry.kind === "dir" ? "folder" : "file",
                })}
              />
              {isAdmin && ctx.entry.kind === "dir" && (
                <ProtectButton
                  label={ctx.entry.name}
                  onClick={() => setProtectTarget({ path: ctx.fullPath })}
                />
              )}
              <Tooltip content="Copy">
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={`Copy ${ctx.entry.name}`}
                  onClick={() => setTransfer({ kind: "copy", paths: [ctx.fullPath] })}
                >
                  <Copy size={14} />
                </Button>
              </Tooltip>
              <Tooltip content="Move">
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={`Move ${ctx.entry.name}`}
                  onClick={() => setTransfer({ kind: "move", paths: [ctx.fullPath] })}
                >
                  <FolderInput size={14} />
                </Button>
              </Tooltip>
              <Tooltip content="Rename">
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={`Rename ${ctx.entry.name}`}
                  onClick={() => {
                    setActionError(null);
                    setRenameTarget({ fullPath: ctx.fullPath, name: ctx.entry.name });
                    setRenameValue(ctx.entry.name);
                  }}
                >
                  <Pencil size={14} />
                </Button>
              </Tooltip>
              <Tooltip content="Move to trash">
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={`Move ${ctx.entry.name} to trash`}
                  onClick={() => setDeletePaths([ctx.fullPath])}
                >
                  <Trash2 size={14} />
                </Button>
              </Tooltip>
            </div>
          </ActionTooltipGroup>
        )}
      />

      <FileViewer
        open={viewerPath != null}
        driveId={driveId}
        path={viewerPath || ""}
        onClose={() => setViewerPath(null)}
        onSaved={() => viewerPath && invalidate([viewerPath])}
      />

      <FolderPickerModal
        open={transfer != null}
        title={
          transfer?.kind === "move"
            ? `Move ${transfer.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer.paths.length} items`}`
            : `Copy ${transfer?.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer?.paths.length || 0} items`}`
        }
        drives={drives.data || [{ id: driveId, label: driveLabel }]}
        initialDriveId={driveId}
        initialPath={path}
        confirmLabel={transfer?.kind === "move" ? "Start moving" : "Start copying"}
        busy={transferMutation.isPending}
        onClose={() => setTransfer(null)}
        onConfirm={(dest, close) => {
          transferMutation.mutateAsync(dest)
            .then(() => close())
            .catch(() => {});
        }}
      />

      <ModalCard
        open={deletePaths != null}
        title="Move to trash?"
        onClose={() => setDeletePaths(null)}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              <span className="font-mono">{deleteLabel}</span> will move to
              Luna&apos;s trash on this drive. You can get it back later from Open trash.
            </p>
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={removeMutation.isPending}
                onClick={() => {
                  if (!deletePaths) return;
                  removeMutation.mutateAsync(deletePaths)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Move to trash
              </Button>
              <Button variant="outline" onClick={close}>Keep it</Button>
            </div>
          </>
        )}
      </ModalCard>

      <CreateNameModal
        open={createKind != null}
        title={createKind?.title || "New"}
        label={createKind?.nameLabel || "Name"}
        hint="Luna will put it in the folder you are in now."
        value={createName}
        onChange={setCreateName}
        confirmLabel={createKind?.confirmLabel || "Create"}
        busy={mkdirMutation.isPending || createFileMutation.isPending}
        error={actionError}
        onSubmit={submitCreate}
        onClose={() => {
          setActionError(null);
          setCreateKind(null);
        }}
      />

      <ModalCard
        open={renameTarget != null}
        title={`Rename ${shownRename?.name || ""}`}
        onClose={() => {
          setActionError(null);
          setRenameTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <input
              className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              value={renameValue}
              maxLength={255}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            {actionError && <PageNotice variant="error" className="mt-2">{actionError}</PageNotice>}
            <div className="mt-4 flex gap-3">
              <Button
                variant="primary"
                loading={renameMutation.isPending}
                onClick={() => {
                  if (!renameTarget) return;
                  renameMutation.mutateAsync({
                    fullPath: renameTarget.fullPath,
                    newName: renameValue,
                  })
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Rename
              </Button>
              <Button variant="outline" onClick={close}>Cancel</Button>
            </div>
          </>
        )}
      </ModalCard>

      <AccessSheet
        open={accessTarget != null}
        driveId={driveId}
        path={accessTarget?.path || ""}
        kind={accessTarget?.kind || "folder"}
        onClose={() => setAccessTarget(null)}
      />
      <ProtectSheet
        open={protectTarget != null}
        driveId={driveId}
        path={protectTarget?.path || ""}
        onClose={() => setProtectTarget(null)}
      />
    </>
  );
}

DriveFileExplorer.propTypes = {
  driveId: PropTypes.string.isRequired,
  driveLabel: PropTypes.string.isRequired,
  path: PropTypes.string,
  onPathChange: PropTypes.func,
  linkNavigation: PropTypes.bool,
  folderHref: PropTypes.func,
  isAdmin: PropTypes.bool,
  showTrashLink: PropTypes.bool,
  dense: PropTypes.bool,
  headerExtra: PropTypes.node,
};
