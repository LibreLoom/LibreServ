import { useQuery } from "@tanstack/react-query";
import { ApiError, getJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const REFRESH_MS = 60 * 60 * 1000;

/**
 * Polls for Luna software updates (admin only). Matches the backend's
 * one-hour release cache; checks run automatically in lunad too.
 */
export function useSoftwareUpdates(refreshInterval = REFRESH_MS) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return useQuery({
    queryKey: ["system-updates"],
    queryFn: () => getJson("/api/v1/system/updates"),
    enabled: isAdmin,
    refetchInterval: isAdmin ? refreshInterval : false,
    retry: (count, err) => {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        return false;
      }
      return count < 1;
    },
  });
}
