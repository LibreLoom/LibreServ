import { Info, Heart } from "lucide-react";
import CollapsibleSection from "../../common/CollapsibleSection";
import ValueDisplay from "../../common/ValueDisplay";
import StatusBadge from "../../common/StatusBadge";
import SettingsCard from "../SettingsCard";

const APP_VERSION = "1.0.0";

export default function AboutCategory({ settings }) {
  return (
    <div className="space-y-4">
      <SettingsCard icon={Info} title="Application" padding={false} index={0}>
        <div className="px-5 py-4 space-y-4">
          <ValueDisplay label="Version" value={APP_VERSION} />

          <CollapsibleSection title="Server Details" size="sm" pill defaultOpen mono>
            <div className="space-y-2">
              <ValueDisplay label="Backend API" value={settings?.server?.host} />
              <ValueDisplay label="Server Port" value={settings?.server?.port} />
              <ValueDisplay label="Proxy Type" value={settings?.proxy?.type || "None"} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Backend Info" mono size="sm" pill>
            <div className="space-y-2">
              <ValueDisplay label="Host" value={settings?.server?.host || "N/A"} />
              <ValueDisplay label="Port" value={settings?.server?.port || "N/A"} />
              <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                <span className="text-sm text-accent">Mode</span>
                <StatusBadge variant={settings?.server?.mode === "production" ? "default" : "warning"}>
                  {settings?.server?.mode || "N/A"}
                </StatusBadge>
              </div>
            </div>
          </CollapsibleSection>

          {settings?.proxy && (
            <CollapsibleSection title="Proxy Info" mono size="sm" pill>
              <div className="space-y-2">
                <ValueDisplay label="Type" value={settings?.proxy?.type || "N/A"} />
                {settings?.proxy?.mode && (
                  <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                    <span className="text-sm text-accent">Mode</span>
                    <StatusBadge variant={settings?.proxy?.mode === "production" ? "default" : "warning"}>
                      {settings?.proxy?.mode}
                    </StatusBadge>
                  </div>
                )}
                {settings?.proxy?.admin_api && (
                  <ValueDisplay label="Admin API" value={settings?.proxy?.admin_api} />
                )}
                {settings?.proxy?.default_domain && (
                  <ValueDisplay label="Default Domain" value={settings?.proxy?.default_domain} />
                )}
                <div className="flex items-center justify-between py-2 px-3 border border-primary/10 rounded-large-element bg-primary/5">
                  <span className="text-sm text-accent">Auto HTTPS</span>
                  <StatusBadge variant={settings?.proxy?.auto_https ? "default" : "accent"}>
                    {settings?.proxy?.auto_https ? "Enabled" : "Disabled"}
                  </StatusBadge>
                </div>
              </div>
            </CollapsibleSection>
          )}
        </div>
      </SettingsCard>

      <SettingsCard icon={Heart} title="LibreServ" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            LibreServ is a self-hosted application management platform that
            allows you to easily deploy and manage self-hosted applications.
          </p>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={14} className="text-error" />
              <span>Made with love for the open source community</span>
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
