import { useState } from "react";
import { Info, Heart, ChevronDown } from "lucide-react";
import SettingsRow from "../SettingsRow";

const APP_VERSION = "1.0.0";

function ExtraInfoDropdown({ title, children, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const dropdownId = `extra-info-${title.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="mt-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        className="flex items-center gap-1.5 text-xs text-accent hover:text-primary transition-colors cursor-pointer"
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

function ValueDisplay({ children, mono = false }) {
  return (
    <span className={`${mono ? "font-mono" : ""} text-sm text-primary`}>
      {children}
    </span>
  );
}

export default function AboutCategory({ settings }) {
  return (
    <div className="space-y-4">
      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-primary/10">
          <Info size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary text-sm">Application</h2>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-accent">Version</span>
            <span className="font-mono text-sm text-primary">{APP_VERSION}</span>
          </div>

          <ExtraInfoDropdown title="server details">
            <SettingsRow mono label="Backend API" compact>
              <ValueDisplay mono>{settings?.backend?.host || "N/A"}</ValueDisplay>
            </SettingsRow>
            <SettingsRow mono label="Server Port" compact>
              <ValueDisplay mono>{settings?.backend?.port || "N/A"}</ValueDisplay>
            </SettingsRow>
            <SettingsRow mono label="Proxy Type" hideDivider compact>
              <ValueDisplay mono>{settings?.proxy?.type || "None"}</ValueDisplay>
            </SettingsRow>
          </ExtraInfoDropdown>
        </div>
      </div>

      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-primary/10">
          <Heart size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary text-sm">LibreServ</h2>
        </div>
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
      </div>
    </div>
  );
}
