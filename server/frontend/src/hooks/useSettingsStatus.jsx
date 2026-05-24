import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export function useSettingsStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["settings-status"],
    queryFn: async () => {
      const res = await api("/system/health/check");
      const data = await res.json();

      const smtpCheck = data?.checks?.smtp;
      const smtpConfigured =
        smtpCheck?.status === "passed" &&
        !(smtpCheck?.details?.optional === true);

      let domainConfigured = false;
      try {
        const proxyRes = await api("/settings/proxy");
        const proxyData = await proxyRes.json();
        const domain = proxyData?.proxy?.default_domain;
        domainConfigured =
          !!domain && domain !== "localhost" && domain !== "127.0.0.1";
      } catch {
        // Not authenticated — domain info unavailable
      }

      return { smtpConfigured, domainConfigured };
    },
    staleTime: 60_000,
    retry: 1,
  });

  return {
    smtpConfigured: data?.smtpConfigured ?? false,
    domainConfigured: data?.domainConfigured ?? false,
    isLoading,
  };
}
