import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import CopyableValue from "../../ui/CopyableValue";
import SettingsCard from "../SettingsCard";
import { TermHint } from "../../ui/Tooltip";
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

/**
 * Lists every address where this Luna can be opened, split into
 * everywhere (public Connect URL) vs home-network-only (luna.local + LAN IP).
 */
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

  const publicHost = connect.data?.hostname || connect.data?.domain || "";
  const publicUrl = asHttpsUrl(publicHost);
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  const ethernet = Boolean(netStatus.data?.ethernet_connected);
  const lunaLocalUrl = asHttpUrl("luna.local");

  return (
    <SettingsCard icon={MapPin} title="Where to open Luna" padding={false} index={index}>
      <div className="px-5 py-4 space-y-6">
        <p className="text-sm text-primary leading-relaxed">
          Type one of these addresses in a browser on your phone or computer to open this Luna.
        </p>

        <section className="space-y-3" aria-labelledby="access-everywhere-heading">
          <div>
            <h3
              id="access-everywhere-heading"
              className="font-mono text-sm font-medium text-primary"
            >
              Everywhere
            </h3>
            <p className="text-sm text-primary leading-relaxed mt-1">
              Works from any internet connection — at home or away.
            </p>
          </div>
          {publicUrl ? (
            <div className="space-y-2">
              <p className="text-sm text-primary font-medium">Public address</p>
              <CopyableValue
                value={publicUrl}
                copyLabel="Copy address"
                ariaLabel="Public Luna address"
              />
            </div>
          ) : (
            <p className="text-sm text-primary leading-relaxed">
              No public address yet. When Luna Connect is set up, your public address
              appears here so you can open this Luna from outside your home.
            </p>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="access-home-heading">
          <div>
            <h3 id="access-home-heading" className="font-mono text-sm font-medium text-primary">
              On your home network only
            </h3>
            <p className="text-sm text-primary leading-relaxed mt-1">
              Only works while your phone or computer is on the same home{" "}
              <TermHint content="Your home Wi‑Fi or wired network — the same connection your router or modem provides indoors.">
                network
              </TermHint>{" "}
              as Luna.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-primary font-medium">luna.local</p>
            <CopyableValue
              value={lunaLocalUrl}
              copyLabel="Copy address"
              ariaLabel="luna.local address"
            />
            <p className="text-sm text-primary leading-relaxed">
              A friendly name many phones and computers can find automatically on your home network.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-primary font-medium">Network address</p>
            {ipv4.length > 0 ? (
              <div className="space-y-2">
                {ipv4.map((ip) => (
                  <CopyableValue
                    key={ip}
                    value={asHttpUrl(ip)}
                    copyLabel="Copy address"
                    ariaLabel={`Network address ${ip}`}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-primary leading-relaxed">
                {ethernet
                  ? "Cable is plugged in. Waiting for an address from your router or modem."
                  : "Plug Luna into your router or modem with the included RJ45 (ethernet) cable. The network address will show up here once Luna is connected."}
              </p>
            )}
          </div>
        </section>
      </div>
    </SettingsCard>
  );
}
