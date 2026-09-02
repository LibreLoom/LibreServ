import { useQuery } from "@tanstack/react-query";
import { Globe2 } from "lucide-react";
import CopyableValue from "../../ui/CopyableValue";
import Pill from "../../common/Pill";
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

  return (
    <div className="space-y-5">
      <SettingsCard
        icon={Globe2}
        title="Luna Connect"
        headerActions={s.enabled ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>}
      >
        <div className="space-y-3 px-4 pb-4">
          {s.enabled && address ? (
            <>
              <p className="text-primary text-sm">Your Luna address:</p>
              <CopyableValue
                value={address}
                copyLabel="Copy address"
                ariaLabel="Luna Connect address"
              />
            </>
          ) : null}
          <p className="text-primary text-sm leading-relaxed">
            Configure your subdomain &amp; add cloud backup on{" "}
            <a
              href={LUNA_CONNECT_URL}
              className="text-accent hover:text-primary motion-safe:transition-colors underline underline-offset-4"
              target="_blank"
              rel="noopener noreferrer"
            >
              Luna Connect
            </a>
            .
          </p>
        </div>
      </SettingsCard>
    </div>
  );
}
