import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FolderInput, HardDrive, Lock, Pencil, RotateCcw, Trash2 } from "lucide-react";
import PropTypes from "prop-types";
import FileBrowser from "./FileBrowser.jsx";
import { BackupRowActions, VersionsModal } from "./backupsView.jsx";
import { backupSegmentLabel, backupSource } from "./backupsSource.js";
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
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { ActionTooltipGroup, InfoHint, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import {
  apiErrorMessage,
  getDrives,
  getJson,
  postJson,
} from "../../lib/api.js";
import { FileSourceProvider, fileListKey, fileSourceScope, useFileSource } from "../../lib/fileSource.jsx";
import UploadFilesPanel from "./UploadFilesPanel.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import {
  CAP,
  capsOnPath,
  hasCapOnDrive,
  memberFileHref,
  memberPathFloor,
} from "../../lib/shareTree.js";
import { CAP_MANAGE, capsBits } from "../../lib/access.js";
import { isPresentDrive, isWritableDrive } from "../../lib/drives.js";
import { useFileOps } from "../../context/FileOpsContext.jsx";
import { parseCreateName } from "../../lib/createName.js";
import { renameExtensionWarning } from "../../lib/renameExtension.js";
import { blankOfficeStub } from "../../lib/officeStubs.js";
import {
  fileHref as defaultFileHref,
  folderHref as defaultFolderHref,
  BACKUPS_PATH,
  isBackupsPath,
  isTrashPath,
  joinPath,
  parentPath,
  pathBasename,
  trashDisplayName,
  TRASH_PATH,
} from "../../lib/paths.js";

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
}) {
  const source = useFileSource();
  // Link guests run this same explorer over /s/{token} — the source carries
  // the link's caps; drive-only surfaces (share, protect, copy, trash, jobs,
  // cross-drive pickers) hide, everything else is identical.
  const guest = source.guest === true;
  const guestCaps = source.capsBits || 0;
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const fileOps = useFileOps();
  // Private items belong to a signed-in person; link guests never make them.
  const allowPrivate = !guest;
  const [innerPath, setInnerPath] = useState("");
  const path = controlledPath !== undefined ? controlledPath : innerPath;

  function setPath(next) {
    if (controlledPath === undefined) setInnerPath(next);
    onPathChange?.(next);
  }

  const [actionError, setActionError] = useState(/** @type {string|null} */ (null));
  const [deletePaths, setDeletePaths] = useState(/** @type {string[]|null} */ (null));
  const [renameTarget, setRenameTarget] = useState(/** @type {{ fullPath: string, name: string, isDir: boolean }|null} */ (null));
  const [renameValue, setRenameValue] = useState("");
  const [renameWarning, setRenameWarning] = useState(/** @type {ReturnType<typeof renameExtensionWarning>} */ (null));
  const [transfer, setTransfer] = useState(/** @type {null|{ kind: "copy"|"move", paths: string[], label?: string }} */ (null));
  const [broadenRetry, setBroadenRetry] = useState(/** @type {null|{ retry: () => Promise<unknown> }} */ (null));
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
  const [restoreTarget, setRestoreTarget] = useState(/** @type {null|{ fullPath: string, displayName: string, originalPath: string, isDir?: boolean }} */ (null));
  const [restoreName, setRestoreName] = useState("");
  const restoreCloseRef = useRef(/** @type {null|(() => void)} */ (null));
  const [restoreWarning, setRestoreWarning] = useState(/** @type {ReturnType<typeof renameExtensionWarning>} */ (null));
  const [purgeTarget, setPurgeTarget] = useState(/** @type {null|{ paths: string[], label: string }} */ (null));
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const backupsList = useQuery({
    queryKey: ["drive-backups", driveId],
    queryFn: () => getJson(`/api/v1/drives/${driveId}/backups`),
    enabled: !guest && !!driveId,
  });
  const backupsAvailable = Array.isArray(backupsList.data) && backupsList.data.length > 0;
  // Backups browse like Trash: a virtual folder in the same path, listed through its own source.
  const inBackups = !guest && isBackupsPath(path);
  const bSource = useMemo(() => backupSource(driveId), [driveId]);
  const [versionsFile, setVersionsFile] = useState(/** @type {null|{ backup: object, rel: string, name: string }} */ (null));
  const drivesQuery = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: !guest });
  const availableDrives = useMemo(() => {
    const data = guest ? (propDrives || []) : (drivesQuery.data || propDrives || []);
    return data.filter(isPresentDrive);
  }, [guest, propDrives, drivesQuery.data]);
  const writableDrives = useMemo(() => availableDrives.filter(isWritableDrive), [availableDrives]);

  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !guest && !isAdmin,
  });
  const protectAvailable = useCanProtect(!guest);
  // Read on a folder is enough to back it up; a whole drive needs Admin.
  const showProtect = !guest && protectAvailable;
  // Trash browses like a normal folder — same chrome, same actions. The
  // only affordances that stay off are the ones that would put NEW things
  // inside it (upload, create): items reach trash by being deleted.
  const inTrash = !guest && isTrashPath(path);
  /** Capability bits for `p`: the union of the member's grants. */
  const capsForPath = (p) => capsOnPath(access.data, driveId, p);
  const myFolderCaps = guest
    ? guestCaps
    : inBackups
      ? CAP.VIEW
    : isAdmin
      ? CAP_MANAGE
      : capsForPath(path);
  const trashVisible = !guest && (isAdmin || hasCapOnDrive(access.data, driveId, CAP.EDIT));
  const folderCanUpload = !inTrash && (myFolderCaps & CAP.UPLOAD) !== 0;
  const folderCanEdit = inTrash ? trashVisible : (myFolderCaps & CAP.EDIT) !== 0;
  const folderCanShare = !inTrash && (myFolderCaps & CAP.SHARE) !== 0;
  const backupsHref = backupsAvailable && !inTrash && path === "" ? folderHref(driveId, BACKUPS_PATH) : null;
  // Upload-only links can write but never read — downloads stay hidden.
  const canView = inTrash ? trashVisible : (myFolderCaps & CAP.VIEW) !== 0;

  // Member grants are virtual roots: the shallowest row containing `path`
  // is the top of the member's world (ancestors of a grant 403), so the
  // browser never offers a crumb, Up, or drop target above it. Trash has
  // its own scoped paths — no floor there.
  const memberRows = !guest && !isAdmin && Array.isArray(access.data)
    ? access.data
    : null;
  const pathFloor = inTrash
    ? ""
    : memberRows
      ? memberPathFloor(memberRows, driveId, path)
      : "";
  // A file whose parent folder isn't browsable for this member is itself
  // the root: `?path=<file>` gets the one-entry listing, `?file=` opens it.
  const rowFileHref = memberRows
    ? (/** @type {string} */ d, /** @type {string} */ p) => memberFileHref(memberRows, d, p)
    : fileHref;

  // The crumb trail inside trash reads "Trash / <where it was>" — the stat
  // endpoint reports the folder's pre-trash path ("" at the trash root).
  const trashStat = useQuery({
    queryKey: ["file-stat", fileSourceScope(source, driveId), path],
    queryFn: () => source.stat(driveId, path),
    enabled: inTrash,
  });
  const trashedFrom = trashStat.data?.trashed_from;
  let segmentLabel;
  if (inTrash) {
    const origin = String(trashedFrom || "");
    const labels = ["Trash", ...origin.split("/").filter(Boolean)];
    segmentLabel = (/** @type {string} */ segment, /** @type {number} */ i) => labels[i] ?? segment;
  }

  // The trash listing — same query key as FileBrowser's, so this shares the
  // cache rather than refetching. Drives "Empty trash" being disabled when
  // there's nothing to remove.
  const trashListing = useQuery({
    queryKey: fileListKey(source, driveId, TRASH_PATH),
    queryFn: () => source.listDir(driveId, TRASH_PATH),
    enabled: inTrash && path === TRASH_PATH,
  });

  /** The query keys a change to `paths` (and the folder in view) makes stale. */
  function staleKeys(paths = [path]) {
    // FileBrowser keys its listing on the source scope: a share token for
    // guests, the drive id signed in. Both sides invalidate the same key.
    const folders = new Set(paths.map((p) => {
      const idx = p.lastIndexOf("/");
      return idx < 0 ? "" : p.slice(0, idx);
    }));
    folders.add(path);
    const keys = [...folders].map((folder) => fileListKey(source, driveId, folder));
    if (!guest) keys.push(["jobs"], ["trash", driveId], ["recents"]);
    return keys;
  }

  function invalidate(paths = [path]) {
    for (const queryKey of staleKeys(paths)) queryClient.invalidateQueries({ queryKey });
  }

  /**
   * Hand an upload to the file task store. It keeps running (and showing in the
   * dock) if this page goes away, and it owns every error and the success toast.
   * @param {{ dropped: import("../../lib/collectUploadFiles.js").DroppedItems } | { files: File[] }} input
   * @param {string} [destFolder]
   */
  function uploadFiles(input, destFolder) {
    const folder = destFolder || "";
    fileOps.startUpload({
      source,
      driveId,
      destFolder: folder,
      destLabel: folder ? pathBasename(folder) : driveLabel,
      ...input,
    });
  }

  // One item moves to Trash with a toast and (on failure) an error in its modal.
  // More than one goes to the file task card, which carries on past failures.
  const removeMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ paths) => {
      for (const p of paths) {
        await source.remove(driveId, p);
      }
    },
    // Modal dismisses via ModalCard close() so exit animation can play.
    onSuccess: (_d, paths) => {
      addToast({ type: "success", message: "Moved to Trash." });
      invalidate(paths);
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't move that to Trash. Try again."));
    },
  });

  function trashPaths(/** @type {string[]} */ paths) {
    fileOps.startRequest({
      kind: "trash",
      source,
      driveId,
      destLabel: driveLabel,
      items: paths.map((p) => ({ name: pathBasename(p), run: () => source.remove(driveId, p) })),
      successToast: (done) => (done === 1 ? "Moved to Trash." : `Moved ${done} items to Trash.`),
      invalidateKeys: staleKeys(paths),
    });
  }

  const mkdirMutation = useMutation({
    mutationFn: (/** @type {string} */ fullPath) =>
      source.mkdir(driveId, fullPath, createKind?.private ? { private: true } : undefined),
    onSuccess: () => {
      addToast({ type: "success", message: createKind?.private ? "Private folder created." : "Folder created." });
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

  // A link guest moves files synchronously inside the link. Luna's own copy and
  // move jobs go to the file task card instead.
  const guestTransferMutation = useMutation({
    mutationFn: (/** @type {{ paths: string[], dest: string }} */ { paths, dest }) =>
      source.move(driveId, paths, dest),
    onSuccess: () => {
      addToast({ type: "success", message: "Moved." });
      invalidate();
    },
    onError: (err) => {
      haptic("error");
      setActionError(apiErrorMessage(err, "Couldn't move those files. Try again."));
    },
  });

  /** Send the picked items to the file task card as copy or move jobs. */
  function startTransfer(/** @type {{ driveId: string, path: string }} */ dest) {
    if (!transfer) return;
    const toDrive = dest.driveId || driveId;
    const toLabel = dest.path
      ? pathBasename(dest.path)
      : toDrive === driveId
        ? driveLabel
        : availableDrives.find((d) => d.id === toDrive)?.label || "";
    fileOps.startJobs({
      kind: transfer.kind,
      fromDrive: driveId,
      items: transfer.paths.map((p) => ({
        path: p,
        name: isTrashPath(p) ? trashDisplayName(p) : pathBasename(p),
      })),
      toDrive,
      toPath: dest.path,
      toLabel,
    });
  }

  const internalMoveMutation = useDriveMove({ driveId, driveLabel });

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
  // One restore from the name dialog stays in its dialog (a name clash is fixed
  // there). Restoring a selection goes to the file task card.
  const restoreMutation = useMutation({
    mutationFn: (/** @type {{ path: string, dest: string, confirm_broaden?: boolean }} */ item) =>
      postJson(`/api/v1/drives/${driveId}/files/restore`, item),
    onSuccess: (_d, item) => {
      addToast({ type: "success", message: "Restored." });
      invalidate([item.dest, item.path]);
    },
    onError: (err, item) => {
      invalidate([item.dest, item.path]);
      if ("code" in err && err.code === "broadens_access") {
        setBroadenRetry({ retry: () => restoreMutation.mutateAsync({ ...item, confirm_broaden: true }) });
        return;
      }
      setActionError(apiErrorMessage(err, "Couldn't restore that. Try again."));
    },
  });

  /** Send the restore under the typed name; the folder above may be gone, lunad re-creates it. */
  function startRestore(/** @type {() => void} */ close) {
    if (!restoreTarget) return Promise.resolve();
    return restoreMutation.mutateAsync({
      path: restoreTarget.fullPath,
      dest: joinPath(restoreDestFolder, restoreName.trim()),
    })
      .then(() => close())
      .catch(() => {});
  }

  function restoreMany(/** @type {{ path: string, dest: string, name: string }[]} */ items) {
    fileOps.startRequest({
      kind: "restore-trash",
      source,
      driveId,
      destLabel: driveLabel,
      items: items.map((item) => ({
        name: item.name,
        run: ({ confirmBroaden } = {}) =>
          postJson(`/api/v1/drives/${driveId}/files/restore`, {
            path: item.path,
            dest: item.dest,
            ...(confirmBroaden ? { confirm_broaden: true } : {}),
          }),
      })),
      successToast: (done) => (done === 1 ? "Restored." : `Restored ${done} items.`),
      invalidateKeys: staleKeys(items.flatMap((i) => [i.dest, i.path])),
    });
  }

  /** Delete permanently runs on Luna, slowly for big folders, so it goes to the card. */
  function purgePaths(/** @type {string[]} */ paths) {
    fileOps.startRequest({
      kind: "purge",
      source,
      driveId,
      destLabel: driveLabel,
      items: paths.map((p) => ({
        name: trashDisplayName(p),
        run: () => postJson(`/api/v1/drives/${driveId}/files/purge`, { path: p }),
      })),
      successToast: (done) => (done === 1 ? "Deleted permanently." : `Deleted ${done} items permanently.`),
      invalidateKeys: staleKeys(paths),
    });
  }

  /** Purge the whole trash. The API removes every entry the caller can see. */
  function emptyTrash() {
    fileOps.startRequest({
      kind: "empty-trash",
      source,
      driveId,
      title: driveLabel,
      destLabel: driveLabel,
      run: () => postJson(`/api/v1/drives/${driveId}/files/purge`, { path: TRASH_PATH }),
      successToast: "Trash emptied.",
      invalidateKeys: staleKeys([TRASH_PATH]),
    });
  }

  const restoreDestFolder = restoreTarget
    ? parentPath(restoreTarget.originalPath) || ""
    : "";

  const deleteSnapRef = useRef(/** @type {string[]|null} */ (null));
  if (deletePaths) deleteSnapRef.current = deletePaths;
  const shownDeletePaths = deletePaths ?? deleteSnapRef.current;
  const deleteLabel = shownDeletePaths?.length === 1
    ? pathBasename(shownDeletePaths[0])
    : `${shownDeletePaths?.length || 0} items`;

  const renameSnapRef = useRef(/** @type {{ fullPath: string, name: string, isDir: boolean }|null} */ (null));
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

  const openVersions = useCallback((/** @type {{ fullPath: string, displayName: string }} */ ctx) => {
    const rest = ctx.fullPath.slice(BACKUPS_PATH.length + 1);
    const slash = rest.indexOf("/");
    const backup = (backupsList.data || []).find((b) => b.id === rest.slice(0, slash));
    if (backup) setVersionsFile({ backup, rel: rest.slice(slash + 1), name: ctx.displayName });
  }, [backupsList.data]);

  // Stable identity so FileBrowser's memoized rows only re-render when one of
  // these inputs changes, not on every explorer render.
  const renderRowActions = useCallback((ctx) => {
    if (inBackups) return <BackupRowActions driveId={driveId} ctx={ctx} onVersions={openVersions} />;
    // Same action row as any folder, with trash deltas. The Trash row
    // itself (the drive-root entry that opens trash) behaves like a
    // folder: share, protect, download, copy, properties. Items INSIDE
    // trash lose share/protect/rename, top-level entries gain Restore,
    // and delete becomes Delete permanently (there is nowhere deeper
    // to move things to). The API maps trash paths to the item's
    // original location for permission checks.
    const trashRoot = ctx.fullPath === TRASH_PATH;
    const trashChild = isTrashPath(ctx.fullPath) && !trashRoot;
    const capPath = trashChild ? (ctx.entry.original_path || ctx.fullPath) : ctx.fullPath;
    // The server stamps each entry's caps — fall back to the grant
    // union for rows that arrive without them (guest listings).
    const rowCaps = ctx.entry.caps != null
      ? capsBits(ctx.entry.caps)
      : isAdmin
        ? CAP_MANAGE
        : capsOnPath(access.data, driveId, capPath);
    const rowCanEdit = guest
      ? (guestCaps & CAP.EDIT) !== 0 && !source.isFile
      : (rowCaps & CAP.EDIT) !== 0;
    const rowCanShare = !guest && !trashChild && (rowCaps & CAP.SHARE) !== 0;
    return (
    <ActionTooltipGroup>
      <div className="flex items-center gap-0.5 flex-wrap justify-end">
        {rowCanShare && (
          <ShareButton
            label={ctx.displayName}
            onClick={() => setAccessTarget({ path: ctx.fullPath })}
          />
        )}
        {showProtect && ctx.entry.kind === "dir" && !trashChild && (
          <ProtectButton
            label={ctx.displayName}
            onClick={() => setProtectTarget({ path: ctx.fullPath })}
          />
        )}
        {canView && (
          <DownloadButton
            driveId={driveId}
            path={ctx.fullPath}
            kind={ctx.entry.kind}
            label={ctx.displayName}
          />
        )}
        {trashChild && ctx.path === TRASH_PATH && (
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
                  isDir: ctx.entry.kind === "dir",
                });
                setRestoreName(ctx.displayName);
              }}
            >
              <RotateCcw size={ICON_SIZE.sm} />
            </Button>
          </Tooltip>
        )}
        {!guest && (
          <Tooltip content="Copy">
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={`Copy ${ctx.displayName}`}
              onClick={() => setTransfer({ kind: "copy", paths: [ctx.fullPath], label: ctx.displayName })}
            >
              <Copy size={ICON_SIZE.sm} />
            </Button>
          </Tooltip>
        )}
        {rowCanEdit && !trashRoot && (
          <>
            <Tooltip content="Move">
              <Button
                variant="ghost"
                surface="secondary"
                size="iconSm"
                aria-label={`Move ${ctx.displayName}`}
                onClick={() => setTransfer({ kind: "move", paths: [ctx.fullPath], label: ctx.displayName })}
              >
                <FolderInput size={ICON_SIZE.sm} />
              </Button>
            </Tooltip>
            {!trashChild && (
              <Tooltip content="Rename">
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={`Rename ${ctx.displayName}`}
                  onClick={() => {
                    setActionError(null);
                    setRenameTarget({ fullPath: ctx.fullPath, name: ctx.displayName, isDir: ctx.entry.kind === "dir" });
                    setRenameValue(ctx.displayName);
                  }}
                >
                  <Pencil size={ICON_SIZE.sm} />
                </Button>
              </Tooltip>
            )}
            <Tooltip content={trashChild ? "Delete permanently" : "Move to trash"}>
              <Button
                variant="ghost"
                surface="secondary"
                size="iconSm"
                aria-label={trashChild
                  ? `Delete ${ctx.displayName} permanently`
                  : `Move ${ctx.displayName} to trash`}
                onClick={() => (trashChild
                  ? setPurgeTarget({ paths: [ctx.fullPath], label: ctx.displayName })
                  : setDeletePaths([ctx.fullPath]))}
              >
                <Trash2 size={ICON_SIZE.sm} />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </ActionTooltipGroup>
    );
  },
    [access.data, driveId, guest, guestCaps, source.isFile, isAdmin, showProtect, canView, inBackups, openVersions]);

  return (
    <>
      {!guest && !isAdmin && access.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner size="sm" decorative className="text-primary" />
        </div>
      ) : !canView && folderCanUpload ? (
        <UploadFilesPanel
          onUploadFiles={(input) => uploadFiles(input, path)}
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
      <FileSourceProvider source={inBackups ? bSource : source}>
      <FileBrowser
        driveId={driveId}
        driveLabel={driveLabel}
        path={path}
        pathFloor={pathFloor}
        forbiddenState={!guest && !isAdmin ? (
          <EmptyState
            icon={Lock}
            title="You don't have access to this folder"
            description="Open items shared with you from Shared instead."
            action={(
              <Button size="sm" variant="primary" asChild>
                <Link to="/shared">Open Shared</Link>
              </Button>
            )}
          />
        ) : null}
        onPathChange={setPath}
        linkNavigation={linkNavigation}
        folderHref={folderHref}
        fileHref={rowFileHref}
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
        onOpenFile={(ctx) => (inBackups ? openVersions(ctx) : setViewerPath(ctx.fullPath))}
        onShare={guest || inTrash ? undefined : (ctx) => setAccessTarget({
          path: ctx.fullPath,
        })}
        onCopy={guest ? undefined : (paths) => setTransfer({ kind: "copy", paths })}
        onMove={folderCanEdit && !source.isFile ? (paths) => setTransfer({ kind: "move", paths }) : undefined}
        onRename={folderCanEdit && !source.isFile ? (ctx) => {
          setActionError(null);
          setRenameTarget({ fullPath: ctx.fullPath, name: ctx.displayName, isDir: ctx.entry.kind === "dir" });
          setRenameValue(ctx.displayName);
        } : undefined}
        onDelete={folderCanEdit && !source.isFile ? (inTrash
          ? (paths) => setPurgeTarget({
              paths,
              label: paths.length === 1 ? trashDisplayName(paths[0]) : `${paths.length} items`,
            })
          : setDeletePaths) : undefined}
        backupsHref={backupsHref}
        trashHref={showTrashLink && trashVisible && !inTrash ? folderHref(driveId, TRASH_PATH) : null}
        segmentLabel={inBackups ? backupSegmentLabel(backupsList.data || [], path) : segmentLabel}
        folderActions={folderCanUpload && !source.isFile ? <NewItemMenu onPick={openCreate} allowPrivate={allowPrivate} /> : null}
        emptyTitle={inTrash ? "Trash is empty" : inBackups ? "No backups on this drive" : undefined}
        breadcrumbExtra={inBackups ? null : (() => {
          // Same buttons a folder's breadcrumb row gets — the label just
          // reads "Trash" / the item's original name instead of the
          // generated on-disk name. Share/protect stay on the Trash root
          // itself but not on folders inside it (they're trash children).
          const label = inTrash
            ? (path === TRASH_PATH ? "Trash" : trashDisplayName(path))
            : (path || driveLabel || "this folder");
          const trashChildFolder = inTrash && path !== TRASH_PATH;
          return (
            <>
              {!guest && !trashChildFolder && folderCanShare && (
                <ShareButton
                  label={label}
                  onClick={() => setAccessTarget({ path })}
                />
              )}
              {canView && !source.isFile && (
                <DownloadButton
                  driveId={driveId}
                  path={path}
                  kind="dir"
                  label={label}
                />
              )}
              {showProtect && !trashChildFolder && (path !== "" || isAdmin) && (
                <ProtectButton
                  label={label}
                  onClick={() => setProtectTarget({ path })}
                />
              )}
            </>
          );
        })()}
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
        renderSelectionActions={inTrash ? (paths, rows) => {
          // Restore only works on whole top-level trash entries — a mixed
          // or nested selection doesn't get the button at all.
          if (paths.length === 0 || !paths.every((p) => parentPath(p) === TRASH_PATH)) return null;
          const rowsByPath = new Map(rows.map((r) => [r.fullPath, r]));
          return (
            <Button
              variant="outline"
              surface="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setActionError(null);
                const items = paths.map((p) => {
                  const row = rowsByPath.get(p);
                  const origin = row?.entry.original_path || "";
                  const name = row?.displayName || pathBasename(p);
                  return { path: p, dest: joinPath(parentPath(origin), name), name };
                });
                if (items.length === 1) {
                  const [only] = items;
                  restoreMutation.mutateAsync({ path: only.path, dest: only.dest }).catch(() => {});
                } else {
                  restoreMany(items);
                }
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Restore
            </Button>
          );
        } : undefined}
        renderRowActions={renderRowActions}
      />
      </FileSourceProvider>
      )}

      {versionsFile && (
        <VersionsModal
          driveId={driveId}
          backup={versionsFile.backup}
          file={versionsFile}
          onClose={() => setVersionsFile(null)}
        />
      )}

      <FileViewer
        open={viewerPath != null}
        driveId={driveId}
        path={viewerPath || ""}
        name={viewerPath === "" && source.isFile ? driveLabel : undefined}
        canWrite={!inTrash && (guest
          ? (guestCaps & CAP.EDIT) !== 0
          : isAdmin || (capsForPath(viewerPath || "") & CAP.EDIT) !== 0)}
        onClose={() => setViewerPath(null)}
        onSaved={() => viewerPath && invalidate([viewerPath])}
        onOpenPath={(next) => {
          invalidate([next]);
          setViewerPath(next);
        }}
      />

      <FolderPickerModal
        open={transfer != null}
        title={(() => {
          // The modal names what is being moved — trash paths show the
          // display name, never the `{nonce}-` storage name.
          const one = transfer?.paths.length === 1
            ? (transfer.label
                || (isTrashPath(transfer.paths[0])
                  ? trashDisplayName(transfer.paths[0])
                  : pathBasename(transfer.paths[0])))
            : `${transfer?.paths.length || 0} items`;
          return transfer?.kind === "move" ? `Move ${one}` : `Copy ${one}`;
        })()}
        drives={writableDrives.length > 0 ? writableDrives : [{ id: driveId, label: driveLabel }]}
        initialDriveId={driveId}
        initialPath={inTrash ? "" : path}
        movingPaths={transfer?.kind === "move" ? transfer.paths : []}
        confirmLabel={transfer?.kind === "move" ? "Start moving" : "Start copying"}
        busy={guestTransferMutation.isPending}
        error={transfer != null ? actionError : null}
        onClose={() => {
          setActionError(null);
          setTransfer(null);
        }}
        onConfirm={(dest, close) => {
          if (guest) {
            guestTransferMutation.mutateAsync({ paths: transfer?.paths || [], dest: dest.path })
              .then(() => close())
              .catch(() => {});
            return;
          }
          // The file task card owns the copy or move from here, so the picker closes.
          startTransfer(dest);
          close();
        }}
      />

      <ConfirmModal
        open={broadenRetry != null}
        variant="warning"
        title="Restore outside the private folder?"
        message="Everyone with access to the destination will be able to open it."
        confirmLabel="Restore anyway"
        loading={restoreMutation.isPending}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => setBroadenRetry(null)}
        onConfirm={() => {
          if (!broadenRetry) return;
          broadenRetry.retry()
            .then(() => {
              setBroadenRetry(null);
              setRestoreTarget(null);
            })
            .catch(() => setBroadenRetry(null));
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
              <InlinePill>{deleteLabel}</InlinePill> will move to
              Luna&apos;s trash on this drive. You can get it back later from Trash.
            </p>
            <ModalErrorNotice error={actionError} />
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                loading={removeMutation.isPending}
                onClick={() => {
                  if (!deletePaths) return;
                  if (deletePaths.length > 1) {
                    // The card shows the progress and any item that fails.
                    trashPaths(deletePaths);
                    close();
                    return;
                  }
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
                className="mt-3 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
                value={restoreName}
                maxLength={255}
                placeholder="File name"
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
                  // Same ending check as rename; the name dialog stays open behind it.
                  const warning = renameExtensionWarning(
                    restoreTarget.displayName,
                    restoreName,
                    restoreTarget.isDir,
                  );
                  if (warning) {
                    setRestoreWarning({ ...warning, confirmLabel: "Restore" });
                    restoreCloseRef.current = close;
                    return;
                  }
                  startRestore(close);
                }}
              >
                Restore
              </Button>
              <Button variant="outline" onClick={close}>Not now</Button>
            </div>
          </>
        )}
      </ModalCard>

      <ConfirmModal
        open={restoreWarning != null}
        variant="warning"
        title={restoreWarning?.title ?? ""}
        message={restoreWarning?.message}
        confirmLabel={restoreWarning?.confirmLabel ?? "Restore"}
        loading={restoreMutation.isPending}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => !restoreMutation.isPending && setRestoreWarning(null)}
        onConfirm={() => {
          const close = restoreCloseRef.current ?? (() => setRestoreTarget(null));
          startRestore(close).finally(() => setRestoreWarning(null));
        }}
      />

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
              <InlinePill>{purgeTarget?.label}</InlinePill> will be
              deleted permanently. Luna cannot get it back after this.
            </p>
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                onClick={() => {
                  if (!purgeTarget) return;
                  purgePaths(purgeTarget.paths);
                  close();
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
            <div className="mt-4 flex gap-3">
              <Button
                variant="danger"
                onClick={() => {
                  emptyTrash();
                  close();
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
        placeholder={createKind?.placeholder}
        hint={createKind?.private ? (
          <>
            A private folder is only visible to you and the people you share it with, no matter who can open the folder it&apos;s in.
            <InfoHint
              label="About private folders"
              content="With physical access to a drive, somebody could read the files inside a private folder."
            />
          </>
        ) : "Luna will put it in the folder you are in now."}
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

      <CreateNameModal
        open={renameTarget != null}
        title={`Rename ${shownRename?.name || ""}`}
        label="New name"
        value={renameValue}
        onChange={setRenameValue}
        keepExtension={!shownRename?.isDir}
        confirmLabel="Rename"
        busy={renameMutation.isPending}
        error={actionError}
        onSubmit={() => {
          if (!renameTarget) return Promise.reject(new Error("Nothing to rename."));
          const warning = renameExtensionWarning(renameTarget.name, renameValue, renameTarget.isDir);
          if (warning) {
            // Keep the name dialog open behind the confirm; Cancel returns to it.
            setRenameWarning(warning);
            return Promise.reject(new Error("Confirm the new ending first."));
          }
          return renameMutation.mutateAsync({
            fullPath: renameTarget.fullPath,
            newName: renameValue,
          }).then(() => undefined);
        }}
        onClose={() => {
          setActionError(null);
          setRenameTarget(null);
          setRenameWarning(null);
        }}
      />

      <ConfirmModal
        open={renameWarning != null}
        variant="warning"
        title={renameWarning?.title ?? ""}
        message={renameWarning?.message}
        confirmLabel={renameWarning?.confirmLabel ?? "Rename"}
        loading={renameMutation.isPending}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => !renameMutation.isPending && setRenameWarning(null)}
        onConfirm={() => {
          if (!renameTarget) return;
          renameMutation
            .mutateAsync({ fullPath: renameTarget.fullPath, newName: renameValue })
            .then(() => {
              setRenameWarning(null);
              setRenameTarget(null);
            })
            .catch(() => setRenameWarning(null));
        }}
      />

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
            onClose={() => {
              setProtectTarget(null);
              queryClient.invalidateQueries({ queryKey: ["private-backups-mine"] });
            }}
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
};
