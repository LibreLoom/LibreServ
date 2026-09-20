import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuth";

export function useCatalog() {
  const { request } = useAuth();

  return useQuery({
    queryKey: ["catalog"],
    queryFn: async () => {
      const res = await request("/catalog");
      const data = await res.json();
      return data.apps || [];
    },
    staleTime: 5 * 60_000,
  });
}
