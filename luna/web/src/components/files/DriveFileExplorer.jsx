import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FolderInput, HardDrive, Pencil, RotateCcw, Trash2 } from "lucide-react";
import PropTypes from "prop-types";
import FileBrowser from "./FileBrowser.jsx";
import FileViewer from "./FileViewer.jsx";
import FolderPickerModal from "./FolderPickerModal.jsx";
import CreateNameModal from "./CreateNameModal.jsx";
import NewItemMenu from "./NewItemMenu.jsx";
import ShareSheet, { ShareButton } from "../share/ShareSheet.jsx";
import ProtectSheet, { ProtectButton } from "./ProtectSheet.jsx";
import useCanProtect from "../../hooks/useCanProtect.js";
import useDriveMove from "../../hooks/useDriveMove.js";
import useStrandedErrorToast from "../../hooks/useStrandedErrorToast.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import {
  apiErrorMessage,
  getDrives,
  getJson,
  postJson,
} from "../../lib/api.js";
import { fileListKey, fileSourceScope, useFileSource } from "../../lib/fileSource.jsx";
import UploadFilesPanel from "./UploadFilesPanel.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { CAP, CAP_FULL, capsOnPath, hasCapOnDrive } from "../../lib/shareTree.js";
import { isPresentDrive, isWritableDrive } from "../../lib/drives.js";
import { filesFromFileList, uploadDestForFile } from "../../lib/collectUploadFiles.js";
import { parseCreateName } from "../../lib/createName.js";
import { blankOfficeStub } from "../../lib/officeStubs.js";
import {
  fileHref as defaultFileHref,
  folderHref as defaultFolderHref,
  fmtSize,
  isTrashPath,
  joinPath,
  parentPath,
  pathBasename,
  TRASH_PATH,
} from "../../lib/paths.js";

/** Parallel uploads — enough for multi-select without saturating the link. */
const UPLOAD_PARALLEL = 2;

function jobBusy(job) {
  return job.state === "running" || job.state === "queued";
}

/**
 * Icon button that downloads a file or folder (folders arrive as a zip).
 * @param {{ driveId: string, path: string, label: string, kind?: string }} props
 */
function DownloadButton({ driveId, path, label, kind }) {
  const source = useFileSource();
  return (
    <Tooltip content="Download">
      <Button
        variant="ghost"
        surface="secondary"
        size="iconSm"
        asChild
        aria-label={`Download ${label}`}
      >
        <a href={source.downloadHref(driveId, path, kind)}>
          <Download size={ICON_SIZE.sm} />
        </a>
      </Button>
    </Tooltip>
  );
}

DownloadButton.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  kind: PropTypes.string,
};

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
export function UploadProgressList({ uploads, onCancel }) {
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
 *   drives?: any[],
 *   path?: string,
 *   onPathChange?: (next: string) => void,
 *   selectPath?: string | null,
 *   onSelectPathApplied?: () => void,
 *   linkNavigation?: boolean,
 *   folderHref?: (driveId: string, folderPath: string) => string,
 *   fileHref?: (driveId: string, filePath: string) => string,
 *   isAdmin?: boolean,
 *   showTrashLink?: boolean,
 *   dense?: boolean,
 *   headerExtra?: import("react").ReactNode,
 *   viewerPath?: string | null,
 *   onViewerPathChange?: (next: string | null) => void,
 *   emptyTitle?: string,
 *   emptyDescription?: string,
 *   emptyIcon?: import("react").ComponentType<{ size?: number, className?: string }>,
 * }} props
 */
