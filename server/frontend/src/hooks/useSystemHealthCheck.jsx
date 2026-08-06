import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

// Fetches the comprehensive system health check (component checks + summary).
// Polled less frequently than resource metrics since each run does real work
// (disk stat, SMTP probe, path checks).
//
// The backend answers 503 (Service Unavailable) when any check fails — the
// body still carries the full check results, so allowNonOk keeps the data
// flowing when the system is unhealthy (the whole point of this query).
export function useSystemHealthCheck(refreshInterval) {
  return useQuery({
    queryKey: ["system-health-check"],
    queryFn: async () => {
      const res = await api("/system/health/check", { allowNonOk: true });
      return res.json();
    },
    refetchInterval: refreshInterval ?? 60_000,
    retry: 1,
  });
}