import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { HardDrive, Trash2 } from "lucide-react";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import FileSearch from "../components/files/FileSearch";
import DriveFileExplorer from "../components/files/DriveFileExplorer";
import DriveMenu from "../components/files/DriveMenu";
import useDriveMove from "../hooks/useDriveMove";
import useStrandedErrorToast from "../hooks/useStrandedErrorToast";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import {
  apiErrorMessage,
  deleteJson,
  getDrives,
  getJson,
} from "../lib/api";
import { folderHref, homeAwareLabel, isMemberHomePath, isTrashPath, memberHomeOwner, parentPath, pathBasename, TRASH_PATH, trashDisplayName } from "../lib/paths";
import useFileNavigation from "../hooks/useFileNavigation.js";
import useMovedLinkForwarding from "../hooks/useMovedLinkForwarding.js";
import { useAuth } from "../context/AuthContext";
import { CAP, hasCapOnDrive, memberWritableRoots } from "../lib/shareTree.js";
import { isPresentDrive } from "../lib/drives.js";

function jobBusy(job) {
  return job.state === "running" || job.state === "queued";
}

/** Router href for a folder inside My files. */
function homeFolderHref(_driveId, folderPath) {
  return folderPath ? `/files?path=${encodeURIComponent(folderPath)}` : "/files";
}

/** Router href for a file inside My files. */
function homeFileHref(_driveId, filePath) {
  const folder = parentPath(filePath) ?? "";
  const base = homeFolderHref("", folder);
  const name = pathBasename(filePath);
  if (!name) return base;
  return `${base}${base.includes("?") ? "&" : "?"}file=${encodeURIComponent(name)}`;
}

function insidePath(root, path) {
  return Boolean(root) && (path === root || path.startsWith(`${root}/`));
}

/**
 * `/files` (My files, `home`) shows the signed-in person's own private
 * folder wherever it lives — the drive is never asked for or shown.
 * `/drives/:id` browses a drive's shared space: everything outside homes.
 *
 * @param {{ home?: boolean }} [props]
 */
