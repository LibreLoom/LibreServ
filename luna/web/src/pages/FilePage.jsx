import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { HardDrive, Trash2 } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import useDriveHealth from "../hooks/useDriveHealth.js";
import { describeDriveHealth } from "../lib/driveHealth.js";
import { FileSearchButton } from "../components/files/FileSearch";
import DriveFileExplorer from "../components/files/DriveFileExplorer";
import DriveMenu from "../components/files/DriveMenu";
import useDriveMove from "../hooks/useDriveMove";
import { getDrives, getJson } from "../lib/api";
import { folderHref, isTrashPath, pathBasename, TRASH_PATH, trashDisplayName } from "../lib/paths";
import useFileNavigation from "../hooks/useFileNavigation.js";
import useMovedLinkForwarding from "../hooks/useMovedLinkForwarding.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext";
import { CAP, hasCapOnDrive, memberWritableRoots } from "../lib/shareTree.js";
import { isPresentDrive, isUnopenable } from "../lib/drives.js";

export default function FilePage() {
  const { id } = useParams();
  const {
    path,
    selectPath,
    viewerPath,
    onPathChange,
    onViewerPathChange,
    clearSelectParam,
  } = useFileNavigation();

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

  // Header drive-menu drops: move dragged files to the top of that drive. The
  // file task store sends the jobs and shows how they go.
  const moveFilesMutation = useDriveMove({ driveId: id, driveLabel: drive?.label });

  const unopenable = drive != null && isUnopenable(drive);
  const browsable = drive != null && drive.state !== "missing" && !unopenable;
  // Only an Admin sees a drive's health; a failing or worn drive still browses.
  const health = useDriveHealth(drive ?? { id: id ?? "" }, isAdmin && drive != null);
  const healthCopy = health.data ? describeDriveHealth(health.data) : null;
  const healthNotice = healthCopy?.needsYou ?? null;

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

  // Members don't get a raw drive picker — their destinations are the
  // shared roots they can put files in. Equity with the admin selector, not
  // equality: the menu looks the same but holds different things.
  const userId = user?.id;
  const memberDests = useMemo(() => {
    if (isAdmin || !userId) return null;
    const present = new Set(
      (drives.data || []).filter(isPresentDrive).map((d) => d.id),
    );
    const labelOf = (id) => (drives.data || []).find((d) => d.id === id)?.label;
    return memberWritableRoots(access.data, (id) => present.has(id), labelOf)
      .map((r) => ({
        driveId: r.driveId,
        path: r.path,
        label: r.label,
        sub: labelOf(r.driveId),
        icon: /** @type {"folder"|"drive"} */ (r.path ? "folder" : "drive"),
        writable: true,
      }));
  }, [isAdmin, userId, drives.data, access.data]);

  const showDriveMenu = drive != null
    && drive.state !== "missing"
    && (isAdmin ? presentDriveCount > 1 : (memberDests?.length || 0) > 0);

  // Trigger shows the browsed place: admins get the drive label, members
  // the folder they're inside (their roots are folder-shaped, not drives).
  const currentLabel = isAdmin
    ? undefined
    : (path ? pathBasename(path) : drive?.label);

  // The most specific thing open: the file, else the folder, else the drive.
  const openName = viewerPath ?? path;
  const openLabel = inTrash
    ? (openName === TRASH_PATH ? "Trash" : trashDisplayName(openName))
    : pathBasename(openName);
  usePageTitle(openLabel || drive?.label || "Files");

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
      rightContent={<FileSearchButton />}
    >
      {!drives.isLoading && !drive && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive not found"
          description={
            isAdmin
              ? "Luna can't find this drive. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in."
              : "Luna couldn't open this drive. Ask an Admin if you still need access."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/files">{isAdmin ? "Go to Files" : "Back to Files"}</Link>
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
              ? "This drive is unplugged. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in."
              : "This drive is unplugged. Ask an Admin, or wait until it's plugged back in."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/files">{isAdmin ? "Go to Files" : "Back to Files"}</Link>
            </Button>
          }
        />
      )}

      {drive && unopenable && (
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Luna can't open this drive"
          description={
            isAdmin
              ? "Unplug it and plug it back in, then try again."
              : "Ask an Admin to check it."
          }
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/files">{isAdmin ? "Go to Files" : "Back to Files"}</Link>
            </Button>
          }
        />
      )}

      {drive && browsable && healthNotice && (
        <PageNotice variant={healthNotice.tone === "problem" ? "error" : "warning"} className="mb-4">
          <p>
            <InlinePill>{drive.label}</InlinePill>
            {healthNotice.title}
            {". "}
            <Link to={`/files#drive-${drive.id}`} className="underline decoration-accent underline-offset-2">
              See what&apos;s wrong
            </Link>
            .
          </p>
        </PageNotice>
      )}

      {drive && browsable && inTrash && !canOpenTrash && !access.isLoading && (
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

      {drive && browsable && !(inTrash && !canOpenTrash) && (
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
