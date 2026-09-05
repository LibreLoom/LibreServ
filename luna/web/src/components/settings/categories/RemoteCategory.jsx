import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Globe2 } from "lucide-react";
import { Link } from "react-router-dom";
import CopyableValue from "../../ui/CopyableValue";
import Button from "../../ui/Button";
import Pill from "../../common/Pill";
import { TermHint } from "../../ui/Tooltip";
import SettingsCard from "../SettingsCard";
import { getJson } from "../../../lib/api";

const LUNA_CONNECT_URL = "https://connect.luna.libreloom.org";

export default function RemoteCategory() {
  const status = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });

  const s = status.data || { enabled: false };
  const host = s.hostname || s.domain || "";
  const address = host ? (host.includes("://") ? host : `https://${host}`) : "";
  const tokenError = s.device_token_error || "";
  const unreachable = s.connect_unreachable || "";
  const tunnelError = s.tunnel_error || "";
  const hardError = tokenError || unreachable;
  const tunnelWarn = !hardError ? tunnelError : "";
  const isOn = Boolean(s.enabled);

  return (
    <div className="space-y-5">
      <SettingsCard
        icon={Globe2}
        title="Luna Connect"
        headerActions={
          isOn ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>
        }
      >
        <div className="space-y-4 px-4 pb-4">
          <div
            className="bg-primary text-secondary rounded-large-element px-4 py-4 space-y-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
            aria-labelledby="luna-connect-public-address-label"
          >
            <p
              id="luna-connect-public-address-label"
              className="font-mono text-xs uppercase tracking-widest text-secondary"
            >
              Public address
            </p>

            {hardError ? (
              <div
                className="rounded-large-element border-2 border-error/30 bg-error/20 px-3 py-3 space-y-2"
                role="alert"
              >
                <p className="text-sm text-error leading-relaxed">{hardError}</p>
                {tokenError ? (
                  <Button variant="outline" surface="primary" size="sm" asChild>
                    <Link to="/settings#about">Change the device token in About → Advanced</Link>
                  </Button>
                ) : null}
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
                    content="The short name you pick on Luna Connect becomes the first part of this address — for example kitchen in kitchen.luna.servers.libreloom.org."
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
                <p className="text-sm text-warning leading-relaxed">{tunnelWarn}</p>
              </div>
            ) : null}
          </div>

          {!isOn && !hardError ? (
            <p className="text-primary text-sm leading-relaxed motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
              Pick a name on Luna Connect. Luna shows the address here once it is ready. You can
              also add cloud backup there.
            </p>
          ) : null}

          {isOn ? (
            <Button variant="outline" fullWidth asChild className="justify-between">
              <a href={LUNA_CONNECT_URL} target="_blank" rel="noopener noreferrer">
                <span>Manage on Luna Connect</span>
                <ChevronRight size={16} aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Button
              variant="primary"
              fullWidth
              asChild
              className="justify-between motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
            >
              <a href={LUNA_CONNECT_URL} target="_blank" rel="noopener noreferrer">
                <span>Open Luna Connect</span>
                <ChevronRight size={16} aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
