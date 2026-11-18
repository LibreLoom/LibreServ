// The data the Dashboard waits for before it counts as usable: the drives,
// the signed-in person's recents and, for a Member, what is shared with them.
// DashboardPage reads these queries and sign-in starts them early, so both
// must use the same keys and fetchers: they live here, once.
import { getDrives, getJson, getRecents } from "./api.js";

export const drivesQuery = { queryKey: ["drives"], queryFn: getDrives };

/** @param {string | undefined} username */
export function recentsQuery(username) {
  return { queryKey: ["recents", username], queryFn: getRecents, enabled: Boolean(username) };
}

/** @param {boolean} enabled only Members read it */
export function myAccessQuery(enabled) {
  return { queryKey: ["my-access"], queryFn: () => getJson("/api/v1/me/access"), enabled };
}

/**
 * Start the Dashboard's requests the moment sign-in succeeds, so they run
 * while the Dashboard's code renders instead of after it (W3). Failures are
 * left to the page's own queries, which show and retry them.
 * @param {import("@tanstack/react-query").QueryClient} queryClient
 * @param {{ username?: string, role?: string } | null | undefined} user
 */
export function prefetchDashboard(queryClient, user) {
  if (!user?.username) return;
  queryClient.prefetchQuery(drivesQuery);
  queryClient.prefetchQuery(recentsQuery(user.username));
  if (user.role !== "admin") queryClient.prefetchQuery(myAccessQuery(true));
}
