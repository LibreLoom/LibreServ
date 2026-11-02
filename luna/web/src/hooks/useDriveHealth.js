import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api.js";

/**
 * The one set of options for a drive's health report, so every screen that
 * asks shares one cache entry. Only Admins ask, only for a drive Luna can
 * open (as is or read-only, and mounted).
 *
 * @param {{ id: string, state?: string, mounted?: boolean }} drive
 * @param {boolean} isAdmin
 */
export function driveHealthQueryOptions(drive, isAdmin) {
  return {
    queryKey: ["drive-health", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/health`),
    retry: false,
    enabled:
      Boolean(isAdmin) &&
      (drive.state === "as_is" || drive.state === "readonly") &&
      drive.mounted !== false,
  };
}

/**
 * A drive's health report (GET /api/v1/drives/:id/health).
 *
 * @param {{ id: string, state?: string, mounted?: boolean }} drive
 * @param {boolean} isAdmin
 */
export default function useDriveHealth(drive, isAdmin) {
  return useQuery(driveHealthQueryOptions(drive, isAdmin));
}
