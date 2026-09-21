import { Heart, Coffee } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import SettingsCard from "../SettingsCard";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ValueDisplay from "@libreloom/ui/components/common/ValueDisplay.jsx";
import SystemUpdatesCard from "./SystemUpdatesCard.jsx";
import SystemChecksCard from "./SystemChecksCard.jsx";
import UpdateSourceCard from "./UpdateSourceCard.jsx";
import AccessAddressesCard from "./AccessAddressesCard.jsx";
import OpenSourceLicenses from "./OpenSourceLicenses.jsx";
import { getJson } from "../../../lib/api";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

export default function AboutCategory() {
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => getJson("/api/v1/setup"),
  });

  const deviceName = setup.data?.name || "Luna";

  return (
    <div className="space-y-4" data-slot="about-category">
      <SystemUpdatesCard index={0} />

      <SettingsCard icon={Coffee} title="Support Luna" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            Luna is free and open source. If it has made keeping your files at home a little easier,
            you can help keep it going with a small contribution — entirely optional, always
            appreciated.
          </p>
          <div className="mt-4">
            <Button asChild variant="primary">
              <a href="https://ko-fi.com/libreloom" target="_blank" rel="noopener noreferrer">
                <Coffee size={ICON_SIZE.md} aria-hidden="true" />
                Support us on Ko-fi
              </a>
            </Button>
          </div>
        </div>
      </SettingsCard>

      <AccessAddressesCard index={2} />

      <UpdateSourceCard index={3} />

      <SystemChecksCard index={4} />

      <SettingsCard icon={Heart} title="Luna" padding={false} index={5}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            Luna is your home file box — a place to keep photos, documents, and backups on your
            own hardware, without renting cloud storage by the gigabyte.
          </p>
          <div className="mt-4">
            <ValueDisplay label="This Luna" value={deviceName} />
          </div>
          <div className="mt-4">
            <OpenSourceLicenses />
          </div>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={ICON_SIZE.sm} className="text-error" aria-hidden="true" />
              <span>Made with love: for everyone, by everyone.</span>
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
