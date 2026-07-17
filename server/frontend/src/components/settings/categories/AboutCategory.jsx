import { Heart, Coffee } from "lucide-react";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";

export default function AboutCategory() {
  return (
    <div className="space-y-4" data-slot="about-category">
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

      <SettingsCard icon={Coffee} title="Support LibreServ" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            LibreServ is free and open source. If it has made running your own
            server a little easier, you can help keep it going with a small
            contribution — entirely optional, always appreciated.
          </p>
          <div className="mt-4">
            <Button asChild variant="primary">
              <a
                href="https://ko-fi.com/libreloom"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Coffee size={16} aria-hidden="true" />
                Support us on Ko-fi
              </a>
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
