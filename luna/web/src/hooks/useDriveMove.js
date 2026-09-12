import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, postJson } from "../lib/api";
import { haptic } from "../utils/haptics";

/**
 * Move files or folders through Luna's job queue — within one drive or
 * across drives. Shared by the file list (drag onto folders/breadcrumbs)
 * and the Files page drive menu (drop onto another drive's item).
 *
 * `driveId` is the drive that owns this hook — normally the drag's source.
 * A drop can carry an explicit `fromDriveId` when the source differs (a
 * spring-loaded cross-drive drag whose payload started on another drive).
 *
 * On success it invalidates the source drive's file list and trash plus
 * the jobs list; a cross-drive move also invalidates the destination
 * drive's files. Failures are reported through `onError` with a
 * plain-language message.
 *
 * @param {{ driveId: string, onError?: (message: string) => void }} options
 */
export default function useDriveMove({ driveId, onError }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      /** @type {{ paths: string[], destFolder?: string, destDriveId?: string, fromDriveId?: string }} */
      { paths, destFolder = "", destDriveId, fromDriveId },
    ) => {
      const fromDrive = fromDriveId || driveId;
      const toDrive = destDriveId || driveId;
      for (const fromPath of paths) {
        await postJson("/api/v1/jobs", {
          kind: "move",
          from_drive: fromDrive,
          from_path: fromPath,
          to_drive: toDrive,
          to_path: destFolder,
        });
      }
    },
    onSuccess: (_data, vars) => {
      haptic("success");
      const fromDrive = vars.fromDriveId || driveId;
      queryClient.invalidateQueries({ queryKey: ["files", fromDrive] });
      queryClient.invalidateQueries({ queryKey: ["trash", fromDrive] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      const toDrive = vars.destDriveId || driveId;
      if (toDrive !== fromDrive) {
        queryClient.invalidateQueries({ queryKey: ["files", toDrive] });
      }
    },
    onError: (err) => {
      haptic("error");
      onError?.(apiErrorMessage(err, "Couldn't move those files. Try again."));
    },
  });
}
