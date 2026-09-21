import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useAppDetail(instanceId) {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["apps", instanceId],
    queryFn: async () => {
      const res = await request(`/apps/${instanceId}`);
      return res.json();
    },
    enabled: !!instanceId,
    retry: (failureCount, error) => {
      // 404 = app not found — don't retry, it's a dead end.
      if (/** @type {{ status?: number }} */ (/** @type {any} */ (error)?.cause)?.status === 404) return false;
      return failureCount < 3;
    },
  });
}