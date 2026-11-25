import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";

/** True when Luna reports an active Connect binding, not merely saved pairing material. */
export default function useConnectActive() {
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => getJson("/api/v1/auth/status"),
    staleTime: 60_000,
  });
  return Boolean(status.data?.connect_active);
}
