import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, postJson } from "../lib/api";
import { submitBatch } from "../lib/submitBatch.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";

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
 * plain-language message — except `broadens_access`, which goes to
 * `onBroaden` so the caller can ask before retrying with `confirmBroaden`.
 *
 * @param {{ driveId: string, onError?: (message: string) => void,
 *   onBroaden?: (retry: () => Promise<unknown>) => void }} options
 */
export default function useDriveMove({ driveId, onError, onBroaden }) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const move = useMutation({
    mutationFn: async (
      /** @type {{ paths: string[], destFolder?: string, destDriveId?: string, fromDriveId?: string, confirmBroaden?: boolean }} */
      { paths, destFolder = "", destDriveId, fromDriveId, confirmBroaden = false },
    ) => {
      const fromDrive = fromDriveId || driveId;
      const toDrive = destDriveId || driveId;
      await submitBatch(paths, (fromPath) => postJson("/api/v1/jobs", {
        kind: "move",
        from_drive: fromDrive,
        from_path: fromPath,
        to_drive: toDrive,
        to_path: destFolder,
        ...(confirmBroaden ? { confirm_broaden: true } : {}),
      }));
    },
    onSuccess: (_data, vars) => {
      const n = vars.paths?.length || 0;
      addToast({
        type: "success",
        message: n === 1 ? "Luna is moving that file." : `Luna is moving ${n} items.`,
      });
      const fromDrive = vars.fromDriveId || driveId;
      queryClient.invalidateQueries({ queryKey: ["files", fromDrive] });
      queryClient.invalidateQueries({ queryKey: ["trash", fromDrive] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      const toDrive = vars.destDriveId || driveId;
      if (toDrive !== fromDrive) {
        queryClient.invalidateQueries({ queryKey: ["files", toDrive] });
      }
    },
    onError: (err, vars) => {
      // Widening who can open something that left a private folder needs a
      // yes from the person — the caller turns this into a confirm.
      const detail = /** @type {any} */ (err);
      if (detail?.pendingItems?.length < vars.paths.length) {
        queryClient.invalidateQueries({ queryKey: ["files"] });
        queryClient.invalidateQueries({ queryKey: ["jobs"] });
      }
      if (detail?.code === "broadens_access" && onBroaden) {
        haptic("warning");
        onBroaden(() => move.mutateAsync({ ...vars, paths: detail.pendingItems || vars.paths, confirmBroaden: true }));
        return;
      }
      haptic("error");
      onError?.(apiErrorMessage(err, "Couldn't move those files. Try again."));
    },
  });
  return move;
}
