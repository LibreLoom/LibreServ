import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useAppActions(appId) {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["apps", appId, "actions"],
    queryFn: async () => {
      const res = await request(`/apps/${appId}/actions`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.actions || [];
    },
    enabled: !!appId,
    staleTime: 60_000,
  });
}