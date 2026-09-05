import PropTypes from "prop-types";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../lib/api";

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

const addressLinkClass =
  "font-mono text-xs text-secondary break-all underline hover:no-underline motion-safe:transition-colors";

/**
 * Where to find Luna after install — remote (when configured) + home LAN.
 *
 * Layout:
 *   Access <name> here:
 *   Everywhere:                         ← only when remote access is configured
 *     whatever.luna.servers.libreloom.org
 *   On your home internet only:
 *     luna.local
 *     192.168.1.118
 */
export default function DiscoveryPaths({ name }) {
  const label = (name && String(name).trim()) || "Luna";
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
      <h3 className="font-mono text-sm text-secondary tracking-tight">
        Access {label} here:
      </h3>
      {remoteHost ? (
        <div>
          <p className="text-xs text-secondary mb-2">From anywhere (when Luna Connect is on):</p>
          <a
            href={asHttpsUrl(remoteHost)}
            target="_blank"
            rel="noreferrer"
            className={addressLinkClass}
          >
            {remoteHost}
          </a>
        </div>
      ) : null}
      <div>
        <p className="text-xs text-secondary mb-2">On your home network only:</p>
        <ul className="space-y-1.5 text-xs font-mono text-secondary">
          <li>
            <a
              href={asHttpUrl("luna.local")}
              target="_blank"
              rel="noreferrer"
              className={addressLinkClass}
            >
              luna.local
            </a>
          </li>
          {ipv4.map((ip) => (
            <li key={ip}>
              <a
                href={asHttpUrl(ip)}
                target="_blank"
                rel="noreferrer"
                className={addressLinkClass}
              >
                {ip}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

DiscoveryPaths.propTypes = {
  name: PropTypes.string,
};
