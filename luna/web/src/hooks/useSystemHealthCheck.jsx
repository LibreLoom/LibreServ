import { useQuery } from "@tanstack/react-query";
import { getJsonAllowErrorStatus } from "../lib/api";

const REFRESH_MS = 60_000;

/**
 * Comprehensive Luna health checks (filesystem, drives, disk space).
 * The backend returns 503 when checks fail — the body still has full results.
 *
 * @param {number} [refreshInterval]
 */
export function useSystemHealthCheck(refreshInterval = REFRESH_MS) {
  return useQuery({
    queryKey: ["system-health-check"],
    queryFn: () => getJsonAllowErrorStatus("/api/v1/system/health/check"),
    refetchInterval: refreshInterval,
    retry: 1,
  });
}
