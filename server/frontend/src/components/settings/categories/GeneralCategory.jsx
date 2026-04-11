import { useState } from "react";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";
import { FileText, ChevronDown } from "lucide-react";
import SettingsRow from "../SettingsRow";
import Dropdown from "../../common/Dropdown";
import StatusBadge from "../../common/StatusBadge";

function InlineValue({ children, mono = false }) {
  return (
    <span className={`${mono ? "font-mono" : ""} text-sm text-primary`}>
      {children}
    </span>
  );
}

function ExtraInfoDropdown({ title, children, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const dropdownId = `extra-info-${title.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="mt-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        className="flex items-center gap-1.5 font-mono text-xs text-accent hover:text-primary motion-safe:transition-colors cursor-pointer"
        aria-expanded={isOpen}
        aria-controls={dropdownId}
      >
        <ChevronDown
          size={14}
          className={`motion-safe:transition-transform duration-200 ${isOpen ? "rotate-180" : "rotate-0"}`}
          aria-hidden="true"
        />
        <span>{isOpen ? "Hide" : "Show"} {title}</span>
      </button>
      <div
        id={dropdownId}
        className={`overflow-hidden motion-safe:transition-all duration-300 ease-out ${
          isOpen ? "max-h-96 opacity-100 mt-3" : "max-h-0 opacity-0"
        }`}
        aria-hidden={!isOpen}
      >
        <div className="bg-primary/5 rounded-card p-3 space-y-0">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function GeneralCategory({ settings }) {
  const loggingCard = useAnimatedHeight();

  return (
    <div className="space-y-4">
      <div
        ref={loggingCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)] animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={loggingCard.innerRef}>
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-primary/10">
          <FileText size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary text-sm">Logging</h2>
        </div>
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
            <InlineValue mono>{settings?.logging?.path || "N/A"}</InlineValue>
          </SettingsRow>

          <div className="border-t border-primary/10 pt-3" />
          <ExtraInfoDropdown title="backend info">
            <SettingsRow mono label="Host" compact>
              <InlineValue mono>{settings?.backend?.host || "N/A"}</InlineValue>
            </SettingsRow>
            <SettingsRow mono label="Port" compact>
              <InlineValue mono>{settings?.backend?.port || "N/A"}</InlineValue>
            </SettingsRow>
            <SettingsRow mono label="Mode" hideDivider compact>
              <StatusBadge variant={settings?.backend?.mode === "production" ? "default" : "warning"}>
                {settings?.backend?.mode || "N/A"}
              </StatusBadge>
            </SettingsRow>
          </ExtraInfoDropdown>

          {settings?.proxy && (
            <ExtraInfoDropdown title="proxy info">
              <SettingsRow mono label="Type" compact>
                <InlineValue mono>{settings?.proxy?.type || "N/A"}</InlineValue>
              </SettingsRow>
              {settings?.proxy?.mode && (
                <SettingsRow mono label="Mode" compact>
                  <StatusBadge variant={settings?.proxy?.mode === "production" ? "default" : "warning"}>
                    {settings?.proxy?.mode}
                  </StatusBadge>
                </SettingsRow>
              )}
              {settings?.proxy?.admin_api && (
                <SettingsRow mono label="Admin API" compact>
                  <InlineValue mono>{settings?.proxy?.admin_api}</InlineValue>
                </SettingsRow>
              )}
              {settings?.proxy?.default_domain && (
                <SettingsRow mono label="Default Domain" compact>
                  <InlineValue mono>{settings?.proxy?.default_domain}</InlineValue>
                </SettingsRow>
              )}
              <SettingsRow mono label="Auto HTTPS" hideDivider compact>
                <StatusBadge variant={settings?.proxy?.auto_https ? "default" : "accent"}>
                  {settings?.proxy?.auto_https ? "Enabled" : "Disabled"}
                </StatusBadge>
              </SettingsRow>
            </ExtraInfoDropdown>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
