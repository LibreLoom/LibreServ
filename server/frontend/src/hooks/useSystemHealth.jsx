import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useSystemHealth(refreshInterval) {
  return useQuery({
    queryKey: ["system-health"],
    queryFn: async () => {
      const res = await api("/system/health");
      const data = await res.json();
      return data;
    },
    refetchInterval: refreshInterval ?? 30000,
    retry: 2,
  });
}
