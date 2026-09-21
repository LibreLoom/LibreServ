import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useCatalogFeatures(appId) {
  const { request } = useAuth();

  return useQuery({
    queryKey: ["catalog", appId, "features"],
    queryFn: async () => {
      const res = await request(`/catalog/${appId}/features`);
      const data = await res.json();
      return data;
    },
    enabled: !!appId,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
