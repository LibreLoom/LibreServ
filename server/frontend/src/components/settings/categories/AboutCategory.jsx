import { Info, Heart, Code } from "lucide-react";
import SettingsRow from "../SettingsRow";

const APP_VERSION = "1.0.0";

export default function AboutCategory({ settings }) {
  return (
    <div className="space-y-4">
      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Info size={18} className="text-accent" />
          <h2 className="font-semibold text-primary">Application</h2>
        </div>
        <SettingsRow label="Version">
          <span className="font-mono text-sm text-primary">{APP_VERSION}</span>
        </SettingsRow>
        <SettingsRow label="Backend API">
          <span className="text-primary">{settings?.backend?.host || "N/A"}</span>
        </SettingsRow>
        <SettingsRow label="Server Port">
          <span className="font-mono text-sm text-primary">
            {settings?.backend?.port || "N/A"}
          </span>
        </SettingsRow>
        <SettingsRow label="Proxy Type">
          <span className="text-primary">{settings?.proxy?.type || "None"}</span>
        </SettingsRow>
      </div>

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Code size={18} className="text-accent" />
          <h2 className="font-semibold text-primary">LibreServ</h2>
        </div>
        <div className="px-4 py-4">
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
      </div>
    </div>
  );
}