import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";

/** True when `{data_dir}/device-token` exists with a valid device token (Connect active). */
export default function useConnectActive() {
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => getJson("/api/v1/auth/status"),
    staleTime: 60_000,
  });
  return Boolean(status.data?.connect_active);
}
