import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useAppUpdates(appId) {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["apps", appId, "updates"],
    queryFn: async () => {
      const res = await request(`/apps/updates/available`);
      if (!res.ok) return null;
      const updates = await res.json();
      return updates?.updates?.find((u) => u.instance_id === appId) || null;
    },
    enabled: !!appId,
    staleTime: 60_000,
  });
}