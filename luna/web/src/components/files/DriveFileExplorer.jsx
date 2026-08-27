import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FolderInput, Pencil, Trash2 } from "lucide-react";
import PropTypes from "prop-types";
import FileBrowser from "./FileBrowser.jsx";
import FileViewer from "./FileViewer.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";
import AccessSheet, { AccessButton } from "./AccessSheet.jsx";
import ProtectSheet, { ProtectButton } from "./ProtectSheet.jsx";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import PageNotice from "../common/PageNotice.jsx";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  postForm,
  postJson,
  putBinary,
} from "../../lib/api.js";
import { folderHref as defaultFolderHref, fmtSize, joinPath, pathBasename } from "../../lib/paths.js";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MULTIPART_LIMIT = 32 * 1024 * 1024;

/**
 * Full file explorer used by the Files page and the Drives browse modal.
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
  const [uploading, setUploading] = useState(/** @type {null|{name:string,received:number,size:number}} */ (null));
  const [deletePaths, setDeletePaths] = useState(/** @type {string[]|null} */ (null));
  const [renameTarget, setRenameTarget] = useState(/** @type {{ fullPath: string, name: string }|null} */ (null));
  const [renameValue, setRenameValue] = useState("");
  const [transfer, setTransfer] = useState(/** @type {null|{ kind: "copy"|"move", paths: string[] }} */ (null));
  const [viewerPath, setViewerPath] = useState(/** @type {string|null} */ (null));
  const [accessTarget, setAccessTarget] = useState(/** @type {null|{ path: string, kind: string }} */ (null));
  const [protectTarget, setProtectTarget] = useState(/** @type {null|{ path: string }} */ (null));
  const selectedRef = useRef(/** @type {string[]} */ ([]));

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });

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

  async function uploadMultipart(file, destPath) {
    const form = new FormData();
    form.append("path", destPath);
    form.append("file", file);
    return postForm(
      `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(destPath)}`,
      form,
    );
  }

  async function uploadChunked(file, destPath) {
    const session = await postJson("/api/v1/uploads", {
      drive_id: driveId,
      path: destPath,
      name: file.name,
      size: file.size,
    });
    let received = 0;
    for (let start = 0; start < file.size; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, file.size) - 1;
      const chunk = file.slice(start, end + 1);
      const progress = await putBinary(`/api/v1/uploads/${session.upload_id}`, chunk, {
        headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
      });
      received = progress.received;
      setUploading({ name: file.name, received, size: file.size });
    }
    return postJson(`/api/v1/uploads/${session.upload_id}/complete`, {});
  }

  async function uploadFiles(files, destPath) {
    setActionError(null);
    for (const file of files) {
      setUploading({ name: file.name, received: 0, size: file.size });
      try {
        if (file.size <= MULTIPART_LIMIT) await uploadMultipart(file, destPath);
        else await uploadChunked(file, destPath);
      } catch (err) {
        setActionError(apiErrorMessage(err, "Couldn't upload that file. Try again."));
        break;
      }
    }
    setUploading(null);
    invalidate([destPath ? `${destPath}/x` : "x"]);
  }

  const removeMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ paths) => {
      for (const p of paths) {
        await deleteJson(`/api/v1/drives/${driveId}/files?path=${encodeURIComponent(p)}`);
      }
    },
    onSuccess: (_d, paths) => {
      setDeletePaths(null);
      invalidate(paths);
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't move that to Trash. Try again.")),
  });

  const renameMutation = useMutation({
    mutationFn: (/** @type {{ fullPath: string, newName: string }} */ { fullPath, newName }) =>
      postJson(`/api/v1/drives/${driveId}/files/rename`, {
        path: fullPath,
        new_name: newName,
      }),
    onSuccess: () => {
      setRenameTarget(null);
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
      setTransfer(null);
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

  const deleteLabel = deletePaths?.length === 1
    ? pathBasename(deletePaths[0])
    : `${deletePaths?.length || 0} items`;

  return (
    <>
      {actionError && (
        <PageNotice variant="error" className="mb-3">{actionError}</PageNotice>
      )}
      {uploading && (
        <p className="text-primary text-xs mb-3 font-mono" role="status">
          Saving {uploading.name}… {fmtSize(uploading.received)} of {fmtSize(uploading.size)}
        </p>
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
          setRenameTarget({ fullPath: ctx.fullPath, name: ctx.entry.name });
          setRenameValue(ctx.entry.name);
        }}
        onDelete={setDeletePaths}
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
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Copy ${ctx.entry.name}`}
              onClick={() => setTransfer({ kind: "copy", paths: [ctx.fullPath] })}
            >
              <Copy size={14} />
            </Button>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Move ${ctx.entry.name}`}
              onClick={() => setTransfer({ kind: "move", paths: [ctx.fullPath] })}
            >
              <FolderInput size={14} />
            </Button>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Rename ${ctx.entry.name}`}
              onClick={() => {
                setRenameTarget({ fullPath: ctx.fullPath, name: ctx.entry.name });
                setRenameValue(ctx.entry.name);
              }}
            >
              <Pencil size={14} />
            </Button>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Move ${ctx.entry.name} to trash`}
              onClick={() => setDeletePaths([ctx.fullPath])}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      />

      {viewerPath && (
        <FileViewer
          driveId={driveId}
          path={viewerPath}
          onClose={() => setViewerPath(null)}
          onSaved={() => invalidate([viewerPath])}
        />
      )}

      {transfer && (
        <FolderPickerModal
          title={
            transfer.kind === "move"
              ? `Move ${transfer.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer.paths.length} items`}`
              : `Copy ${transfer.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer.paths.length} items`}`
          }
          drives={drives.data || [{ id: driveId, label: driveLabel }]}
          initialDriveId={driveId}
          initialPath={path}
          confirmLabel={transfer.kind === "move" ? "Start moving" : "Start copying"}
          busy={transferMutation.isPending}
          onClose={() => setTransfer(null)}
          onConfirm={(dest) => transferMutation.mutate(dest)}
        />
      )}

      {deletePaths && (
        <ModalCard title="Move to trash?" onClose={() => setDeletePaths(null)}>
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
                  onClick={() => removeMutation.mutate(deletePaths)}
                >
                  Move to trash
                </Button>
                <Button variant="outline" onClick={close}>Keep it</Button>
              </div>
            </>
          )}
        </ModalCard>
      )}

      {renameTarget && (
        <ModalCard title={`Rename ${renameTarget.name}`} onClose={() => setRenameTarget(null)}>
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
                  onClick={() => renameMutation.mutate({
                    fullPath: renameTarget.fullPath,
                    newName: renameValue,
                  })}
                >
                  Rename
                </Button>
                <Button variant="outline" onClick={close}>Cancel</Button>
              </div>
            </>
          )}
        </ModalCard>
      )}

      {accessTarget && (
        <AccessSheet
          driveId={driveId}
          path={accessTarget.path}
          kind={accessTarget.kind}
          onClose={() => setAccessTarget(null)}
        />
      )}
      {protectTarget && (
        <ProtectSheet
          driveId={driveId}
          path={protectTarget.path}
          onClose={() => setProtectTarget(null)}
        />
      )}
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
