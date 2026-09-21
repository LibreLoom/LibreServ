import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useAppMetrics(appId) {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["apps", appId, "metrics"],
    queryFn: async () => {
      const res = await request(`/apps/${appId}/metrics`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!appId,
    refetchInterval: 30_000,
    retry: 1,
  });
}