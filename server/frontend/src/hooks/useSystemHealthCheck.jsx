import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

// Fetches the comprehensive system health check (component checks + summary).
// Polled less frequently than resource metrics since each run does real work
// (disk stat, SMTP probe, path checks).
export function useSystemHealthCheck(refreshInterval) {
  return useQuery({
    queryKey: ["system-health-check"],
    queryFn: async () => {
      const res = await api("/system/health/check");
      if (!res.ok) {
        throw new Error(`System health check failed: ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: refreshInterval ?? 60_000,
    retry: 1,
  });
}