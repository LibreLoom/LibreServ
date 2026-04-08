import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useApps(refreshInterval) {
  const { request } = useAuth();

  return useQuery({
    queryKey: ["apps"],
    queryFn: async () => {
      const res = await request("/apps");
      const data = await res.json();
      return data.apps || [];
    },
    refetchInterval: refreshInterval ?? 30_000,
  });
}

export function useInvalidateApps() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["apps"] });
}
