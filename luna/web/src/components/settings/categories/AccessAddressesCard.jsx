import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import CopyableValue from "../../ui/CopyableValue";
import SettingsCard from "../SettingsCard";
import { getJson } from "../../../lib/api";

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

/** Addresses to open this Luna — public vs home-network only. */
export default function AccessAddressesCard({ index = 2 }) {
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 5000,
    retry: false,
  });
  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
    retry: false,
  });

  const publicUrl = asHttpsUrl(connect.data?.hostname || connect.data?.domain || "");
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  const ethernet = Boolean(netStatus.data?.ethernet_connected);

  return (
    <SettingsCard icon={MapPin} title="Where to open Luna" padding={false} index={index}>
      <div className="px-5 py-4 space-y-5">
        <section className="space-y-2" aria-labelledby="access-everywhere-heading">
          <h3 id="access-everywhere-heading" className="font-mono text-sm font-medium text-primary">
            Everywhere
          </h3>
          {publicUrl ? (
            <CopyableValue
              value={publicUrl}
              copyLabel="Copy"
              ariaLabel="Public Luna address"
            />
          ) : (
            <p className="text-sm text-primary">None yet</p>
          )}
        </section>

        <section className="space-y-2" aria-labelledby="access-home-heading">
          <h3 id="access-home-heading" className="font-mono text-sm font-medium text-primary">
            On your home network only
          </h3>
          <CopyableValue
            value={asHttpUrl("luna.local")}
            copyLabel="Copy"
            ariaLabel="luna.local address"
          />
          {ipv4.length > 0 ? (
            ipv4.map((ip) => (
              <CopyableValue
                key={ip}
                value={asHttpUrl(ip)}
                copyLabel="Copy"
                ariaLabel={`Network address ${ip}`}
              />
            ))
          ) : (
            <p className="text-sm text-primary">
              {ethernet ? "Waiting for an address" : "Not plugged in"}
            </p>
          )}
        </section>
      </div>
    </SettingsCard>
  );
}
