import { useState } from "react";
import { useAnimatedHeight } from "../../../hooks/useAnimatedHeight";
import { useSystemHardware } from "../../../hooks/useSystemHardware";
import { Info, Heart, ChevronDown, RefreshCw, Cpu, HardDrive, MemoryStick, Wifi } from "lucide-react";
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
        <div className="bg-primary/5 rounded-card rounded-b-card p-3 space-y-0 pb-6">
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

function HardwareInfo() {
  const { data: hardware, isLoading, refetch, isFetching } = useSystemHardware();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-accent">
        <RefreshCw size={14} className="animate-spin" />
        <span>Loading hardware info...</span>
      </div>
    );
  }

  if (!hardware) {
    return (
      <button
        onClick={() => refetch()}
        className="flex items-center gap-2 text-sm text-accent hover:text-primary transition-colors"
      >
        <RefreshCw size={14} />
        <span>Click to load hardware info</span>
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-accent">Hardware Detection</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors disabled:opacity-50"
          title="Refresh hardware info"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          <span>Refresh</span>
        </button>
      </div>
      
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="flex items-center gap-1.5 text-accent">
          <Cpu size={12} />
          <span>CPU</span>
        </div>
        <ValueDisplay mono>{hardware.cpu?.cores || "?"} cores</ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <MemoryStick size={12} />
          <span>RAM</span>
        </div>
        <ValueDisplay mono>{hardware.ram?.total_gb?.toFixed(1) || "?"} GB</ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <HardDrive size={12} />
          <span>Disk</span>
        </div>
        <ValueDisplay mono>{hardware.disk?.total_gb || "?"} GB</ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <Wifi size={12} />
          <span>Network</span>
        </div>
        <ValueDisplay mono>{hardware.network?.interfaces?.length || 0} interfaces</ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <span>GPU</span>
        </div>
        <ValueDisplay mono className="truncate max-w-[120px]">
          {hardware.gpu?.description?.split(":")[1]?.trim() || "None"}
        </ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <span>OS</span>
        </div>
        <ValueDisplay mono className="truncate max-w-[120px]">
          {hardware.os?.name?.replace(/"/g, "") || "Unknown"}
        </ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <span>Virt</span>
        </div>
        <ValueDisplay mono>{hardware.virtualization?.type || "None"}</ValueDisplay>
        
        <div className="flex items-center gap-1.5 text-accent">
          <span>Meets Min</span>
        </div>
        <span className={`text-sm ${hardware.meets_minimums ? "text-success" : "text-error"}`}>
          {hardware.meets_minimums ? "✓ Yes" : "✗ No"}
        </span>
      </div>
    </div>
  );
}

export default function AboutCategory({ settings }) {
  const appCard = useAnimatedHeight();
  const libreServCard = useAnimatedHeight();

  return (
    <div className="space-y-4">
      <div
        ref={appCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)] animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={appCard.innerRef}>
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
            
            <div className="mt-4 pt-3 border-t border-primary/10">
              <HardwareInfo />
            </div>
          </ExtraInfoDropdown>
        </div>
        </div>
      </div>

      <div
        ref={libreServCard.outerRef}
        className="bg-secondary rounded-large-element overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)] animate-in fade-in slide-in-from-bottom-2 duration-300"
        style={{ transitionDuration: "var(--motion-duration-medium2)", animationDelay: "50ms" }}
      >
        <div ref={libreServCard.innerRef}>
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
    </div>
  );
}