export default function FilesPage({ home = false } = {}) {
  const { addToast } = useToast();
  const params = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const userHome = user?.home;
  const id = home ? userHome?.drive_id : params.id;
  const {
    path: navPath,
    selectPath,
    viewerPath,
    onPathChange,
    onViewerPathChange,
    clearSelectParam,
  } = useFileNavigation();

  const [actionError, setActionError] = useState(null);
  const homeRoot = userHome?.path || "";
  // My files opens at the top of the person's own folder.
  const path = home ? (navPath || homeRoot) : navPath;

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !isAdmin,
  });
  // Trash browses like a folder but keeps its access rule: write somewhere
  // on the drive, or the explorer never mounts.
  const inTrash = isTrashPath(path);
  const canOpenTrash = isAdmin || hasCapOnDrive(access.data, id, CAP.EDIT);

  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson("/api/v1/jobs"),
    refetchInterval: (q) => ((q.state.data || []).some(jobBusy) ? 1000 : false),
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId) => deleteJson(`/api/v1/jobs/${jobId}`),
    onSuccess: () => {
      addToast({ type: "success", message: "Job stopped." });
    },
    onError: (err) => setActionError(apiErrorMessage(err, "Couldn't cancel that job. Try again.")),
  });

  // Header drive-menu drops: move dragged files to the top of that drive.
  const moveFilesMutation = useDriveMove({ driveId: id, onError: setActionError });

  const activeJobs = (jobs.data || []).filter(jobBusy);

  // A bookmark or recent from before a move or rename follows the item.
  useMovedLinkForwarding({
    driveId: id,
    path,
    viewerPath,
    selectPath,
    enabled: Boolean(drive) && drive.state !== "missing",
  });

  // Same conditions the explorer used for the in-list strip: only when the
  // file browser itself can render and more than one drive is ready.
  const presentDriveCount = (drives.data || []).filter(isPresentDrive).length;

  // Members don't get a raw drive picker — their destinations are writable
  // roots: My files plus every shared folder they can put files in.
  // Equity with the admin selector, not equality: the menu looks the same
  // but holds different things.
  const userId = user?.id;
  const memberDests = useMemo(() => {
    if (isAdmin || !userId) return null;
    const present = new Set(
      (drives.data || []).filter(isPresentDrive).map((d) => d.id),
    );
    const labelOf = (id) => (drives.data || []).find((d) => d.id === id)?.label;
    // The server tells the member where their home actually lives (a
    // pinned drive can differ from the member-home default), and `/me`
    // carries the path — the members container has the drive's marker
    // prefix, which the frontend can't derive.
    return memberWritableRoots(access.data, userHome, (id) => present.has(id), labelOf)
      .map((r) => ({
        driveId: r.driveId,
        path: r.path,
        label: r.label,
        sub: r.isHome
          ? "Only you can see this"
          : labelOf(r.driveId),
        icon: /** @type {"home"|"folder"|"drive"} */ (r.isHome ? "home" : r.path ? "folder" : "drive"),
        writable: true,
      }));
  }, [isAdmin, userId, userHome, drives.data, access.data]);

  const showDriveMenu = !home
    && drive != null
    && drive.state !== "missing"
    && (isAdmin ? presentDriveCount > 1 : (memberDests?.length || 0) > 0);

  // Trigger shows the browsed place: admins get the drive label, members
  // the folder they're inside (their roots are folder-shaped, not drives).
  const currentLabel = isAdmin
    ? undefined
    : isMemberHomePath(path)
      // Own home reads "Home"; a deep share inside a peer's home names
      // the owner — the internal path never renders either way.
      ? (userHome?.path && path.split("/").slice(0, 2).join("/") === userHome.path
          ? "Home"
          : `${memberHomeOwner(path)}'s home`)
      : (path ? pathBasename(path) : drive?.label);

  useStrandedErrorToast(actionError, false, () => setActionError(null));

  // Links written before this split (search hits, recents, shares) can name
  // a home through /drives/:id — send them to My files, and anything in My
  // files that is not the person's own folder back to the shared space.
  const rehome = (pathname) => (
    <Navigate to={{ pathname, search: location.search, hash: location.hash }} replace />
  );
  if (!home && navPath && insidePath(homeRoot, navPath)) return rehome("/files");
  if (home && id && navPath && !insidePath(homeRoot, navPath) && !isTrashPath(navPath)) {
    return rehome(`/drives/${id}`);
  }

  const hrefForFolder = home ? homeFolderHref : folderHref;
  const backHref = home ? "/" : isAdmin ? "/drives" : "/folders";
  const backLabel = home ? "Back to Home" : isAdmin ? "Go to Drives" : "Back to Shared folders";
  const noHome = home && !userHome?.drive_id;

  return (
    <Page
      title={home ? (inTrash ? "Trash" : "My files") : inTrash ? "Trash" : (drive ? drive.label : "Files")}
      titleId="files-title"
      bottomContent={home && !noHome ? (
        <p className="text-sm inline-flex items-center gap-1.5">
          Only you can see these unless you share them.
          <InfoHint
            label="Who can open My files"
            content="Other people on this Luna, Admins included, can't open your files through Luna. Your files aren't encrypted, though, so anyone who unplugs the drive and reads it on another computer can open them."
          />
        </p>
      ) : undefined}
      leftContent={showDriveMenu ? (
        <DriveMenu
          drives={isAdmin ? drives.data : undefined}
          destinations={isAdmin ? undefined : memberDests}
          currentDriveId={id}
          currentPath={isAdmin ? "" : path}
          currentLabel={currentLabel}
          onDropPaths={(destDriveId, destPath, paths, sourceDriveId) =>
            moveFilesMutation.mutate({ paths, destFolder: destPath, destDriveId, fromDriveId: sourceDriveId })}
        />
      ) : undefined}
      rightContent={<FileSearch />}
    >
      {activeJobs.length > 0 && (
        <div className="grid gap-3 mb-4">
          {activeJobs.map((job) => (
            <Card key={job.id} padding>
              <p className="text-primary text-sm font-mono">
                {job.kind === "move" ? "Moving" : "Copying"}{" "}
                {job.from_path
                  ? job.from_path === TRASH_PATH
                    ? "trash"
                    : isTrashPath(job.from_path)
                      ? trashDisplayName(job.from_path)
                      : isMemberHomePath(job.from_path)
                        ? homeAwareLabel(job.from_path, userHome?.path || "")
                        : job.from_path
                  : "a file"}
              </p>
              <p className="text-primary text-xs mt-1">
                {job.total > 0
                  ? `${Math.min(100, Math.round((100 * job.progress) / job.total))}% done`
                  : "Starting…"}
              </p>
              <div className="mt-2 h-2 rounded-pill surface-primary p-0.5 overflow-hidden" aria-hidden="true">
                <div
                  className="h-full rounded-pill surface-secondary motion-safe:transition-all"
                  style={{ width: `${job.total > 0 ? Math.min(100, (100 * job.progress) / job.total) : 8}%` }}
                />
              </div>
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  loading={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(job.id)}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {noHome && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="My files isn't ready yet"
          description={
            isAdmin
              ? "Luna needs a drive to keep your files on. Add one in Drives."
              : "Luna needs a drive to keep your files on. Ask an Admin to add one."
          }
          action={isAdmin ? (
            <Button size="sm" variant="primary" asChild>
              <Link to="/drives">Go to Drives</Link>
            </Button>
          ) : undefined}
        />
      )}

      {!noHome && !drives.isLoading && !drive && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title={home ? "Can't open My files" : "Drive not found"}
          description={
            home
              ? "The drive holding your files isn't connected. Plug it back in, or ask an Admin."
              : isAdmin
                ? "Luna can't find this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in."
                : "Luna couldn't open this drive. Ask an Admin if you still need access."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to={backHref}>{backLabel}</Link>
            </Button>
          }
        />
      )}

      {drive && drive.state === "missing" && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title={home ? "Can't open My files" : "Drive unplugged"}
          description={
            home
              ? "The drive holding your files is unplugged. Plug it back in, or ask an Admin."
              : isAdmin
                ? "This drive is unplugged. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in."
                : "This drive is unplugged. Ask an Admin, or wait until it's plugged back in."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to={backHref}>{backLabel}</Link>
            </Button>
          }
        />
      )}

      {drive && drive.state !== "missing" && inTrash && !canOpenTrash && !access.isLoading && (
        <EmptyState
          className="mt-4"
          icon={Trash2}
          title="Trash isn't available here"
          description="You need Write access somewhere on this drive to open trash."
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to={hrefForFolder(id, "")}>Back to files</Link>
            </Button>
          }
        />
      )}

      {drive && drive.state !== "missing" && !(inTrash && !canOpenTrash) && (
        <DriveFileExplorer
          driveId={id}
          driveLabel={drive.label}
          drives={drives.data}
          path={path}
          onPathChange={onPathChange}
          viewerPath={viewerPath}
          onViewerPathChange={onViewerPathChange}
          selectPath={selectPath || null}
          onSelectPathApplied={clearSelectParam}
          linkNavigation
          folderHref={hrefForFolder}
          fileHref={home ? homeFileHref : undefined}
          isAdmin={isAdmin}
          showTrashLink={canOpenTrash}
        />
      )}
    </Page>
  );
}
