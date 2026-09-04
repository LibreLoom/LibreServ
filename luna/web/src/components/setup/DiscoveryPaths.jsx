import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

/**
 * Where to find Luna after install — remote (when configured) + home LAN.
 *
 * Layout:
 *   Everywhere:                         ← only when remote access is configured
 *     whatever.luna.servers.libreloom.org
 *   On your home internet only:
 *     luna.local
 *     192.168.1.118
 */
export default function DiscoveryPaths() {
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 3000,
    retry: false,
  });
  const connectStatus = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
    retry: false,
  });
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  const remoteHost = (() => {
    const s = connectStatus.data;
    if (!s || s.device_token_error) return "";
    const host = String(s.hostname || s.domain || "").trim();
    return host || "";
  })();

  return (
    <div className="mt-8 w-full bg-primary text-secondary rounded-large-element p-5 text-left space-y-4">
      {remoteHost ? (
        <div>
          <p className="text-xs text-secondary mb-2">Everywhere:</p>
          <p className="font-mono text-xs text-secondary break-all">{remoteHost}</p>
        </div>
      ) : null}
      <div>
        <p className="text-xs text-secondary mb-2">On your home internet only:</p>
        <ul className="space-y-1.5 text-xs font-mono text-secondary">
          <li>luna.local</li>
          {ipv4.map((ip) => (
            <li key={ip}>{ip}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
