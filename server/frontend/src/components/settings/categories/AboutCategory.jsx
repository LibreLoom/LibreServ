import { Heart } from "lucide-react";
import SettingsCard from "../SettingsCard";

export default function AboutCategory() {
  return (
    <div className="space-y-4">
      <SettingsCard icon={Heart} title="LibreServ" padding={false} index={0}>
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
