import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { getJson } from "../../../lib/api";
import { isConnectBound } from "../../../lib/connectState.js";

function asHttpsUrl(host) {
  const h = String(host || "").trim();
  if (!h) return "";
  if (h.includes("://")) return h;
  return `https://${h}`;
}

function asHttpUrl(hostOrIp) {
  const h = String(hostOrIp || "").trim();
  if (!h) return "";
  if (h.includes("://")) return h;
  return `http://${h}`;
}

/** Addresses that actually open this Luna right now. */
export default function AccessAddressesCard({ index = 2 }) {
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 5000,
    retry: false,
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });

  const bound = isConnectBound(connect.data);
  const publicUrl = bound ? asHttpsUrl(connect.data?.hostname || connect.data?.domain || "") : "";
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  // Local addresses depend on the reported Connect binding, not on a saved
  // verification code. Hide them when Luna reports that LAN access is blocked.
  const lanBlocked = Boolean(bound && !connect.data?.lan_override);

  return (
    <SettingsCard icon={MapPin} title="Where to open Luna" padding={false} index={index}>
      <div className="px-5 py-4 space-y-5">
        {publicUrl ? (
          <section className="space-y-2" aria-labelledby="access-everywhere-heading">
            <h3 id="access-everywhere-heading" className="font-mono text-sm text-primary">Everywhere</h3>
            <CopyableValue
              value={publicUrl}
              copyLabel="Copy"
              ariaLabel="Public Luna address"
            />
          </section>
        ) : null}

        {!lanBlocked ? (
          <section className="space-y-2" aria-labelledby="access-local-heading">
            <h3 id="access-local-heading" className="font-mono text-sm text-primary">On your local network</h3>
            <CopyableValue
              value={asHttpUrl("luna.local")}
              copyLabel="Copy"
              ariaLabel="luna.local address"
            />
            {ipv4.map((ip) => (
              <CopyableValue
                key={ip}
                value={asHttpUrl(ip)}
                copyLabel="Copy"
                ariaLabel={`Network address ${ip}`}
              />
            ))}
          </section>
        ) : null}
        {lanBlocked ? (
          <p className="text-sm text-secondary">
            Local access is turned off while Luna Connect is connected.
          </p>
        ) : null}
        {lanBlocked && !publicUrl ? (
          <p className="text-sm text-secondary">
            No way to open Luna is ready right now. Wait a moment and try again.
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
