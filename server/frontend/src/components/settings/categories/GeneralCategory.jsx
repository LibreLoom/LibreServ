import { FileText } from "lucide-react";
import Card from "../../cards/Card";
import CollapsibleSection from "../../common/CollapsibleSection";
import ValueDisplay from "../../common/ValueDisplay";
import Dropdown from "../../common/Dropdown";
import StatusBadge from "../../common/StatusBadge";
import SettingsRow from "../SettingsRow";

export default function GeneralCategory({ settings }) {
  return (
    <div className="space-y-4">
      <Card icon={FileText} title="Logging" padding={false} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="px-5 py-3">
          <SettingsRow label="Log Level" description="Verbosity of logged messages">
            <Dropdown
              value={settings?.logging?.level || "info"}
              onChange={(val) => settings?.onLoggingChange?.(val)}
              width={120}
              options={[
                { value: "debug", label: "Debug" },
                { value: "info", label: "Info" },
                { value: "warn", label: "Warn" },
                { value: "error", label: "Error" },
              ]}
            />
          </SettingsRow>
          <SettingsRow label="Log Path" hideDivider>
            <ValueDisplay value={settings?.logging?.path || "N/A"} />
          </SettingsRow>

          <div className="border-t border-primary/10 pt-3" />
          <CollapsibleSection title="backend info" mono size="xs" background className="mt-3">
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
            <CollapsibleSection title="proxy info" mono size="xs" background className="mt-3">
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
      </Card>
    </div>
  );
}
