import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { HardDrive, Trash2 } from "lucide-react";
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
import { folderHref, homeAwareLabel, isMemberHomePath, isTrashPath, memberHomeOwner, pathBasename, TRASH_PATH, trashDisplayName } from "../lib/paths";
import useFileNavigation from "../hooks/useFileNavigation.js";
import { useAuth } from "../context/AuthContext";
import { CAP, hasCapOnDrive, memberWritableRoots } from "../lib/shareTree.js";
import { isPresentDrive } from "../lib/drives.js";

function jobBusy(job) {
  return job.state === "running" || job.state === "queued";
}

export default function FilesPage() {
  const { addToast } = useToast();
  const { id } = useParams();
  const {
    path,
    selectPath,
    viewerPath,
    onPathChange,
    onViewerPathChange,
    clearSelectParam,
  } = useFileNavigation();

  const [actionError, setActionError] = useState(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

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

  // Same conditions the explorer used for the in-list strip: only when the
  // file browser itself can render and more than one drive is ready.
  const presentDriveCount = (drives.data || []).filter(isPresentDrive).length;

  // Members don't get a raw drive picker — their destinations are writable
  // roots: the Home folder on the member-home drive plus every shared root
  // they can put files in. Equity with the admin selector, not equality:
  // the menu looks the same but holds different things.
  const userId = user?.id;
  const userHome = user?.home;
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
          ? `Your private folder${labelOf(r.driveId) ? ` on ${labelOf(r.driveId)}` : ""}`
          : labelOf(r.driveId),
        icon: /** @type {"home"|"folder"|"drive"} */ (r.isHome ? "home" : r.path ? "folder" : "drive"),
        writable: true,
      }));
  }, [isAdmin, userId, userHome, drives.data, access.data]);

  const showDriveMenu = drive != null
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

  return (
    <Page
      title={inTrash ? "Trash" : (drive ? drive.label : "Files")}
      titleId="files-title"
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
              <div className="mt-2 h-2 rounded-pill bg-primary overflow-hidden" aria-hidden="true">
                <div
                  className="h-full bg-accent motion-safe:transition-all"
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

      {!drives.isLoading && !drive && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive not found"
          description={
            isAdmin
              ? "Luna couldn't find this drive. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
              : "Luna couldn't open this drive. Ask an Admin if you still need access."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/drives">{isAdmin ? "Go to Drives" : "Back to Files"}</Link>
            </Button>
          }
        />
      )}

      {drive && drive.state === "missing" && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive unplugged"
          description={
            isAdmin
              ? "This drive is unplugged. Ensure that the drive is plugged in. If it is, try unplugging it and plugging it back in."
              : "This drive is unplugged. Ask an Admin, or wait until it's plugged back in."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/drives">{isAdmin ? "Go to Drives" : "Back to Files"}</Link>
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
              <Link to={folderHref(id, "")}>Back to files</Link>
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
          folderHref={folderHref}
          isAdmin={isAdmin}
          showTrashLink={canOpenTrash}
        />
      )}
    </Page>
  );
}
