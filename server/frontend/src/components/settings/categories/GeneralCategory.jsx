import { Server, Globe, FileText } from "lucide-react";
import SettingsRow from "../SettingsRow";

export default function GeneralCategory({ settings }) {
  return (
    <div className="space-y-4">
      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Server size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Backend API</h2>
        </div>
        <SettingsRow label="Host">
          <span className="font-mono text-sm text-primary">
            {settings?.backend?.host || "N/A"}
          </span>
        </SettingsRow>
        <SettingsRow label="Port">
          <span className="font-mono text-sm text-primary">
            {settings?.backend?.port || "N/A"}
          </span>
        </SettingsRow>
        <SettingsRow label="Mode">
          <span
            className={`inline-flex items-center px-3 py-1 rounded-pill text-xs font-medium ${
              settings?.backend?.mode === "production"
                ? "bg-primary/10 text-primary"
                : "bg-warning/20 text-warning"
            }`}
          >
            {settings?.backend?.mode || "N/A"}
          </span>
        </SettingsRow>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          settings?.proxy ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
            <Globe size={18} className="text-accent" />
            <h2 className="font-mono font-normal text-primary">Reverse Proxy</h2>
          </div>
          <SettingsRow label="Type">
            <span className="text-primary">{settings?.proxy?.type || "N/A"}</span>
          </SettingsRow>
          {settings?.proxy?.mode && (
            <SettingsRow label="Mode">
              <span
                className={`inline-flex items-center px-3 py-1 rounded-pill text-xs font-medium ${
                  settings?.proxy?.mode === "production"
                    ? "bg-primary/10 text-primary"
                    : "bg-warning/20 text-warning"
                }`}
              >
                {settings?.proxy?.mode}
              </span>
            </SettingsRow>
          )}
          {settings?.proxy?.admin_api && (
            <SettingsRow label="Admin API">
              <span className="font-mono text-sm text-primary">
                {settings?.proxy?.admin_api}
              </span>
            </SettingsRow>
          )}
          {settings?.proxy?.default_domain && (
            <SettingsRow label="Default Domain">
              <span className="text-primary">{settings?.proxy?.default_domain}</span>
            </SettingsRow>
          )}
          <SettingsRow label="Auto HTTPS">
            <span
              className={`inline-flex items-center px-3 py-1 rounded-pill text-xs font-medium ${
                settings?.proxy?.auto_https
                  ? "bg-primary/10 text-primary"
                  : "bg-accent/20 text-accent"
              }`}
            >
              {settings?.proxy?.auto_https ? "Enabled" : "Disabled"}
            </span>
          </SettingsRow>
        </div>
      </div>

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "100ms" }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <FileText size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Logging</h2>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-primary">Log Level</div>
              <div className="text-sm text-accent mt-0.5">
                Verbosity of logged messages
              </div>
            </div>
            <select
              value={settings?.logging?.level || "info"}
              onChange={(e) => settings?.onLoggingChange?.(e.target.value)}
              className="px-4 py-2 border border-primary/20 rounded-pill bg-primary text-secondary focus:outline-none focus:ring-2 focus:ring-accent text-sm transition-all duration-200"
            >
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>
          <div className="mt-3 pt-3 border-t border-primary/10">
            <div className="text-sm text-accent">Log Path</div>
            <div className="font-mono text-sm text-primary mt-1 bg-primary/10 px-3 py-2 rounded-large-element">
              {settings?.logging?.path || "N/A"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}