export default function DriveFileExplorer({
  driveId,
  driveLabel,
  drives: propDrives,
  path: controlledPath,
  onPathChange,
  selectPath = null,
  onSelectPathApplied,
  linkNavigation = false,
  folderHref = defaultFolderHref,
  fileHref = defaultFileHref,
  isAdmin = false,
  showTrashLink = true,
  dense = false,
  headerExtra = null,
  viewerPath: controlledViewerPath,
  onViewerPathChange,
  emptyTitle = "This drive is empty",
  emptyDescription = "Upload files or create folders to get started.",
  emptyIcon = HardDrive,
}) {
  const source = useFileSource();
  // Link guests run this same explorer over /s/{token} — the source carries
  // the link's caps; drive-only surfaces (share, protect, copy, trash, jobs,
  // cross-drive pickers) hide, everything else is identical.
  const guest = source.guest === true;
  const guestCaps = source.capsBits || 0;
  const queryClient = useQueryClient();
  const { addToast } = useToast();
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
  const [innerViewerPath, setInnerViewerPath] = useState(/** @type {string|null} */ (null));
  const viewerPath = controlledViewerPath !== undefined ? controlledViewerPath : innerViewerPath;

  function setViewerPath(next) {
    if (controlledViewerPath === undefined) setInnerViewerPath(next);
    onViewerPathChange?.(next);
  }
  const [accessTarget, setAccessTarget] = useState(/** @type {null|{ path: string }} */ (null));
  const [protectTarget, setProtectTarget] = useState(/** @type {null|{ path: string }} */ (null));
  const [createKind, setCreateKind] = useState(/** @type {import("../../lib/createKinds.js").CreateKind|null} */ (null));
  const [createName, setCreateName] = useState("");
  const selectedRef = useRef(/** @type {string[]} */ ([]));
  const [restoreTarget, setRestoreTarget] = useState(/** @type {null|{ fullPath: string, displayName: string, originalPath: string }} */ (null));
  const [restoreName, setRestoreName] = useState("");
  const [purgeTarget, setPurgeTarget] = useState(/** @type {null|{ paths: string[], label: string }} */ (null));
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  const drivesQuery = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: !guest });
  const availableDrives = useMemo(() => {
    const data = guest ? (propDrives || []) : (drivesQuery.data || propDrives || []);
    return data.filter(isPresentDrive);
  }, [guest, propDrives, drivesQuery.data]);
  const writableDrives = useMemo(() => availableDrives.filter(isWritableDrive), [availableDrives]);

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson("/api/v1/jobs"),
    enabled: !guest,
    refetchInterval: (q) => ((q.state.data || []).some(jobBusy) ? 1000 : false),
  });
  const prevBusyJobIds = useRef(new Set());
  useEffect(() => {
    const list = Array.isArray(jobs.data) ? jobs.data : [];
    const busyIds = new Set(list.filter(jobBusy).map((job) => job.id));
    for (const id of prevBusyJobIds.current) {
      if (busyIds.has(id)) continue;
      const job = list.find((row) => row.id === id);
      if (!job) continue;
      if (job.from_drive) {
        queryClient.invalidateQueries({ queryKey: ["files", job.from_drive] });
        queryClient.invalidateQueries({ queryKey: ["trash", job.from_drive] });
      }
      if (job.to_drive && job.to_drive !== job.from_drive) {
        queryClient.invalidateQueries({ queryKey: ["files", job.to_drive] });
        queryClient.invalidateQueries({ queryKey: ["trash", job.to_drive] });
      }
    }
    prevBusyJobIds.current = busyIds;
  }, [jobs.data, queryClient]);

  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !guest && !isAdmin,
  });
  const protectAvailable = useCanProtect(!guest && isAdmin);
  const showProtect = !guest && isAdmin && protectAvailable;
  // Trash is a normal folder to look at — but strictly read-only. Every
  // write affordance (upload, rename, move, delete-to-trash) stays off.
  const inTrash = !guest && isTrashPath(path);
  const myFolderCaps = guest ? guestCaps : isAdmin ? CAP_FULL : capsOnPath(access.data, driveId, path);
  const trashVisible = !guest && (isAdmin || hasCapOnDrive(access.data, driveId, CAP.EDIT));
  const folderCanUpload = !inTrash && (myFolderCaps & CAP.UPLOAD) !== 0;
  const folderCanEdit = !inTrash && (myFolderCaps & CAP.EDIT) !== 0;
  // Upload-only links can write but never read — downloads stay hidden.
  const canView = inTrash ? trashVisible : (myFolderCaps & CAP.VIEW) !== 0;

  // The crumb trail inside trash reads "Trash / <where it was>" — the stat
  // endpoint reports the folder's pre-trash path ("" at the trash root).
  const trashStat = useQuery({
    queryKey: ["file-stat", fileSourceScope(source, driveId), path],
    queryFn: () => source.stat(driveId, path),
    enabled: inTrash,
  });
  const segmentLabel = useMemo(() => {
    if (!inTrash) return undefined;
    const origin = String(trashStat.data?.trashed_from || "");
    const labels = ["Trash", ...origin.split("/").filter(Boolean)];
    return (/** @type {string} */ segment, /** @type {number} */ i) => labels[i] ?? segment;
  }, [inTrash, trashStat.data]);

  // The trash listing — same query key as FileBrowser's, so this shares the
  // cache rather than refetching. Drives "Empty trash" being disabled when
  // there's nothing to remove.
  const trashListing = useQuery({
    queryKey: fileListKey(source, driveId, TRASH_PATH),
    queryFn: () => source.listDir(driveId, TRASH_PATH),
    enabled: inTrash && path === TRASH_PATH,
  });

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
    // FileBrowser keys its listing on the source scope — a share token for
    // guests, the drive id signed in — so both sides invalidate the same key.
    const folders = new Set(paths.map((p) => {
      const idx = p.lastIndexOf("/");
      return idx < 0 ? "" : p.slice(0, idx);
    }));
    folders.add(path);
    for (const folder of folders) {
      queryClient.invalidateQueries({ queryKey: fileListKey(source, driveId, folder) });
    }
    if (!guest) {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["trash", driveId] });
    }
  }

  function cancelUpload(id) {
    const row = uploadsRef.current.find((item) => item.id === id);
    if (!row) return;
    row.abort.abort();
    if (row.uploadId) {
      void source.cancelUpload(driveId, row.uploadId).catch(() => {});
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
    if (source.isFile && list.length > 1) {
      setActionError("Choose one file to replace this file.");
      return;
    }

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
    let completed = 0;

    await mapPool(batch, UPLOAD_PARALLEL, async (item) => {
      const row = uploadsRef.current.find((u) => u.id === item.id) || item;
      try {
        await source.uploadFile(driveId, item.file, item.destPath, item.leafName, {
          signal: row.abort.signal,
          onSession: (uploadId) => patchUpload(item.id, { uploadId }),
          onProgress: (loaded, total) => {
            patchUpload(item.id, { received: Math.min(loaded, total), size: total });
          },
        });
        completed += 1;
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
    if (completed > 0) {
      addToast({
        type: "success",
        message: completed === 1 ? "1 file uploaded." : `${completed} files uploaded.`,
      });
    }
  }

  const removeMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ paths) => {
      for (const p of paths) {
        await source.remove(driveId, p);
      }
    },
    // Modal dismisses via ModalCard close() so exit animation can play.
    onSuccess: (_d, paths) => {
      addToast({
        type: "success",
        message: paths.length === 1 ? "Moved to Trash." : `Moved ${paths.length} items to Trash.`,
      });
      invalidate(paths);
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't move that to Trash. Try again."));
    },
  });

  const mkdirMutation = useMutation({
    mutationFn: (/** @type {string} */ fullPath) =>
      source.mkdir(driveId, fullPath),
    onSuccess: () => {
      addToast({ type: "success", message: "Folder created." });
      invalidate();
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't create that folder. Try another name."));
    },
  });

  const createFileMutation = useMutation({
    mutationFn: async (/** @type {string} */ fullPath) => {
      if (createKind?.stub || createKind?.initialContent) {
        const folder = fullPath.includes("/")
          ? fullPath.slice(0, fullPath.lastIndexOf("/"))
          : "";
        const name = fullPath.split("/").pop() || fullPath;
        const blob = createKind.initialContent
          ? new Blob([createKind.initialContent()], { type: "application/json" })
          : blankOfficeStub(createKind.stub);
        const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
        await source.uploadFile(driveId, file, folder, name);
        return fullPath;
      }
      await source.createFile(driveId, fullPath);
      return fullPath;
    },
    onSuccess: (_data, fullPath) => {
      addToast({ type: "success", message: "File created." });
      invalidate();
      if (createKind?.openAfter === "text" || createKind?.openAfter === "viewer") {
        setViewerPath(fullPath);
      }
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't create that file. Try another name."));
    },
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
      createKind.stub || createKind.initialContent
        ? { forceExt: createKind.defaultExt || `.${createKind.stub}` }
        : createKind.defaultExt
          ? { defaultExt: createKind.defaultExt }
          : {},
    );
    if (parsed.error) {
      setActionError(parsed.error);
      return Promise.reject(new Error(parsed.error));
    }
    const fullPath = joinPath(path, parsed.name);
    const mutation = createKind.action === "create-file" ? createFileMutation : mkdirMutation;
    return mutation.mutateAsync(fullPath).then(() => undefined);
  }

  const renameMutation = useMutation({
    mutationFn: (/** @type {{ fullPath: string, newName: string }} */ { fullPath, newName }) =>
      source.rename(driveId, fullPath, newName),
    onSuccess: () => {
      addToast({ type: "success", message: "Renamed." });
      invalidate();
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't rename that. Try again."));
    },
  });

  const transferMutation = useMutation({
    mutationFn: async (/** @type {{ driveId: string, path: string }} */ { driveId: toDrive, path: toPath }) => {
      if (!transfer) return;
      // Guests move synchronously inside the link — no job queue.
      if (guest) {
        await source.move(driveId, transfer.paths, toPath);
        queryClient.invalidateQueries({ queryKey: fileListKey(source, driveId) });
        return;
      }
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
    onSuccess: (_d, vars) => {
      addToast({
        type: "success",
        message: transfer?.kind === "move"
          ? guest ? "Moved." : "Luna is moving those files."
          : "Luna is copying those files.",
      });
      invalidate();
      if (vars.driveId && vars.driveId !== driveId) {
        queryClient.invalidateQueries({ queryKey: ["files", vars.driveId] });
      }
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't start that transfer. Try again."));
    },
  });

  const internalMoveMutation = useDriveMove({ driveId, onError: setActionError });

  const shareMoveMutation = useMutation({
    mutationFn: (/** @type {{ paths: string[], dest: string }} */ { paths, dest }) =>
      source.move(driveId, paths, dest),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileListKey(source, driveId) });
      addToast({ type: "success", message: "Files moved." });
    },
    onError: (err) =>
      setActionError(apiErrorMessage(err, "Couldn't move those files. Try again.")),
  });

  // Trash's two writes: restore a whole entry, or delete it permanently.
  // Both stay top-level — the API only accepts `{trash}/{entry}` paths.
  const restoreMutation = useMutation({
    mutationFn: (/** @type {{ path: string, dest: string }} */ vars) =>
      postJson(`/api/v1/drives/${driveId}/files/restore`, vars),
    onSuccess: (_d, vars) => {
      addToast({ type: "success", message: "Restored." });
      invalidate([vars.dest, vars.path]);
    },
    onError: (err) =>
      setActionError(apiErrorMessage(err, "Couldn't restore that. Try again.")),
  });

  const purgeMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ paths) => {
      for (const p of paths) {
        await postJson(`/api/v1/drives/${driveId}/files/purge`, { path: p });
      }
    },
    onSuccess: (_d, paths) => {
      addToast({
        type: "success",
        message: paths.length === 1 ? "Deleted permanently." : `Deleted ${paths.length} items permanently.`,
      });
      invalidate(paths);
    },
    onError: (err) =>
      setActionError(apiErrorMessage(err, "Couldn't permanently delete that. Try again.")),
  });

  /** Purge the whole trash — the API removes every entry the caller can see. */
  const emptyTrashMutation = useMutation({
    mutationFn: () =>
      postJson(`/api/v1/drives/${driveId}/files/purge`, { path: TRASH_PATH }),
    onSuccess: () => {
      addToast({ type: "success", message: "Trash emptied." });
      invalidate([TRASH_PATH]);
    },
    onError: (err) =>
      setActionError(apiErrorMessage(err, "Couldn't empty the trash. Try again.")),
  });

  const restoreDestFolder = restoreTarget
    ? parentPath(restoreTarget.originalPath) || ""
    : "";

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
  const actionModalOpen =
    deletePaths != null || transfer != null || nameModalOpen
    || restoreTarget != null || purgeTarget != null || emptyTrashOpen;
  useStrandedErrorToast(
    actionError,
    actionModalOpen || (!canView && folderCanUpload),
    () => setActionError(null),
  );

  return (
    <>
      {uploads.length > 0 && (
        <UploadProgressList uploads={uploads} onCancel={cancelUpload} />
      )}

      {!guest && !isAdmin && access.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner size="sm" decorative className="text-primary" />
        </div>
      ) : !canView && folderCanUpload ? (
        <UploadFilesPanel
          onUploadFiles={(files) => uploadFiles(files, path)}
          onMovePaths={
            // Guests never hold EDIT under an upload-only link, so the only
            // in-Luna drags that can land here come from a signed-in window.
            !guest && !source.isFile
              ? (paths, sourceDriveId) => {
                  const sameDrive = !sourceDriveId || sourceDriveId === driveId;
                  const filtered = paths.filter((p) => {
                    if (!p) return false;
                    if (!sameDrive) return true;
                    if (p === path || path.startsWith(`${p}/`)) return false;
                    if (parentPath(p) === path) return false;
                    return true;
                  });
                  if (filtered.length) {
                    internalMoveMutation.mutate({
                      paths: filtered,
                      destFolder: path,
                      destDriveId: driveId,
                      fromDriveId: sourceDriveId,
                    });
                  }
                }
              : undefined
          }
          error={actionError}
        />
      ) : (
      <FileBrowser
        driveId={driveId}
        driveLabel={driveLabel}
        path={path}
        onPathChange={setPath}
        linkNavigation={linkNavigation}
        folderHref={folderHref}
        fileHref={fileHref}
        enableDownload={canView}
        enableUploadDrop={!inTrash && folderCanUpload}
        dense={dense}
        multiSelect
        selectPath={selectPath}
        onSelectPathApplied={onSelectPathApplied}
        onSelectedPathsChange={(paths) => { selectedRef.current = paths; }}
        onUploadFiles={folderCanUpload ? uploadFiles : undefined}
        onInternalMove={folderCanEdit && !source.isFile ? (paths, destFolder, destDriveId, sourceDriveId) =>
          guest
            ? shareMoveMutation.mutate({ paths, dest: destFolder })
            : internalMoveMutation.mutate({ paths, destFolder, destDriveId, fromDriveId: sourceDriveId }) : undefined}
        onOpenFile={(ctx) => setViewerPath(ctx.fullPath)}
        onShare={guest || inTrash ? undefined : (ctx) => setAccessTarget({
          path: ctx.fullPath,
        })}
        onCopy={guest || inTrash ? undefined : (paths) => setTransfer({ kind: "copy", paths })}
        onMove={folderCanEdit && !source.isFile ? (paths) => setTransfer({ kind: "move", paths }) : undefined}
        onRename={folderCanEdit && !source.isFile ? (ctx) => {
          setActionError(null);
          setRenameTarget({ fullPath: ctx.fullPath, name: ctx.entry.name });
          setRenameValue(ctx.entry.name);
        } : undefined}
        onDelete={folderCanEdit && !source.isFile ? setDeletePaths : undefined}
        trashHref={showTrashLink && trashVisible && !inTrash ? folderHref(driveId, TRASH_PATH) : null}
        segmentLabel={segmentLabel}
        folderActions={folderCanUpload && !source.isFile ? <NewItemMenu onPick={openCreate} /> : null}
        emptyTitle={inTrash ? "Trash is empty" : emptyTitle}
        emptyDescription={inTrash
          ? "Things you delete on this drive land here. Restore them or delete them permanently."
          : emptyDescription}
        emptyIcon={inTrash ? Trash2 : emptyIcon}
        emptyAction={folderCanUpload && !source.isFile ? (
          <div className="flex justify-center">
            <NewItemMenu onPick={openCreate} />
          </div>
        ) : null}
        breadcrumbExtra={inTrash ? (
          canView && !source.isFile ? (
            <DownloadButton
              driveId={driveId}
              path={path}
              kind="dir"
              label="Trash"
            />
          )
            : null
        ) : (
          <>
            {!guest && (
              <ShareButton
                label={path || driveLabel || "this folder"}
                onClick={() => setAccessTarget({ path })}
              />
            )}
            {canView && !source.isFile && (
              <DownloadButton
                driveId={driveId}
                path={path}
                kind="dir"
                label={path || driveLabel || "this folder"}
              />
            )}
            {showProtect && (
              <ProtectButton
                label={path || driveLabel || "this folder"}
                onClick={() => setProtectTarget({ path })}
              />
            )}
          </>
        )}
        headerExtra={inTrash && path === TRASH_PATH ? (
          <>
            <Button
              variant="outline"
              surface="secondary"
              size="sm"
              disabled={!trashListing.data?.length}
              onClick={() => {
                setActionError(null);
                setEmptyTrashOpen(true);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Empty trash
            </Button>
            {headerExtra}
          </>
        ) : headerExtra}
        renderRowActions={inTrash ? (ctx) => (
          <ActionTooltipGroup>
            <div className="flex items-center gap-0.5 flex-wrap justify-end">
              <DownloadButton
                driveId={driveId}
                path={ctx.fullPath}
                kind={ctx.entry.kind}
                label={ctx.displayName}
              />
              {ctx.path === TRASH_PATH && (
                <>
                  <Tooltip content="Restore">
                    <Button
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      aria-label={`Restore ${ctx.displayName}`}
                      onClick={() => {
                        setActionError(null);
                        setRestoreTarget({
                          fullPath: ctx.fullPath,
                          displayName: ctx.displayName,
                          originalPath: ctx.entry.original_path || "",
                        });
                        setRestoreName(ctx.displayName);
                      }}
                    >
                      <RotateCcw size={ICON_SIZE.sm} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete permanently">
                    <Button
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      aria-label={`Delete ${ctx.displayName} permanently`}
                      onClick={() => setPurgeTarget({ paths: [ctx.fullPath], label: ctx.displayName })}
                    >
                      <Trash2 size={ICON_SIZE.sm} />
                    </Button>
                  </Tooltip>
                </>
              )}
            </div>
          </ActionTooltipGroup>
        ) : (ctx) => (
          <ActionTooltipGroup>
            <div className="flex items-center gap-0.5 flex-wrap justify-end">
              {!guest && (
                <ShareButton
                  label={ctx.entry.name}
                  onClick={() => setAccessTarget({ path: ctx.fullPath })}
                />
              )}
              {showProtect && ctx.entry.kind === "dir" && (
                <ProtectButton
                  label={ctx.entry.name}
                  onClick={() => setProtectTarget({ path: ctx.fullPath })}
                />
              )}
              {canView && (
                <DownloadButton
                  driveId={driveId}
                  path={ctx.fullPath}
                  kind={ctx.entry.kind}
                  label={ctx.entry.name}
                />
              )}
              {!guest && (
                <Tooltip content="Copy">
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    aria-label={`Copy ${ctx.entry.name}`}
                    onClick={() => setTransfer({ kind: "copy", paths: [ctx.fullPath] })}
                  >
                    <Copy size={ICON_SIZE.sm} />
                  </Button>
                </Tooltip>
              )}
              {(guest
                ? (guestCaps & CAP.EDIT) !== 0 && !source.isFile
                : isAdmin || (capsOnPath(access.data, driveId, ctx.fullPath) & CAP.EDIT) !== 0
              ) && (
                <>
                  <Tooltip content="Move">
                    <Button
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      aria-label={`Move ${ctx.entry.name}`}
                      onClick={() => setTransfer({ kind: "move", paths: [ctx.fullPath] })}
                    >
                      <FolderInput size={ICON_SIZE.sm} />
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
                      <Pencil size={ICON_SIZE.sm} />
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
                      <Trash2 size={ICON_SIZE.sm} />
                    </Button>
                  </Tooltip>
                </>
              )}
            </div>
          </ActionTooltipGroup>
        )}
      />
      )}

      <FileViewer
        open={viewerPath != null}
        driveId={driveId}
        path={viewerPath || ""}
        name={viewerPath === "" && source.isFile ? driveLabel : undefined}
        canWrite={!inTrash && (guest
          ? (guestCaps & CAP.EDIT) !== 0
          : isAdmin || (capsOnPath(access.data, driveId, viewerPath || "") & CAP.EDIT) !== 0)}
        onClose={() => setViewerPath(null)}
        onSaved={() => viewerPath && invalidate([viewerPath])}
        onOpenPath={(next) => {
          invalidate([next]);
          setViewerPath(next);
        }}
      />

      <FolderPickerModal
        open={transfer != null}
        title={
          transfer?.kind === "move"
            ? `Move ${transfer.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer.paths.length} items`}`
            : `Copy ${transfer?.paths.length === 1 ? pathBasename(transfer.paths[0]) : `${transfer?.paths.length || 0} items`}`
        }
        drives={writableDrives.length > 0 ? writableDrives : [{ id: driveId, label: driveLabel }]}
        initialDriveId={driveId}
        initialPath={path}
        confirmLabel={transfer?.kind === "move" ? "Start moving" : "Start copying"}
        busy={transferMutation.isPending}
        error={transfer != null ? actionError : null}
        onClose={() => {
          setActionError(null);
          setTransfer(null);
        }}
        onConfirm={(dest, close) => {
          transferMutation.mutateAsync(dest)
            .then(() => close())
            .catch(() => {});
        }}
      />

      <ModalCard
        open={deletePaths != null}
        title="Move to trash?"
        onClose={() => {
          setActionError(null);
          setDeletePaths(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              <span className="font-mono">{deleteLabel}</span> will move to
              Luna&apos;s trash on this drive. You can get it back later from Trash.
            </p>
            <ModalErrorNotice error={actionError} />
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

      <ModalCard
        open={restoreTarget != null}
        title="Restore this?"
        onClose={() => {
          setActionError(null);
          setRestoreTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              Luna will move it out of Trash
              to {restoreDestFolder ? `“${restoreDestFolder}”` : `the top of ${driveLabel}`}.
              Choose the name it should have.
            </p>
            <ShakeTarget shake={actionError}>
              <input
                className="mt-3 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
                value={restoreName}
                maxLength={255}
                onChange={(e) => setRestoreName(e.target.value)}
                aria-label="Restored file name"
              />
            </ShakeTarget>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="primary"
                loading={restoreMutation.isPending}
                onClick={() => {
                  if (!restoreTarget) return;
                  restoreMutation.mutateAsync({
                    path: restoreTarget.fullPath,
                    dest: joinPath(restoreDestFolder, restoreName.trim()),
                  })
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Restore
              </Button>
              <Button variant="outline" onClick={close}>Not now</Button>
            </div>
          </>
        )}
      </ModalCard>

      <ModalCard
        open={purgeTarget != null}
        title="Delete permanently?"
        onClose={() => {
          setActionError(null);
          setPurgeTarget(null);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              <span className="font-mono">{purgeTarget?.label}</span> will be
              deleted permanently. Luna cannot get it back after this.
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={purgeMutation.isPending}
                onClick={() => {
                  if (!purgeTarget) return;
                  purgeMutation.mutateAsync(purgeTarget.paths)
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Delete permanently
              </Button>
              <Button variant="outline" onClick={close}>Keep in trash</Button>
            </div>
          </>
        )}
      </ModalCard>

      <ModalCard
        open={emptyTrashOpen}
        title="Empty trash?"
        onClose={() => {
          setActionError(null);
          setEmptyTrashOpen(false);
        }}
      >
        {({ close }) => (
          <>
            <p className="text-primary text-sm">
              Everything in Trash will be deleted permanently. Luna cannot get
              any of it back after this.
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={emptyTrashMutation.isPending}
                onClick={() => {
                  emptyTrashMutation.mutateAsync()
                    .then(() => close())
                    .catch(() => {});
                }}
              >
                Empty trash
              </Button>
              <Button variant="outline" onClick={close}>Keep it all</Button>
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
            <ShakeTarget shake={actionError}>
              <input
                className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
                value={renameValue}
                maxLength={255}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </ShakeTarget>
            <ModalErrorNotice error={actionError} />
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

      {!guest && (
        <>
          <ShareSheet
            open={accessTarget != null}
            subject={
              accessTarget
                ? { kind: "path", driveId, path: accessTarget.path || "" }
                : null
            }
            onClose={() => setAccessTarget(null)}
          />
          <ProtectSheet
            open={protectTarget != null}
            driveId={driveId}
            path={protectTarget?.path || ""}
            onClose={() => setProtectTarget(null)}
          />
        </>
      )}
    </>
  );
}

DriveFileExplorer.propTypes = {
  driveId: PropTypes.string.isRequired,
  driveLabel: PropTypes.string.isRequired,
  drives: PropTypes.array,
  path: PropTypes.string,
  onPathChange: PropTypes.func,
  selectPath: PropTypes.string,
  onSelectPathApplied: PropTypes.func,
  linkNavigation: PropTypes.bool,
  folderHref: PropTypes.func,
  fileHref: PropTypes.func,
  isAdmin: PropTypes.bool,
  showTrashLink: PropTypes.bool,
  dense: PropTypes.bool,
  headerExtra: PropTypes.node,
  viewerPath: PropTypes.string,
  onViewerPathChange: PropTypes.func,
  emptyTitle: PropTypes.string,
  emptyDescription: PropTypes.string,
  emptyIcon: PropTypes.elementType,
};
