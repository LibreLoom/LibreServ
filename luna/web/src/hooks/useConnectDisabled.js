import { useQuery } from "@tanstack/react-query";
import { getJson } from "../lib/api";

/** True when `{data_dir}/disable-connect` exists on the Luna (Connect fully off). */
export default function useConnectDisabled() {
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => getJson("/api/v1/auth/status"),
    staleTime: 60_000,
  });
  return Boolean(status.data?.connect_disabled);
}
