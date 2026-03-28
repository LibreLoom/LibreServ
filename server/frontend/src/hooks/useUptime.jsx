import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useUptime() {
  return useQuery({
    queryKey: ["uptime"],
    queryFn: async () => {
      const res = await api("/health");
      const data = await res.json();
      return data.uptime_seconds ?? 0;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
