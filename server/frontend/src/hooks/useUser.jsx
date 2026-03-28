import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useUser() {
  return useQuery({
    queryKey: ["user"],
    queryFn: async () => {
      const res = await api("/auth/me");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
}
