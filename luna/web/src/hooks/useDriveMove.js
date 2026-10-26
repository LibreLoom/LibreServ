import { useQueryClient } from "@tanstack/react-query";
import { useFileOps } from "../context/FileOpsContext.jsx";
import { isTrashPath, pathBasename, trashDisplayName } from "../lib/paths.js";

/**
 * Move files or folders through Luna's job queue, within one drive or across
 * drives. Shared by the file list (drag onto folders/breadcrumbs) and the
 * Files page drive menu (drop onto another drive's item).
 *
 * This only hands the work to the file task store. The store sends the jobs
 * (four at a time), shows them in the file task card, asks about name clashes
 * and private-folder moves in their rows, and keeps failures visible.
 *
 * `driveId` is the drive that owns this hook, normally the drag's source. A
 * drop can carry an explicit `fromDriveId` when the source differs (a
 * spring-loaded cross-drive drag whose payload started on another drive).
 * `driveLabel` names `driveId` for the card when a drop lands at its top level.
 *
 * @param {{ driveId: string, driveLabel?: string }} options
 */
export default function useDriveMove({ driveId, driveLabel = "" }) {
  const fileOps = useFileOps();
  const queryClient = useQueryClient();

  /**
   * @param {{ paths: string[], destFolder?: string, destDriveId?: string, fromDriveId?: string, destLabel?: string }} input
   */
  function mutate({ paths, destFolder = "", destDriveId, fromDriveId, destLabel }) {
    const fromDrive = fromDriveId || driveId;
    const toDrive = destDriveId || driveId;
    const drives = /** @type {{ id: string, label?: string }[]|undefined} */ (queryClient.getQueryData(["drives"]));
    const driveName = toDrive === driveId && driveLabel
      ? driveLabel
      : (drives || []).find((d) => d.id === toDrive)?.label || "";
    fileOps.startJobs({
      kind: "move",
      fromDrive,
      items: paths.map((path) => ({
        path,
        name: isTrashPath(path) ? trashDisplayName(path) : pathBasename(path),
      })),
      toDrive,
      toPath: destFolder,
      toLabel: destFolder ? pathBasename(destFolder) : destLabel || driveName,
    });
  }

  return { mutate };
}
