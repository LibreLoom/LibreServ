import { useCallback } from "react";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

import { releaseInspectedDrive } from "../lib/drives.js";

/**
 * Returns a function that lets go of the drive an inspect window was showing.
 * Closing the window has no inline home for a failure, so it is announced
 * once as an error toast.
 * @returns {(drive: { name?: string, model?: string } | null | undefined) => Promise<void>}
 */
export default function useReleaseInspectedDrive() {
  const { addToast } = useToast();
  return useCallback(
    async (drive) => {
      try {
        await releaseInspectedDrive(drive);
      } catch {
        addToast({
          type: "error",
          message: `Luna couldn't finish closing ${drive?.model || "this drive"}.`,
          description: "Unplug it, wait a few seconds, and plug it back in.",
        });
      }
    },
    [addToast],
  );
}
