import { useQuery } from "@tanstack/react-query";
import { getJsonAllowErrorStatus } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const REFRESH_MS = 60_000;

/**
 * Comprehensive Luna health checks (filesystem, drives, disk space).
 * Admin-only — Members should not see system inventory.
 * The backend returns 503 when checks fail — the body still has full results.
 *
 * @param {number} [refreshInterval]
 */
export function useSystemHealthCheck(refreshInterval = REFRESH_MS) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  return useQuery({
    queryKey: ["system-health-check"],
    queryFn: () => getJsonAllowErrorStatus("/api/v1/system/health/check"),
    enabled: isAdmin,
    refetchInterval: isAdmin ? refreshInterval : false,
    retry: 1,
  });
}
