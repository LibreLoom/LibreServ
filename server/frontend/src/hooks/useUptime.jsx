import { useQuery } from "@tanstack/react-query";

export function useUptime() {
  return useQuery({
    queryKey: ["uptime"],
    queryFn: async () => {
      const res = await fetch("/health");
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const data = await res.json();
      return data.uptime_seconds ?? 0;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}
