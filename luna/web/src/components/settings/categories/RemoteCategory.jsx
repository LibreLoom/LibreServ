import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Globe2 } from "lucide-react";
import PathTrail from "@libreloom/ui/components/common/PathTrail.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import { getJson } from "../../../lib/api";
import { connectState, isConnectBound } from "../../../lib/connectState.js";
import { useOptionalAuth } from "../../../context/AuthContext";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const LUNA_CONNECT_URL = "https://connect.luna.libreloom.org";

const STATUS = {
  loading: { label: "Loading", variant: "muted" },
  unbound: { label: "Not paired", variant: "muted" },
  pairing: { label: "Pairing", variant: "info" },
  bound: { label: "Connected", variant: "success" },
  pending: { label: "Disconnect pending", variant: "warning" },
  revoked: { label: "Reconnect required", variant: "error" },
};

export default function RemoteCategory() {
  const status = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });

  const s = status.data || {};
  const state = connectState(status.data);
  const connected = isConnectBound(s);
  const host = connected ? (s.hostname || s.domain || "") : "";
  const address = host ? (host.includes("://") ? host : `https://${host}`) : "";
  const connectError = s.connect_error || "";
  const unreachable = s.connect_unreachable || "";
  const hardError = connectError || unreachable || (state === "revoked"
    ? "Luna Connect revoked this Luna. Reconnect it from your Connect account."
    : "");
  const tunnelWarn = connected && !hardError ? (s.tunnel_error || "") : "";
  const pill = STATUS[state];
  const isAdmin = useOptionalAuth()?.user?.role === "admin";

  return (
    <div className="space-y-5">
      <SettingsCard
        icon={Globe2}
        title="Luna Connect"
        headerActions={<Pill variant={pill.variant}>{pill.label}</Pill>}
      >
        <div className="space-y-4 px-4 pb-4">
          <div
            className="surface-primary rounded-large-element px-4 py-4 space-y-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
            aria-labelledby="luna-connect-public-address-label"
          >
            <p
              id="luna-connect-public-address-label"
              className="font-mono text-xs text-secondary"
            >
              Public address
            </p>

            {hardError ? (
              <div
                className="rounded-large-element border-2 border-error/30 bg-error/20 px-3 py-3 space-y-2"
                role="alert"
              >
                <p className="text-sm text-secondary leading-relaxed">{hardError}</p>
              </div>
            ) : address ? (
              <CopyableValue
                value={address}
                copyLabel="Copy address"
                ariaLabel="Luna Connect address"
                surface="primary"
              />
            ) : (
              <div className="space-y-1">
                <p className="font-mono text-lg leading-snug text-secondary">
                  No public address yet
                </p>
                <p className="font-mono text-sm text-secondary break-all">
                  <TermHint
                    content="The short name you pick on Luna Connect becomes the first part of this address, for example kitchen in kitchen.luna.servers.libreloom.org."
                    surface="primary"
                  >
                    yourname
                  </TermHint>
                  .luna.servers.libreloom.org
                </p>
              </div>
            )}

            {tunnelWarn ? (
              <div
                className="rounded-large-element border-2 border-warning/30 bg-warning/20 px-3 py-3"
                role="status"
              >
                <p className="text-sm text-secondary leading-relaxed">{tunnelWarn}</p>
              </div>
            ) : null}
          </div>

          {state === "pending" && !hardError ? (
            <p className="text-primary text-sm leading-relaxed" role="status">
              Remote access and pairing are off until Luna finishes disconnecting.
            </p>
          ) : null}

          {!connected && !hardError && state !== "pending" && status.data ? (
            <p className="text-primary text-sm leading-relaxed">
              {state === "pairing"
                ? "Luna Connect is waiting for Luna to finish pairing."
                : isAdmin
                  ? "Pair this Luna in Luna Connect with its device token."
                  : "An Admin can pair this Luna from Luna Connect."}
            </p>
          ) : null}

          {connected ? (
            <>
              {address ? (
                <p className="text-primary text-sm leading-relaxed">
                  To change this address, open <PathTrail steps={["Luna Connect", "Devices", "Change address"]} />.
                </p>
              ) : (
                <p className="text-primary text-sm leading-relaxed">
                  Pick a name on Luna Connect. The address shows here when it is ready.
                </p>
              )}
              <Button variant="outline" fullWidth asChild className="justify-between">
                <a href={LUNA_CONNECT_URL} target="_blank" rel="noopener noreferrer">
                  <span>Manage on Luna Connect</span>
                  <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
                </a>
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              fullWidth
              asChild
              className="justify-between motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
            >
              <a href={LUNA_CONNECT_URL} target="_blank" rel="noopener noreferrer">
                <span>Open Luna Connect</span>
                <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
