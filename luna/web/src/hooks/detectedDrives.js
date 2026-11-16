import { getJson } from "../lib/api.js";

/**
 * How often drive lists refresh while a page shows them. Each detected call
 * makes lunad rescan block devices and mounts, which is real work on a slow
 * box, so this is not every few seconds. Adopt, eject, remove, format and
 * unlock refresh both lists themselves the moment they finish.
 */
export const DRIVE_POLL_MS = 15_000;

/**
 * The one set of options for the plugged-in drives Luna has not added yet,
 * so the dashboard, Needs you and the Files page share one cache entry and one
 * poll. Admins only.
 *
 * @param {boolean} isAdmin
 */
export function detectedDrivesQueryOptions(isAdmin) {
  return {
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: DRIVE_POLL_MS,
    enabled: Boolean(isAdmin),
  };
}
