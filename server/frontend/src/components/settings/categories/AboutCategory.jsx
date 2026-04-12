import { Info, Heart } from "lucide-react";
import Card from "../../cards/Card";
import CollapsibleSection from "../../common/CollapsibleSection";
import ValueDisplay from "../../common/ValueDisplay";

const APP_VERSION = "1.0.0";

export default function AboutCategory({ settings }) {
  return (
    <div className="space-y-4">
      <Card icon={Info} title="Application" padding={false} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="px-5 py-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-accent">Version</span>
            <span className="font-mono text-sm text-primary">{APP_VERSION}</span>
          </div>

          <CollapsibleSection title="Server Details" size="xs" background className="mt-3">
            <div className="space-y-2">
              <ValueDisplay label="Backend API" value={settings?.server?.host} />
              <ValueDisplay label="Server Port" value={settings?.server?.port} />
              <ValueDisplay label="Proxy Type" value={settings?.proxy?.type || "None"} />
            </div>
          </CollapsibleSection>
        </div>
      </Card>

      <Card icon={Heart} title="LibreServ" padding={false} className="animate-in fade-in slide-in-from-bottom-2 duration-300" style={{ animationDelay: "50ms" }}>
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
      </Card>
    </div>
  );
}
