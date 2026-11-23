import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useMonitoring(refreshInterval) {
  return useQuery({
    queryKey: ["monitoring"],
    queryFn: async () => {
      const res = await api("/monitoring/system");
      const data = await res.json();
      if (!data?.resources) {
        throw new Error("Missing resources in /monitoring/system response");
      }
      return data.resources;
    },
    refetchInterval: refreshInterval ?? 60_000,
    // This query polls; a tab focus should not add a second request burst.
    refetchOnWindowFocus: false,
  });
}
